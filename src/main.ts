// cruAIR: связь физики 6DOF + 3D + UI. Перехват считается мгновенно (предвычисление),
// затем проигрывается как кинематографичная сцена 1x. Лагов нет: физика отделена от рендера.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Vec3 } from './sim/math';
import { INTERCEPTORS, TARGETS, SITES } from './sim/config';
import { runEngagement, Battle, EngageParams, EngageResult, TrackPoint } from './sim/simulation';
import { toCSV } from './sim/montecarlo';
import { makeTerrain, makeSky, makeClouds, nedToThree, groundH, makeMarker } from './three/scene';
import { buildLauncherSite, buildRadar, buildMissile } from './three/models';
import { Trail, Smoke, Explosion } from './three/effects';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xc3cfd8, 8000, 130000); // дальняя прорисовка до 130км
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 600000);
camera.position.set(320, 180, 420);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 40, 0); controls.maxDistance = 150000; controls.minDistance = 3;

const { dome, sun, hemi } = makeSky();
scene.add(dome, sun, hemi, makeTerrain(), makeClouds());
scene.add(new THREE.AmbientLight(0xffffff, 0.15));

// Установки ПВО на местности + РЛС у каждой
const dishes: THREE.Group[] = [];
for (const s of SITES) {
  const g = buildLauncherSite();
  const tv = nedToThree(s.pos.x, s.pos.y, 0, new THREE.Vector3());
  g.position.set(tv.x, groundH(tv.x, tv.z), tv.z);
  g.scale.setScalar(s.scale);
  scene.add(g);
  const r = buildRadar();
  r.group.position.set(tv.x + 70 * s.scale, groundH(tv.x + 70 * s.scale, tv.z + 40) , tv.z + 40);
  r.group.scale.setScalar(Math.max(0.6, s.scale));
  scene.add(r.group);
  dishes.push(r.dish);
}

// Пул ЗУР (залп + дострел — до 6 в воздухе) и цель
const POOL = 6;
const pool: { mesh: THREE.Group; trail: Trail; idx: number }[] = [];
for (let i = 0; i < POOL; i++) {
  const mesh = buildMissile(0xcfd6dc, 7.2, 0.9);
  mesh.visible = false; scene.add(mesh);
  const trail = new Trail(i === 0 ? 0xffd27a : 0xffb45e);
  scene.add(trail.line);
  pool.push({ mesh, trail, idx: 0 });
}
const targetMesh = buildMissile(0x7a2f28, 6.0, 0.8);
targetMesh.visible = false; scene.add(targetMesh);
const trailT = new Trail(0xff6b6b); scene.add(trailT.line);
// маркеры дальних объектов (иначе на 20км ничего не найти)
const markerT = makeMarker('#ff7d7d'); scene.add(markerT);
const markerPool: THREE.Sprite[] = [];
for (let i = 0; i < POOL; i++) { const m = makeMarker('#7dffb0'); scene.add(m); markerPool.push(m); }
// Маркер виден ТОЛЬКО издалека (иначе закрывает красивую модель):
// ближе 900м — прячем, 900–2200м — плавное появление, дальше — во всей красе.
function placeMarker(sp: THREE.Sprite, p: THREE.Vector3, vis: boolean) {
  if (!vis) { sp.visible = false; return; }
  const d = camera.position.distanceTo(p);
  if (d < 900) { sp.visible = false; return; }
  sp.visible = true;
  sp.position.copy(p);
  const s = THREE.MathUtils.clamp(d * 0.025, 25, 350);
  sp.scale.set(s, s, 1);
  (sp.material as THREE.SpriteMaterial).opacity =
    THREE.MathUtils.clamp((d - 900) / (2200 - 900), 0, 1) * 0.95;
}

const smoke = new Smoke(1500); scene.add(smoke.points);
const boom = new Explosion(); scene.add(boom.group);
const meetMark = new THREE.Mesh(new THREE.RingGeometry(20, 24, 40),
  new THREE.MeshBasicMaterial({ color: 0x4cc38a, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
meetMark.rotation.x = -Math.PI / 2; meetMark.visible = false; scene.add(meetMark);

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------- состояние сценария ----------
let result: EngageResult | null = null;
let live: Battle | null = null;   // живой бой (ручная цель)
let liveOver = false;
let playT = 0, playing = false, speed = 1;
let camMode: 'orbit' | 'chase' | 'missile' | 'tchase' | 'tnose' | 'radar' = 'orbit';
let role: 'pvo' | 'target' = 'pvo';
const keys: Record<string, boolean> = {};
addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  keys[e.code] = true;
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
function pilotInput(): { pitch: number; yaw: number } | null {
  if (role !== 'target' || !live || liveOver) return null;
  const up = keys['KeyW'] || keys['ArrowUp'] ? 1 : 0;
  const dn = keys['KeyS'] || keys['ArrowDown'] ? 1 : 0;
  const lf = keys['KeyA'] || keys['ArrowLeft'] ? 1 : 0;
  const rt = keys['KeyD'] || keys['ArrowRight'] ? 1 : 0;
  if (!up && !dn && !lf && !rt) return null; // руки убрал — летит прямо по программе
  return { pitch: up - dn, yaw: rt - lf };
}

function verdictText(r: EngageResult, p: EngageParams, ms: string): { html: string; cls: string; short: string } {
  const siteName = uiVal('p-site') === 'all' ? 'кооператив' : SITES.find(s => s.id === uiVal('p-site'))!.name;
  const evNote = p.evasion?.enabled ? ' · цель уклонялась!' : '';
  const roleNote = role === 'target' ? ' · пилотировал ТЫ' : '';
  if (r.hit) return {
    html: `<b>ПОРАЖЕНИЕ</b> · промах ${r.missM.toFixed(1)} м · t=${r.tHit.toFixed(2)} c · пусков: ${r.shots}${evNote}${roleNote}<br><span style="color:#8aa0b4">счёт ${ms} мс · ${siteName} · ${p.law.toUpperCase()} N=${p.N} · ${TARGETS[uiVal('p-target')].name}</span>`,
    cls: 'ok', short: `Цель поражена (${r.missM.toFixed(1)} м, пусков ${r.shots})`
  };
  return {
    html: `<b>ПРОМАХ</b> · мин. дистанция ${r.missM.toFixed(0)} м · пусков: ${r.shots} · ${r.endReason}${evNote}${roleNote}<br><span style="color:#8aa0b4">счёт ${ms} мс · ${siteName} · ${TARGETS[uiVal('p-target')].name}</span>`,
    cls: 'miss', short: `Промах (${r.missM.toFixed(0)} м)`
  };
}
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();

function uiVal(id: string): string { return (document.getElementById(id) as HTMLInputElement | HTMLSelectElement).value; }
function uiChecked(id: string): boolean { return (document.getElementById(id) as HTMLInputElement).checked; }
function toast(s: string) { const e = document.getElementById('toast')!; e.textContent = s; e.style.display = 'block'; setTimeout(() => e.style.display = 'none', 2600); }
function logBox(html: string, cls = 'info') { const b = document.getElementById('engage-log')!; const d = document.createElement('div'); d.className = cls; d.innerHTML = html; b.prepend(d); }

function buildParams(): EngageParams {
  const tgtKey = uiVal('p-target');
  const siteKey = uiVal('p-site');
  const rangeKm = parseFloat(uiVal('p-range')), altKm = parseFloat(uiVal('p-alt'));
  const tv = parseFloat(uiVal('p-tv')), cross = parseFloat(uiVal('p-cross')) * Math.PI / 180;
  const law = (uiVal('p-law') as 'pn' | 'apn');
  const N = parseFloat(uiVal('p-nav'));
  const R = rangeKm * 1000, H = altKm * 1000;
  const tPos = new Vec3(R, Math.tan(cross) * R, -H);
  const dir = new Vec3(-1, -Math.tan(cross) * 0.4, 0).normalized();
  const tVel = tgtKey === 'ballistic'
    ? new Vec3(-tv * 0.75, 0, tv * 0.45) // снижается к земле
    : tgtKey === 'iskander'
      ? new Vec3(-tv * 0.83, -Math.tan(cross) * tv * 0.3, tv * 0.55).normalized().scale(tv) // крутое пикирование
      : dir.scale(tv);
  const man = tgtKey === 'ballistic' ? 'constant' : tgtKey === 'cruise' ? 'constant' : tgtKey === 'weave' ? 'weave' : tgtKey === 'turn' ? 'turn' : 'quasi';
  // установки: выбранная или все сразу (кооператив)
  const picked = siteKey === 'all' ? SITES : SITES.filter(s => s.id === siteKey);
  const first = picked[0];
  const sites = picked.map(s => ({ pos: new Vec3(s.pos.x, s.pos.y, 0), cfg: INTERCEPTORS[s.interceptor], delay: 1.2 }));
  const salvo = Math.max(1, Math.min(3, parseInt(uiVal('p-salvo') || '2')));
  const evOn = uiChecked('p-evade');
  const evG = parseFloat(uiVal('p-evadeg') || '10');
  return {
    interceptorCfg: INTERCEPTORS[first.interceptor], law, N,
    targetInitPos: tPos, targetInitVel: tVel, maneuver: man as never,
    launchPos: new Vec3(first.pos.x, first.pos.y, 0), launchDelay: 1.2,
    seed: 1234 + Math.floor(Math.random() * 5000), windSpeed: 5, windFrom: 290,
    radarRcs: tgtKey === 'cruise' ? 0.15 : tgtKey === 'iskander' ? 0.2 : 0.5, seekerNoise: 6, maxT: 90,
    turnOnsetS: 10,
    salvo, salvoDt: 1.5, sites,
    evasion: { enabled: evOn, rangeM: parseFloat(uiVal('p-evr') || '9') * 1000, g: evG, maxG: evG + 2 },
    reshoot: uiChecked('p-reshoot'), maxShots: 6
  };
}

function launch() {
  role = (uiVal('p-role') as 'pvo' | 'target');
  speed = parseFloat(uiVal('p-speed')) || 1;
  (document.getElementById('role-hint') as HTMLElement).innerHTML = role === 'target'
    ? 'Ты — ПИЛОТ цели: <b>W/S</b> — набор/снижение, <b>A/D</b> или стрелки — разворот. ПВО работает само: уклонись от залпа!'
    : 'РЛС обнаруживает цель автоматически. Промах &lt; 12 м = поражение (ОФ БЧ).';
  if (role === 'target') startLive();
  else startAuto();
}

function resetScene() {
  playing = false; result = null; live = null; liveOver = false; playT = 0;
  for (const q of pool) { q.mesh.visible = false; q.trail.clear(); q.idx = 0; }
  trackState.forEach(s => s.i = 0);
  targetMesh.visible = false; meetMark.visible = false; trailT.clear();
  markerT.visible = false; for (const m of markerPool) m.visible = false;
  (document.getElementById('hud-stats') as HTMLElement).textContent = '—';
}

function startAuto() {
  const p = buildParams();
  const t0 = performance.now();
  result = runEngagement(p);
  live = null; liveOver = false;
  const ms = (performance.now() - t0).toFixed(0);
  playT = 0; playing = true;
  resetVisual();
  (window as never as { __lastCSV?: string }).__lastCSV = toCSV(result.log as never);
  const v = verdictText(result, p, ms);
  logBox(v.html, v.cls);
  toast(v.short);
  drawChart();
}

function startLive() {
  const p = buildParams();
  // в ручном режиме уклонения-автомата нет — пилот ты
  if (p.evasion) p.evasion = { ...p.evasion, enabled: false };
  resetScene();
  live = new Battle(p);
  (live as unknown as { uiParams: EngageParams }).uiParams = p;
  playing = false;
  toast('Живой бой: ты пилотируешь цель. Уклонись!');
  logBox(`Живой бой: ты за <b>цель</b> (${TARGETS[uiVal('p-target')].name}), ПВО — ${uiVal('p-site') === 'all' ? 'кооператив' : 'установка'}, залп и дострел автоматом. Удачи.`, 'info');
}

function resetVisual() {
  for (const q of pool) { q.trail.clear(); q.mesh.visible = false; q.idx = 0; }
  trackState.forEach(s => s.i = 0);
  trailT.clear();
  meetMark.visible = false;
  targetMesh.visible = true;
}

function sampleLog(t: number) {
  if (!result || !result.log.length) return null;
  const L = result.log;
  let i = 0;
  while (i < L.length - 1 && L[i + 1].t < t) i++;
  const a = L[i], b = L[Math.min(i + 1, L.length - 1)];
  const k = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return { a, b, k };
}

// выборка трека ЗУР на время t (кэш-индекс только вперёд; сброс при пуске)
function sampleTrack(tr: TrackPoint[], t: number, st: { i: number }): { p: Vec3; v: Vec3; hot: boolean; live: boolean } | null {
  if (!tr.length) return null;
  if (t < tr[0].t - 1e-9) return null; // ещё не пущена
  while (st.i < tr.length - 1 && tr[st.i + 1].t < t) st.i++;
  const a = tr[st.i], b = tr[Math.min(st.i + 1, tr.length - 1)];
  const k = b.t > a.t ? THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
  return {
    p: a.p.clone().add(b.p.sub(a.p).scale(k)),
    v: a.v.clone().add(b.v.sub(a.v).scale(k)),
    hot: (a.hot || b.hot) && k < 1,
    live: true
  };
}
const trackState = pool.map(() => ({ i: 0 }));

function orientAlongPos(mesh: THREE.Object3D, p: Vec3, v: Vec3) {
  nedToThree(v.x, v.y, v.z, tmpV2);
  if (tmpV2.lengthSq() < 1e-6) return;
  tmpV2.normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), tmpV2);
  mesh.quaternion.slerp(q, 0.4);
}

function primaryMesh(): THREE.Group {
  // ближайшая к цели видимая ЗУР
  let best: THREE.Group | null = null, bd = 1e12;
  for (const q of pool) {
    if (!q.mesh.visible) continue;
    const d = q.mesh.position.distanceToSquared(targetMesh.position);
    if (d < bd) { bd = d; best = q.mesh; }
  }
  return best ?? pool[0].mesh;
}

// ---------- цикл ----------
const clock = new THREE.Clock();

// позиция+скорость цели в удобном виде (из авто-лога или живого боя)
function targetPV(): { p: THREE.Vector3; v: Vec3 } | null {
  if (result && playing) {
    const s = sampleLog(playT);
    if (!s) return null;
    const tp = s.a.tpos.clone().add(s.b.tpos.sub(s.a.tpos).scale(THREE.MathUtils.clamp(s.k, 0, 1)));
    nedToThree(tp.x, tp.y, tp.z, tmpV); tmpV.y = Math.max(tmpV.y, 2);
    return { p: tmpV.clone(), v: s.a.tvel };
  }
  if (live) {
    nedToThree(live.tgt.pos.x, live.tgt.pos.y, live.tgt.pos.z, tmpV); tmpV.y = Math.max(tmpV.y, 2);
    return { p: tmpV.clone(), v: live.tgt.vel };
  }
  return null;
}

function updateHudFromRow(a: { range: number; vc: number; losRate: number; altM: number; mach: number; g: number; evade: number; shotsUp: number }) {
  const rangeKm = (a.range / 1000).toFixed(1);
  const evTag = a.evade ? ' · ⚠ ЦЕЛЬ МАНЕВРИРУЕТ' : (role === 'target' && pilotHasInput() ? ' · 🛩 ТЫ МАНЕВРИРУЕШЬ' : '');
  const shTag = a.shotsUp > 0 ? ` · ЗУР в полёте: ${a.shotsUp}` : '';
  (document.getElementById('hud-stats') as HTMLElement).textContent =
    `t=${playT.toFixed(1)}c · дальн. ${rangeKm} км · сближ. ${a.vc.toFixed(0)} м/с · LOS ${a.losRate.toFixed(3)} · H ${a.altM.toFixed(0)} м · M${a.mach.toFixed(2)} · ${a.g.toFixed(0)}g${shTag}${evTag}`;
}
function pilotHasInput(): boolean {
  return !!(keys['KeyW'] || keys['KeyS'] || keys['KeyA'] || keys['KeyD'] || keys['ArrowUp'] || keys['ArrowDown'] || keys['ArrowLeft'] || keys['ArrowRight']);
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  for (const d of dishes) d.rotation.y += dt * 0.9;
  dome.position.copy(camera.position);
  smoke.step(dt); boom.step(dt);

  // --- живой бой: шагаем физику в реальном времени ---
  if (live && !liveOver) {
    live.tgt.manual = pilotInput();
    const n = Math.min(600, Math.round(dt * speed / 0.0005));
    for (let k = 0; k < n; k++) {
      if (live.step() === 'HIT') break;
      if (live.pollEnd()) break;
    }
    playT = live.t;
    renderLive();
    const end = live.pollEnd();
    if (end) finishLive(end);
  }

  // --- автобой: проигрывание предвычисления ---
  if (playing && result) {
    playT += dt * speed;
    const s = sampleLog(playT);
    const lastT = result.log.length ? result.log[result.log.length - 1].t : 0;
    if (s) {
      const tp = s.a.tpos.clone().add(s.b.tpos.sub(s.a.tpos).scale(THREE.MathUtils.clamp(s.k, 0, 1)));
      nedToThree(tp.x, tp.y, tp.z, tmpV); tmpV.y = Math.max(tmpV.y, 2); targetMesh.position.copy(tmpV);
      orientAlongPos(targetMesh, tp, s.a.tvel);
      if (Math.random() < 0.7) trailT.push(targetMesh.position);
      result.tracks.forEach((tr, i) => {
        if (i >= POOL) return;
        const sm = sampleTrack(tr, playT, trackState[i]);
        const q = pool[i];
        if (!sm) { q.mesh.visible = false; return; }
        q.mesh.visible = true;
        nedToThree(sm.p.x, sm.p.y, sm.p.z, tmpV); tmpV.y = Math.max(tmpV.y, 2);
        q.mesh.position.copy(tmpV);
        orientAlongPos(q.mesh, sm.p, sm.v);
        if (Math.random() < 0.85) { smoke.emit(q.mesh.position, 2, 1); q.trail.push(q.mesh.position); }
        const fl = q.mesh.getObjectByName('flame') as THREE.Mesh;
        const gl = q.mesh.getObjectByName('glow') as THREE.PointLight;
        fl.visible = sm.hot; fl.scale.set(1, sm.hot ? 0.8 + Math.random() * 0.5 : 0.001, 1);
        gl.intensity = sm.hot ? 60 : 0;
      });
      const prim = primaryMesh();
      if (result.hit && playT >= result.tHit && !meetMark.visible) {
        boom.boom(prim.position.clone());
        meetMark.visible = true; meetMark.position.copy(prim.position);
        logBox(`Взрыватель сработал на ${result.missM.toFixed(1)} м, цель уничтожена`, 'ok');
      }
      updateHudFromRow(s.a);
      if (playT > lastT + 2) { playing = false; }
    }
  }

  // маркеры дальних объектов
  placeMarker(markerT, targetMesh.position, targetMesh.visible);
  pool.forEach((q, i) => placeMarker(markerPool[i], q.mesh.position, q.mesh.visible));

  // камеры
  const tpv = targetPV();
  const prim = primaryMesh();
  if (camMode === 'chase') {
    tmpV.copy(prim.position).add(new THREE.Vector3(-60, 35, 80));
    camera.position.lerp(tmpV, 0.06); controls.target.lerp(prim.position, 0.2);
  } else if (camMode === 'missile') {
    camera.position.lerp(prim.position.clone().add(new THREE.Vector3(0, 6, 0)), 0.35);
    controls.target.lerp(targetMesh.position, 0.4);
  } else if (camMode === 'tchase' && tpv) {
    nedToThree(tpv.v.x, tpv.v.y, tpv.v.z, tmpV2).normalize();
    tmpV.copy(tpv.p).addScaledVector(tmpV2, -55).add(new THREE.Vector3(0, 16, 0));
    camera.position.lerp(tmpV, 0.25); controls.target.lerp(tpv.p, 0.5);
  } else if (camMode === 'tnose' && tpv) {
    nedToThree(tpv.v.x, tpv.v.y, tpv.v.z, tmpV2).normalize();
    tmpV.copy(tpv.p).addScaledVector(tmpV2, 9).add(new THREE.Vector3(0, 2.5, 0));
    camera.position.copy(tmpV);
    controls.target.copy(tpv.p).addScaledVector(tmpV2, 600);
  } else if (camMode === 'radar') {
    camera.position.lerp(new THREE.Vector3(-90 + 40, 30, 60 + 55), 0.08);
    controls.target.lerp(targetMesh.position, 0.1);
  }
  controls.update();
  renderer.render(scene, camera);
}
frame();

function renderLive() {
  if (!live) return;
  nedToThree(live.tgt.pos.x, live.tgt.pos.y, live.tgt.pos.z, tmpV);
  tmpV.y = Math.max(tmpV.y, 2);
  targetMesh.visible = true;
  targetMesh.position.copy(tmpV);
  orientAlongPos(targetMesh, live.tgt.pos, live.tgt.vel);
  trailT.push(targetMesh.position);
  live.missiles.forEach((m, i) => {
    if (i >= POOL) return;
    const q = pool[i];
    q.mesh.visible = true;
    nedToThree(m.veh.st.pos.x, m.veh.st.pos.y, m.veh.st.pos.z, tmpV);
    tmpV.y = Math.max(tmpV.y, 2);
    q.mesh.position.copy(tmpV);
    orientAlongPos(q.mesh, m.veh.st.pos, m.veh.st.vel);
    if (Math.random() < 0.85) { smoke.emit(q.mesh.position, 2, 1); q.trail.push(q.mesh.position); }
    const hot = m.veh.st.thrust > 1000;
    const fl = q.mesh.getObjectByName('flame') as THREE.Mesh;
    const gl = q.mesh.getObjectByName('glow') as THREE.PointLight;
    fl.visible = hot; fl.scale.set(1, hot ? 0.8 + Math.random() * 0.5 : 0.001, 1);
    gl.intensity = hot ? 60 : 0;
  });
  // лишние меши пула прячем
  for (let i = live.missiles.length; i < POOL; i++) pool[i].mesh.visible = false;
  const last = live.log[live.log.length - 1];
  if (last) updateHudFromRow(last);
}

function finishLive(end: string) {
  if (!live || liveOver) return;
  liveOver = true;
  const p = (live as unknown as { uiParams: EngageParams }).uiParams;
  result = {
    hit: live.hit, missM: live.miss > 1e8 ? 1e9 : live.miss, tHit: live.tClosest,
    log: live.log, tracks: live.tracks, endReason: end,
    maxG: live.maxG, maxMach: live.maxMach, shots: live.shots
  };
  (window as never as { __lastCSV?: string }).__lastCSV = toCSV(result.log as never);
  const v = verdictText(result, p, (live.t).toFixed(1) + 'с боя');
  logBox(v.html, v.cls);
  toast(v.short);
  drawChart();
  if (result.hit) {
    const prim = primaryMesh();
    boom.boom(prim.position.clone());
    meetMark.visible = true; meetMark.position.copy(prim.position);
  }
}

// ---------- UI ----------
document.getElementById('btn-launch')!.onclick = launch;
document.getElementById('btn-reset')!.onclick = resetScene;
// Пресеты ввода под цель: Искандеру нужны дальность/высота/скорость квазибаллистики
document.getElementById('p-target')!.onchange = () => {
  const t = uiVal('p-target');
  const set = (id: string, v: string) => ((document.getElementById(id) as HTMLInputElement).value = v);
  if (t === 'iskander') { set('p-range', '70'); set('p-alt', '45'); set('p-tv', '2100'); }
  else if (t === 'cruise') { set('p-range', '15'); set('p-alt', '0.1'); set('p-tv', '250'); }
  else if (t === 'ballistic') { set('p-range', '40'); set('p-alt', '25'); set('p-tv', '1500'); }
  else { set('p-range', '20'); set('p-alt', '6'); set('p-tv', '700'); }
};
document.querySelectorAll('.cam-btns button').forEach(b => ((b as HTMLElement).onclick = () => {
  document.querySelectorAll('.cam-btns button').forEach(x => x.classList.remove('active'));
  (b as HTMLElement).classList.add('active'); camMode = (b as HTMLElement).dataset.cam as never;
  if (camMode === 'orbit') { camera.position.set(320, 180, 420); controls.target.set(0, 40, 0); }
}));
document.getElementById('btn-csv')!.onclick = () => {
  const csv = (window as never as { __lastCSV?: string }).__lastCSV;
  if (!csv) return toast('Сначала выполни пуск');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'cruair_trajectory.csv'; a.click();
};
document.getElementById('btn-mc')!.onclick = async () => {
  const n = parseInt((document.getElementById('mc-n') as HTMLInputElement).value || '200');
  const seed = parseInt((document.getElementById('mc-seed') as HTMLInputElement).value || '7');
  const out = document.getElementById('mc-out')!;
  out.textContent = 'Считаю… (физика в чанках, интерфейс не виснет)';
  await new Promise(r => setTimeout(r, 30));
  const base = buildParams(); base.seed = seed;
  const misses: number[] = []; let hits = 0; const reasons: Record<string, number> = {};
  for (let k = 0; k < n; k++) {
    const p: EngageParams = { ...base, seed: seed * 100003 + k * 7919, windSpeed: Math.max(0, base.windSpeed + ((k * 37) % 7 - 3)) };
    p.targetInitPos = base.targetInitPos.clone();
    const r = runEngagement(p);
    misses.push(r.missM); if (r.hit) hits++; reasons[r.endReason] = (reasons[r.endReason] || 0) + 1;
    if (k % 10 === 0) { out.textContent = `Считаю… ${k}/${n}`; await new Promise(r2 => setTimeout(r2, 0)); }
  }
  misses.sort((a, b) => a - b);
  const pk = hits / n, p50 = misses[Math.floor(n * 0.5)], p90 = misses[Math.floor(n * 0.9)];
  const verdict = pk >= 0.8 ? 'ЗАЯВЛЕННОЕ ДЕРЖИТ ✓' : pk >= 0.5 ? 'ПОГРАНИЧНО ~' : 'НЕ ДЕРЖИТ ✗';
  out.textContent = `${verdict}\nPk=${(pk * 100).toFixed(1)}% (${hits}/${n})\nмедиана промаха ${p50.toFixed(1)} м · P90 ${p90.toFixed(1)} м\n${Object.entries(reasons).map(([k2, v]) => `${k2}: ${v}`).join(' · ')}`;
  drawHist(misses);
};

function drawChart() {
  const c = document.getElementById('chart') as HTMLCanvasElement, x = c.getContext('2d')!;
  x.clearRect(0, 0, c.width, c.height);
  if (!result || !result.log.length) return;
  const L = result.log;
  const series = [
    { v: L.map(r => r.range / 1000), col: '#4cc38a', label: 'дальн.км' },
    { v: L.map(r => r.mach), col: '#ffb454', label: 'M' },
  ];
  x.fillStyle = '#8aa0b4'; x.font = '10px sans-serif';
  series.forEach((s, si) => {
    const mx = Math.max(...s.v, 1e-6);
    x.strokeStyle = s.col; x.beginPath();
    s.v.forEach((val, i) => { const px = (i / (s.v.length - 1)) * c.width, py = c.height - 14 - (val / mx) * (c.height - 30); i ? x.lineTo(px, py) : x.moveTo(px, py); });
    x.stroke(); x.fillText(`${s.label} max ${mx.toFixed(1)}`, 6, 12 + si * 12);
  });
}

function drawHist(misses: number[]) {
  const c = document.getElementById('mc-hist') as HTMLCanvasElement, x = c.getContext('2d')!;
  x.clearRect(0, 0, c.width, c.height);
  const max = Math.min(500, Math.max(...misses, 50));
  const B = 24, bins = new Array(B).fill(0);
  misses.forEach(m => { const b = Math.min(B - 1, Math.floor(m / max * B)); bins[b]++; });
  const mx = Math.max(...bins, 1);
  const killX = (12 / max) * c.width;
  bins.forEach((v, i) => { const h = (v / mx) * (c.height - 20); x.fillStyle = '#4cc38a'; x.fillRect((i / B) * c.width + 1, c.height - h, c.width / B - 2, h); });
  x.strokeStyle = '#ff6b6b'; x.beginPath(); x.moveTo(killX, 0); x.lineTo(killX, c.height); x.stroke();
  x.fillStyle = '#8aa0b4'; x.font = '10px sans-serif'; x.fillText('красная = радиус БЧ 12м', 6, 10);
}

// автопуск первой сцены
setTimeout(launch, 600);
