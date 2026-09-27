import { HALF_WIDTH } from '../track/track.ts';

/**
 * Beat waves: when the drums keep a steady pattern, the track surface rolls in smooth waves
 * with a crest on every beat, like riding over ripples in time with the music. The height at
 * each crest follows how hard the drums hit there, and fades in and out with the pattern.
 * Purely visual: the track's path (and so the gameplay) never changes. The same formula runs
 * in the surface shader and here, so the ship and blocks ride the waves.
 */

export const MAX_BUMPS = 32;
/** waves rise from flat as they come into view, so they never pop in */
const RISE_FROM = 520;
const RISE_TO = 300;
const EDGE0 = HALF_WIDTH - 3.5;
const EDGE1 = HALF_WIDTH - 0.2;

/** Consecutive beats (s along the track, crest height); the wave runs between them. */
export const RIPPLE_GLSL = /* glsl */ `
uniform vec2 uBumps[${MAX_BUMPS}];
uniform float uBumpS;
float rippleHeight(float s, float x) {
  float h = 0.0;
  for (int k = 0; k < ${MAX_BUMPS - 1}; k++) {
    vec2 a = uBumps[k];
    vec2 b = uBumps[k + 1];
    if (b.x <= a.x) break;
    if (s < a.x || s >= b.x) continue;
    float u = (s - a.x) / (b.x - a.x);
    float amp = mix(a.y, b.y, u * u * (3.0 - 2.0 * u));
    float rise = 1.0 - smoothstep(${RISE_TO.toFixed(1)}, ${RISE_FROM.toFixed(1)}, s - uBumpS);
    h = amp * rise * (0.5 + 0.5 * cos(6.28318531 * u));
    break;
  }
  return h * (1.0 - smoothstep(${EDGE0.toFixed(2)}, ${EDGE1.toFixed(2)}, abs(x)));
}
`;

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Ripples {
  /** per beat: s, crest height (the shader's uBumps), in track order */
  readonly data = new Float32Array(MAX_BUMPS * 2);
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

  add(s: number, height: number) {
    if (this.n >= MAX_BUMPS) return;
    this.data[this.n * 2] = s;
    this.data[this.n * 2 + 1] = height;
    this.n++;
  }

  /** Surface height offset at (s, x): the same as the shader's rippleHeight. */
  height(s: number, x: number): number {
    let h = 0;
    for (let k = 0; k < this.n - 1; k++) {
      const as = this.data[k * 2], bs = this.data[k * 2 + 2];
      if (bs <= as) break;
      if (s < as || s >= bs) continue;
      const u = (s - as) / (bs - as);
      const amp = this.data[k * 2 + 1] + (this.data[k * 2 + 3] - this.data[k * 2 + 1]) * (u * u * (3 - 2 * u));
      const rise = 1 - smoothstep(RISE_TO, RISE_FROM, s - this.playerS);
      h = amp * rise * (0.5 + 0.5 * Math.cos(2 * Math.PI * u));
      break;
    }
    return h * (1 - smoothstep(EDGE0, EDGE1, Math.abs(x)));
  }
}
