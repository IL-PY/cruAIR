import { Quat, Vec3, RNG, tableLookup } from '../src/sim/math.ts';
import { isaDensity, gravityWGS84 } from '../src/sim/atmosphere.ts';
import { runEngagement } from '../src/sim/simulation.ts';
import { INTERCEPTORS, TARGETS } from '../src/sim/config.ts';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } }

// 1. кватернион round-trip
const q = Quat.fromEuler(0.3, -0.2, 1.1).normalized();
const e = q.toEuler();
const q2 = Quat.fromEuler(e.roll, e.pitch, e.yaw);
ok('quat-roundtrip', Math.abs(q.w - q2.w) < 1e-6 && Math.abs(q.x - q2.x) < 1e-6);
// 2. норма вектора
ok('vec-norm', Math.abs(new Vec3(3, 4, 0).norm() - 5) < 1e-9);
// 3. атмосфера на 0м
const s0 = isaDensity(0);
ok('isa-sea', Math.abs(s0.rho - 1.225) < 0.01 && Math.abs(s0.a - 340.3) < 0.5, JSON.stringify(s0));
// 4. на 11км
const s11 = isaDensity(11000);
ok('isa-11k', Math.abs(s11.T - 216.65) < 0.5 && s11.rho < 0.4);
// 5. гравитация
ok('gravity', gravityWGS84(0, 55) > 9.8 && gravityWGS84(0, 55) < 9.85);
// 6. таблицы
ok('table', tableLookup([0, 1], [10, 20], 0.5) === 15);
// 7. детерминизм RNG
const a = new RNG(7), b = new RNG(7);
ok('rng-det', a.uniform() === b.uniform());
// 8. перехват head-on должен быть HIT (близкая дистанция, без манёвра)
const r = runEngagement({
  interceptorCfg: INTERCEPTORS.sam_long, law: 'apn', N: 4,
  targetInitPos: new Vec3(20000, 0, -6000), targetInitVel: new Vec3(-700, 0, 120),
  maneuver: 'constant', launchPos: new Vec3(0, 0, 0), launchDelay: 1,
  seed: 7, windSpeed: 3, windFrom: 270, radarRcs: 0.5, seekerNoise: 4, maxT: 60
});
ok('intercept-headon', r.hit === true, `miss=${r.missM.toFixed(1)} reason=${r.endReason}`);
// 9. детерминизм симуляции
const r2 = runEngagement({
  interceptorCfg: INTERCEPTORS.sam_long, law: 'apn', N: 4,
  targetInitPos: new Vec3(20000, 0, -6000), targetInitVel: new Vec3(-700, 0, 120),
  maneuver: 'constant', launchPos: new Vec3(0, 0, 0), launchDelay: 1,
  seed: 7, windSpeed: 3, windFrom: 270, radarRcs: 0.5, seekerNoise: 4, maxT: 60
});
ok('sim-det', Math.abs(r.missM - r2.missM) < 1e-6);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
