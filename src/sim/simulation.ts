// Многоконтурная симуляция: plant 2000 Гц (dt=0.0005), control 500 Гц, guidance 100 Гц.
// Бой: несколько установок, залповая стрельба, автоматический дострел,
// цель с реактивным уклонением или ручным пилотированием. Детерминизм по seed.
//
// Два режима использования одного кода:
// - runEngagement: пакетный просчёт до конца (верификация, Monte-Carlo);
// - Battle: живой пошаговый бой для игры (роль ПВО-наблюдатель или пилот цели).
import { Vec3, RNG, clamp } from './math';
import { Vehicle } from './vehicle';
import { Autopilot } from './autopilot';
import { guideVec, nedToBodyG, Law } from './guidance';
import { Seeker } from './seeker';
import { Radar } from './radar';
import { TargetKin, Maneuver } from './target';
import { WindField } from './atmosphere';
import type { VehicleConfig } from './config';

export interface LaunchSite { pos: Vec3; cfg: VehicleConfig; delay: number; }
export interface EvasionParams { enabled: boolean; rangeM: number; g: number; maxG: number; }

export interface EngageParams {
  interceptorCfg: VehicleConfig; law: Law; N: number;
  targetInitPos: Vec3; targetInitVel: Vec3; maneuver: Maneuver;
  launchPos: Vec3; launchDelay: number;
  seed: number; windSpeed: number; windFrom: number;
  radarRcs: number; seekerNoise: number;
  maxT: number; turnOnsetS?: number;
  // --- бой ---
  salvo?: number; salvoDt?: number;           // ракет в залпе с одной установки
  sites?: LaunchSite[];                        // доп. установки (если нет — одна из launchPos)
  evasion?: EvasionParams;                     // реактивное уклонение цели
  reshoot?: boolean; maxShots?: number;        // дострел при промахе
}

export interface TrackPoint { t: number; p: Vec3; v: Vec3; hot: boolean; }
export interface EngageResult {
  hit: boolean; missM: number; tHit: number;
  log: TraceRow[]; tracks: TrackPoint[][]; endReason: string;
  maxG: number; maxMach: number; shots: number;
}

export interface TraceRow {
  t: number;
  mpos: Vec3; mvel: Vec3; tpos: Vec3; tvel: Vec3;
  range: number; vc: number; losRate: number; qbar: number; mach: number; g: number; altM: number;
  cmdG: number; rollDeg: number; alphaDeg: number; finDeg: number;
  evade: number; shotsUp: number;
}

export const DT_PLANT = 0.0005, DT_CTRL = 0.002, DT_GUIDE = 0.01;
const BLEND = 12000; // дальность перехода на точный финал: раньше = больше времени свести ошибку

interface Missile {
  veh: Vehicle; ap: Autopilot; seeker: Seeker;
  aNed: Vec3; losHist: Vec3[]; accC: number; accG: number;
  lastLos: number; lastVc: number;
  minD: number; done: boolean; doneWhy: string;
  track: TrackPoint[];
}
interface Shot { t: number; pos: Vec3; cfg: VehicleConfig; }

export class Battle {
  rng: RNG; wind: WindField; radar: Radar; tgt: TargetKin;
  missiles: Missile[] = [];
  schedule: Shot[] = [];
  baseSites: LaunchSite[];
  t = 0; accR = 0; logAcc = 0;
  log: TraceRow[] = [];
  miss = 1e9; tClosest = 0; maxG = 0; maxMach = 0;
  endReason = 'time'; hit = false;
  manKind: Maneuver;
  salvo: number; salvoDt: number;
  allowReshoot: boolean; maxShots: number;

  constructor(public p: EngageParams) {
    this.rng = new RNG(p.seed);
    this.wind = new WindField(); this.wind.setBase(p.windSpeed, p.windFrom);
    this.radar = new Radar(new Vec3(0, 0, 0), 120000, p.radarRcs, 25, 0.25);
    this.tgt = new TargetKin(p.targetInitPos, p.targetInitVel);
    if (p.turnOnsetS !== undefined) this.tgt.turnOnset = p.turnOnsetS;
    if (p.maneuver === 'weave') { this.tgt.weaveG = 7; this.tgt.weaveFreq = 0.7 + this.rng.uniform() * 0.5; }
    if (p.maneuver === 'turn') this.tgt.turnG = 9;
    const ev = p.evasion;
    if (ev?.enabled) {
      this.tgt.evadeOn = true; this.tgt.evadeRange = ev.rangeM; this.tgt.evadeG = ev.g;
      this.tgt.evadeMaxG = ev.maxG; this.tgt.evadePhase = this.rng.uniform() * Math.PI * 2;
    }
    this.salvo = Math.max(1, Math.min(4, Math.floor(p.salvo ?? 1)));
    this.salvoDt = p.salvoDt ?? 1.5;
    this.baseSites = p.sites?.length
      ? p.sites
      : [{ pos: p.launchPos, cfg: p.interceptorCfg, delay: p.launchDelay }];
    for (const s of this.baseSites)
      for (let k = 0; k < this.salvo; k++)
        this.schedule.push({ t: s.delay + k * this.salvoDt, pos: s.pos, cfg: s.cfg });
    this.schedule.sort((a, b) => a.t - b.t);
    this.allowReshoot = p.reshoot ?? false;
    this.maxShots = Math.max(this.schedule.length, Math.min(8, p.maxShots ?? (this.schedule.length + (p.reshoot ? 2 : 0))));
    this.manKind = (p.maneuver === 'constant' && p.targetInitPos.z < -4000) ? 'constant' : p.maneuver;
  }

  get shots() { return this.missiles.length; }
  get tracks(): TrackPoint[][] { return this.missiles.map(m => m.track); }

  fire(pos: Vec3, cfg: VehicleConfig) {
    const p = this.p, rng = this.rng;
    const r = this.radar.track.pos.sub(pos).norm();
    // Горизонт прогноза ограничен реалистичным подлётом (~25с):
    // дальше — точка встречи уходит под землю за пикирующей целью, ЗУР «путается».
    const tgo0 = Math.min(r / 1200, 25);
    const aim = this.radar.track.pos.add(this.radar.track.vel.scale(Math.max(1, tgo0)));
    const dirRaw = aim.sub(pos).normalized();
    const minUp = -0.07;
    const dir = dirRaw.z > minUp ? new Vec3(dirRaw.x, dirRaw.y, minUp).normalized() : dirRaw;
    const v0 = dir.scale(260);
    const railPos = pos.clone(); railPos.z -= 4;
    const veh = new Vehicle(cfg, railPos, v0, Math.atan2(dir.y, dir.x));
    veh.alignTo(v0);
    veh.thrustScale = 0.97 + rng.uniform() * 0.06;
    this.missiles.push({
      veh, ap: new Autopilot(cfg.maxG), seeker: new Seeker(p.seekerNoise, 4, 0.12, 60),
      aNed: new Vec3(), losHist: [], accC: 0, accG: 0, lastLos: 0, lastVc: 0,
      minD: 1e9, done: false, doneWhy: '', track: []
    });
  }

  /** Один шаг планта. Возвращает событие ('HIT') или null. */
  step(): string | null {
    const p = this.p, rng = this.rng, tgt = this.tgt;
    this.t += DT_PLANT;
    const t = this.t;
    this.wind.step(DT_PLANT, 0.4, () => rng.gaussian(1));
    const wTot = this.wind.total();
    // угроза для уклонения = ближайшая живая ЗУР
    let threat: Missile | null = null, threatD = 1e12;
    for (const m of this.missiles) {
      if (m.done || m.veh.st.dead) continue;
      const d = m.veh.st.pos.sub(tgt.pos).norm();
      if (d < threatD) { threatD = d; threat = m; }
    }
    tgt.setThreat(threat ? threat.veh.st.pos : null);
    if (!tgt.dead) tgt.step(DT_PLANT, this.manKind);
    // РЛС 10 Гц
    this.accR += DT_PLANT;
    if (this.accR >= 0.1 - 1e-9) { this.radar.update(tgt.pos, tgt.vel, p.radarRcs, this.accR, rng); this.accR = 0; }

    // пуски по расписанию
    while (this.schedule.length && t >= this.schedule[0].t) {
      const s = this.schedule[0];
      if (this.radar.track.detected && !tgt.dead) { this.schedule.shift(); this.fire(s.pos, s.cfg); }
      else if (tgt.dead || t > s.t + 45) this.schedule.shift();
      else break;
    }
    // дострел
    const allDone = this.missiles.length > 0 && this.missiles.every(m => m.done);
    if (this.allowReshoot && allDone && !tgt.dead && this.radar.track.detected
        && this.missiles.length < this.maxShots && this.schedule.length === 0) {
      const s0 = this.baseSites[0];
      if (tgt.pos.sub(s0.pos).norm() < 60000) this.schedule.push({ t: t + 2.0, pos: s0.pos, cfg: s0.cfg });
    }

    for (const m of this.missiles) {
      if (m.done) continue;
      if (m.veh.st.dead) { m.done = true; m.doneWhy = 'ground'; continue; }
      if (tgt.dead) { m.done = true; m.doneWhy = 'target-gone'; continue; }
      m.accC += DT_PLANT; m.accG += DT_PLANT;
      if (m.accG >= DT_GUIDE - 1e-9) {
        m.accG = 0;
        if (m.veh.st.t > 0.4) {
          m.seeker.update(tgt.pos, tgt.vel, tgt.acc, m.veh.st.pos, DT_GUIDE, rng);
          const pre = guideVec(p.law, p.N, m.veh.st.pos, m.veh.st.vel, m.seeker.measPos, m.seeker.measVel, m.seeker.measAcc);
          let g = pre;
          if (pre.range > BLEND) {
            const tgoE = Math.max(0.5, Math.min(25, pre.range / Math.max(200, pre.vc)));
            const pip = m.seeker.measPos.add(m.seeker.measVel.scale(tgoE));
            // Низкие цели (<300м): держим +250м превышения на середине
            // (запас от земли + энергия; в финале ныряем). Иначе скребём грунт.
            if (-m.seeker.measPos.z < 300) pip.z -= 250;
            // PIP никогда под землю: минимум 300м (иначе ЗУР ныряет за призраком)
            if (pip.z > -300) pip.z = -300;
            const toPip = pip.sub(m.veh.st.pos);
            const dist = Math.max(1, toPip.norm());
            const vDes = toPip.scale(m.veh.st.vel.norm() / dist);
            const aMid = vDes.sub(m.veh.st.vel).scale(1 / 0.9);
            g = { aNed: aMid, losRate: pre.losRate, vc: pre.vc, range: pre.range, tgo: tgoE };
          } else {
            const losNow = m.seeker.measPos.sub(m.veh.st.pos).normalized();
            m.losHist.push(losNow); if (m.losHist.length > 11) m.losHist.shift();
            if (m.losHist.length >= 6) {
              const base = DT_GUIDE * (m.losHist.length - 1);
              const om = m.losHist[0].cross(losNow).scale(1 / base);
              const wRate = om.norm(), vc = Math.max(0, pre.vc);
              const Nterm = p.N + 2; // финал злой: N+2 против терминального джинка
              const ax = om.cross(m.veh.st.vel);
              const an = ax.norm();
              let aT = an > 1e-9 ? ax.scale(Nterm * vc * wRate / an) : new Vec3();
              if (p.law === 'apn') {
                const aTp = m.seeker.measAcc.sub(losNow.scale(m.seeker.measAcc.dot(losNow)));
                aT = aT.add(aTp.scale(Nterm / 2));
              }
              g = { aNed: aT, losRate: wRate, vc, range: pre.range, tgo: vc > 1 ? pre.range / vc : 5 };
            }
          }
          const limBase = m.veh.cfg.maxG * 9.81;
          const qSnow = m.veh.st.qbar * m.veh.cfg.Sref;
          // Располагаемая при alpha 16° — не требуем больше, чем даёт крыло.
          const nAero = qSnow * 9 * 0.28 / (m.veh.st.m * 9.81);
          const lim = Math.min(limBase, pre.range > BLEND ? 20 * 9.81 : limBase, Math.max(2.5 * 9.81, nAero * 9.81));
          if (g.aNed.norm() > lim) g.aNed = g.aNed.scale(lim / g.aNed.norm());
          const tau = pre.range > BLEND ? 0.15 : 0.04;
          const kf = 1 - Math.exp(-DT_GUIDE / tau);
          m.aNed = m.aNed.scale(1 - kf).add(g.aNed.scale(kf));
          m.lastLos = g.losRate; m.lastVc = g.vc;
          const mAltNow = -m.veh.st.pos.z;
          if (pre.range > BLEND) {
            if (mAltNow < 200 && m.aNed.z > -20) m.aNed.z = -20;
            if (mAltNow < 80 && m.aNed.z > 0) m.aNed.z = 0;
          }
        }
      }
      if (m.accC >= DT_CTRL - 1e-9) {
        m.accC = 0;
        const toBody = (v: Vec3) => m.veh.st.q.conjugate().rotate(v);
        const aLift = m.aNed.sub(new Vec3(0, 0, 9.80665));
        const { ay, az } = nedToBodyG(aLift, toBody);
        const V = Math.max(1, m.veh.st.vel.sub(wTot).norm());
        const gBody = m.veh.st.q.conjugate().rotate(new Vec3(0, 0, 9.80665));
        const cmds = m.ap.update(ay, az, m.veh.st.qbar, V, m.veh.st.omega, DT_CTRL, gBody, { m: m.veh.st.m, qS: m.veh.st.qbar * m.veh.cfg.Sref, cla: 9, alS: m.veh.st.alpha, beS: m.veh.st.beta });
        m.veh.stepActuators(DT_CTRL, cmds.finP, cmds.finY, cmds.finR);
      }
      m.veh.step(DT_PLANT, wTot, 55);
      this.maxG = Math.max(this.maxG, m.veh.st.loadG); this.maxMach = Math.max(this.maxMach, m.veh.st.mach);
      const d = m.veh.st.pos.sub(tgt.pos).norm();
      if (d < m.minD) m.minD = d;
      if (d < this.miss) { this.miss = d; this.tClosest = t; }
      const relF = tgt.pos.sub(m.veh.st.pos);
      const vcTrue = -tgt.vel.sub(m.veh.st.vel).dot(relF.scale(1 / Math.max(1, relF.norm())));
      const killR = m.veh.cfg.warheadRadius * (1 + Math.max(0, vcTrue) / 1500);
      if (d < killR && vcTrue > 50) {
        this.hit = true; this.endReason = 'HIT';
        this.pushTracks();
        return 'HIT';
      }
      if (m.veh.st.dead) { m.done = true; m.doneWhy = 'ground'; continue; }
      if (vcTrue < -100 && d > m.minD + 400) { m.done = true; m.doneWhy = 'flyby'; continue; }
    }

    // лог 50 Гц
    this.logAcc += DT_PLANT;
    if (this.logAcc >= 0.02) {
      this.logAcc = 0;
      let prim: Missile | null = null, pd = 1e12;
      for (const m of this.missiles) {
        if (m.veh.st.dead && m.done) continue;
        const d = m.veh.st.pos.sub(tgt.pos).norm();
        if (d < pd) { pd = d; prim = m; }
      }
      this.pushTracks();
      if (prim) {
        const eulDbg = prim.veh.st.q.toEuler();
        this.log.push({
          t, mpos: prim.veh.st.pos.clone(), mvel: prim.veh.st.vel.clone(),
          tpos: tgt.pos.clone(), tvel: tgt.vel.clone(), range: pd, vc: prim.lastVc, losRate: prim.lastLos,
          qbar: prim.veh.st.qbar, mach: prim.veh.st.mach, g: prim.veh.st.loadG, altM: -prim.veh.st.pos.z,
          cmdG: prim.aNed.norm() / 9.81, rollDeg: eulDbg.roll * 57.3, alphaDeg: prim.veh.st.alpha * 57.3, finDeg: prim.veh.st.finP * 57.3,
          evade: tgt.evading ? 1 : 0, shotsUp: this.missiles.filter(x => !x.done).length
        });
      } else {
        this.log.push({
          t, mpos: p.launchPos.clone(), mvel: new Vec3(), tpos: tgt.pos.clone(), tvel: tgt.vel.clone(),
          range: tgt.pos.sub(p.launchPos).norm(), vc: 0, losRate: 0, qbar: 0, mach: 0, g: 0, altM: -tgt.pos.z,
          cmdG: 0, rollDeg: 0, alphaDeg: 0, finDeg: 0, evade: tgt.evading ? 1 : 0, shotsUp: 0
        });
      }
      if (this.log.length > 4000) this.log.shift();
    }
    return null;
  }

  /** Проверка конца боя после шага. Возвращает причину или null (продолжать). */
  pollEnd(): string | null {
    const tgt = this.tgt;
    if (this.hit) return 'HIT';
    if (tgt.dead) return this.missiles.length > 0 ? 'target-impact' : 'target-impact-before-launch';
    if (this.missiles.length === 0 && this.schedule.length === 0) {
      if (this.t > 30 && !this.radar.track.detected) return 'no-detection';
      return null;
    }
    if (this.missiles.length > 0 && this.missiles.every(m => m.done) && this.schedule.length === 0) {
      if (!this.allowReshoot || this.missiles.length >= this.maxShots) return 'MISS-flyby';
      const dSite = tgt.pos.sub(this.baseSites[0].pos).norm();
      if (dSite > 90000 || !this.radar.track.detected) return 'MISS-flyby';
      return null; // ждём дострел
    }
    return null;
  }

  pushTracks() {
    for (const m of this.missiles) {
      const last = m.track[m.track.length - 1];
      if (!last || this.t - last.t >= 0.02 - 1e-9) {
        m.track.push({ t: this.t, p: m.veh.st.pos.clone(), v: m.veh.st.vel.clone(), hot: m.veh.st.thrust > 1000 });
        if (m.track.length > 4000) m.track.shift();
      }
    }
  }
}

export function runEngagement(p: EngageParams): EngageResult {
  const b = new Battle(p);
  const steps = Math.floor(p.maxT / DT_PLANT);
  for (let i = 0; i < steps; i++) {
    const evt = b.step();
    if (evt === 'HIT') { b.endReason = 'HIT'; break; }
    const pe = b.pollEnd();
    if (pe) { b.endReason = pe; break; }
  }
  return {
    hit: b.hit, missM: b.miss > 1e8 ? 1e9 : b.miss, tHit: b.tClosest,
    log: b.log, tracks: b.tracks, endReason: b.endReason,
    maxG: b.maxG, maxMach: b.maxMach, shots: b.shots
  };
}

export function quickRangeCheck() { return clamp(1, 0, 2); }
