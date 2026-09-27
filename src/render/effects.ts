import * as THREE from 'three';

const PARTICLE_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (320.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;
const PARTICLE_FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d) * 2.0;
  float a = pow(max(0.0, 1.0 - r), 1.8);
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

/** Additive spark particles; they inherit the ship's velocity so bursts travel with you. */
export class Particles {
  points: THREE.Points;
  private max: number;
  private pos: Float32Array;
  private vel: Float32Array;
  private col: Float32Array;
  private base: Float32Array;
  private size: Float32Array;
  private baseSize: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private drag: Float32Array;
  private cursor = 0;
  private geo = new THREE.BufferGeometry();

  constructor(max = 5000) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.base = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.baseSize = new Float32Array(max);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max).fill(1);
    this.drag = new Float32Array(max);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.points = new THREE.Points(
      this.geo,
      new THREE.ShaderMaterial({
        vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    this.points.frustumCulled = false;
  }

  /**
   * Burst `n` sparks at `p`. `carry` is the velocity they inherit (the ship's), `spread` the
   * random speed, `up` biases them upward along that axis.
   */
  burst(p: THREE.Vector3, carry: THREE.Vector3, color: THREE.Color, n: number, spread: number, life = 0.7, size = 1, up?: THREE.Vector3) {
    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const o = i * 3;
      // Random direction on a sphere.
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const sp = spread * (0.3 + Math.random() * 0.7);
      let dx = r * Math.cos(th), dy = u, dz = r * Math.sin(th);
      if (up) { dx += up.x * 0.8; dy += up.y * 0.8; dz += up.z * 0.8; }
      this.pos[o] = p.x; this.pos[o + 1] = p.y; this.pos[o + 2] = p.z;
      this.vel[o] = carry.x + dx * sp;
      this.vel[o + 1] = carry.y + dy * sp;
      this.vel[o + 2] = carry.z + dz * sp;
      const tint = 0.6 + Math.random() * 0.8;
      this.base[o] = color.r * tint; this.base[o + 1] = color.g * tint; this.base[o + 2] = color.b * tint;
      this.maxLife[i] = life * (0.5 + Math.random() * 0.8);
      this.life[i] = this.maxLife[i];
      this.baseSize[i] = size * (0.5 + Math.random());
      this.drag[i] = 2.5 + Math.random() * 2;
    }
  }

  update(dt: number, carry: THREE.Vector3) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) {
        this.size[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const o = i * 3;
      // Relax toward the carrier velocity: sparks spread, then drift along with the ship.
      const k = Math.min(1, this.drag[i] * dt);
      this.vel[o] += (carry.x - this.vel[o]) * k;
      this.vel[o + 1] += (carry.y - this.vel[o + 1]) * k;
      this.vel[o + 2] += (carry.z - this.vel[o + 2]) * k;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.col[o] = this.base[o] * t;
      this.col[o + 1] = this.base[o + 1] * t;
      this.col[o + 2] = this.base[o + 2] * t;
      this.size[i] = this.baseSize[i] * (0.4 + t * 0.6);
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aColor.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
  }
}

/** Expanding neon rings (catches, gems, drops). They also move with the ship. */
export class Shockwaves {
  group = new THREE.Group();
  private items: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; grow: number; vel: THREE.Vector3; color: THREE.Color }[] = [];
  private geo = new THREE.RingGeometry(0.85, 1, 48);

  constructor(n = 24) {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.visible = false;
      this.group.add(mesh);
      this.items.push({ mesh, mat, age: 1, life: 1, grow: 1, vel: new THREE.Vector3(), color: new THREE.Color() });
    }
  }

  spawn(p: THREE.Vector3, normal: THREE.Vector3, vel: THREE.Vector3, color: THREE.Color, grow = 10, life = 0.45) {
    const it = this.items.reduce((a, b) => (b.age / b.life > a.age / a.life ? b : a));
    it.mesh.position.copy(p);
    it.mesh.lookAt(p.clone().add(normal));
    it.age = 0;
    it.life = life;
    it.grow = grow;
    it.vel.copy(vel);
    it.color.copy(color);
    it.mesh.visible = true;
  }

  update(dt: number) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.age += dt;
      const t = it.age / it.life;
      if (t >= 1) { it.mesh.visible = false; continue; }
      it.mesh.position.addScaledVector(it.vel, dt);
      const e = 1 - Math.pow(1 - t, 3);
      it.mesh.scale.setScalar(0.5 + e * it.grow);
      it.mat.color.copy(it.color).multiplyScalar(0.9 * (1 - t) * (1 - t));
    }
  }
}

/** Streaks flying past the camera; their length and brightness follow the speed. */
export class SpeedLines {
  lines: THREE.LineSegments;
  private n: number;
  private data: Float32Array; // x, y, z per streak
  private pos: Float32Array;
  private col: Float32Array;
  private geo = new THREE.BufferGeometry();

  constructor(n = 340) {
    this.n = n;
    this.data = new Float32Array(n * 3);
    this.pos = new Float32Array(n * 6);
    this.col = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) this.respawn(i, true);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(
      this.geo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    );
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 5;
  }

  private respawn(i: number, anywhere = false) {
    const a = Math.random() * Math.PI * 2;
    const r = 7 + Math.pow(Math.random(), 0.7) * 60;
    this.data[i * 3] = Math.cos(a) * r;
    this.data[i * 3 + 1] = Math.sin(a) * r * 0.75 + 2;
    this.data[i * 3 + 2] = anywhere ? -Math.random() * 420 : -380 - Math.random() * 60;
  }

  update(dt: number, speed: number, color: THREE.Color, boost: number) {
    const len = speed * (0.05 + boost * 0.08);
    const k = Math.min(1.4, Math.max(0, (speed - 50) / 120)) * (0.5 + boost);
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      this.data[o + 2] += speed * dt * (1.3 + boost);
      if (this.data[o + 2] > 6) this.respawn(i);
      const x = this.data[o], y = this.data[o + 1], z = this.data[o + 2];
      const p = i * 6;
      this.pos[p] = x; this.pos[p + 1] = y; this.pos[p + 2] = z;
      this.pos[p + 3] = x; this.pos[p + 4] = y; this.pos[p + 5] = z - len;
      const fade = Math.min(1, (z + 420) / 120) * k;
      const w = 0.35 + (i % 5 === 0 ? 0.6 : 0);
      this.col[p] = (color.r * 0.6 + w) * fade; this.col[p + 1] = (color.g * 0.6 + w) * fade; this.col[p + 2] = (color.b * 0.6 + w) * fade;
      this.col[p + 3] = 0; this.col[p + 4] = 0; this.col[p + 5] = 0;
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}
