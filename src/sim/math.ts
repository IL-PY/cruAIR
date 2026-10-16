// Базовая математика: Vec3, Quat, интерполяция, ГСЧ. Без зависимостей.
export class Vec3 {
  x: number; y: number; z: number;
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this; }
  add(v: Vec3) { return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z); }
  sub(v: Vec3) { return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z); }
  scale(s: number) { return new Vec3(this.x * s, this.y * s, this.z * s); }
  dot(v: Vec3) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  cross(v: Vec3) { return new Vec3(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x); }
  norm() { return Math.hypot(this.x, this.y, this.z); }
  normalized() { const n = this.norm() || 1; return this.scale(1 / n); }
  static lerp(a: Vec3, b: Vec3, t: number) { return a.scale(1 - t).add(b.scale(t)); }
}

export class Quat {
  w: number; x: number; y: number; z: number;
  constructor(w = 1, x = 0, y = 0, z = 0) { this.w = w; this.x = x; this.y = y; this.z = z; }
  clone() { return new Quat(this.w, this.x, this.y, this.z); }
  normalized() { const n = Math.hypot(this.w, this.x, this.y, this.z) || 1; return new Quat(this.w / n, this.x / n, this.y / n, this.z / n); }
  // Кинематика attitude-кватерниона (активный, body->NED):
  // q_dot = 0.5 * [0,omega_body] ⊗ q. Проверено покадрово (dbg19/20):
  // +wx = крен вправо, +wy = нос вверх, +wz = нос вправо.
  derivative(omega: Vec3): Quat {
    const { w, x, y, z } = this; const wx = omega.x, wy = omega.y, wz = omega.z;
    return new Quat(
      0.5 * (-wx * x - wy * y - wz * z),
      0.5 * (wx * w + wy * z - wz * y),
      0.5 * (wy * w + wz * x - wx * z),
      0.5 * (wz * w + wx * y - wy * x));
  }
  add(q: Quat) { return new Quat(this.w + q.w, this.x + q.x, this.y + q.y, this.z + q.z); }
  scale(s: number) { return new Quat(this.w * s, this.x * s, this.y * s, this.z * s); }
  conjugate() { return new Quat(this.w, -this.x, -this.y, -this.z); }
  rotate(v: Vec3): Vec3 {
    // v' = q * v * q*
    const qv = new Quat(0, v.x, v.y, v.z);
    const r = this.mul(qv).mul(this.conjugate());
    return new Vec3(r.x, r.y, r.z);
  }
  mul(q: Quat): Quat {
    return new Quat(
      this.w * q.w - this.x * q.x - this.y * q.y - this.z * q.z,
      this.w * q.x + this.x * q.w + this.y * q.z - this.z * q.y,
      this.w * q.y - this.x * q.z + this.y * q.w + this.z * q.x,
      this.w * q.z + this.x * q.y - this.y * q.x + this.z * q.w);
  }
  static fromXTo(dir: Vec3): Quat {
    // активное вращение, переводящее +X в dir (оба в одной системе)
    const d = dir.normalized();
    const dot = clamp(1 * d.x, -1, 1);
    if (dot > 0.99999) return new Quat();
    if (dot < -0.99999) return new Quat(0, 0, 1, 0); // разворот на 180 через Y
    const ax = new Vec3(0 * d.z - 0 * d.y, 0 * d.x - 1 * d.z, 1 * d.y - 0 * d.x).normalized(); // X × d
    const half = Math.acos(dot) / 2, s = Math.sin(half);
    return new Quat(Math.cos(half), ax.x * s, ax.y * s, ax.z * s).normalized();
  }
  static fromEuler(roll: number, pitch: number, yaw: number): Quat {
    const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
    const cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
    const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2);
    return new Quat(cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy).normalized();
  }
  toEuler(): { roll: number; pitch: number; yaw: number } {
    const { w, x, y, z } = this.normalized();
    const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    return { roll, pitch, yaw };
  }
}

// Линейная интерполяция таблицы [x[], y[]] с клампом
export function tableLookup(xs: number[], ys: number[], x: number): number {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  for (let i = 0; i < xs.length - 1; i++) {
    if (x >= xs[i] && x <= xs[i + 1]) {
      const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] * (1 - t) + ys[i + 1] * t;
    }
  }
  return ys[ys.length - 1];
}

// Двумерная таблица Cd(Mach, alphaDeg) — билинейная
export function table2Lookup(machs: number[], alphas: number[], table: number[][], mach: number, alpha: number): number {
  const mi = clampIndex(machs, mach), ai = clampIndex(alphas, alpha);
  const m0 = machs[mi], m1 = machs[Math.min(mi + 1, machs.length - 1)];
  const a0 = alphas[ai], a1 = alphas[Math.min(ai + 1, alphas.length - 1)];
  const tm = m1 > m0 ? (mach - m0) / (m1 - m0) : 0, ta = a1 > a0 ? (alpha - a0) / (a1 - a0) : 0;
  const i1 = Math.min(mi + 1, machs.length - 1), j1 = Math.min(ai + 1, alphas.length - 1);
  const v00 = table[mi][ai], v10 = table[i1][ai], v01 = table[mi][j1], v11 = table[i1][j1];
  return v00 * (1 - tm) * (1 - ta) + v10 * tm * (1 - ta) + v01 * (1 - tm) * ta + v11 * tm * ta;
}
function clampIndex(xs: number[], x: number): number {
  if (x <= xs[0]) return 0;
  for (let i = 0; i < xs.length - 1; i++) if (x < xs[i + 1]) return i;
  return xs.length - 2;
}

// Детерминированный ГСЧ (mulberry32) + гауссиан Бокса-Мюллера
export class RNG {
  private s: number;
  constructor(seed = 1) { this.s = seed >>> 0 || 1; }
  uniform() { this.s |= 0; this.s = (this.s + 0x6D2B79F5) | 0; let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  gaussian(sigma = 1) { const u1 = Math.max(1e-9, this.uniform()), u2 = this.uniform(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * sigma; }
}

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const deg2rad = (d: number) => d * Math.PI / 180;
export const rad2deg = (r: number) => r * 180 / Math.PI;
