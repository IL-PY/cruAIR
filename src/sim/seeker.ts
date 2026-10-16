// ГСН: абстрактная, но честная — шум + лаг + лимит подвеса. Не видит truth напрямую.
import { Vec3 } from './math';
import { RNG } from './math';

export class Seeker {
  measPos = new Vec3(); measVel = new Vec3(); measAcc = new Vec3();
  init = false;
  posNoise: number; velNoise: number; lag: number; gimbalDeg: number;
  constructor(posNoise = 6, velNoise = 4, lag = 0.12, gimbalDeg = 60) { this.posNoise = posNoise; this.velNoise = velNoise; this.lag = lag; this.gimbalDeg = gimbalDeg; }
  update(truePos: Vec3, trueVel: Vec3, trueAcc: Vec3, mPos: Vec3, dt: number, rng: RNG) {
    const rel = truePos.sub(mPos);
    const range = rel.norm();
    // Адаптивная полоса: далеко — сглаживаем шум (0.12с), в финале (<3км) — почти
    // сырые замеры (0.025с): иначе лаг × скорость сближения = сотни метров систематики.
    const lagEff = range > 3000 ? this.lag : 0.025;
    const k = 1 - Math.exp(-dt / Math.max(1e-3, lagEff));
    const np = new Vec3(rng.gaussian(this.posNoise), rng.gaussian(this.posNoise), rng.gaussian(this.posNoise));
    const nv = new Vec3(rng.gaussian(this.velNoise), rng.gaussian(this.velNoise), rng.gaussian(this.velNoise * 0.5));
    if (!this.init) { this.measPos = truePos.add(np); this.measVel = trueVel.add(nv); this.measAcc = trueAcc.clone(); this.init = true; }
    else {
      this.measPos = this.measPos.scale(1 - k).add(truePos.add(np).scale(k));
      this.measVel = this.measVel.scale(1 - k).add(trueVel.add(nv).scale(k));
      this.measAcc = this.measAcc.scale(1 - k).add(trueAcc.scale(k));
    }
    // компенсация лага: экстраполяция замера на время задержки (стандартный приём ГСН)
    this.measPos = this.measPos.add(this.measVel.scale(lagEff));
  }
}
