import { HALF_WIDTH } from '../track/track.ts';

/**
 * Water-like ripples on the track surface: every beat drops a "stone" just ahead of the
 * ship and rings spread out from it, sized by the bass; a light shimmer rides the bassline in
 * between. Purely visual: the track's path (and so the gameplay) never changes. The same
 * formula runs in the surface shader and here, so the ship and blocks ride the water.
 */

export const MAX_RIPPLES = 8;
/** ring wavelength, spreading speed and packet width (world units) */
const K = (2 * Math.PI) / 9;
const SPEED = 30;
const WIDTH = 15;
const DECAY = 1.1;
const EDGE0 = HALF_WIDTH - 3.5;
const EDGE1 = HALF_WIDTH - 0.2;

export const RIPPLE_GLSL = /* glsl */ `
uniform vec4 uRipples[${MAX_RIPPLES}];
uniform float uRippleTime;
uniform float uShimmer;
float rippleHeight(float s, float x) {
  float h = 0.0;
  for (int k = 0; k < ${MAX_RIPPLES}; k++) {
    vec4 r = uRipples[k];
    if (r.w <= 0.0) continue;
    float age = uRippleTime - r.z;
    if (age < 0.0 || age > 3.0) continue;
    float d = length(vec2(s - r.x, x - r.y));
    float front = d - ${SPEED.toFixed(1)} * age;
    float env = r.w * exp(-age * ${DECAY.toFixed(2)}) * smoothstep(0.0, 0.08, age) / (1.0 + d * 0.03);
    h += env * exp(-(front * front) / ${(WIDTH * WIDTH).toFixed(1)}) * sin(front * ${K.toFixed(4)});
  }
  h += uShimmer * sin(s * 0.9 - uRippleTime * 7.0) * sin(x * 1.1 + uRippleTime * 2.3);
  return h * (1.0 - smoothstep(${EDGE0.toFixed(2)}, ${EDGE1.toFixed(2)}, abs(x)));
}
`;

const smoothstep = (a: number, b: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class Ripples {
  /** per ripple: s, x, start time, amplitude (the shader's uRipples) */
  readonly data = new Float32Array(MAX_RIPPLES * 4);
  time = 0;
  shimmer = 0;
  private next = 0;

  reset() {
    this.data.fill(0);
    this.next = 0;
  }

  spawn(s: number, x: number, time: number, amp: number) {
    const o = this.next * 4;
    this.data[o] = s;
    this.data[o + 1] = x;
    this.data[o + 2] = time;
    this.data[o + 3] = amp;
    this.next = (this.next + 1) % MAX_RIPPLES;
  }

  /** Surface height offset at (s, x): the same as the shader's rippleHeight. */
  height(s: number, x: number): number {
    let h = 0;
    for (let k = 0; k < MAX_RIPPLES; k++) {
      const o = k * 4;
      const amp = this.data[o + 3];
      if (amp <= 0) continue;
      const age = this.time - this.data[o + 2];
      if (age < 0 || age > 3) continue;
      const d = Math.hypot(s - this.data[o], x - this.data[o + 1]);
      const front = d - SPEED * age;
      const env = (amp * Math.exp(-age * DECAY) * smoothstep(0, 0.08, age)) / (1 + d * 0.03);
      h += env * Math.exp(-(front * front) / (WIDTH * WIDTH)) * Math.sin(front * K);
    }
    h += this.shimmer * Math.sin(s * 0.9 - this.time * 7) * Math.sin(x * 1.1 + this.time * 2.3);
    return h * (1 - smoothstep(EDGE0, EDGE1, Math.abs(x)));
  }
}
