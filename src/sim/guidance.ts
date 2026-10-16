// Законы наведения: PN / APN / pursuit + loft. Работают в NED по измеренному состоянию.
import { Vec3, clamp } from './math';

export type Law = 'pn' | 'apn' | 'pursuit';

export interface GuideOut { ay: number; az: number; losRate: number; closingVc: number; range: number; tgo: number; }

export function guide(law: Law, N: number, mPos: Vec3, mVel: Vec3, tPos: Vec3, tVel: Vec3, tAccEst: Vec3): GuideOut {
  const rel = tPos.sub(mPos);
  const range = Math.max(1, rel.norm());
  const los = rel.scale(1 / range);
  const relV = tVel.sub(mVel);
  const vc = -relV.dot(los); // скорость сближения
  const tgo = vc > 1 ? range / vc : 5;
  // LOS rate: omega = (rel x relV)/r^2
  const omega = rel.cross(relV).scale(1 / (range * range));
  const losRate = omega.norm();
  let aCmd = new Vec3();
  if (law === 'pursuit') {
    aCmd = tPos.sub(mPos).normalized().scale(25 * 9.81);
  } else {
    // PN: a = N * Vc * (omega x Vm)/|Vm| ... классика: N*Vc*losRate перпендикулярно LOS
    const vm = Math.max(50, mVel.norm());
    const dir = omega.cross(mVel).normalized();
    let mag = N * Math.max(0, vc) * losRate;
    aCmd = dir.scale(isFinite(mag) ? mag : 0);
    if (law === 'apn') {
      // APN: + N/2 * aT_perp
      const aTp = tAccEst.sub(los.scale(tAccEst.dot(los)));
      aCmd = aCmd.add(aTp.scale(N / 2));
    }
  }
  // Перевод команды из NED в "перегрузки body" грубо: раскладываем на Y/Z через ориентацию позже.
  // Здесь возвращаем вектор ускорения NED; снаружи проецируем на body.
  void ay_az(aCmd);
  return { ay: 0, az: 0, losRate, closingVc: vc, range, tgo };
}

// Вспомогательно: проекция NED-команды на body-перегрузки
export function nedToBodyG(aNed: Vec3, qConjRotate: (v: Vec3) => Vec3): { ay: number; az: number } {
  const ab = qConjRotate(aNed); // NED -> body
  const g0 = 9.80665;
  // body X — продольная (тяга), управляем Y (рыскание) и Z (тангаж)
  return { ay: clamp(ab.y / g0, -60, 60), az: clamp(-ab.z / g0, -60, 60) };
}

// Прямой расчёт команды (чтобы не таскать лишнее): возвращает NED-вектор
export function guideVec(law: Law, N: number, mPos: Vec3, mVel: Vec3, tPos: Vec3, tVel: Vec3, tAccEst: Vec3): { aNed: Vec3; losRate: number; vc: number; range: number; tgo: number } {
  const rel = tPos.sub(mPos);
  const range = Math.max(1, rel.norm());
  const los = rel.scale(1 / range);
  const relV = tVel.sub(mVel);
  const vc = -relV.dot(los);
  const tgo = vc > 1 ? range / vc : 5;
  const omega = rel.cross(relV).scale(1 / (range * range));
  const losRate = omega.norm();
  let aNed: Vec3;
  if (law === 'pursuit') aNed = los.scale(25 * 9.81);
  else {
    const dir = omega.cross(mVel);
    const dn = dir.norm();
    const mag = N * Math.max(0, vc) * losRate;
    aNed = dn > 1e-6 ? dir.scale(mag / dn) : new Vec3();
    if (law === 'apn') aNed = aNed.add(tAccEst.sub(los.scale(tAccEst.dot(los))).scale(N / 2));
  }
  // Ограничение располагаемой перегрузки — снаружи по конфигу
  return { aNed, losRate, vc, range, tgo };
}

function ay_az(_a: Vec3) { return _a; }
