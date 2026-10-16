// Эффекты: шлейфы-ленты, дым (Points), взрыв, подсветка траектории цели.
import * as THREE from 'three';

export class Trail {
  line: THREE.Line; pts: THREE.Vector3[] = []; max = 900;
  constructor(color = 0xffd27a) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.line = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    this.line.frustumCulled = false;
  }
  push(p: THREE.Vector3) {
    this.pts.push(p.clone());
    if (this.pts.length > this.max) this.pts.shift();
    this.line.geometry.setFromPoints(this.pts.length > 1 ? this.pts : [p, p.clone().add(new THREE.Vector3(0.1, 0, 0))]);
  }
  clear() { this.pts = []; }
}

export class Smoke {
  points: THREE.Points; vel: Float32Array; life: Float32Array; n: number;
  head = 0;
  constructor(n = 1200) {
    this.n = n;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3).fill(999999), 3));
    this.vel = new Float32Array(n * 3); this.life = new Float32Array(n).fill(0);
    this.points = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xcfd4d8, size: 14, transparent: true, opacity: 0.5, depthWrite: false }));
    this.points.frustumCulled = false;
  }
  emit(p: THREE.Vector3, spread = 3, up = 1.5) {
    const a = this.head; this.head = (this.head + 1) % this.n;
    const arr = (this.points.geometry.attributes.position as THREE.BufferAttribute);
    arr.setXYZ(a, p.x + (Math.random() - 0.5) * spread, p.y + (Math.random() - 0.5) * spread, p.z + (Math.random() - 0.5) * spread);
    this.vel[a * 3] = (Math.random() - 0.5) * 4; this.vel[a * 3 + 1] = up + Math.random() * 3; this.vel[a * 3 + 2] = (Math.random() - 0.5) * 4;
    this.life[a] = 1; arr.needsUpdate = true;
  }
  step(dt: number) {
    const arr = (this.points.geometry.attributes.position as THREE.BufferAttribute);
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt * 0.35;
      arr.setXYZ(i, arr.getX(i) + this.vel[i * 3] * dt, arr.getY(i) + this.vel[i * 3 + 1] * dt, arr.getZ(i) + this.vel[i * 3 + 2] * dt);
    }
    arr.needsUpdate = true;
    (this.points.material as THREE.PointsMaterial).opacity = 0.5;
  }
}

export class Explosion {
  group = new THREE.Group(); t = 1e9;
  flash: THREE.PointLight; ball: THREE.Mesh; ring: THREE.Mesh;
  constructor() {
    this.flash = new THREE.PointLight(0xffc37a, 0, 3000, 1.6);
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(10, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.ring = new THREE.Mesh(new THREE.RingGeometry(8, 10, 48),
      new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, opacity: 0.8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    this.group.add(this.flash, this.ball, this.ring);
    this.group.visible = false;
  }
  boom(p: THREE.Vector3) {
    this.t = 0; this.group.visible = true; this.group.position.copy(p);
  }
  step(dt: number) {
    if (this.t > 2) { this.group.visible = false; return; }
    this.t += dt;
    const k = this.t / 1.4;
    this.ball.scale.setScalar(1 + k * 9);
    (this.ball.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.95 - k);
    this.ring.scale.setScalar(1 + k * 26);
    (this.ring.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.8 - k * 0.8);
    this.flash.intensity = Math.max(0, 8000 * (1 - k));
  }
}
