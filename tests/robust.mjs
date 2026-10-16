import { Vec3 } from '../src/sim/math.ts';
import { runEngagement } from '../src/sim/simulation.ts';
import { INTERCEPTORS } from '../src/sim/config.ts';

const cases = [
  { man: 'constant', tv: [-700, 0, 0], alt: 6000, r: 20000, label: 'head-on level' },
  { man: 'weave', tv: [-650, 0, 0], alt: 5500, r: 22000, label: 'weave 7g' },
  { man: 'turn', tv: [-650, 0, 0], alt: 5500, r: 22000, label: 'turn 9g (ontime)', onset: 11 },
  { man: 'constant', tv: [-250, 0, 0], alt: 100, r: 15000, label: 'cruise low' },
];
for (const c of cases) {
  let hits = 0; const ms = [];
  for (let s = 1; s <= 8; s++) {
    const r = runEngagement({
      interceptorCfg: INTERCEPTORS.sam_long, law: 'apn', N: 4,
      targetInitPos: new Vec3(c.r, 0, -c.alt), targetInitVel: new Vec3(...c.tv),
      maneuver: c.man, launchPos: new Vec3(0, 0, 0), launchDelay: 1,
      seed: s * 101, windSpeed: 5, windFrom: 290, radarRcs: 0.3, seekerNoise: 6, maxT: 90,
      turnOnsetS: c.onset
    });
    if (r.hit) hits++;
    ms.push(r.missM);
  }
  ms.sort((a, b) => a - b);
  console.log(`${c.label}: Pk=${hits}/8 med=${ms[4].toFixed(1)}m max=${ms[7].toFixed(0)}m`);
}
