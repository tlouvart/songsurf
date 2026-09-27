import * as THREE from 'three';

/** Block colours from cool (low value) to hot (high value). */
export const TIER_COLORS = [0x8a5cff, 0x2f7bff, 0x19e08a, 0xffc93c, 0xff2e5e].map((c) => new THREE.Color(c));
/** Grey blocks: dull on purpose, they are the ones to avoid. */
export const GREY_COLOR = new THREE.Color(0.62, 0.64, 0.7);
export const GEM_COLOR = new THREE.Color(0xfff1c2);
export const PLAYER_COLOR = 0x33e1ff;

/** Intensity → track colour. Shared with GLSL (see PALETTE_GLSL) so both stay in sync. */
const STOPS = [
  [0.0, new THREE.Color(0x2a1bff)],
  [0.35, new THREE.Color(0x7a2cff)],
  [0.6, new THREE.Color(0xff2bd0)],
  [0.82, new THREE.Color(0xff4a2a)],
  [1.0, new THREE.Color(0xff8a1a)],
] as const;

export function intensityColor(v: number, out = new THREE.Color()): THREE.Color {
  v = Math.min(1, Math.max(0, v));
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i];
    const [p0, c0] = STOPS[i - 1];
    if (v <= p1) return out.copy(c0).lerp(c1, (v - p0) / (p1 - p0));
  }
  return out.copy(STOPS[STOPS.length - 1][1]);
}

const g = (c: THREE.Color) => `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;

export const PALETTE_GLSL = /* glsl */ `
vec3 heatColor(float v) {
  v = clamp(v, 0.0, 1.0);
  vec3 c = mix(${g(STOPS[0][1])}, ${g(STOPS[1][1])}, smoothstep(${STOPS[0][0].toFixed(3)}, ${STOPS[1][0].toFixed(3)}, v));
  c = mix(c, ${g(STOPS[2][1])}, smoothstep(${STOPS[1][0].toFixed(3)}, ${STOPS[2][0].toFixed(3)}, v));
  c = mix(c, ${g(STOPS[3][1])}, smoothstep(${STOPS[2][0].toFixed(3)}, ${STOPS[3][0].toFixed(3)}, v));
  c = mix(c, ${g(STOPS[4][1])}, smoothstep(${STOPS[3][0].toFixed(3)}, ${STOPS[4][0].toFixed(3)}, v));
  return c;
}
`;

export const FOG_GLSL = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
vec3 applyFog(vec3 c, float dist) {
  return mix(c, uFogColor, smoothstep(uFogNear, uFogFar, dist));
}
float fogFade(float dist) {
  return 1.0 - smoothstep(uFogNear, uFogFar, dist);
}
`;

/** Uniforms shared by every custom material (same objects, so updating once updates all). */
export const shared = {
  uTime: { value: 0 },
  uBeat: { value: 0 },
  uBeatAge: { value: 10 },
  uEnergy: { value: 0 },
  uBass: { value: 0 },
  uPlayerS: { value: 0 },
  uPlayerX: { value: 0 },
  /** player speed, units/s: fine stripes fade out at high speed so they never strobe */
  uSpeed: { value: 0 },
  /** last catch: lane x, seconds since, colour — drives the streak down the lane */
  uHitX: { value: 0 },
  uHitAge: { value: 10 },
  uHitColor: { value: new THREE.Color() },
  uPlayerPos: { value: new THREE.Vector3() },
  uHeat: { value: new THREE.Color() },
  uFogColor: { value: new THREE.Color(0x05020d) },
  uFogNear: { value: 260 },
  uFogFar: { value: 900 },
  uBands: { value: new Float32Array(16) },
  /** track ripples (see ./ripples.ts) */
  uRipples: { value: new Float32Array(8 * 4) },
  uRippleTime: { value: 0 },
};
