// 6DOF аппарат: состояние 14 элементов, масса от выгорания, аэродинамика, уравнения движения, RK4.
// Оси: NED для трансляции, body для ротации. Ориентация — кватернион (без gimbal lock).
import { Vec3, Quat, tableLookup, table2Lookup, clamp } from './math';
import { sampleAtmo } from './atmosphere';
import type { VehicleConfig } from './config';

export interface VehicleState {
  pos: Vec3;   // NED, м (z вниз отрицат. высота = -z)
  vel: Vec3;   // NED, м/с
  q: Quat;     // body <- NED
  omega: Vec3; // body, рад/с
  m: number; mPropLeft: number;
  t: number;
  finP: number; finY: number; finR: number; // текущие отклонения, рад
  finP_rate: number; finY_rate: number;
  thrust: number; qbar: number; mach: number; alpha: number; beta: number;
  axCmd: number; azCmd: number; // команды автопилота (body перегрузки)
  loadG: number;
  dead: boolean;
}

export class Vehicle {
  st: VehicleState;
  Ixx = 900; Iyy = 5200; Izz = 5200;
  cmdAy = 0; cmdAz = 0; // команды перегрузки в body (g)
  throttle = 1;
  thrustScale = 1; // дисперсия для Monte-Carlo

  cfg: VehicleConfig;
  constructor(cfg: VehicleConfig, pos: Vec3, vel: Vec3, yaw0 = 0) {
    this.cfg = cfg;
    this.st = {
      pos: pos.clone(), vel: vel.clone(), q: Quat.fromEuler(0, 0, yaw0), omega: new Vec3(),
      m: cfg.m0, mPropLeft: cfg.mProp, t: 0, finP: 0, finY: 0, finR: 0, finP_rate: 0, finY_rate: 0,
      thrust: 0, qbar: 0, mach: 0.3, alpha: 0, beta: 0, axCmd: 0, azCmd: 0, loadG: 1, dead: false
    };
    this.updateInertia();
  }
  /** Выставить ось +X корпуса по вектору скорости (старт без начального угла атаки) */
  alignTo(velNED: Vec3) {
    // q активный: переводит +X в dir напрямую
    this.st.q = Quat.fromXTo(velNED).normalized();
    this.st.omega = new Vec3();
  }
  updateInertia() {
    const f = this.st.mPropLeft / this.cfg.mProp;
    this.Ixx = 900 * (0.55 + 0.45 * f);
    this.Iyy = 5200 * (0.6 + 0.4 * f);
    this.Izz = this.Iyy;
  }
  thrustAt(t: number): number {
    const pts = this.cfg.thrust;
    if (t <= pts[0].t) return pts[0].T * this.throttle * this.thrustScale;
    for (let i = 0; i < pts.length - 1; i++) {
      if (t >= pts[i].t && t <= pts[i + 1].t) {
        const k = (t - pts[i].t) / Math.max(1e-6, pts[i + 1].t - pts[i].t);
        return (pts[i].T * (1 - k) + pts[i + 1].T * k) * this.throttle * this.thrustScale;
      }
    }
    return 0;
  }
  // Шаг приводов 2-го порядка с лимитами
  stepActuators(dt: number, cmdP: number, cmdY: number, cmdR: number) {
    const s = this.st, wn = 150, z = 0.65;
    const maxD = this.cfg.maxFinDeg * Math.PI / 180, maxR = this.cfg.maxFinRateDeg * Math.PI / 180;
    const ch = (cur: number, rate: number, cmd: number) => {
      const c = clamp(cmd, -maxD, maxD);
      const acc = wn * wn * (c - cur) - 2 * z * wn * rate;
      let nr = clamp(rate + acc * dt, -maxR, maxR);
      let nc = clamp(cur + nr * dt, -maxD, maxD);
      return [nc, nr] as const;
    };
    const [p, pr] = ch(s.finP, s.finP_rate, cmdP);
    const [y, yr] = ch(s.finY, s.finY_rate, cmdY);
    s.finP = p; s.finP_rate = pr; s.finY = y; s.finY_rate = yr;
    s.finR = clamp(cmdR, -maxD, maxD);
  }
  // Производные состояния для RK4 (трансляция — в NED, ротация — Эйлер)
  deriv(cmdFinP: number, cmdFinY: number, wind: Vec3, latDeg: number) {
    const s = this.st;
    const atmo = sampleAtmo(s.pos, s.vel, wind, latDeg);
    const vAirNED = s.vel.sub(wind);
    const vBody = s.q.conjugate().rotate(vAirNED); // body вектор скорости (q активный body->NED)
    const V = Math.max(1, vBody.norm());
    const alpha = Math.atan2(-vBody.z, Math.max(1e-6, vBody.x)); // угол атаки
    const beta = Math.asin(clamp(vBody.y / V, -1, 1));
    const mach = V / atmo.a;
    const T = this.thrustAt(s.t);
    const { CLalpha, CMalpha, CD, machs, alphas } = this.cfg.aero;
    const cla = tableLookup(machs, CLalpha, mach);
    const cma = tableLookup(machs, CMalpha, mach);
    // CD0 — только от Маха (чистое сопротивление корпуса); индуктивное — физикой ниже.
    // (старый член 0.012*a² занижал индуктивное в ~27 раз — повороты были почти бесплатны)
    const cd0 = table2Lookup(machs, alphas, CD, mach, 0);
    const qS = atmo.qbar * this.cfg.Sref;
    // Стандартные углы: alS>0 = нос выше скорости (кабрирование), beS>0 = нос правее скорости.
    // (внутренние alpha/beta инвертированы из-за +Z вниз — см. atan2 выше)
    const alS = -alpha, beS = -beta;
    // Силы body: тяга по +X, аэродинамика
    const CL = cla * alS, CY = cla * beS;
    const K_IND = 0.133; // 1/(pi*AR*e), AR~3 — индуктивное от подъёмной/боковой силы
    const D = qS * (cd0 + K_IND * (CL * CL + CY * CY));
    const Lift = qS * CL, Side = qS * CY;
    // Моменты в коэффициентной форме (короткопериодическая динамика):
    // CmA<0 — статическая устойчивость, Cmq — демпфирование, CMd>0 — эффективность рулей.
    // Знаки проверены эмпирически: finP>0 -> кабрирование (вверх), finY>0 -> вправо.
    const CMd = 2.5, CMq = -20.0, ClP = -0.6, ClD = 0.35;
    const qSL = qS * this.cfg.Lref;
    // Знак моментов — стандартный (активный кватернион, проверено dbg19/20/17):
    // finP>0 -> вверх, finY>0 -> вправо, cma<0 -> статическая устойчивость.
    const Mx = qSL * (ClP * s.omega.x * this.cfg.Lref / V + ClD * s.finR);
    const My = qSL * (cma * alS + CMq * s.omega.y * this.cfg.Lref / V + CMd * s.finP);
    const Mz = qSL * (cma * beS + CMq * s.omega.z * this.cfg.Lref / V + CMd * s.finY);
    const Fbx = T - D, Fby = Side, Fbz = -Lift;
    const Fb = new Vec3(Fbx, Fby, Fbz);
    // Корректно: q активный (body->NED), обратно — через conjugate
    const Fned = s.q.rotate(Fb);
    const acc = Fned.scale(1 / s.m).add(new Vec3(0, 0, atmo.g));
    // угловые ускорения Эйлера
    const { x: wx, y: wy, z: wz } = s.omega;
    const MxI = Mx / this.Ixx, MyI = My / this.Iyy, MzI = Mz / this.Izz;
    const dom = new Vec3(
      MxI - (this.Izz - this.Iyy) / this.Ixx * wy * wz,
      MyI - (this.Ixx - this.Izz) / this.Iyy * wx * wz,
      MzI - (this.Iyy - this.Ixx) / this.Izz * wx * wy);
    return { acc, dom, alpha: alS, beta: beS, mach, qbar: atmo.qbar, T, g: atmo.g };
  }
  // Один шаг RK4 для трансляции + Эйлер для ротации
  step(dt: number, wind: Vec3, latDeg: number) {
    const s = this.st;
    if (s.dead) return;
    // приводы к командам автопилота переводятся снаружи через autopilot -> здесь только удержание
    const d1 = this.deriv(s.finP, s.finY, wind, latDeg);
    // упрощённый RK4 по скорости/позиции (ориентация — Эйлер 1-й порядок на малом dt=0.0005)
    const p0 = s.pos.clone(), v0 = s.vel.clone(), q0 = s.q.clone(), w0 = s.omega.clone();
    s.pos = p0.add(v0.scale(dt)); // предиктор для оценки не нужен полный RK4 по всем — делаем классику:
    // полный шаг:
    const k1v = d1.acc, k1w = d1.dom;
    // k2
    s.pos = p0.add(v0.scale(dt / 2)); s.vel = v0.add(k1v.scale(dt / 2)); s.omega = w0.add(k1w.scale(dt / 2));
    const d2 = this.deriv(s.finP, s.finY, wind, latDeg);
    s.pos = p0.add(v0.add(d2.acc.scale(dt / 2)).scale(dt)); // оценка
    s.vel = v0.add(d2.acc.scale(dt / 2)); s.omega = w0.add(d2.dom.scale(dt / 2));
    const d3 = this.deriv(s.finP, s.finY, wind, latDeg);
    s.vel = v0.add(d3.acc.scale(dt / 2)); s.omega = w0.add(d3.dom.scale(dt / 2));
    const d4 = this.deriv(s.finP, s.finY, wind, latDeg);
    // финал
    s.vel = v0.add(k1v.scale(dt / 6)).add(d2.acc.scale(dt / 3)).add(d3.acc.scale(dt / 3)).add(d4.acc.scale(dt / 6));
    s.omega = w0.add(k1w.scale(dt / 6)).add(d2.dom.scale(dt / 3)).add(d3.dom.scale(dt / 3)).add(d4.dom.scale(dt / 6));
    s.pos = p0.add(v0.scale(dt / 6)).add(v0.add(k1v.scale(dt / 2)).scale(dt / 3)).add(v0.add(d3.acc.scale(dt / 2)).scale(dt / 3)).add(v0.add(d4.acc.scale(dt)).scale(dt / 6));
    void q0;
    s.q = s.q.add(s.q.derivative(s.omega).scale(dt)).normalized();
    s.t += dt;
    // масса: интеграл тяги через Isp
    const mdot = d1.T > 0 && s.mPropLeft > 0 ? d1.T / (this.cfg.Isp * 9.80665) : 0;
    const dm = Math.min(mdot * dt, s.mPropLeft);
    s.m -= dm; s.mPropLeft -= dm; this.updateInertia();
    if (d1.T <= 0) s.thrust = 0; else s.thrust = d1.T;
    s.qbar = d1.qbar; s.mach = d1.mach; s.alpha = d1.alpha; s.beta = d1.beta;
    s.loadG = Math.hypot(d1.acc.x, d1.acc.y, d1.acc.z - d1.g) / 9.80665;
    // земля
    if (s.pos.z > 0) { s.pos.z = 0; s.dead = true; }
  }
}
