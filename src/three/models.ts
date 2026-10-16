// Процедурные PBR-модели (НЕ кубики): ТПК/ПУ, РЛС с антенной, ЗУР и цель.
// Всё из цилиндров/конусов/сфер с реальными пропорциями + камуфляж.
import * as THREE from 'three';

function mat(color: number, rough = 0.6, metal = 0.25) {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
}
const CAMO = mat(0x4a5d3a, 0.75, 0.15);
const DARK = mat(0x23282c, 0.6, 0.4);
const WHITE = mat(0xd8dde2, 0.45, 0.2);
const RED = mat(0x8a2f2a, 0.55, 0.3);

export function buildLauncherSite(): THREE.Group {
  const g = new THREE.Group();
  // бетонка
  const pad = new THREE.Mesh(new THREE.CylinderGeometry(60, 60, 2, 40), mat(0x55565a, 0.9, 0.05));
  pad.position.y = 1; pad.receiveShadow = true; g.add(pad);
  // 4 ПУ: шасси (корпус со скосами через цилиндр+бокс со фаской выглядит норм) + ТПК-труба под углом
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.4;
    const px = Math.cos(a) * 32, pz = Math.sin(a) * 32;
    const tel = new THREE.Group();
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(9, 1.6, 2.8), CAMO); chassis.position.y = 1.6; chassis.castShadow = true; tel.add(chassis);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.8, 2.7), mat(0x55663f, 0.7, 0.2)); cab.position.set(3.4, 2.6, 0); cab.castShadow = true; tel.add(cab);
    for (let w = 0; w < 4; w++) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.6, 18), DARK);
      wheel.rotation.x = Math.PI / 2; wheel.position.set(-2.8 + w * 2.0, 0.75, 1.35); tel.add(wheel);
      const w2 = wheel.clone(); w2.position.z = -1.35; tel.add(w2);
    }
    const tube = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 8.6, 20), mat(0x5c6b4a, 0.65, 0.3));
    tube.position.set(-0.4, 4.2, 0); tube.rotation.z = Math.PI / 2 - 1.05; tube.castShadow = true; tel.add(tube);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(1.06, 1.06, 0.3, 20), DARK); cap.position.set(-0.4 + Math.cos(1.05) * 4.3, 4.2 + Math.sin(1.05) * 4.3, 0); cap.rotation.z = Math.PI / 2 - 1.05; tel.add(cap);
    tel.position.set(px, 1, pz); tel.rotation.y = -a + Math.PI / 2;
    g.add(tel);
  }
  // мачта связи + “купол” КП
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.4, 18, 10), DARK); mast.position.set(-14, 9, 10); g.add(mast);
  const cp = new THREE.Mesh(new THREE.SphereGeometry(3, 18, 14, 0, Math.PI * 2, 0, Math.PI / 2), WHITE); cp.position.set(12, 1, -12); cp.castShadow = true; g.add(cp);
  return g;
}

export function buildRadar(): { group: THREE.Group; dish: THREE.Group } {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 3, 18), CAMO); base.position.y = 1.5; base.castShadow = true; g.add(base);
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.6, 7, 14), mat(0x6b7a5a, 0.7, 0.2)); tower.position.y = 6; tower.castShadow = true; g.add(tower);
  const dish = new THREE.Group();
  const panel = new THREE.Mesh(new THREE.BoxGeometry(7.5, 4.6, 0.5), mat(0x9aa3ab, 0.4, 0.6)); panel.castShadow = true; dish.add(panel);
  // излучатели
  for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) {
    const el = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.7, 8), RED);
    el.rotation.x = Math.PI / 2; el.position.set(-3 + i * 1.2, -1.4 + j * 1.4, 0.5); dish.add(el);
  }
  dish.position.y = 10.4; dish.rotation.x = -0.25;
  g.add(dish);
  const dome2 = new THREE.Mesh(new THREE.SphereGeometry(1.4, 14, 10), WHITE); dome2.position.set(6, 1.2, 4); g.add(dome2);
  return { group: g, dish };
}

export function buildMissile(bodyColor: number, len: number, dia: number, fins = 4): THREE.Group {
  const g = new THREE.Group();
  const bm = mat(bodyColor, 0.35, 0.65);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(dia / 2, dia / 2, len * 0.78, 20), bm);
  body.rotation.z = Math.PI / 2; body.castShadow = true; g.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(dia / 2, len * 0.22, 20), mat(0x2b2f33, 0.3, 0.7));
  nose.rotation.z = -Math.PI / 2; nose.position.x = len * 0.5; nose.castShadow = true; g.add(nose);
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(dia * 0.32, dia * 0.42, 0.8, 14), DARK);
  nozzle.rotation.z = Math.PI / 2; nozzle.position.x = -len * 0.42; g.add(nozzle);
  // пламя (конус additive, масштабируется тягой)
  const flame = new THREE.Mesh(new THREE.ConeGeometry(dia * 0.42, 4.5, 12),
    new THREE.MeshBasicMaterial({ color: 0xffb545, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  flame.rotation.z = Math.PI / 2; flame.position.x = -len * 0.42 - 2.4; flame.name = 'flame'; g.add(flame);
  const glow = new THREE.PointLight(0xff9a3c, 0, 120); glow.position.x = -len * 0.4; glow.name = 'glow'; g.add(glow);
  // рули
  for (let i = 0; i < fins; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.08, 1.3), mat(0x39424a, 0.5, 0.5));
    const a = (i / fins) * Math.PI * 2;
    fin.position.set(-len * 0.32, Math.cos(a) * (dia / 2 + 0.6), Math.sin(a) * (dia / 2 + 0.6));
    fin.rotation.x = -a; g.add(fin);
  }
  // полосы маркировки
  const band = new THREE.Mesh(new THREE.CylinderGeometry(dia / 2 + 0.01, dia / 2 + 0.01, 0.4, 20), RED);
  band.rotation.z = Math.PI / 2; band.position.x = len * 0.28; g.add(band);
  // ориентация: +X вперёд (как в физике body X)
  return g;
}
