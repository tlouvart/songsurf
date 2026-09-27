import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { frameAt, HALF_WIDTH, LANES, newFrame, valueAt, type Track } from '../track/track.ts';
import { FOG_GLSL, PALETTE_GLSL, shared } from './palette.ts';
import { RIPPLE_GLSL } from './ripples.ts';

interface ProfilePoint { x: number; h: number; u: number }

/** Sweep a 2D cross-section profile along the track's frames. */
function sweep(tr: Track, profile: ProfilePoint[], stride = 1, sub = 1): THREE.BufferGeometry {
  if (sub > 1) return sweepFine(tr, profile, sub);
  const rows = Math.floor((tr.count - 1) / stride) + 1;
  const cols = profile.length;
  const pos = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  const heat = new Float32Array(rows * cols);
  const upv = new Float32Array(rows * cols * 3);
  for (let r = 0; r < rows; r++) {
    const i = Math.min(tr.count - 1, r * stride);
    const j = i * 3;
    for (let c = 0; c < cols; c++) {
      const p = profile[c];
      const o = (r * cols + c) * 3;
      pos[o] = tr.pos[j] + tr.right[j] * p.x + tr.up[j] * p.h;
      pos[o + 1] = tr.pos[j + 1] + tr.right[j + 1] * p.x + tr.up[j + 1] * p.h;
      pos[o + 2] = tr.pos[j + 2] + tr.right[j + 2] * p.x + tr.up[j + 2] * p.h;
      uv[(r * cols + c) * 2] = p.u;
      uv[(r * cols + c) * 2 + 1] = tr.s[i];
      heat[r * cols + c] = tr.intensity[i];
      upv[o] = tr.up[j]; upv[o + 1] = tr.up[j + 1]; upv[o + 2] = tr.up[j + 2];
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aHeat', new THREE.BufferAttribute(heat, 1));
  g.setAttribute('aUp', new THREE.BufferAttribute(upv, 3));
  g.setIndex(idx);
  return g;
}

/** Like sweep, with `sub` rows per track sample (interpolated frames): for the ripples. */
function sweepFine(tr: Track, profile: ProfilePoint[], sub: number): THREE.BufferGeometry {
  const rows = (tr.count - 1) * sub + 1;
  const cols = profile.length;
  const pos = new Float32Array(rows * cols * 3);
  const upv = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  const heat = new Float32Array(rows * cols);
  const f = newFrame();
  for (let r = 0; r < rows; r++) {
    const idx = r / sub;
    frameAt(tr, idx, f);
    const s = valueAt(tr.s, idx);
    const h = valueAt(tr.intensity, idx);
    for (let c = 0; c < cols; c++) {
      const p = profile[c];
      const k = r * cols + c;
      pos[k * 3] = f.px + f.rx * p.x + f.ux * p.h;
      pos[k * 3 + 1] = f.py + f.ry * p.x + f.uy * p.h;
      pos[k * 3 + 2] = f.pz + f.rz * p.x + f.uz * p.h;
      upv[k * 3] = f.ux; upv[k * 3 + 1] = f.uy; upv[k * 3 + 2] = f.uz;
      uv[k * 2] = p.u;
      uv[k * 2 + 1] = s;
      heat[k] = h;
    }
  }
  const idx: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aHeat', new THREE.BufferAttribute(heat, 1));
  g.setAttribute('aUp', new THREE.BufferAttribute(upv, 3));
  g.setIndex(rows * cols > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : idx);
  return g;
}

const COMMON_VERT = /* glsl */ `
attribute vec2 aUv;
attribute float aHeat;
varying vec2 vUv;
varying float vHeat;
varying float vDist;
varying vec3 vWorld;
void main() {
  vUv = aUv;
  vHeat = aHeat;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

/** The driving surface: moved by the ripples along the track's up vector. */
const SURFACE_VERT = /* glsl */ `
attribute vec2 aUv;
attribute float aHeat;
attribute vec3 aUp;
varying vec2 vUv;
varying float vHeat;
varying float vDist;
varying vec3 vWorld;
${RIPPLE_GLSL}
void main() {
  vUv = aUv;
  vHeat = aHeat;
  float x = (aUv.x - 0.5) * ${(HALF_WIDTH * 2).toFixed(2)};
  vec3 p = position + aUp * rippleHeight(aUv.y, x);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const HEADER = /* glsl */ `
uniform float uTime;
uniform float uBeat;
uniform float uBeatAge;
uniform float uEnergy;
uniform float uBass;
uniform float uPlayerS;
uniform float uPlayerX;
uniform float uSpeed;
uniform float uHitX;
uniform float uHitAge;
uniform vec3 uHitColor;
varying vec2 vUv;
varying float vHeat;
varying float vDist;
varying vec3 vWorld;
${PALETTE_GLSL}
${FOG_GLSL}
float aaLine(float coord, float width) {
  float d = abs(fract(coord + 0.5) - 0.5);
  float w = max(fwidth(coord), 1e-4);
  return 1.0 - smoothstep(width, width + w * 1.5, d);
}
`;

const SURFACE_FRAG = /* glsl */ `
${HEADER}
${RIPPLE_GLSL}
void main() {
  float lanes = ${LANES.toFixed(1)};
  float lu = vUv.x * lanes;
  float s = vUv.y;
  float rel = s - uPlayerS;
  vec3 heat = heatColor(vHeat);

  // Dark glossy base with a subtle lane checker.
  float laneId = floor(lu);
  vec3 base = vec3(0.018, 0.012, 0.04) + heat * 0.035 * mod(laneId, 2.0);

  // Lane dividers and edges.
  float divider = aaLine(lu, 0.018);
  float edge = 1.0 - smoothstep(0.0, 0.035, min(vUv.x, 1.0 - vUv.x));
  // Cross grid scrolling past gives the speed read.
  // Fine cross lines would strobe at high speed: fade them out like motion blur would.
  float blur = 1.0 - smoothstep(130.0, 230.0, uSpeed);
  float grid = aaLine(s / 7.0, 0.02) * 0.55 * blur;
  // Chevrons in the centre of each lane, every 28 units.
  float ch = fract((s + abs(fract(lu) - 0.5) * 6.0) / 28.0);
  float chevron = smoothstep(0.0, 0.02, ch) * (1.0 - smoothstep(0.04, 0.08, ch)) * 0.35;

  // Beat shockwave racing ahead of the player.
  float wave = uBeatAge * 520.0;
  float pulse = exp(-abs(rel - wave) / 10.0) * exp(-uBeatAge * 2.2) * step(0.0, rel);
  // Glow around the player's lane.
  float pd = (vUv.x - 0.5) * ${(HALF_WIDTH * 2).toFixed(2)} - uPlayerX;
  float playerLane = exp(-pd * pd / 3.0);
  float near = exp(-abs(rel) / 40.0);

  vec3 col = base;
  col += heat * (divider * (0.32 + 0.55 * uBeat) + grid * (0.12 + uEnergy * 0.35));
  col += heat * chevron * (0.25 + uEnergy * 0.3);
  col += heat * edge * 1.3;
  col += heat * pulse * 0.25;
  col += heat * playerLane * near * 0.18;
  // Catch streak: light races down the lane the block was caught in.
  float hd = (vUv.x - 0.5) * ${(HALF_WIDTH * 2).toFixed(2)} - uHitX;
  float hitLane = exp(-hd * hd / 1.6);
  float front = uHitAge * (300.0 + uSpeed * 1.5);
  float streak = step(-4.0, rel) * (1.0 - smoothstep(front - 20.0, front + 6.0, rel)) * exp(-max(rel, 0.0) / 90.0);
  col += uHitColor * hitLane * streak * exp(-uHitAge * 5.0) * 1.4;
  // A faint reflection band of the heat colour.
  col += heat * 0.04 * (0.5 + 0.5 * sin(s * 0.05 + uTime * 0.7));

  // The swell catches a little light as it rolls by: a hint, not a flash.
  float rx = (vUv.x - 0.5) * ${(HALF_WIDTH * 2).toFixed(2)};
  float gs = rippleHeight(s + 0.5, rx) - rippleHeight(s - 0.5, rx);
  col += heat * clamp(-gs * 0.5, 0.0, 0.12);

  gl_FragColor = vec4(applyFog(col, vDist), 1.0);
}
`;

/** Curbs + underside. u runs around the profile; the curb tops are neon tubes. */
const BODY_FRAG = /* glsl */ `
${HEADER}
void main() {
  vec3 heat = heatColor(vHeat);
  float u = vUv.x;
  float s = vUv.y;
  // Tube highlight on the curb tops (u in [0.1,0.2] and [0.8,0.9]).
  float tube = smoothstep(0.1, 0.13, u) * (1.0 - smoothstep(0.17, 0.2, u)) + smoothstep(0.8, 0.83, u) * (1.0 - smoothstep(0.87, 0.9, u));
  // Running lights along the sides.
  float runner = mix(0.18, step(0.82, fract(s / 9.0)), 1.0 - smoothstep(110.0, 200.0, uSpeed)) * (step(u, 0.3) + step(0.7, u));
  vec3 col = vec3(0.012, 0.008, 0.03);
  col += heat * tube * (1.1 + 0.9 * uBeat);
  col += heat * runner * 0.4;
  col += heat * 0.05;
  gl_FragColor = vec4(applyFog(col, vDist), 1.0);
}
`;

/** Additive glow sheets (fences above curbs, curtain below). u: 0 at the base, 1 at the tip. */
const GLOW_FRAG = /* glsl */ `
${HEADER}
uniform float uStrength;
void main() {
  vec3 heat = heatColor(vHeat);
  float a = pow(clamp(1.0 - vUv.x, 0.0, 1.0), 2.2);
  float stripes = 0.55 + 0.45 * mix(0.5, step(0.5, fract(vUv.y / 6.0)), 1.0 - smoothstep(90.0, 170.0, uSpeed));
  float rel = vUv.y - uPlayerS;
  float wave = exp(-abs(rel - uBeatAge * 520.0) / 14.0) * exp(-uBeatAge * 2.0);
  float k = a * stripes * uStrength * (0.35 + uEnergy * 0.5 + uBeat * 0.3 + wave * 0.5);
  gl_FragColor = vec4(heat * k * fogFade(vDist), 1.0);
}
`;

export class TrackMesh {
  group = new THREE.Group();
  private geoms: THREE.BufferGeometry[] = [];

  constructor(tr: Track) {
    const HW = HALF_WIDTH;
    // Enough columns across the width for the ripples to take shape.
    const COLS = 15;
    const surface = sweep(tr, Array.from({ length: COLS }, (_, c) => ({ x: -HW + (2 * HW * c) / (COLS - 1), h: 0, u: c / (COLS - 1) })), 1, 2);
    const C = 0.55; // curb width
    const body = sweep(tr, [
      { x: -HW, h: 0.02, u: 0.05 },
      { x: -HW, h: 0.45, u: 0.1 },
      { x: -HW - C, h: 0.45, u: 0.2 },
      { x: -HW - C, h: -1.1, u: 0.3 },
      { x: HW + C, h: -1.1, u: 0.7 },
      { x: HW + C, h: 0.45, u: 0.8 },
      { x: HW, h: 0.45, u: 0.9 },
      { x: HW, h: 0.02, u: 0.95 },
    ]);
    const fenceL = sweep(tr, [
      { x: -HW - C * 0.5, h: 0.45, u: 0 },
      { x: -HW - C * 0.5 - 0.6, h: 3.2, u: 1 },
    ], 2);
    const fenceR = sweep(tr, [
      { x: HW + C * 0.5, h: 0.45, u: 0 },
      { x: HW + C * 0.5 + 0.6, h: 3.2, u: 1 },
    ], 2);
    const curtain = sweep(tr, [
      { x: -HW - C, h: -1.1, u: 0 },
      { x: -HW - C - 1, h: -9, u: 1 },
    ], 2);
    const curtainR = sweep(tr, [
      { x: HW + C, h: -1.1, u: 0 },
      { x: HW + C + 1, h: -9, u: 1 },
    ], 2);
    const fences = mergeGeometries([fenceL, fenceR])!;
    const curtains = mergeGeometries([curtain, curtainR])!;
    this.geoms.push(surface, body, fences, curtains, fenceL, fenceR, curtain, curtainR);

    const mat = (frag: string, extra: Partial<THREE.ShaderMaterialParameters> = {}, uniforms = {}, vert = COMMON_VERT) =>
      new THREE.ShaderMaterial({
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: { ...shared, ...uniforms },
        ...extra,
      });

    const add = (g: THREE.BufferGeometry, m: THREE.Material, order = 0) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      this.group.add(mesh);
    };
    add(surface, mat(SURFACE_FRAG, { side: THREE.DoubleSide }, {}, SURFACE_VERT));
    add(body, mat(BODY_FRAG, { side: THREE.DoubleSide }));
    const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide };
    add(fences, mat(GLOW_FRAG, additive, { uStrength: { value: 0.45 } }), 2);
    add(curtains, mat(GLOW_FRAG, additive, { uStrength: { value: 0.3 } }), 2);
  }

  dispose() {
    for (const g of this.geoms) g.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose();
    });
  }
}
