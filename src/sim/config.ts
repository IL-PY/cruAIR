// Заявленные ТТХ (нотиональные, условные — подставляются из паспорта изделия).
// Структура позволяет проверять ЛЮБУЮ ракету: меняешь таблицы — проверяешь перехват.
export interface ThrustPoint { t: number; T: number }
export interface AeroTables {
  machs: number[]; alphas: number[];
  CD: number[][];      // лобовое
  CLalpha: number[];   // dCL/dalpha по Маху (на рад)
  CMalpha: number[];   // стат. устойчивость (отриц. = устойчив)
}
export interface VehicleConfig {
  name: string;
  m0: number; mProp: number; Isp: number;
  Sref: number; Lref: number;
  thrust: ThrustPoint[];
  aero: AeroTables;
  maxFinDeg: number; maxFinRateDeg: number;
  maxG: number;
  warheadRadius: number; // радиус поражения ОФ БЧ, м
  maxMach: number;
}

function cdGeneric(): AeroTables {
  const machs = [0.3, 0.8, 1.0, 1.2, 2.0, 3.0, 4.5, 6.0];
  const alphas = [0, 5, 10, 15, 20];
  // рост Cx на трансзвуке + индуктивное от alpha (стройный корпус с boat-tail)
  const base = [0.27, 0.29, 0.44, 0.40, 0.30, 0.25, 0.22, 0.20];
  const CD = machs.map(m => alphas.map(a => {
    const i = 0.012 * a * a / 100 * (1 + 0.3 * m);
    return base[machs.indexOf(m)] + i;
  }));
  return {
    machs, alphas, CD,
    CLalpha: [13.5, 14.5, 11.0, 10.0, 9.0, 8.0, 7.2, 6.8],
    CMalpha: [-6.5, -7.0, -4.5, -4.0, -3.6, -3.2, -3.0, -2.8]
  };
}

export const INTERCEPTORS: Record<string, VehicleConfig> = {
  sam_long: {
    name: 'ЗУР дальняя', m0: 1350, mProp: 640, Isp: 265, Sref: 0.42, Lref: 6.8,
    thrust: [{ t: 0, T: 148000 }, { t: 1.2, T: 152000 }, { t: 7.5, T: 140000 }, { t: 8.2, T: 34000 }, { t: 16, T: 30000 }, { t: 16.5, T: 0 }],
    aero: cdGeneric(), maxFinDeg: 25, maxFinRateDeg: 600, maxG: 55, warheadRadius: 12, maxMach: 6
  },
  sam_mid: {
    name: 'ЗУР средняя', m0: 620, mProp: 280, Isp: 255, Sref: 0.24, Lref: 4.6,
    thrust: [{ t: 0, T: 68000 }, { t: 0.8, T: 70000 }, { t: 5.2, T: 62000 }, { t: 5.8, T: 0 }],
    aero: cdGeneric(), maxFinDeg: 28, maxFinRateDeg: 700, maxG: 35, warheadRadius: 10, maxMach: 4.5
  },
  sam_long_hot: {
    name: 'ЗУР дальняя+ (форсированная)', m0: 1470, mProp: 760, Isp: 290, Sref: 0.42, Lref: 6.8,
    thrust: [{ t: 0, T: 165000 }, { t: 1.2, T: 170000 }, { t: 7.5, T: 155000 }, { t: 8.2, T: 38000 }, { t: 17, T: 34000 }, { t: 17.5, T: 0 }],
    aero: cdGeneric(), maxFinDeg: 25, maxFinRateDeg: 600, maxG: 55, warheadRadius: 14, maxMach: 6.5
  },
  sam_short: {
    name: 'ЗУР ближняя', m0: 170, mProp: 72, Isp: 250, Sref: 0.09, Lref: 2.9,
    thrust: [{ t: 0, T: 24000 }, { t: 0.4, T: 25000 }, { t: 2.6, T: 22000 }, { t: 3.0, T: 0 }],
    aero: cdGeneric(), maxFinDeg: 30, maxFinRateDeg: 900, maxG: 22, warheadRadius: 8, maxMach: 3.2
  }
};

// Установки ПВО на местности (NED, метры от центра сцены).
// Разные позиции + разные ракеты = разная тактика.
export interface SamSite { id: string; name: string; interceptor: string; pos: { x: number; y: number }; scale: number; }
export const SITES: SamSite[] = [
  { id: 'north', name: 'Север — дальняя', interceptor: 'sam_long', pos: { x: 0, y: 0 }, scale: 1.0 },
  { id: 'north_hot', name: 'Север-2 — дальняя+ (форс.)', interceptor: 'sam_long_hot', pos: { x: 900, y: -700 }, scale: 1.0 },
  { id: 'hill', name: 'Холм — средняя', interceptor: 'sam_mid', pos: { x: 2600, y: 2100 }, scale: 0.85 },
  { id: 'point', name: 'Объект — ближняя', interceptor: 'sam_short', pos: { x: -1700, y: -1400 }, scale: 0.7 },
];

export const TARGETS: Record<string, VehicleConfig & { kind: string }> = {
  ballistic: {
    name: 'SRBM (баллистика)', kind: 'ballistic', m0: 3200, mProp: 2100, Isp: 250, Sref: 0.8, Lref: 9.5,
    thrust: [{ t: 0, T: 260000 }, { t: 42, T: 250000 }, { t: 44, T: 0 }],
    aero: cdGeneric(), maxFinDeg: 12, maxFinRateDeg: 200, maxG: 8, warheadRadius: 0, maxMach: 7
  },
  cruise: {
    name: 'Крылатая дозвуковая', kind: 'cruise', m0: 1300, mProp: 400, Isp: 3000 /*ВРД эфф.*/, Sref: 0.5, Lref: 6.0,
    thrust: [{ t: 0, T: 6500 }, { t: 900, T: 6500 }],
    aero: cdGeneric(), maxFinDeg: 20, maxFinRateDeg: 300, maxG: 9, warheadRadius: 0, maxMach: 0.9
  },
  weave: {
    name: 'Маневрирующая weave 7g', kind: 'weave', m0: 1100, mProp: 480, Isp: 270, Sref: 0.35, Lref: 5.4,
    thrust: [{ t: 0, T: 90000 }, { t: 6, T: 82000 }, { t: 6.5, T: 0 }],
    aero: cdGeneric(), maxFinDeg: 25, maxFinRateDeg: 600, maxG: 22, warheadRadius: 0, maxMach: 4
  },
  turn: {
    name: 'Отворот 9g', kind: 'turn', m0: 1100, mProp: 480, Isp: 270, Sref: 0.35, Lref: 5.4,
    thrust: [{ t: 0, T: 90000 }, { t: 6, T: 82000 }, { t: 6.5, T: 0 }],
    aero: cdGeneric(), maxFinDeg: 25, maxFinRateDeg: 600, maxG: 22, warheadRadius: 0, maxMach: 4
  },
  iskander: {
    name: 'Искандер (квазибаллистика)', kind: 'quasi', m0: 3800, mProp: 0, Isp: 250, Sref: 0.6, Lref: 7.3,
    thrust: [{ t: 0, T: 0 }],
    aero: cdGeneric(), maxFinDeg: 20, maxFinRateDeg: 500, maxG: 30, warheadRadius: 0, maxMach: 7
  }
};
