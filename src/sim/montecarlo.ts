// Monte-Carlo + CSV логгер
import { runEngagement, EngageParams } from './simulation';

export interface MCStats { n: number; hits: number; pk: number; missMean: number; missP50: number; missP90: number; misses: number[]; reasons: Record<string, number>; }

export function runMonteCarlo(base: EngageParams, n: number, onProgress?: (done: number) => void): MCStats {
  const misses: number[] = []; const reasons: Record<string, number> = {}; let hits = 0;
  for (let k = 0; k < n; k++) {
    const p: EngageParams = {
      ...base, seed: base.seed * 100003 + k * 7919,
      windSpeed: Math.max(0, base.windSpeed + ((k * 37) % 7 - 3)),
      seekerNoise: base.seekerNoise * (0.8 + ((k * 13) % 10) / 25),
      radarRcs: base.radarRcs * (0.85 + ((k * 29) % 10) / 33),
    };
    // лёгкий разброс начальных условий (±150м, ±15м/с)
    const j = (m: number) => ((k * 7919 + m * 131) % 100) / 100 - 0.5;
    p.targetInitPos = base.targetInitPos.clone().add({ x: j(1) * 300, y: j(2) * 300, z: j(3) * 120 } as never);
    const r = runEngagement(p);
    misses.push(r.missM); if (r.hit) hits++;
    reasons[r.endReason] = (reasons[r.endReason] || 0) + 1;
    if (onProgress && k % 20 === 0) onProgress(k);
  }
  misses.sort((a, b) => a - b);
  const mean = misses.reduce((s, v) => s + v, 0) / Math.max(1, misses.length);
  return { n, hits, pk: hits / n, missMean: mean, missP50: misses[Math.floor(misses.length * 0.5)] ?? 0, missP90: misses[Math.floor(misses.length * 0.9)] ?? 0, misses, reasons };
}

export function toCSV(log: { t: number; mpos: { x: number; y: number; z: number }; mvel: { x: number; y: number; z: number }; tpos: { x: number; y: number; z: number }; range: number; vc: number; losRate: number; qbar: number; mach: number; g: number }[]): string {
  const h = 't,mx,my,mz,mvx,mvy,mvz,tx,ty,tz,range,vc,losRate,qbar,mach,g';
  const rows = log.map(r => [r.t.toFixed(3), r.mpos.x.toFixed(1), r.mpos.y.toFixed(1), r.mpos.z.toFixed(1), r.mvel.x.toFixed(1), r.mvel.y.toFixed(1), r.mvel.z.toFixed(1), r.tpos.x.toFixed(1), r.tpos.y.toFixed(1), r.tpos.z.toFixed(1), r.range.toFixed(1), r.vc.toFixed(1), r.losRate.toFixed(4), r.qbar.toFixed(0), r.mach.toFixed(2), r.g.toFixed(1)].join(','));
  return h + '\n' + rows.join('\n');
}
