import * as THREE from 'three';
import type { Frame } from '../track/track.ts';
import { buildShip, type ShipModel } from '../ship/build.ts';
import { DEFAULT_LOADOUT, type Loadout } from '../ship/catalog.ts';

const FLAME_VERT = /* glsl */ `
varying float vT;
varying vec3 vN;
varying vec3 vV;
void main() {
  vT = 1.0 - uv.y; // 1 at the nozzle, 0 at the tip
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;
const FLAME_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uPower;
varying float vT;
varying vec3 vN;
varying vec3 vV;
void main() {
  float core = pow(clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 1.5);
  float flick = 0.94 + 0.06 * sin(uTime * 18.0 + vT * 8.0);
  float a = pow(clamp(vT, 0.0, 1.0), 1.4) * flick * uPower;
  vec3 c = mix(uColor, vec3(1.0), core * vT * 0.6) * a * (0.5 + core * 0.9);
  gl_FragColor = vec4(c, 1.0);
}
`;

const GLOW_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uPower;
varying vec2 vUv;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = pow(max(0.0, 1.0 - r), 2.0);
  gl_FragColor = vec4(uColor * a * uPower, 1.0);
}
`;
const GLOW_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

type TrailMode = 'solid' | 'dashed' | 'rainbow' | 'lightning';

/** A ribbon that follows a point in world space and fades out. */
class Trail {
  mesh: THREE.Mesh;
  private pts: THREE.Vector3[] = [];
  private sides: THREE.Vector3[] = [];
  private pos: Float32Array;
  private col: Float32Array;
  private geo = new THREE.BufferGeometry();
  private hsl = { h: 0, s: 0, l: 0 };
  private tmp = new THREE.Color();

  constructor(private n: number, private color: THREE.Color, private width: number, private mode: TrailMode, private falloff = 1.6) {
    this.pos = new Float32Array(n * 2 * 3);
    this.col = new Float32Array(n * 2 * 3);
    const idx: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.mesh = new THREE.Mesh(
      this.geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide, toneMapped: false,
      }),
    );
    this.mesh.frustumCulled = false;
  }

  push(p: THREE.Vector3, side: THREE.Vector3, up: THREE.Vector3, power: number, time: number) {
    const q = p.clone();
    if (this.mode === 'lightning') q.addScaledVector(up, (Math.random() - 0.5) * 0.5).addScaledVector(side, (Math.random() - 0.5) * 0.35);
    this.pts.unshift(q);
    this.sides.unshift(side.clone());
    if (this.pts.length > this.n) { this.pts.pop(); this.sides.pop(); }
    const m = this.pts.length;
    this.color.getHSL(this.hsl);
    for (let i = 0; i < this.n; i++) {
      const pt = this.pts[Math.min(i, m - 1)];
      const sd = this.sides[Math.min(i, m - 1)];
      const t = i / (this.n - 1);
      const w = this.width * (1 - t) * (0.4 + power * 0.6);
      const o = i * 6;
      this.pos[o] = pt.x - sd.x * w; this.pos[o + 1] = pt.y - sd.y * w; this.pos[o + 2] = pt.z - sd.z * w;
      this.pos[o + 3] = pt.x + sd.x * w; this.pos[o + 4] = pt.y + sd.y * w; this.pos[o + 5] = pt.z + sd.z * w;
      let a = Math.pow(1 - t, this.falloff) * power * (i < m ? 1 : 0);
      let c = this.color;
      if (this.mode === 'dashed') a *= (i + Math.floor(time * 30)) % 4 < 2 ? 1 : 0.1;
      if (this.mode === 'rainbow') c = this.tmp.setHSL((this.hsl.h + t * 0.9 + time * 0.2) % 1, 1, 0.55);
      for (let k = 0; k < 2; k++) {
        this.col[o + k * 3] = c.r * a;
        this.col[o + k * 3 + 1] = c.g * a;
        this.col[o + k * 3 + 2] = c.b * a;
      }
    }
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  reset() {
    this.pts = [];
    this.sides = [];
  }

  dispose() {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

const tmpV = new THREE.Vector3();
const tmpSide = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const basis = new THREE.Matrix4();
const ax = new THREE.Vector3(), ay = new THREE.Vector3(), az = new THREE.Vector3();
const HURT = new THREE.Color(1, 0.1, 0.1);
const TMP = new THREE.Color();

/** Trail styles: where the ribbons come from and how they look. */
function trailSetup(style: string, model: ShipModel): { anchors: THREE.Vector3[]; width: number; n: number; mode: TrailMode; falloff: number } | null {
  const main = model.nozzles.length > 1
    ? [model.nozzles[0].pos, model.nozzles[model.nozzles.length - 1].pos]
    : [model.nozzles[0]?.pos ?? model.center];
  switch (style) {
    case 'none': return null;
    case 'twin': return { anchors: main.map((p) => p.clone().add(new THREE.Vector3(0, 0, 0.3))), width: 0.07, n: 26, mode: 'solid', falloff: 1.2 };
    case 'wide': return { anchors: [model.center], width: 0.85, n: 16, mode: 'solid', falloff: 2 };
    case 'comet': return { anchors: [model.center], width: 0.5, n: 11, mode: 'solid', falloff: 2.6 };
    case 'dashed': return { anchors: model.wingtips, width: 0.13, n: 24, mode: 'dashed', falloff: 1.2 };
    case 'rainbow': return { anchors: model.wingtips, width: 0.13, n: 22, mode: 'rainbow', falloff: 1.4 };
    case 'lightning': return { anchors: model.wingtips, width: 0.08, n: 18, mode: 'lightning', falloff: 1.3 };
    default: return { anchors: model.wingtips, width: 0.12, n: 18, mode: 'solid', falloff: 1.6 };
  }
}

export class Ship {
  root = new THREE.Group();
  body = new THREE.Group();
  trails: Trail[] = [];
  private anchors: THREE.Object3D[] = [];
  private flames: { mesh: THREE.Mesh; r: number }[] = [];
  private flameMat: THREE.ShaderMaterial;
  private flameGeo: THREE.ConeGeometry;
  private glowMat: THREE.ShaderMaterial;
  private glowGeo: THREE.PlaneGeometry;
  private underglow: THREE.Mesh;
  private model: ShipModel;
  private bank = 0;
  private pulseAmt = 0;
  private pulseColor = new THREE.Color();
  private trailColor = new THREE.Color();
  private edgeBase: THREE.Color;
  private holo: boolean;
  color: THREE.Color;

  constructor(public loadout: Loadout = DEFAULT_LOADOUT) {
    this.color = new THREE.Color(loadout.glow);
    this.holo = loadout.finish === 'holo';
    this.model = buildShip(loadout);
    this.body.add(this.model.group);
    this.edgeBase = this.model.neonMat.color.clone();

    this.flameMat = new THREE.ShaderMaterial({
      vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG,
      uniforms: { uColor: { value: this.color.clone() }, uTime: { value: 0 }, uPower: { value: 1 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.flameGeo = new THREE.ConeGeometry(1, 1, 14, 1, true);
    this.flameGeo.translate(0, 0.5, 0);
    this.flameGeo.rotateX(Math.PI / 2); // base at the nozzle, tip points +Z (backwards)
    for (const n of this.model.nozzles) {
      const f = new THREE.Mesh(this.flameGeo, this.flameMat);
      f.position.copy(n.pos).add(new THREE.Vector3(0, 0, 0.01));
      this.flames.push({ mesh: f, r: n.r * 0.9 });
      this.body.add(f);
    }

    this.glowMat = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      uniforms: { uColor: { value: this.color.clone() }, uPower: { value: 0.6 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.glowGeo = new THREE.PlaneGeometry(6, 7);
    const glow = new THREE.Mesh(this.glowGeo, this.glowMat);
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = -0.95;
    this.underglow = glow;
    this.root.add(glow);

    const setup = trailSetup(loadout.trail, this.model);
    this.trailColor.copy(this.color);
    if (setup) {
      for (const p of setup.anchors) {
        const o = new THREE.Object3D();
        o.position.copy(p);
        this.anchors.push(o);
        this.body.add(o);
        this.trails.push(new Trail(setup.n, this.trailColor, setup.width, setup.mode, setup.falloff));
      }
    }
    this.root.add(this.body);
  }

  /** Place on the track at frame `f`, lateral x, with velocity vx (for banking). */
  update(f: Frame, x: number, vx: number, time: number, dt: number, opts: { power: number; hurt: boolean; bass: number; overdrive: boolean; lift?: number }) {
    basis.makeBasis(ax.set(f.rx, f.ry, f.rz), ay.set(f.ux, f.uy, f.uz), az.set(-f.fx, -f.fy, -f.fz));
    this.root.quaternion.setFromRotationMatrix(basis);
    // Rides the track's ripples (lift), plus a small idle bob.
    const hover = 1.15 + (opts.lift ?? 0) + Math.sin(time * 3.2) * 0.07 + opts.bass * 0.12;
    this.root.position.set(f.px + f.rx * x + f.ux * hover, f.py + f.ry * x + f.uy * hover, f.pz + f.rz * x + f.uz * hover);
    this.animate(vx, time, dt, opts);
    this.root.updateMatrixWorld(true);
    tmpSide.set(f.rx, f.ry, f.rz);
    tmpUp.set(f.ux, f.uy, f.uz);
    this.emitTrails(opts, time);
  }

  /** Banking, flames, pulse and finish animation, independent of where the ship is. */
  animate(vx: number, time: number, dt: number, opts: { power: number; hurt: boolean; bass: number; overdrive: boolean }) {
    dt = Math.max(0, dt);
    const targetBank = THREE.MathUtils.clamp(-vx * 0.02, -0.65, 0.65);
    this.bank += (targetBank - this.bank) * (1 - Math.exp(-dt * 16));
    this.body.rotation.z = this.bank;
    this.body.rotation.y = -this.bank * 0.25;
    this.body.rotation.x = 0.04 - opts.bass * 0.05;
    for (const paint of this.model.paintMats) {
      if (this.holo) {
        // Holo finish: the paint slowly shifts through the spectrum.
        paint.emissive.setHSL((time * 0.08) % 1, 0.9, 0.5);
        paint.emissiveIntensity = opts.hurt ? 0.6 : 0.22;
        if (opts.hurt) paint.emissive.lerp(HURT, 0.8);
      } else {
        paint.emissive.copy(this.edgeBase).multiplyScalar(1 / 2.4).lerp(HURT, opts.hurt ? 0.8 : 0);
        paint.emissiveIntensity = opts.hurt ? 0.5 : 0.04;
      }
    }

    this.pulseAmt = Math.max(0, this.pulseAmt - dt * 3);
    const p = this.pulseAmt * this.pulseAmt;
    this.model.neonMat.color.copy(this.edgeBase).lerp(TMP.copy(this.pulseColor).multiplyScalar(3.2), p);
    this.trailColor.copy(this.color).lerp(this.pulseColor, Math.min(1, p * 1.5));
    (this.glowMat.uniforms.uColor.value as THREE.Color).copy(this.color).lerp(this.pulseColor, p);
    this.body.scale.setScalar(1 + p * 0.08);

    this.flameMat.uniforms.uTime.value = time;
    this.flameMat.uniforms.uPower.value = 0.7 + opts.power * 0.6;
    const len = 1.4 + opts.power * 2 + opts.bass * 0.6 + (opts.overdrive ? 2.5 : 0);
    for (const fl of this.flames) fl.mesh.scale.set(fl.r, fl.r, len * (0.6 + fl.r * 1.6));
    this.glowMat.uniforms.uPower.value = 0.5 * (0.8 + opts.bass * 0.6 + (opts.overdrive ? 0.8 : 0) + p * 1.6);
  }

  /** Push the current anchor positions into the trails (world space). */
  emitTrails(opts: { power: number; overdrive: boolean }, time: number, side = tmpSide, up = tmpUp) {
    for (let i = 0; i < this.trails.length; i++) {
      this.anchors[i].getWorldPosition(tmpV);
      this.trails[i].push(tmpV, side, up, opts.overdrive ? 1.1 : 0.35 + opts.power * 0.35, time);
    }
  }

  /** The light pool under the ship only makes sense above a track. */
  setUnderglow(on: boolean) {
    this.underglow.visible = on;
  }

  /** New colours / texture scale on the same parts and finish: no rebuild needed. */
  recolor(l: Loadout) {
    this.loadout = l;
    this.model.recolor(l);
    this.edgeBase = this.model.neonMat.color.clone();
    this.color.set(l.glow);
    this.trailColor.copy(this.color);
    (this.flameMat.uniforms.uColor.value as THREE.Color).copy(this.color);
    (this.glowMat.uniforms.uColor.value as THREE.Color).copy(this.color);
  }

  pulse(color: THREE.Color, strength = 1) {
    this.pulseColor.copy(color);
    this.pulseAmt = Math.max(this.pulseAmt, strength);
  }

  addTo(scene: THREE.Object3D) {
    scene.add(this.root, ...this.trails.map((t) => t.mesh));
  }

  removeFrom(scene: THREE.Object3D) {
    scene.remove(this.root, ...this.trails.map((t) => t.mesh));
  }

  resetTrails() {
    for (const t of this.trails) t.reset();
  }

  dispose() {
    for (const t of this.trails) t.dispose();
    this.model.dispose();
    this.flameMat.dispose();
    this.flameGeo.dispose();
    this.glowMat.dispose();
    this.glowGeo.dispose();
  }
}
