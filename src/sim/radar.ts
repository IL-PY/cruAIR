// РЛС: обнаружение по дальности от ЭПР + шумы + простое альфа-бета сопровождение.
import { Vec3, RNG } from './math';

export interface Track { pos: Vec3; vel: Vec3; init: boolean; detected: boolean; range: number; snr: number; }

export class Radar {
  track: Track = { pos: new Vec3(), vel: new Vec3(), init: false, detected: false, range: 0, snr: 0 };
  antYaw = 0;
  pos: Vec3; maxRangeM: number; rcsM2: number; rangeNoise: number; angleNoiseDeg: number;
  constructor(
    pos: Vec3, // NED позиция РЛС (z=0 земля)
    maxRangeM = 120000,
    rcsM2 = 0.5,
    rangeNoise = 25,
    angleNoiseDeg = 0.25
  ) { this.pos = pos; this.maxRangeM = maxRangeM; this.rcsM2 = rcsM2; this.rangeNoise = rangeNoise; this.angleNoiseDeg = angleNoiseDeg; }
  maxRangeFor(rcs: number) { return this.maxRangeM * Math.pow(Math.max(0.01, rcs) / 0.5, 0.25); }
  update(truePos: Vec3, trueVel: Vec3, rcs: number, dt: number, rng: RNG) {
    this.antYaw += dt * 0.9; // вращение антенны для картинки
    const rel = truePos.sub(this.pos);
    const range = rel.norm();
    const rMax = this.maxRangeFor(rcs);
    const detected = range < rMax && truePos.z < -5;
    this.track.detected = detected;
    this.track.range = range;
    this.track.snr = detected ? Math.max(0, 20 * Math.log10(rMax / Math.max(1, range))) : -99;
    if (!detected) return;
    const aN = this.angleNoiseDeg * Math.PI / 180;
    const noisy = new Vec3(
      truePos.x + rng.gaussian(this.rangeNoise * (0.4 + range / rMax)),
      truePos.y + rng.gaussian(this.rangeNoise * (0.4 + range / rMax)),
      truePos.z + rng.gaussian(this.rangeNoise * 0.6 * (0.4 + range / rMax)) + range * rng.gaussian(aN) * 0.3);
    const noisyVel = trueVel.add(new Vec3(rng.gaussian(6), rng.gaussian(6), rng.gaussian(3)));
    if (!this.track.init) { this.track.pos = noisy; this.track.vel = noisyVel; this.track.init = true; }
    else {
      const alpha = 0.35, beta = 0.12;
      const pred = this.track.pos.add(this.track.vel.scale(dt));
      const resid = noisy.sub(pred);
      this.track.pos = pred.add(resid.scale(alpha));
      this.track.vel = this.track.vel.add(resid.scale(beta / Math.max(dt, 1e-3)));
    }
  }
}
