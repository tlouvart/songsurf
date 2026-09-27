import { HALF_WIDTH } from '../track/track.ts';

/**
 * Beat bumps: when the song has a steady kick or bassline, the track surface gets a soft hump
 * at the spot the ship reaches on each kick, so you see the groove coming and ride over it in
 * time. Purely visual: the track's path (and so the gameplay) never changes. The same formula
 * runs in the surface shader and here, so the ship and blocks ride the bumps.
 */

export const MAX_BUMPS = 24;
/** how far ahead bumps rise from flat, so they never pop in */
const RISE_FROM = 520;
const RISE_TO = 300;
const EDGE0 = HALF_WIDTH - 3.5;
const EDGE1 = HALF_WIDTH - 0.2;

export const RIPPLE_GLSL = /* glsl */ `
uniform vec3 uBumps[${MAX_BUMPS}];
uniform float uBumpS;
float rippleHeight(float s, float x) {
  float h = 0.0;
  for (int k = 0; k < ${MAX_BUMPS}; k++) {
    vec3 b = uBumps[k];
    if (b.y <= 0.0) continue;
    float u = (s - b.x) / b.z;
    if (abs(u) >= 1.0) continue;
    float rise = 1.0 - smoothstep(${RISE_TO.toFixed(1)}, ${RISE_FROM.toFixed(1)}, b.x - uBumpS);
    h += b.y * rise * (0.5 + 0.5 * cos(3.14159265 * u));
  }
  return h * (1.0 - smoothstep(${EDGE0.toFixed(2)}, ${EDGE1.toFixed(2)}, abs(x)));
}
`;

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Ripples {
  /** per bump: s (centre on the track), height, half-width (the shader's uBumps) */
  readonly data = new Float32Array(MAX_BUMPS * 3);
  /** the player's position along the track */
  playerS = 0;
  private n = 0;

  reset() {
    this.data.fill(0);
    this.n = 0;
  }

  begin(playerS: number) {
    this.playerS = playerS;
    this.data.fill(0);
    this.n = 0;
  }

  add(s: number, height: number, halfWidth: number) {
    if (this.n >= MAX_BUMPS) return;
    const o = this.n++ * 3;
    this.data[o] = s;
    this.data[o + 1] = height;
    this.data[o + 2] = halfWidth;
  }

  /** Surface height offset at (s, x): the same as the shader's rippleHeight. */
  height(s: number, x: number): number {
    let h = 0;
    for (let k = 0; k < this.n; k++) {
      const o = k * 3;
      const u = (s - this.data[o]) / this.data[o + 2];
      if (Math.abs(u) >= 1) continue;
      const rise = 1 - smoothstep(RISE_TO, RISE_FROM, this.data[o] - this.playerS);
      h += this.data[o + 1] * rise * (0.5 + 0.5 * Math.cos(Math.PI * u));
    }
    return h * (1 - smoothstep(EDGE0, EDGE1, Math.abs(x)));
  }
}
