// Атмосфера ISA-1976 (до 32 км, выше — экспоненциальная), гравитация WGS84, ветер.
import { Vec3 } from './math';

export interface AtmoSample { rho: number; p: number; T: number; a: number; g: number; qbar: number; mach: number; }

// Табличные точки ISA для кусочно-линейной температуры
const H = [0, 11000, 20000, 32000];
const T0 = 288.15, P0 = 101325, R = 287.05, GAMMA = 1.4;

export function isaDensity(altM: number): { rho: number; p: number; T: number; a: number } {
  const h = Math.max(0, Math.min(80000, altM));
  let T: number, p: number;
  if (h <= 11000) { T = T0 - 0.0065 * h; p = P0 * Math.pow(T / T0, 9.80665 / (0.0065 * R)); }
  else if (h <= 20000) { T = 216.65; const p11 = P0 * Math.pow(216.65 / T0, 9.80665 / (0.0065 * R)); p = p11 * Math.exp(-9.80665 * (h - 11000) / (R * T)); }
  else { T = 216.65 + 0.001 * (h - 20000); const p20 = 5474.9; p = p20 * Math.pow(T / 216.65, -9.80665 / (0.001 * R)); }
  const rho = p / (R * T);
  const a = Math.sqrt(GAMMA * R * T);
  return { rho, p, T, a };
}

// g(h, lat) по WGS84 (упрощённо Сомильяна + высота)
export function gravityWGS84(altM: number, latDeg = 55): number {
  const lat = latDeg * Math.PI / 180;
  const g0 = 9.780327 * (1 + 0.0053024 * Math.sin(lat) ** 2 - 0.0000058 * Math.sin(2 * lat) ** 2);
  return g0 * (6378137 / (6378137 + altM)) ** 2;
}

export function sampleAtmo(posNED: Vec3, velNED: Vec3, windNED: Vec3, latDeg = 55): AtmoSample {
  const alt = Math.max(0, -posNED.z);
  const { rho, p, T, a } = isaDensity(alt);
  const vAir = velNED.sub(windNED);
  const V = vAir.norm();
  const qbar = 0.5 * rho * V * V;
  return { rho, p, T, a, g: gravityWGS84(alt, latDeg), qbar, mach: V / a };
}

// Профиль ветра: постоянный + турбулентность Dryden-упрощённо (белый шум через НЧ)
export class WindField {
  base = new Vec3(0, 0, 0);
  gust = new Vec3(0, 0, 0);
  setBase(speed: number, fromDeg: number) {
    const a = fromDeg * Math.PI / 180;
    // NED: x-север, y-восток. Ветер "откуда" -> вектор "куда"
    this.base = new Vec3(-Math.cos(a) * speed, -Math.sin(a) * speed, 0);
  }
  step(dt: number, intensity: number, rnd: () => number) {
    const k = Math.exp(-dt / 2.5);
    this.gust = this.gust.scale(k).add(new Vec3(rnd(), rnd(), rnd() * 0.3).scale(intensity * (1 - k) * 8));
  }
  total() { return this.base.add(this.gust); }
}

export { H };
