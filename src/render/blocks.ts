import * as THREE from 'three';
import type { Ripples } from './ripples.ts';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { frameAtS, HALF_WIDTH, laneX, newFrame, type Block, type Frame, type Track } from '../track/track.ts';
import { FOG_GLSL, GEM_COLOR, GREY_COLOR, TIER_COLORS, intensityColor, shared } from './palette.ts';

const VIEW_AHEAD = 520;
const VIEW_BEHIND = 40;

const m4 = new THREE.Matrix4();
const basis = new THREE.Matrix4();
const q = new THREE.Quaternion();
const v = new THREE.Vector3();
const sc = new THREE.Vector3();
const col = new THREE.Color();
const fr: Frame = newFrame();
const ax = new THREE.Vector3();
const ay = new THREE.Vector3();
const az = new THREE.Vector3();
const localQ = new THREE.Quaternion();
const euler = new THREE.Euler(0, 0, 0, 'YXZ');

/** Build a transform on the track frame: lateral x, height h, rotation `spin` about local up. */
export function place(f: Frame, x: number, h: number, spin: number, scale: THREE.Vector3, out: THREE.Matrix4, tilt = 0) {
  basis.makeBasis(ax.set(f.rx, f.ry, f.rz), ay.set(f.ux, f.uy, f.uz), az.set(-f.fx, -f.fy, -f.fz));
  q.setFromRotationMatrix(basis);
  if (spin !== 0 || tilt !== 0) q.multiply(localQ.setFromEuler(euler.set(tilt, spin, 0, 'YXZ')));
  v.set(f.px + f.rx * x + f.ux * h, f.py + f.ry * x + f.uy * h, f.pz + f.rz * x + f.uz * h);
  out.compose(v, q, scale);
}

const BLOCK_VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vColor;
varying float vDist;
void main() {
  vLocal = position;
  vColor = instanceColor;
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  vNormalV = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  vViewDir = normalize(-mv.xyz);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

/**
 * Lit block shading. uStyle 0: good block — a glossy coloured gem with neon edges and an
 * inner glow. 1: bad block — brushed-steel spiked mine, no glow. 2: gem — bright crystal.
 */
const BLOCK_FRAG = /* glsl */ `
uniform float uBeat;
uniform vec3 uHalf;
uniform float uCore;
uniform float uStyle;
${FOG_GLSL}
varying vec3 vLocal;
varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vColor;
varying float vDist;
void main() {
  vec3 N = length(vNormalV) > 1e-5 ? normalize(vNormalV) : vec3(0.0, 0.0, 1.0);
  vec3 V = normalize(vViewDir);
  vec3 L = normalize(vec3(0.3, 0.85, 0.45));
  float diff = max(dot(N, L), 0.0);
  float spec = pow(max(dot(reflect(-L, N), V), 0.0), 28.0);
  float fres = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 2.5);
  vec3 c;
  if (uStyle < 0.5) {
    vec3 d = uHalf - abs(vLocal);
    float e1 = min(d.x, d.y), e2 = min(d.y, d.z), e3 = min(d.x, d.z);
    float edge = 1.0 - smoothstep(0.0, 0.12, min(min(e1, e2), e3));
    float top = smoothstep(0.4, 0.9, N.y);
    // Kept mostly below the bloom threshold so faces, shading and edges read as a solid.
    c = vColor * (0.1 + 0.42 * diff);
    c += vColor * uCore * (1.0 - fres) * 0.18;       // a hint of inner glow
    c += vColor * top * 0.12;
    c += vColor * edge * 0.9;                         // neon frame
    c += vec3(spec) * 0.3 + vColor * fres * 0.2;
  } else if (uStyle < 1.5) {
    float tip = smoothstep(1.15, 1.6, length(vLocal));
    vec3 steel = mix(vec3(0.34, 0.35, 0.39), vec3(0.8, 0.82, 0.86), tip);
    c = steel * (0.22 + 0.95 * diff) + vec3(spec) * 0.9 + vec3(0.85) * fres * 0.35;
  } else {
    c = vColor * (0.5 + 0.6 * diff) + vec3(spec) + vColor * fres * 0.8 + vColor * uCore * 0.4;
  }
  gl_FragColor = vec4(c * fogFade(vDist), 1.0);
}
`;

/** A steel sea-mine: faceted core with twelve spikes. Nothing like a good block. */
function mineGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [new THREE.IcosahedronGeometry(0.78, 1).toNonIndexed()];
  const dirs = new THREE.IcosahedronGeometry(1, 0).getAttribute('position');
  const seen: THREE.Vector3[] = [];
  for (let i = 0; i < dirs.count; i++) {
    const d = new THREE.Vector3().fromBufferAttribute(dirs, i).normalize();
    if (seen.some((o) => o.distanceTo(d) < 1e-3)) continue;
    seen.push(d);
    const cone = new THREE.ConeGeometry(0.2, 0.85, 6).toNonIndexed();
    cone.translate(0, 0.78 + 0.35, 0);
    cone.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d));
    parts.push(cone);
  }
  for (const g of parts) { g.deleteAttribute('uv'); g.deleteAttribute('normal'); }
  const merged = mergeGeometries(parts)!;
  merged.computeVertexNormals(); // non-indexed → flat facets, reads well
  return merged;
}

const HALO_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vDist;
void main() {
  vUv = uv;
  vColor = instanceColor;
  vec4 mv = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
const HALO_FRAG = /* glsl */ `
uniform float uBeat;
${FOG_GLSL}
varying vec2 vUv;
varying vec3 vColor;
varying float vDist;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = pow(max(0.0, 1.0 - r), 2.4);
  gl_FragColor = vec4(vColor * a * fogFade(vDist), 1.0);
}
`;

/** Neon-edged block material for instanced meshes (per-instance colour). */
export function makeBlockMaterial(half: THREE.Vector3, core: number, style = 0, extra: Partial<THREE.ShaderMaterialParameters> = {}) {
  return new THREE.ShaderMaterial({
    vertexShader: BLOCK_VERT,
    fragmentShader: BLOCK_FRAG,
    uniforms: { ...shared, uHalf: { value: half }, uCore: { value: core }, uStyle: { value: style } },
    ...extra,
  });
}

interface Pool {
  mesh: THREE.InstancedMesh;
  n: number;
}

function pool(geo: THREE.BufferGeometry, mat: THREE.Material, max: number): Pool {
  const mesh = new THREE.InstancedMesh(geo, mat, max);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  return { mesh, n: 0 };
}

function push(p: Pool, m: THREE.Matrix4, c: THREE.Color) {
  if (p.n >= p.mesh.instanceMatrix.count) return;
  p.mesh.setMatrixAt(p.n, m);
  p.mesh.setColorAt(p.n, c);
  p.n++;
}

function flush(p: Pool) {
  p.mesh.count = p.n;
  p.mesh.instanceMatrix.needsUpdate = true;
  if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
  p.n = 0;
}

/** Notes, hazards, gems, their light pools, plus the beat arches/rings. */
export class BlockField {
  group = new THREE.Group();
  private notes: Pool;
  private hazards: Pool;
  private gems: Pool;
  private halos: Pool;
  private arches: Pool;
  private rings: Pool;
  private first = 0;
  private firstBeat = 0;
  private disposables: { dispose(): void }[] = [];

  constructor(private tr: Track, private ripples: Ripples | null = null) {
    const blockMat = makeBlockMaterial;
    const noteGeo = new RoundedBoxGeometry(2.5, 1.4, 2.5, 3, 0.18);
    const mineGeo = mineGeometry();
    const gemGeo = new THREE.OctahedronGeometry(1.2, 0);
    gemGeo.scale(1, 1.6, 1);
    const haloGeo = new THREE.PlaneGeometry(1, 1);
    haloGeo.rotateX(-Math.PI / 2);
    const archGeo = new THREE.TorusGeometry(HALF_WIDTH + 2.2, 0.2, 6, 40, Math.PI);
    const ringGeo = new THREE.TorusGeometry(HALF_WIDTH + 3.2, 0.26, 6, 6);
    ringGeo.rotateZ(Math.PI / 6);

    const additive = {
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    } as const;
    const haloMat = new THREE.ShaderMaterial({ vertexShader: HALO_VERT, fragmentShader: HALO_FRAG, uniforms: shared, ...additive });
    const archMat = new THREE.MeshBasicMaterial({ toneMapped: false, transparent: true, opacity: 0.95 });

    this.notes = pool(noteGeo, blockMat(new THREE.Vector3(1.25, 0.7, 1.25), 0.5, 0), 400);
    this.hazards = pool(mineGeo, blockMat(new THREE.Vector3(9, 9, 9), 0, 1), 160);
    this.gems = pool(gemGeo, blockMat(new THREE.Vector3(9, 9, 9), 1.2, 2), 20);
    this.halos = pool(haloGeo, haloMat, 520);
    this.arches = pool(archGeo, archMat, 160);
    this.rings = pool(ringGeo, archMat, 160);
    for (const p of [this.halos, this.arches, this.rings, this.notes, this.hazards, this.gems]) this.group.add(p.mesh);
    this.halos.mesh.renderOrder = 1;
    this.disposables.push(noteGeo, mineGeo, gemGeo, haloGeo, archGeo, ringGeo, haloMat, archMat);
  }

  update(playerS: number) {
    const tr = this.tr;
    const blocks = tr.blocks;
    while (this.first < blocks.length && blocks[this.first].s < playerS - VIEW_BEHIND) this.first++;
    while (this.first > 0 && blocks[this.first - 1].s >= playerS - VIEW_BEHIND) this.first--;

    for (let i = this.first; i < blocks.length; i++) {
      const b = blocks[i];
      const rel = b.s - playerS;
      if (rel > VIEW_AHEAD) break;
      if (b.takenBy >= 0) continue;
      this.drawBlock(b, rel);
    }
    flush(this.notes);
    flush(this.hazards);
    flush(this.gems);
    flush(this.halos);

    this.drawBeats(playerS);
  }

  private drawBlock(b: Block, rel: number) {
    frameAtS(this.tr, b.s, fr);
    // Blocks drop in from above as they enter view, then bob to the beat.
    const appear = Math.min(1, Math.max(0, (VIEW_AHEAD - rel) / 90));
    const ease = 1 - Math.pow(1 - appear, 3);
    const drop = (1 - ease) * 26;
    const missed = b.resolved && rel < 0;
    const x = laneX(b.lane);
    const lift = this.ripples ? this.ripples.height(b.s, x) : 0;

    if (b.kind === 'note' || b.kind === 'pellet') {
      const k = ease * (missed ? 0.7 : 1);
      place(fr, x, 1.15 + lift + drop, 0, sc.set(k, k, k), m4);
      col.copy(TIER_COLORS[b.tier]);
      if (missed) col.multiplyScalar(0.25);
      push(this.notes, m4, col);
    } else if (b.kind === 'grey') {
      const k = ease * 1.25 * (missed ? 0.7 : 1);
      place(fr, x, 2.0 + lift + drop, 0.3, sc.set(k, k, k), m4);
      col.copy(GREY_COLOR);
      if (missed) col.multiplyScalar(0.4);
      push(this.hazards, m4, col);
    } else {
      const k = ease * 1.1;
      place(fr, x, 1.9 + lift + drop, Math.PI / 4, sc.set(k, k, k), m4);
      col.copy(GEM_COLOR);
      push(this.gems, m4, col);
    }
    // Light pool on the track under each block.
    const hs = (b.kind === 'gem' ? 9 : 5.5) * ease;
    place(fr, x, 0.06 + lift, 0, sc.set(hs, 1, hs), m4);
    col.copy(b.kind === 'grey' ? GREY_COLOR : b.kind === 'gem' ? GEM_COLOR : TIER_COLORS[b.tier]).multiplyScalar(missed ? 0.06 : b.kind === 'grey' ? 0.12 : 0.3);
    push(this.halos, m4, col);
  }

  private drawBeats(playerS: number) {
    const beats = this.tr.beats;
    while (this.firstBeat < beats.length && beats[this.firstBeat].s < playerS - 30) this.firstBeat++;
    while (this.firstBeat > 0 && beats[this.firstBeat - 1].s >= playerS - 30) this.firstBeat--;
    for (let i = this.firstBeat; i < beats.length; i++) {
      const bm = beats[i];
      const rel = bm.s - playerS;
      if (rel > VIEW_AHEAD) break;
      const hot = bm.intensity > 0.72;
      // Calm parts: arches on downbeats. Hot parts: a tunnel of rings on every beat.
      if (!hot && !bm.downbeat) continue;
      frameAtS(this.tr, bm.s, fr);
      const rise = Math.min(1, Math.max(0, (VIEW_AHEAD - rel) / 140));
      const e = 1 - Math.pow(1 - rise, 3);
      const passed = rel < 0 ? Math.max(0, 1 + rel / 30) : 1;
      const k = e * (bm.downbeat ? 1.08 : 1);
      place(fr, 0, hot ? 0.2 : 0.1, 0, sc.set(k, k, k), m4);
      // The next arch lights up as it approaches.
      const glow = 1 + Math.exp(-Math.abs(rel - 20) / 25) * 1.2;
      intensityColor(bm.intensity, col).multiplyScalar((bm.downbeat ? 0.9 : 0.55) * glow * passed);
      push(hot ? this.rings : this.arches, m4, col);
    }
    flush(this.arches);
    flush(this.rings);
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    for (const p of [this.notes, this.hazards, this.gems]) {
      (p.mesh.material as THREE.Material).dispose();
      p.mesh.dispose();
    }
  }
}
