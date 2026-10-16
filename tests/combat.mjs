import { Vec3 } from '../src/sim/math.ts';
import { runEngagement, Battle } from '../src/sim/simulation.ts';
import { INTERCEPTORS } from '../src/sim/config.ts';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.log(`FAIL ${name} ${extra}`); } }

function headon(extra = {}) {
  return {
    interceptorCfg: INTERCEPTORS.sam_long, law: 'apn', N: 4,
    targetInitPos: new Vec3(20000, 0, -6000), targetInitVel: new Vec3(-700, 0, 120),
    maneuver: 'constant', launchPos: new Vec3(0, 0, 0), launchDelay: 1,
    seed: 7, windSpeed: 3, windFrom: 270, radarRcs: 0.5, seekerNoise: 4, maxT: 60,
    ...extra
  };
}

// 1. залп из 2 — поражение, выпущено 2
const s2 = runEngagement(headon({ salvo: 2, salvoDt: 1.5 }));
ok('salvo-hit', s2.hit === true, `shots=${s2.shots} miss=${s2.missM.toFixed(1)}`);
ok('salvo-shots', s2.shots === 2, `shots=${s2.shots}`);
ok('salvo-tracks', s2.tracks.length === 2 && s2.tracks.every(t => t.length > 10), `tracks=${s2.tracks.map(t => t.length)}`);

// 2. уклонение включается и работает (флаг в логе), детерминизм
const evP = headon({ salvo: 1, evasion: { enabled: true, rangeM: 8000, g: 9, maxG: 12 } });
const e1 = runEngagement(evP);
const e2 = runEngagement(evP);
ok('evade-flag', e1.log.some(r => r.evade === 1), 'флаг уклонения ни разу не встал');
ok('evade-det', Math.abs(e1.missM - e2.missM) < 1e-6, `a=${e1.missM} b=${e2.missM}`);

// 3. уклонение в среднем снижает Pk (8 сидов, head-on)
let pkOff = 0, pkOn = 0;
for (let s = 1; s <= 8; s++) {
  const a = runEngagement(headon({ seed: s * 101, evasion: { enabled: false, rangeM: 0, g: 0, maxG: 0 } }));
  const b = runEngagement(headon({ seed: s * 101, evasion: { enabled: true, rangeM: 8000, g: 9, maxG: 12 } }));
  if (a.hit) pkOff++; if (b.hit) pkOn++;
}
ok('evade-hurts', pkOn <= pkOff, `off=${pkOff}/8 on=${pkOn}/8`);
console.log(`  (info) Pk без уклонения ${pkOff}/8, с уклонением ${pkOn}/8`);

// 4. дострел: одиночный + reshoot против weave — выпущено >= 1, бой завершается
const rs = runEngagement(headon({
  maneuver: 'weave', salvo: 1, reshoot: true, maxShots: 3,
  targetInitPos: new Vec3(22000, 0, -5500), targetInitVel: new Vec3(-650, 0, 0), seed: 21
}));
ok('reshoot-runs', rs.shots >= 1 && (rs.hit || rs.endReason.startsWith('MISS')), `shots=${rs.shots} reason=${rs.endReason}`);

// 5. две установки одновременно
const two = runEngagement(headon({
  salvo: 1,
  sites: [
    { pos: new Vec3(0, 0, 0), cfg: INTERCEPTORS.sam_long, delay: 1 },
    { pos: new Vec3(2600, 2100, 0), cfg: INTERCEPTORS.sam_mid, delay: 2 },
  ]
}));
ok('two-sites', two.shots === 2, `shots=${two.shots} hit=${two.hit}`);

// 6. живой бой с ручным пилотом: цель слушается рулей, бой завершается
// (у цели начальное снижение 120м/с — сначала гасим его набором, потом вираж)
const liveP = headon({ salvo: 1 });
const b = new Battle(liveP);
const alt0 = -b.tgt.pos.z;
for (let i = 0; i < 16000; i++) {
  b.tgt.manual = b.t < 3 ? { pitch: 1, yaw: 0 } : { pitch: 0.5, yaw: 1 };
  b.step();
  if (b.pollEnd()) break;
}
const alt1 = -b.tgt.pos.z;
ok('manual-climb', alt1 > alt0 + 50, `alt ${alt0.toFixed(0)} -> ${alt1.toFixed(0)}`);
ok('manual-turn', Math.abs(b.tgt.vel.y) > 20, `vy=${b.tgt.vel.y.toFixed(0)}`);
ok('manual-live', b.log.length > 20 && b.t > 2.5, `t=${b.t.toFixed(1)} rows=${b.log.length}`);
// полный живой бой до конца (пилот просто летит прямо)
const b2 = new Battle(headon({ salvo: 1, maxT: 60 }));
let end = null;
for (let i = 0; i < 200000; i++) { b2.step(); end = b2.pollEnd(); if (end) break; }
ok('manual-finish', end !== null, `end=${end} hit=${b2.hit} shots=${b2.shots}`);

// 7. Искандер (quasi 2100м/с + терминальные срывы): stock страдает честно,
// форсированная достаёт. Главное — без «шока»: финал чистый, без блужданий.
function iskRun(cfgKey, seed) {
  const tv = new Vec3(-0.83, 0, 0.55).normalized().scale(2100);
  return runEngagement({
    interceptorCfg: INTERCEPTORS[cfgKey], law: 'apn', N: 4,
    targetInitPos: new Vec3(70000, 0, -45000), targetInitVel: tv,
    maneuver: 'quasi', launchPos: new Vec3(0, 0, 0), launchDelay: 1,
    seed, windSpeed: 5, windFrom: 290, radarRcs: 0.2, seekerNoise: 6, maxT: 120,
    salvo: 2, salvoDt: 1.5, reshoot: true, maxShots: 6
  });
}
let pkStock = 0, pkHot = 0, sane = true;
for (let s = 1; s <= 8; s++) {
  const a = iskRun('sam_long', s * 911);
  const h = iskRun('sam_long_hot', s * 911);
  if (a.hit) pkStock++; if (h.hit) pkHot++;
  // вменяемость: причина из known-набора, промах конечен, без NaN
  for (const r of [a, h]) {
    if (!isFinite(r.missM) || r.missM > 1e8) sane = false;
    if (!['HIT', 'MISS-flyby', 'target-impact', 'interceptor-ground', 'time', 'no-detection'].includes(r.endReason)) sane = false;
  }
}
ok('isk-sane', sane, 'бой завершается вменяемо');
ok('isk-hot', pkHot >= 4, `форсированная Pk=${pkHot}/8 (stock=${pkStock}/8)`);
console.log(`  (info) Искандер: stock Pk=${pkStock}/8, hot Pk=${pkHot}/8`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
