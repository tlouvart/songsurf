import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Loadout } from './catalog.ts';

/**
 * Procedural ship construction from a loadout. Conventions (ship space): x lateral, y up,
 * nose toward −z. Outlines are written in a top-view "shape space" (x, forward) through a few
 * control points, smoothed into curves, then extruded, lathed or swept into 3D.
 */

type P2 = [number, number];

export interface ShipModel {
  group: THREE.Group;
  /** engine exhausts: position of the nozzle (back end) and radius */
  nozzles: { pos: THREE.Vector3; r: number }[];
  wingtips: THREE.Vector3[];
  center: THREE.Vector3;
  /** painted materials (body + wings), for finish animation and hit tint */
  paintMats: THREE.MeshPhysicalMaterial[];
  neonMat: THREE.MeshBasicMaterial;
  /** apply new colours / texture scale without rebuilding (parts and finish unchanged) */
  recolor(l: Loadout): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

/** Smooth a half outline (nose → tail) through its control points. */
function smooth(half: P2[], samples = 28): P2[] {
  const curve = new THREE.CatmullRomCurve3(half.map(([x, y]) => new THREE.Vector3(x, y, 0)), false, 'centripetal');
  return curve.getSpacedPoints(samples).map((v) => [Math.max(0, v.x), v.y] as P2);
}

/** Mirror a half outline into a closed polygon, dropping duplicate points. */
function mirror(half: P2[]): P2[] {
  const left = half.slice(1).reverse().map(([x, y]) => [-x, y] as P2);
  if (half[0][0] !== 0) left.push([-half[0][0], half[0][1]]);
  const all = [...half, ...left];
  return all.filter((p, i) => {
    const q = all[(i + 1) % all.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-3;
  });
}

/** Extrude a top-view polygon into a slab of the given thickness, centred on y = y0. */
function slab(poly: P2[], depth: number, y0 = 0, bevel = 0.1, segments = 3): THREE.BufferGeometry {
  const shape = new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.85, bevelSegments: segments, curveSegments: 8,
  });
  g.rotateX(-Math.PI / 2); // shape y (forward) → −z, extrusion → +y
  g.translate(0, y0 - depth / 2, 0);
  return g;
}

/** Neon tube along a closed top-view outline at height y. */
function edge(poly: P2[], y: number, radius = 0.04): THREE.BufferGeometry {
  const pts = poly.map(([x, f]) => new THREE.Vector3(x, y, -f));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.05);
  return new THREE.TubeGeometry(curve, Math.max(60, poly.length * 6), radius, 5, true);
}

/** Side-profile fin (points in (back, up)), thickness along x, placed at x, rolled. */
function fin(profile: P2[], thickness: number, x: number, y: number, z: number, roll = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape(profile.map(([b, u]) => new THREE.Vector2(b, u)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.025, bevelSegments: 2 });
  g.rotateY(-Math.PI / 2); // shape x → +z (back), extrusion → −x
  g.translate(thickness / 2, 0, 0);
  if (roll) g.rotateZ(roll);
  g.translate(x, y, z);
  return g;
}

/** Engine nacelle: intake lip, body, tapered waist and flared exhaust bell. */
function nacelle(r: number, len: number): THREE.BufferGeometry {
  const h = len / 2;
  const profile: P2[] = [
    [r * 0.62, -h], [r * 0.92, -h + 0.05], [r, -h + 0.18], [r * 1.02, -h + len * 0.45],
    [r * 0.9, h - 0.28], [r * 0.94, h - 0.12], [r * 1.06, h],
  ];
  const g = new THREE.LatheGeometry(profile.map(([rr, y]) => new THREE.Vector2(rr, y)), 24);
  g.rotateX(Math.PI / 2); // profile y (front → back) → +z
  return g;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

interface HullSpec {
  half: P2[];
  depth: number;
  /** z of the tail (engines sit here) */
  tail: number;
  /** extra pieces for special hulls */
  booms?: { half: P2[]; x: number };
  intakes?: boolean;
}

const HULLS: Record<string, HullSpec> = {
  dart: { half: [[0, 2.9], [0.28, 1.9], [0.55, 0.6], [0.66, -0.8], [0.58, -1.6]], depth: 0.26, tail: 1.6, intakes: true },
  arrow: { half: [[0, 3.3], [0.2, 2.2], [0.42, 0.4], [0.5, -1.3], [0.4, -1.7]], depth: 0.24, tail: 1.7 },
  manta: { half: [[0, 2.4], [0.5, 1.7], [1.25, 0.4], [1.05, -0.9], [0.55, -1.6]], depth: 0.22, tail: 1.6 },
  shark: { half: [[0, 3.0], [0.3, 2.1], [0.72, 0.7], [0.6, -0.4], [0.76, -1.3], [0.4, -1.75]], depth: 0.28, tail: 1.75, intakes: true },
  falcon: { half: [[0, 2.8], [0.4, 1.95], [0.42, 0.9], [0.9, 0.25], [0.84, -1.3], [0.45, -1.75]], depth: 0.28, tail: 1.75, intakes: true },
  stingray: { half: [[0, 2.4], [0.62, 1.5], [1.35, 0.2], [0.95, -0.6], [0.35, -1.05], [0.06, -2.6]], depth: 0.2, tail: 1.15 },
  phantom: {
    half: [[0, 2.7], [0.3, 1.7], [0.42, -0.2], [0.34, -1.3]], depth: 0.26, tail: 1.8,
    booms: { half: [[0, 2.2], [0.17, 1.2], [0.22, -1.4], [0.15, -1.8]], x: 1.05 },
  },
};

interface WingSpec {
  /** outline with the root at x = 0 */
  pts: P2[];
  dihedral?: number;
  y?: number;
  winglet?: boolean;
}

const WINGS: Record<string, WingSpec[]> = {
  delta: [{ pts: [[0, 0.4], [1.6, -1.0], [1.65, -1.4], [0, -1.15]] }],
  swept: [{ pts: [[0, 0.2], [1.7, -1.1], [1.9, -1.5], [1.4, -1.45], [0, -0.9]], winglet: true }],
  blade: [{ pts: [[0, -1.0], [1.7, 0.25], [1.85, 0.0], [0, -1.5]], winglet: true }],
  bat: [{ pts: [[0, 0.3], [1.1, 0.1], [2.0, -0.5], [1.6, -0.7], [1.3, -1.3], [0.9, -0.9], [0.5, -1.4], [0, -1.1]] }],
  xsplit: [
    { pts: [[0, 0.0], [1.7, -0.6], [1.75, -0.9], [0, -1.0]], dihedral: 0.32, y: 0.09 },
    { pts: [[0, 0.0], [1.7, -0.6], [1.75, -0.9], [0, -1.0]], dihedral: -0.32, y: -0.09 },
  ],
  scythe: [{ pts: [[0, 0.4], [1.0, 0.35], [1.8, -0.1], [2.3, -1.0], [1.85, -0.75], [1.1, -0.5], [0, -0.6]] }],
  halo: [],
};

interface Nacelle { x: number; y: number; r: number; len: number }

function engineLayout(id: string, tipX: number): { nacelles: Nacelle[]; ring?: boolean } {
  switch (id) {
    case 'mono': return { nacelles: [{ x: 0, y: 0, r: 0.42, len: 1.6 }] };
    case 'triple': return { nacelles: [{ x: 0, y: 0.05, r: 0.3, len: 1.5 }, { x: -0.66, y: 0, r: 0.22, len: 1.2 }, { x: 0.66, y: 0, r: 0.22, len: 1.2 }] };
    case 'heavy': return { nacelles: [-0.6, 0.6].map((x) => ({ x, y: 0, r: 0.38, len: 1.8 })) };
    case 'ring': return { nacelles: [{ x: 0, y: 0, r: 0.32, len: 1.3 }], ring: true };
    case 'quad': {
      const outer = Math.max(1.2, tipX - 0.2);
      return { nacelles: [-outer, -0.42, 0.42, outer].map((x) => ({ x, y: 0, r: 0.22, len: 1.3 })) };
    }
    default: return { nacelles: [-0.45, 0.45].map((x) => ({ x, y: 0, r: 0.27, len: 1.4 })) };
  }
}

function fins(id: string, tail: number, top: number): THREE.BufferGeometry[] {
  const z = tail - 1.1;
  const blade: P2[] = [[0, 0], [1.0, 0], [0.97, 0.1], [0.45, 0.72], [0.18, 0.76]];
  switch (id) {
    case 'twin': return [fin(blade, 0.07, -0.5, top, z, 0.3), fin(blade, 0.07, 0.5, top, z, -0.3)];
    case 'spine': return [fin([[0, 0], [1.5, 0], [1.42, 0.08], [0.5, 0.5], [0.2, 0.52]], 0.08, 0, top, z - 0.5)];
    case 'tall': return [fin([[0, 0], [1.1, 0], [1.06, 0.14], [0.6, 1.2], [0.32, 1.22]], 0.09, 0, top, z)];
    case 'spoiler': {
      const wing = slab(mirror([[0, 0.24], [1.2, 0.22], [1.25, -0.2], [0, -0.22]]), 0.05, top + 0.62, 0.02, 2);
      wing.translate(0, 0, z + 0.75);
      const struts = [-0.62, 0.62].map((x) => fin([[0, 0], [0.3, 0], [0.22, 0.62], [0.08, 0.62]], 0.06, x, top, z + 0.6));
      return [wing, ...struts];
    }
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

const TEXTURE_ID: Record<string, number> = {
  none: 0, stripes: 1, chevrons: 2, split: 3, fade: 4, hex: 5, tiger: 6, camo: 7, circuit: 8, flames: 9,
};

const FINISHES: Record<string, Partial<THREE.MeshPhysicalMaterialParameters>> = {
  matte: { roughness: 0.85, metalness: 0.05 },
  metal: { roughness: 0.32, metalness: 0.85 },
  satin: { roughness: 0.5, metalness: 0.35, clearcoat: 0.35, clearcoatRoughness: 0.4 },
  carbon: { roughness: 0.42, metalness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.15 },
  chrome: { roughness: 0.06, metalness: 1 },
  pearl: { roughness: 0.22, metalness: 0.25, clearcoat: 1, clearcoatRoughness: 0.08, iridescence: 1, iridescenceIOR: 1.6, iridescenceThicknessRange: [200, 600] },
  holo: { roughness: 0.14, metalness: 0.9, iridescence: 1, iridescenceIOR: 1.9, iridescenceThicknessRange: [300, 900] },
};

const PAINT_FRAGMENT_HEAD = /* glsl */ `
varying vec3 vPat;
uniform vec3 uPatColor;
uniform float uPatScale;
uniform float uTexture;
uniform float uCarbon;
float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hexLines(vec2 p) {
  vec2 r = vec2(1.0, 1.732);
  vec2 a = mod(p, r) - r * 0.5;
  vec2 b = mod(p - r * 0.5, r) - r * 0.5;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  vec2 q = abs(g);
  float d = max(q.x * 0.866 + q.y * 0.5, q.y);
  return smoothstep(0.43, 0.47, d);
}
float texMask(vec3 pos) {
  int t = int(uTexture + 0.5);
  vec2 p = vec2(pos.x, -pos.z) / uPatScale; // x lateral, y forward
  float x = p.x, y = p.y;
  if (t == 1) return step(abs(x), 0.16) + step(abs(abs(x) - 0.32), 0.035);
  if (t == 2) return step(fract((y - abs(x) * 1.3) * 1.2), 0.3);
  if (t == 3) return step(0.0, pos.x);
  if (t == 4) return 1.0 - smoothstep(-1.6, 0.8, y);
  if (t == 5) return hexLines(p * 3.2);
  if (t == 6) return step(0.55, sin(y * 6.0 + sin(x * 5.0) * 1.6 + x * 2.0));
  if (t == 7) return step(0.62, pHash(floor(p * 5.0)));
  if (t == 8) {
    vec2 c = floor(p * 4.0); vec2 f = fract(p * 4.0);
    float h = pHash(c);
    float lineH = step(abs(f.y - 0.5), 0.06) * step(0.5, h);
    float lineV = step(abs(f.x - 0.5), 0.06) * step(h, 0.5);
    float dotMask = step(length(f - 0.5), 0.16) * step(0.8, h);
    return max(max(lineH, lineV), dotMask);
  }
  if (t == 9) {
    float k = -y + 1.4;
    float tongue = sin(x * 7.0) * 0.35 + sin(x * 13.0 + 1.3) * 0.18;
    return (1.0 - smoothstep(0.0, 0.05, k - 1.6 - tongue)) * step(0.0, k);
  }
  return 0.0;
}
`;

/**
 * A painted surface: finish + colour + the shared texture (drawn in ship space). Every
 * paint uses the same shader program: texture, weave and colours are uniforms, and
 * clearcoat / iridescence are always enabled (at ~0 when unused), so switching parts,
 * finishes or textures never triggers a shader compile.
 */
function paintMaterial(l: Loadout, color: string): THREE.MeshPhysicalMaterial {
  const f = { clearcoat: 0.001, clearcoatRoughness: 0.5, iridescence: 0.001, ...(FINISHES[l.finish] ?? FINISHES.metal) };
  f.clearcoat = Math.max(0.001, f.clearcoat ?? 0);
  f.iridescence = Math.max(0.001, f.iridescence ?? 0);
  const mat = new THREE.MeshPhysicalMaterial({ ...f });
  const uniforms = {
    uPatColor: { value: new THREE.Color() },
    uPatScale: { value: 1 },
    uTexture: { value: 0 },
    uCarbon: { value: 0 },
  };
  mat.userData.paint = uniforms;
  setPaint(mat, l, color);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPat;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPat = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PAINT_FRAGMENT_HEAD}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
diffuseColor.rgb = mix(diffuseColor.rgb, uPatColor, clamp(texMask(vPat), 0.0, 1.0));
diffuseColor.rgb *= 1.0 - uCarbon * (0.22 - 0.22 * step(0.5, fract((vPat.x + vPat.z) * 14.0)) * step(0.5, fract((vPat.x - vPat.z) * 14.0)));`);
  };
  mat.customProgramCacheKey = () => 'songsurf-paint';
  return mat;
}

/** Colours, texture and weave of a paint material, updated in place. */
function setPaint(mat: THREE.MeshPhysicalMaterial, l: Loadout, color: string) {
  const u = mat.userData.paint as { uPatColor: { value: THREE.Color }; uPatScale: { value: number }; uTexture: { value: number }; uCarbon: { value: number } };
  mat.color.set(color);
  if (l.finish === 'chrome') mat.color.lerp(new THREE.Color(1, 1, 1), 0.3);
  u.uPatColor.value.set(l.pattern);
  u.uPatScale.value = l.scale;
  u.uTexture.value = TEXTURE_ID[l.texture] ?? 0;
  u.uCarbon.value = l.finish === 'carbon' ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export function buildShip(l: Loadout): ShipModel {
  const hull = HULLS[l.hull] ?? HULLS.dart;
  const group = new THREE.Group();
  const geoms: THREE.BufferGeometry[] = [];
  const bodyMat = paintMaterial(l, l.body);
  const wingMat = paintMaterial(l, l.wing);
  const trimMat = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(l.trim), roughness: 0.3, metalness: 0.9, clearcoat: 0.4 });
  const neonMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(l.neon).multiplyScalar(2.4), toneMapped: false });
  const glow = new THREE.Color(l.glow);
  const glowMat = new THREE.MeshBasicMaterial({ color: glow.clone().multiplyScalar(2.2), toneMapped: false });
  const nozzleMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).lerp(glow, 0.55).multiplyScalar(1.4), toneMapped: false });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x05050a, roughness: 0.8 });
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0x050510, metalness: 0.2, roughness: 0.03, clearcoat: 1, emissive: new THREE.Color(l.neon), emissiveIntensity: 0.3,
  });
  const mats: THREE.Material[] = [bodyMat, wingMat, trimMat, neonMat, glowMat, nozzleMat, darkMat, glassMat];

  const body: THREE.BufferGeometry[] = [];
  const wing: THREE.BufferGeometry[] = [];
  const trim: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  const neon: THREE.BufferGeometry[] = [];
  const glowG: THREE.BufferGeometry[] = [];
  const nozzleGeo: THREE.BufferGeometry[] = [];

  // --- hull: base slab + raised deck, both smoothed
  const halfSmooth = smooth(hull.half);
  const poly = mirror(halfSmooth);
  const d = hull.depth;
  body.push(slab(poly, d, 0, 0.1, 3));
  const baseTop = d / 2 + 0.1;
  neon.push(edge(poly, baseTop - 0.02));
  const noseY = hull.half[0][1];
  const tailY = hull.half[hull.half.length - 1][1];
  const deckHalf = smooth(hull.half.map(([x, y]) => [x * 0.5, y * 0.82 + (noseY - noseY * 0.82) * 0.3] as P2))
    .filter(([, y]) => y > tailY + 0.25);
  const deckPoly = mirror(deckHalf);
  const deckDepth = d * 0.55;
  body.push(slab(deckPoly, deckDepth, baseTop + deckDepth / 2 - 0.02, 0.06, 3));
  const deckTop = baseTop + deckDepth + 0.04;
  neon.push(edge(deckPoly, deckTop - 0.03, 0.02));
  let halfWidth = Math.max(...hull.half.map(([x]) => x));

  if (hull.booms) {
    const boomPoly = mirror(smooth(hull.booms.half));
    for (const s of [-1, 1]) {
      const g = slab(boomPoly, d, 0, 0.08, 3);
      g.translate(s * hull.booms.x, 0, 0);
      body.push(g);
      const e = edge(boomPoly, baseTop - 0.02, 0.035);
      e.translate(s * hull.booms.x, 0, 0);
      neon.push(e);
    }
    // Plate joining the booms to the pod.
    const plate = slab(mirror([[0, 0.5], [hull.booms.x, 0.1], [hull.booms.x, -0.9], [0, -0.7]]), 0.08, 0, 0.03, 2);
    wing.push(plate);
    halfWidth = hull.booms.x + 0.2;
  }

  if (hull.intakes) {
    // Side air intakes: a trim cowl with a dark mouth.
    for (const s of [-1, 1]) {
      const x = s * (halfWidth * 0.62);
      const cowl = new THREE.CylinderGeometry(0.16, 0.2, 0.9, 16, 1, true);
      cowl.rotateX(Math.PI / 2);
      cowl.scale(1, 0.75, 1);
      cowl.translate(x, 0.12, 0.1);
      trim.push(cowl);
      const mouth = new THREE.CircleGeometry(0.15, 16);
      mouth.rotateY(Math.PI);
      mouth.scale(1, 0.75, 1);
      mouth.translate(x, 0.12, -0.34);
      dark.push(mouth);
    }
  }

  // --- wings (root at the hull side)
  const root = halfWidth * 0.8;
  let tipX = halfWidth + 0.2;
  let tipZ = 0.8;
  for (const w of WINGS[l.wings] ?? []) {
    const right = w.pts.map(([x, y]) => [x + root, y] as P2);
    const left = right.map(([x, y]) => [-x, y] as P2).reverse();
    const tip = right.reduce((a, b) => (b[0] > a[0] ? b : a));
    for (const [side, pts] of [[1, right], [-1, left]] as const) {
      const g = slab(pts, 0.08, w.y ?? 0, 0.035, 2);
      const e = edge(pts, (w.y ?? 0) + 0.08, 0.032);
      const parts = [g];
      if (w.winglet) parts.push(fin([[0, 0], [0.55, 0], [0.5, 0.08], [0.25, 0.45], [0.12, 0.45]], 0.05, side * tip[0], (w.y ?? 0) + 0.05, -tip[1] - 0.2));
      for (const p of [...parts, e]) if (w.dihedral) p.rotateZ(side * w.dihedral);
      wing.push(...parts);
      neon.push(e);
    }
    if (tip[0] > tipX) {
      tipX = tip[0];
      tipZ = -tip[1];
    }
  }
  if (l.wings === 'halo') {
    const ring = new THREE.TorusGeometry(1.8, 0.11, 12, 72);
    ring.translate(0, 0, 0.3);
    wing.push(ring);
    const ringNeon = new THREE.TorusGeometry(1.8, 0.03, 6, 96);
    ringNeon.scale(1.045, 1.045, 1);
    ringNeon.translate(0, 0, 0.3);
    neon.push(ringNeon);
    for (const s of [-1, 1]) {
      const strut = slab(mirror([[0, 0.2], [0.9, 0.1], [0.9, -0.1], [0, -0.2]]), 0.06, 0, 0.02, 1);
      strut.translate(s * (root + 0.45), 0, 0.3);
      wing.push(strut);
    }
    tipX = 1.8;
    tipZ = 0.3;
  }

  // --- fins
  wing.push(...fins(l.fins, hull.tail, baseTop - 0.05));

  // --- engines
  const layout = engineLayout(l.engines, tipX);
  const nozzles: ShipModel['nozzles'] = [];
  for (const n of layout.nacelles) {
    const zc = hull.tail - n.len / 2 + 0.3;
    const g = nacelle(n.r, n.len);
    g.translate(n.x, n.y, zc);
    trim.push(g);
    const back = zc + n.len / 2;
    const disc = new THREE.CircleGeometry(n.r * 0.9, 24);
    disc.translate(n.x, n.y, back - 0.06);
    nozzleGeo.push(disc);
    const lip = new THREE.TorusGeometry(n.r * 1.03, 0.028, 6, 32);
    lip.translate(n.x, n.y, back + 0.005);
    glowG.push(lip);
    nozzles.push({ pos: new THREE.Vector3(n.x, n.y, back), r: n.r });
  }
  if (layout.ring) {
    const r = new THREE.TorusGeometry(0.72, 0.12, 12, 48);
    r.translate(0, 0, hull.tail + 0.2);
    trim.push(r);
    const rn = new THREE.TorusGeometry(0.72, 0.035, 6, 64);
    rn.translate(0, 0, hull.tail + 0.33);
    glowG.push(rn);
    for (let k = 0; k < 3; k++) {
      const strut = new THREE.BoxGeometry(0.06, 0.45, 0.2);
      strut.translate(0, 0.55, 0);
      strut.rotateZ((k / 3) * Math.PI * 2);
      strut.translate(0, 0, hull.tail + 0.2);
      trim.push(strut);
    }
  }

  // --- cockpit: glass + neon frame
  const glass: THREE.BufferGeometry[] = [];
  const cy = deckTop - 0.05;
  const canopy = (sx: number, sy: number, sz: number, x: number, z: number) => {
    const g = new THREE.SphereGeometry(0.42, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(sx, sy, sz);
    g.translate(x, cy, z);
    glass.push(g);
    const frame = new THREE.TorusGeometry(0.42, 0.022, 6, 48);
    frame.rotateX(Math.PI / 2);
    frame.scale(sx * 1.02, 1, sz * 1.02);
    frame.translate(x, cy + 0.01, z);
    neon.push(frame);
  };
  switch (l.cockpit) {
    case 'bubble': canopy(0.9, 0.72, 2.2, 0, -0.35); break;
    case 'long': canopy(0.75, 0.58, 3.4, 0, -0.1); break;
    case 'twin': canopy(0.5, 0.66, 1.5, -0.24, -0.3); canopy(0.5, 0.66, 1.5, 0.24, -0.3); break;
    case 'visor': {
      const v = slab(mirror(smooth([[0, 0.45], [0.35, 0.3], [0.42, -0.1], [0.3, -0.25]], 16)), 0.1, cy + 0.06, 0.04, 2);
      v.translate(0, 0, -0.9);
      glass.push(v);
      const e = edge(mirror(smooth([[0, 0.45], [0.35, 0.3], [0.42, -0.1], [0.3, -0.25]], 16)), cy + 0.03, 0.02);
      e.translate(0, 0, -0.9);
      neon.push(e);
      break;
    }
    case 'crystal': {
      const s = new THREE.OctahedronGeometry(0.42, 0);
      s.scale(0.7, 0.85, 2.2);
      s.translate(0, cy + 0.14, -0.4);
      glass.push(s);
      break;
    }
  }

  // Merge each material group; keep the generators' (smooth) normals.
  const add = (list: THREE.BufferGeometry[], mat: THREE.Material, withNormals = true) => {
    if (!list.length) return;
    const prepared = list.map((g) => {
      const ng = g.index ? g.toNonIndexed() : g;
      for (const k of Object.keys(ng.attributes)) if (k !== 'position' && !(withNormals && k === 'normal')) ng.deleteAttribute(k);
      return ng;
    });
    const merged = mergeGeometries(prepared)!;
    for (const g of list) g.dispose();
    geoms.push(merged);
    group.add(new THREE.Mesh(merged, mat));
  };
  add(body, bodyMat);
  add(wing, wingMat);
  add(trim, trimMat);
  add(dark, darkMat);
  add(glass, glassMat);
  add(neon, neonMat, false);
  add(glowG, glowMat, false);
  add(nozzleGeo, nozzleMat, false);

  return {
    group,
    nozzles,
    wingtips: [new THREE.Vector3(-tipX, 0.05, tipZ + 0.2), new THREE.Vector3(tipX, 0.05, tipZ + 0.2)],
    center: new THREE.Vector3(0, 0, hull.tail + 0.3),
    paintMats: [bodyMat, wingMat],
    neonMat,
    recolor(n: Loadout) {
      setPaint(bodyMat, n, n.body);
      setPaint(wingMat, n, n.wing);
      trimMat.color.set(n.trim);
      neonMat.color.set(n.neon).multiplyScalar(2.4);
      glassMat.emissive.set(n.neon);
      const g = new THREE.Color(n.glow);
      glowMat.color.copy(g).multiplyScalar(2.2);
      nozzleMat.color.setRGB(1, 1, 1).lerp(g, 0.55).multiplyScalar(1.4);
    },
    dispose() {
      for (const g of geoms) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
