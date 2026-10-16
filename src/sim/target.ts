// Цель: кинематика + программные манёвры + РЕАКТИВНОЕ уклонение от угрозы.
// Уклонение: when ЗУР близко и сближается — двухтональный weave + вертикальный jink
// + отворот от пеленга угрозы. Цель пытается сорвать наведение, ПВО — достреливает.
import { Vec3, clamp } from './math';

export type Maneuver = 'constant' | 'weave' | 'turn' | 'dive' | 'quasi';

export class TargetKin {
  pos: Vec3; vel: Vec3; acc = new Vec3();
  t = 0; dead = false; alt0: number;
  weaveFreq = 0.9; weaveG = 7; turnG = 9; turnOnset = 4; // начало отворота, с
  // --- уклонение ---
  evadeOn = false; evadeRange = 8000; evadeG = 8; evadeMaxG = 12; evadePhase = 0;
  threatPos: Vec3 | null = null; lastThreatR = 1e12; evading = false;
  // ручное управление (живой бой за цель): pitch/yaw -1..1, скорость держится сама
  manual: { pitch: number; yaw: number } | null = null;
  constructor(pos: Vec3, vel: Vec3) { this.pos = pos.clone(); this.vel = vel.clone(); this.alt0 = -pos.z; }
  setThreat(p: Vec3 | null) { this.threatPos = p ? p.clone() : null; }
  step(dt: number, man: Maneuver, g0 = 9.80665) {
    this.t += dt;
    const V = Math.max(50, this.vel.norm());
    // направление полёта
    const fwd = this.vel.normalized();
    // боковая ось (горизонталь)
    const side = new Vec3(-fwd.y, fwd.x, 0);
    const sn = side.norm() > 1e-6 ? side.scale(1 / side.norm()) : new Vec3(0, 1, 0);
    let latG = 0, vertG = 0;
    if (this.manual) {
      // пилот: свободный полёт, A/D — разворот ±9g, W/S — набор/снижение ±6g
      latG = this.manual.yaw * 9;
      vertG = this.manual.pitch * 6;
    } else if (man === 'weave') latG = this.weaveG * Math.sin(2 * Math.PI * this.weaveFreq * this.t) * (this.t > 3 ? 1 : 0);
    else if (man === 'turn') latG = this.t > this.turnOnset ? this.turnG : 0;
    else if (man === 'dive') vertG = -4;
    else if (man === 'quasi') {
      // квазибаллистика типа Искандера: свободное падение, ниже 20км —
      // терминальные срывы: рывок в сторону + клевок, 15-20g, непериодично
      const qalt = -this.pos.z;
      if (qalt < 20000) {
        const w1 = 2 * Math.PI * 1.1 * this.t + this.evadePhase;
        const w2 = 2 * Math.PI * 0.53 * this.t + 2.2;
        latG = 16 * Math.sin(w1) + 7 * Math.sin(w2);
        vertG = 9 * Math.sin(2 * Math.PI * 0.71 * this.t + 0.6) - 3;
        latG = clamp(latG, -22, 22);
        vertG = clamp(vertG, -15, 12);
      }
    }
    // --- реактивное уклонение от ближайшей ЗУР ---
    if (!this.manual && this.evadeOn && this.threatPos) {
      const toT = this.pos.sub(this.threatPos);
      const r = toT.norm();
      const closing = r < this.lastThreatR;
      this.lastThreatR = r;
      if (!this.evading && r < this.evadeRange && (closing || r < this.evadeRange * 0.4)) this.evading = true;
      if (this.evading && r > this.evadeRange * 1.35) this.evading = false;
      if (this.evading) {
        // частота растёт по мере сближения: 0.6 -> 2.6 Гц, фаза случайна по seed
        const f = 0.6 + 2.0 * (1 - Math.min(r, this.evadeRange) / this.evadeRange);
        const w = 2 * Math.PI * f * this.t + this.evadePhase;
        latG += this.evadeG * Math.sin(w) + this.evadeG * 0.45 * Math.sin(0.41 * w + 1.1);
        // отворот от пеленга угрозы: давим в сторону от ЗУР
        const away = toT.norm() > 1e-6 ? toT.scale(1 / toT.norm()) : new Vec3();
        const sideSign = sn.dot(away) >= 0 ? 1 : -1;
        latG += sideSign * this.evadeG * 0.35;
        // вертикальный джинк
        vertG += this.evadeG * 0.55 * Math.sin(2 * Math.PI * 0.63 * f * this.t + 1.7 + this.evadePhase);
        latG = clamp(latG, -this.evadeMaxG, this.evadeMaxG);
        vertG = clamp(vertG, -this.evadeMaxG * 0.7, this.evadeMaxG * 0.7);
      }
    }
    this.acc = sn.scale(latG * g0).add(new Vec3(0, 0, vertG * g0 * -1));
    // гравитация компенсируется подъёмной силой (держим высоту), кроме dive/manual-снижения
    if (!this.manual && (man === 'constant' || man === 'weave' || man === 'turn')) {
      // держим высоту: демпфируем вертикальную скорость + слабое удержание эшелона
      // (в наших координатах высота = -z, земля при z=0)
      const alt = -this.pos.z;
      this.acc = this.acc.add(new Vec3(0, 0, -this.vel.z * 0.8 + (alt - this.alt0) * 0.05));
    } else {
      this.acc = this.acc.add(new Vec3(0, 0, g0)); // NED +z вниз: свободное падение
    }
    this.vel = this.vel.add(this.acc.scale(dt));
    // держим скорость (тяга компенсирует drag) — упрощённо нормируем к начальной
    this.pos = this.pos.add(this.vel.scale(dt));
    if (this.pos.z > 0) { this.pos.z = 0; this.dead = true; }
    void V;
  }
}
