// Автопилот перегрузки через угол атаки (альфа-контур):
// внешний PI держит alpha_req (эквивалент команды подъёмной силы),
// внутренний P по rate демпфирует, feedforward дожимает руль.
// Гравитация компенсируется СНАРУЖИ: в автопилот приходит уже подъёмная сила
// (a_total - g), поэтому горизонтальный полёт = +1g, а не баллистика.
import { clamp } from './math';
import { Vec3 } from './math';

export interface PlantFB { m: number; qS: number; cla: number; alS: number; beS: number; }

export class Autopilot {
  intY = 0; intZ = 0;
  cmdFinP = 0; cmdFinY = 0; cmdFinR = 0;
  maxG: number;
  constructor(maxG = 40) { this.maxG = maxG; }
  reset() { this.intY = 0; this.intZ = 0; this.cmdFinP = 0; this.cmdFinY = 0; }
  /**
   * @param ayCmd,azCmd команды перегрузки body (g), rollHold — удержание крыла
   * @param qbar динамическое давление, V воздушная скорость
   * @param omega body rates, dt шаг контура 0.002
   */
  update(ayLiftG: number, azLiftG: number, qbar: number, V: number, omega: { x: number; y: number; z: number }, dt: number, gBody: Vec3, plant: PlantFB) {
    // Крен удерживаем по вектору гравитации в body (без эйлеровых углов — без сингулярностей):
    // gb.y = 0 значит крыло горизонтально. Вертикальный полёт (|gb.z| мал) — gain мягче.
    const rollErr = Math.atan2(gBody.y, Math.abs(gBody.z) + 2.0);
    const finRhold = clamp(-(1.4 * rollErr + 0.30 * omega.x), -0.44, 0.44);
    if (qbar < 4000 || V < 40) { this.cmdFinP = 0; this.cmdFinY = 0; this.cmdFinR = finRhold; return this.out(); }
    const g0 = 9.80665;
    // Потребный угол атаки из команды ПОДЪЁМНОЙ силы (уже без гравитации):
    // Lift = qS*cla*alS = n*m*g  =>  alS_req = n*m*g/(qS*cla)
    const liftSlope = Math.max(1, plant.qS * plant.cla);
    const alReqZ = clamp(azLiftG * plant.m * g0 / liftSlope, -0.30, 0.30);
    const alReqY = clamp(ayLiftG * plant.m * g0 / liftSlope, -0.30, 0.30);
    // Внешний PI по углу атаки (рад): быстрая и честная обратная связь, без оценок через rates
    const kpA = 6.0, kiA = 7.0;
    const eY = alReqY - plant.beS, eZ = alReqZ - plant.alS;
    const satP = Math.abs(this.cmdFinP) > 0.43, satY = Math.abs(this.cmdFinY) > 0.43;
    if (!(satY && Math.sign(eY) === Math.sign(this.cmdFinY))) this.intY = clamp(this.intY + eY * dt, -0.5, 0.5);
    if (!(satP && Math.sign(eZ) === Math.sign(this.cmdFinP))) this.intZ = clamp(this.intZ + eZ * dt, -0.5, 0.5);
    const qMax = (this.maxG * g0) / Math.max(V, 50);
    const qzCmd = clamp(kpA * eY + kiA * this.intY, -qMax, qMax);
    const qyCmd = clamp(kpA * eZ + kiA * this.intZ, -qMax, qMax);
    // Внутренний контур: feedforward (статика) + P по rate (демпфирование)
    const CMd = 2.5, cmaMag = 4.0; // должны совпадать с vehicle.ts
    const ffP = (cmaMag * alReqZ) / CMd, ffY = (cmaMag * alReqY) / CMd;
    const qRef = 30000;
    const kRate = clamp(qRef / Math.max(qbar, 4000), 0.35, 4.0) * 0.55;
    const finY = clamp(ffY + kRate * (qzCmd - omega.z), -0.44, 0.44);
    const finP = clamp(ffP + kRate * (qyCmd - omega.y), -0.44, 0.44);
    this.cmdFinP = finP; this.cmdFinY = finY; this.cmdFinR = finRhold;
    return this.out();
  }
  out() { return { finP: this.cmdFinP, finY: this.cmdFinY, finR: this.cmdFinR }; }
}
