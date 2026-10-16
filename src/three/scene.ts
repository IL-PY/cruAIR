// 3D сцена: террейн с холмами, небо-купол с солнцем, туман, свет, стартовые позиции.
// Масштаб: 1 юнит = 1 метр, но дальние дистанции сжимаем логарифмически для картинки.
import * as THREE from 'three';

export const WORLD = {
  // сжатие дальности для визуала: показываем до 40км, дальше — на куполе
  visRange: 40000,
  scaleDist(d: number) { return Math.sign(d) * Math.min(Math.abs(d), this.visRange); }
};

// NED (x-север, y-восток, z-вниз) -> Three (x-восток, y-вверх, z-юг)
export function nedToThree(x: number, y: number, z: number, out: THREE.Vector3) {
  out.set(y, -z, -x);
  return out;
}

// Высота грунта (та же функция, что красит террейн) — для расстановки объектов
export function groundH(x: number, z: number): number {
  const s1 = Math.sin(x * 0.00035) * Math.cos(z * 0.0003);
  const s2 = Math.sin(x * 0.0011 + 1.7) * Math.sin(z * 0.0009 + 0.6);
  const s3 = Math.sin((x + z) * 0.00012);
  const flat = Math.exp(-(x * x + z * z) / (2 * 2600 * 2600)); // плацдарм ровный
  return (s1 * 160 + s2 * 45 + s3 * 220) * (1 - flat) + 2;
}

export function makeTerrain(): THREE.Mesh {
  const SIZE = 160000, SEG = 256; // дальняя прорисовка: 160км, центр всё равно ровный
  const geo = new THREE.PlaneGeometry(SIZE, SEG * 0 + SEG, SEG, SEG);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  // детерминированный шум холмов
  const hAt = groundH;
  const colors: number[] = [];
  const cGrass = new THREE.Color(0x3d5a3a), cDry = new THREE.Color(0x6b6a4d), cRock = new THREE.Color(0x5a5a60), cBase = new THREE.Color(0x2e402e);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = hAt(x, z);
    pos.setY(i, h);
    const t = THREE.MathUtils.clamp(h / 220, 0, 1);
    const c = cBase.clone().lerp(cGrass, 0.55).lerp(t > 0.55 ? cRock : cDry, t * 0.7);
    // дороги: крест через центр
    if (Math.abs(x) < 26 || Math.abs(z) < 26) c.set(0x3a3a3c);
    colors.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

export function makeSky(): { dome: THREE.Mesh; sun: THREE.DirectionalLight; hemi: THREE.HemisphereLight } {
  const geo = new THREE.SphereGeometry(450000, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { sunDir: { value: new THREE.Vector3(0.4, 0.35, -0.6).normalize() } },
    vertexShader: 'varying vec3 vP; void main(){ vP=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: `varying vec3 vP; uniform vec3 sunDir;
      void main(){
        float h = clamp(vP.y, -0.1, 1.0);
        vec3 top = vec3(0.10,0.23,0.45); vec3 mid = vec3(0.45,0.62,0.80); vec3 hor = vec3(0.85,0.80,0.72);
        vec3 col = mix(hor, mid, smoothstep(0.0,0.25,h)); col = mix(col, top, smoothstep(0.2,0.9,h));
        float s = max(dot(normalize(vP), normalize(sunDir)), 0.0);
        col += vec3(1.0,0.85,0.6)*pow(s, 600.0)*1.2 + vec3(1.0,0.8,0.55)*pow(s,8.0)*0.18;
        // лёгкая дымка у горизонта
        col = mix(col, hor*0.9, (1.0-smoothstep(0.0,0.14,h))*0.5);
        gl_FragColor = vec4(col, 1.0);
      }`
  });
  const dome = new THREE.Mesh(geo, mat);
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
  sun.position.set(8000, 7000, -12000); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -600, right: 600, top: 600, bottom: -600, far: 40000 });
  const hemi = new THREE.HemisphereLight(0xbcd3ff, 0x3a4a3a, 0.85);
  return { dome, sun, hemi };
}

export function makeClouds(): THREE.Points {
  const N = 260;
  const g = new THREE.BufferGeometry();
  const p = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 15000 + Math.random() * 95000, a = Math.random() * Math.PI * 2;
    p[i * 3] = Math.cos(a) * r; p[i * 3 + 1] = 3000 + Math.random() * 6000; p[i * 3 + 2] = Math.sin(a) * r;
  }
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const m = new THREE.PointsMaterial({ color: 0xffffff, size: 2600, transparent: true, opacity: 0.35, sizeAttenuation: true, depthWrite: false });
  return new THREE.Points(g, m);
}

// Маркер для дальних объектов: ромбик, виден сквозь всё, размер по дистанции.
// Без него ракету на 20км не найти глазами.
export function makeMarker(color: string): THREE.Sprite {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d')!;
  x.strokeStyle = color; x.lineWidth = 6;
  x.beginPath(); x.moveTo(32, 6); x.lineTo(58, 32); x.lineTo(32, 58); x.lineTo(6, 32); x.closePath(); x.stroke();
  x.fillStyle = color; x.beginPath(); x.arc(32, 32, 6, 0, Math.PI * 2); x.fill();
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.95, depthTest: false }));
  sp.renderOrder = 999;
  return sp;
}
