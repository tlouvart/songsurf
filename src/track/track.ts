import type { AudioAnalysis } from '../audio/analyze.ts';
import * as THREE from 'three';
import { clamp, hashString, lerp, mulberry32, smoothstep } from './random.ts';

const smootherstep = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);

/**
 * Bump whenever generation changes the layout of a song's track: ghosts and leaderboards
 * are keyed on it, since a recorded run only makes sense on the exact same track.
 */
export const TRACK_VERSION = 7;

export const LANES = 5;
export const LANE_WIDTH = 3.2;
export const HALF_WIDTH = (LANES * LANE_WIDTH) / 2;
export const laneX = (lane: number) => (lane - (LANES - 1) / 2) * LANE_WIDTH;

/** Seconds of track before the music starts (countdown run-up). */
export const PRE_ROLL = 4;
/** Seconds of track after the music ends (finish straight). */
const TAIL = 4;
/** Track samples per second of music. */
const SPS = 60;

export type BlockKind = 'note' | 'grey' | 'gem' | 'pellet';

export interface Block {
  id: number;
  time: number;
  s: number;
  lane: number;
  kind: BlockKind;
  /** colour/value tier 0 (cool) .. 4 (hot) */
  tier: number;
  strength: number;
  /** id of the other note of a chord, or -1 */
  partner: number;
  /** long block: the trail runs until this time (and s), optionally sliding to lane2 */
  holdEnd?: number;
  holdEndS?: number;
  holdLane2?: number;
  /** centre time of the slide to holdLane2 */
  holdShift?: number;
  /** pellet: which stream it belongs to */
  stream?: number;
  // --- runtime state, owned by the race simulation ---
  takenBy: number;
  resolved: boolean;
  /** long blocks: 0 pending, 1 riding, 2 completed, 3 broken or missed */
  holdState: number;
}

/** A fast run of small linked blocks ("pellets"): catch them all for a bonus. */
export interface Stream {
  id: number;
  start: number;
  end: number;
  count: number;
  tier: number;
  /** runtime: a pellet was missed */
  broken: boolean;
}

/** Lateral lane (fractional during a slide) of a long block at time t. */
export function holdLaneAt(b: Block, t: number): number {
  if (b.holdLane2 === undefined || b.holdShift === undefined) return b.lane;
  const u = clamp((t - (b.holdShift - 0.15)) / 0.3, 0, 1);
  return lerp(b.lane, b.holdLane2, smoothstep(u));
}

export interface BeatMark {
  time: number;
  s: number;
  downbeat: boolean;
  intensity: number;
}

export interface TrackElement {
  kind: 'loop' | 'roll';
  start: number;
  end: number;
  /** loop: side it shifts to; roll: roll direction */
  dir: 1 | -1;
  /** loop: sideways distance between entry and exit */
  shift: number;
}

export interface Frame {
  px: number; py: number; pz: number;
  fx: number; fy: number; fz: number;
  rx: number; ry: number; rz: number;
  ux: number; uy: number; uz: number;
}

export const newFrame = (): Frame => ({ px: 0, py: 0, pz: 0, fx: 0, fy: 0, fz: -1, rx: 1, ry: 0, rz: 0, ux: 0, uy: 1, uz: 0 });

export interface Track {
  seed: string;
  duration: number;
  bpm: number;
  count: number;
  /** distance along the track, per sample (0 at music start) */
  s: Float32Array;
  pos: Float32Array;
  fwd: Float32Array;
  right: Float32Array;
  up: Float32Array;
  /** the track's continuous ribbon twist (rad), without barrel rolls: for the camera */
  ribbon: Float32Array;
  intensity: Float32Array;
  speed: Float32Array;
  blocks: Block[];
  streams: Stream[];
  beats: BeatMark[];
  drops: { time: number; s: number }[];
  elements: TrackElement[];
  length: number;
  noteCount: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const indexAtTime = (tr: Track, t: number) => clamp((t + PRE_ROLL) * SPS, 0, tr.count - 1);

export function valueAt(arr: Float32Array, idx: number): number {
  const i = Math.floor(idx);
  const f = idx - i;
  if (i >= arr.length - 1) return arr[arr.length - 1];
  return arr[i] + (arr[i + 1] - arr[i]) * f;
}

export const sAtTime = (tr: Track, t: number) => valueAt(tr.s, indexAtTime(tr, t));

export function indexAtS(tr: Track, s: number): number {
  const a = tr.s;
  if (s <= a[0]) return 0;
  if (s >= a[tr.count - 1]) return tr.count - 1;
  let lo = 0, hi = tr.count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= s) lo = mid; else hi = mid;
  }
  return lo + (s - a[lo]) / (a[hi] - a[lo] || 1);
}

/** Interpolated frame (position + orthonormal-ish basis) at a fractional sample index. */
export function frameAt(tr: Track, idx: number, out: Frame): Frame {
  const i = Math.min(Math.floor(idx), tr.count - 2);
  const f = clamp(idx - i, 0, 1);
  const j = i * 3, k = j + 3;
  const L = (a: Float32Array, o: number) => a[j + o] + (a[k + o] - a[j + o]) * f;
  out.px = L(tr.pos, 0); out.py = L(tr.pos, 1); out.pz = L(tr.pos, 2);
  out.fx = L(tr.fwd, 0); out.fy = L(tr.fwd, 1); out.fz = L(tr.fwd, 2);
  out.rx = L(tr.right, 0); out.ry = L(tr.right, 1); out.rz = L(tr.right, 2);
  out.ux = L(tr.up, 0); out.uy = L(tr.up, 1); out.uz = L(tr.up, 2);
  return out;
}

export const frameAtS = (tr: Track, s: number, out: Frame) => frameAt(tr, indexAtS(tr, s), out);

/** World position of a point at distance s, lateral offset x, height h above the track surface. */
export function pointOn(fr: Frame, x: number, h: number, out: { x: number; y: number; z: number }) {
  out.x = fr.px + fr.rx * x + fr.ux * h;
  out.y = fr.py + fr.ry * x + fr.uy * h;
  out.z = fr.pz + fr.rz * x + fr.uz * h;
  return out;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function sampleFeature(arr: Float32Array, fps: number, t: number): number {
  const idx = clamp(t * fps, 0, arr.length - 1);
  return valueAt(arr, idx);
}

function smoothArray(arr: Float32Array, radius: number): Float32Array {
  const n = arr.length;
  const out = new Float32Array(n);
  let sum = 0;
  let a = 0, b = 0; // window [a, b)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n, i + radius + 1);
    while (b < hi) sum += arr[b++];
    while (a < lo) sum -= arr[a++];
    out[i] = sum / (b - a);
  }
  return out;
}

export function generateTrack(a: AudioAnalysis, seed: string): Track {
  const rng = mulberry32(hashString(seed));
  const count = Math.ceil((a.duration + PRE_ROLL + TAIL) * SPS) + 1;
  const dt = 1 / SPS;
  const timeOf = (i: number) => i * dt - PRE_ROLL;
  const spb = 60 / a.bpm;

  // --- per-sample musical drivers ---------------------------------------
  const intensity = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const t = timeOf(i);
    const inSong = clamp(t, 0, a.duration);
    let v = sampleFeature(a.intensity, a.fps, inSong);
    if (t < 0) v *= 0.3; // calm run-up
    if (t > a.duration) v *= Math.max(0, 1 - (t - a.duration) / TAIL);
    intensity[i] = v;
  }

  // Drop envelope: a short pull-up before the drop, then a dive and a speed burst.
  const drop = new Float32Array(count); // 0..1 burst after drop
  const tension = new Float32Array(count); // 0..1 before drop
  for (const d of a.drops) {
    for (let i = 0; i < count; i++) {
      const t = timeOf(i) - d;
      if (t >= 0 && t < 3) drop[i] = Math.max(drop[i], Math.pow(1 - t / 3, 1.6) * smoothstep(Math.min(1, t / 0.25)));
      if (t > -2.5 && t < 0) tension[i] = Math.max(tension[i], smoothstep(1 + t / 2.5));
    }
  }

  // Speed: the tempo sets the song's pace, the intensity swings it hard between calm
  // cruising and all-out sections, and drops kick it further.
  const tempoK = clamp(a.bpm / 118, 0.8, 1.4);
  const speed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const I = intensity[i];
    speed[i] = 100 * tempoK * lerp(0.58, 1.75, Math.pow(I, 1.4)) * (1 + 0.35 * drop[i] - 0.1 * tension[i]);
  }

  // --- bar grid used to time turns and coaster elements -------------------
  const bars: number[] = [];
  for (let b = a.downbeatPhase; b < a.beats.length; b += 4) bars.push(a.beats[b]);
  const barLen = spb * 4;
  const speedAt = (t: number) => speed[Math.round(clamp((t + PRE_ROLL) * SPS, 0, count - 1))];
  const elements = scheduleElements(a, bars, barLen, rng, speedAt);
  const inLoop = (t: number, pad = 0) => elements.some((e) => e.kind === 'loop' && t >= e.start - pad && t <= e.end + pad * 0.5);

  // Pass 1: turns. A new yaw-rate target is chosen every 1–4 bars (longer in calm music)
  // and eased in over that whole span, so turns are long sweeping arcs rather than jolts.
  // The target reacts to the current heading so the track never spirals around itself.
  const yawRate = new Float32Array(count);
  {
    let heading = 0;
    let barIdx = -1;
    let prevTarget = 0;
    let target = 0;
    let lastSign = rng() < 0.5 ? -1 : 1;
    let spanStart = -PRE_ROLL;
    let spanLen = barLen;
    let nextChange = 0;
    for (let i = 0; i < count; i++) {
      const t = timeOf(i);
      while (barIdx + 1 < bars.length && bars[barIdx + 1] <= t) {
        barIdx++;
        if (barIdx < nextChange) continue;
        const I = intensity[i];
        const hold = I < 0.35 ? 4 : I < 0.65 ? (rng() < 0.5 ? 2 : 4) : rng() < 0.5 ? 1 : 2;
        nextChange = barIdx + hold;
        prevTarget = lerp(prevTarget, target, smoothstep(clamp((t - spanStart) / spanLen, 0, 1)));
        spanStart = bars[barIdx];
        spanLen = barLen * hold;
        if (inLoop(t, barLen * 2) || inLoop(t + spanLen, barLen) || t > a.duration - 1) target = 0;
        else if (rng() < 0.15) target = 0;
        else {
          const sign = rng() < 0.7 ? -lastSign : lastSign;
          lastSign = sign;
          // Calm: wide, long arcs. Hot: tighter, snappier ones.
          target = sign * lerp(0.4, 1, rng()) * (hold >= 4 ? 0.8 : 1);
        }
        target -= clamp(heading / 1.4, -1, 1) * 0.6;
        target = clamp(target, -1.2, 1.2);
      }
      const tIn = clamp((t - spanStart) / spanLen, 0, 1);
      const amp = 0.22 + 0.38 * intensity[i];
      yawRate[i] = lerp(prevTarget, target, smoothstep(tIn)) * amp;
      heading += yawRate[i] * dt;
    }
  }
  const yawSmooth = smoothArray(smoothArray(yawRate, Math.round(SPS * 0.6)), Math.round(SPS * 0.6));

  // Heights: the song drawn as a ride. No dice here, every wave comes from the music:
  //  - dynamics: the track climbs while the music builds and dives as it releases,
  //  - melody: it lifts with brighter, higher notes and sinks with darker ones,
  //  - phrasing: a smooth swell locked to 2-bar phrases, deeper when the song is energetic,
  //  - Audiosurf's feel underneath (calm rides high, intense rides low), a lift hill into
  //    each drop and a plunge when it hits.
  const pitch = new Float32Array(count);
  {
    const feat = (arr: Float32Array) => {
      const out = new Float32Array(count);
      for (let i = 0; i < count; i++) out[i] = sampleFeature(arr, a.fps, clamp(timeOf(i), 0, a.duration));
      return out;
    };
    const half = Math.round((barLen / 2) * SPS);
    const energy = smoothArray(feat(a.loudness), Math.round(SPS * 0.6));
    const bright = feat(a.centroid);
    const melody = smoothArray(bright, Math.round(SPS * 0.35));
    const melodyBase = smoothArray(bright, Math.round(SPS * 6));
    const bass = smoothArray(feat(a.low), Math.round(SPS * 0.5));
    const phase0 = bars.length ? bars[0] : 0;
    for (let i = 0; i < count; i++) {
      const t = timeOf(i);
      const I = intensity[i];
      const rise = energy[Math.min(count - 1, i + half)] - energy[Math.max(0, i - half)];
      let p = lerp(0.1, -0.16, I);
      p += clamp(rise * 2.1, -0.34, 0.34);
      p += clamp((melody[i] - melodyBase[i]) * 2.1, -0.26, 0.26) * (0.45 + 0.55 * I);
      p += (0.07 + 0.27 * I * (0.5 + 0.5 * bass[i])) * Math.sin((2 * Math.PI * (t - phase0)) / (barLen * 2));
      p += 0.34 * tension[i] - 0.5 * drop[i];
      if (inLoop(t, barLen)) p *= 0.3;
      if (t < 0) p *= clamp((t + PRE_ROLL) / PRE_ROLL, 0, 1);
      pitch[i] = clamp(p, -0.8, 0.6);
    }
  }
  // Well smoothed: waves, never bumps.
  const pitchSmooth = smoothArray(smoothArray(pitch, Math.round(SPS * 0.4)), Math.round(SPS * 0.4));

  // Bank into turns, a bit more than physics would, for the swoop.
  const rollRaw = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    rollRaw[i] = clamp(-Math.atan((speed[i] * yawSmooth[i]) / 60), -0.85, 0.85);
  }
  const roll = smoothArray(rollRaw, Math.round(SPS * 0.5));

  // Twist: a slow, continuous extra roll of the track around its axis. Knots every 2–4
  // bars, amplitude growing with the music, so busy passages feel like a twisting ribbon.
  const twist = new Float32Array(count);
  {
    const knots: { t: number; v: number }[] = [{ t: -PRE_ROLL, v: 0 }];
    let sign = rng() < 0.5 ? -1 : 1;
    for (let b = 0; b < bars.length; ) {
      const t = bars[b];
      const I = sampleFeature(a.intensity, a.fps, t);
      const v = inLoop(t, barLen * 2) ? 0 : sign * lerp(0.05, 0.36, I) * lerp(0.5, 1, rng());
      if (rng() < 0.75) sign = -sign;
      knots.push({ t, v });
      b += I > 0.6 ? 2 : 4;
    }
    knots.push({ t: a.duration + TAIL, v: 0 });
    let k = 0;
    for (let i = 0; i < count; i++) {
      const t = timeOf(i);
      while (k + 1 < knots.length - 1 && knots[k + 1].t <= t) k++;
      const k0 = knots[k], k1 = knots[Math.min(k + 1, knots.length - 1)];
      const u = k1.t > k0.t ? clamp((t - k0.t) / (k1.t - k0.t), 0, 1) : 1;
      twist[i] = lerp(k0.v, k1.v, smootherstep(u));
    }
  }

  // The ribbon twist alone (not the barrel rolls): the camera takes part of it back out.
  const ribbon = twist.slice();

  // Occasional big moves layered on top of the flow: long slow barrel rolls, and loops on
  // the strongest drops (with a sideways shift so the exit clears the entry).
  const loopAngle = new Float32Array(count);
  const shift = new Float32Array(count);
  for (const e of elements) {
    for (let i = Math.max(0, Math.floor((e.start + PRE_ROLL) * SPS)); i < count; i++) {
      const t = timeOf(i);
      const u = clamp((t - e.start) / (e.end - e.start), 0, 1);
      const k = smootherstep(u);
      if (e.kind === 'loop') {
        loopAngle[i] += Math.PI * 2 * k;
        shift[i] += e.dir * e.shift * k;
      } else {
        twist[i] += Math.PI * 2 * e.dir * k;
      }
    }
  }

  // --- integrate the centre line -----------------------------------------
  // Orientation = cruise (yaw, pitch, bank) followed by the element rotations in the
  // local frame. Quaternions keep this well-defined upside down.
  const pos = new Float32Array(count * 3);
  const fwd = new Float32Array(count * 3);
  const right = new Float32Array(count * 3);
  const up = new Float32Array(count * 3);
  const s = new Float32Array(count);
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
  const qc = new THREE.Quaternion(), q = new THREE.Quaternion(), tmp = new THREE.Quaternion();
  const vf = new THREE.Vector3(), vr = new THREE.Vector3(), vu = new THREE.Vector3(), cr = new THREE.Vector3();
  let x = 0, y = 0, z = 0, yaw = 0, dist = 0;
  for (let i = 0; i < count; i++) {
    qc.setFromAxisAngle(Y, -yaw);
    qc.multiply(tmp.setFromAxisAngle(X, pitchSmooth[i]));
    qc.multiply(tmp.setFromAxisAngle(Z, roll[i]));
    q.copy(qc);
    if (loopAngle[i] !== 0) q.multiply(tmp.setFromAxisAngle(X, loopAngle[i]));
    if (twist[i] !== 0) q.multiply(tmp.setFromAxisAngle(Z, twist[i]));
    vf.set(0, 0, -1).applyQuaternion(q);
    vr.set(1, 0, 0).applyQuaternion(q);
    vu.set(0, 1, 0).applyQuaternion(q);
    const j = i * 3;
    pos[j] = x; pos[j + 1] = y; pos[j + 2] = z;
    fwd[j] = vf.x; fwd[j + 1] = vf.y; fwd[j + 2] = vf.z;
    right[j] = vr.x; right[j + 1] = vr.y; right[j + 2] = vr.z;
    up[j] = vu.x; up[j + 1] = vu.y; up[j + 2] = vu.z;
    s[i] = dist;
    const step = speed[i] * dt;
    const ds = i > 0 ? shift[i] - shift[i - 1] : 0;
    cr.set(1, 0, 0).applyQuaternion(qc);
    x += vf.x * step + cr.x * ds; y += vf.y * step + cr.y * ds; z += vf.z * step + cr.z * ds;
    dist += step;
    yaw += yawSmooth[i] * dt;
  }
  const s0 = s[Math.round(PRE_ROLL * SPS)];
  for (let i = 0; i < count; i++) s[i] -= s0;

  const track: Track = {
    seed, duration: a.duration, bpm: a.bpm, count, s, pos, fwd, right, up, ribbon, intensity, speed,
    blocks: [], streams: [], beats: [], drops: [], elements, length: s[count - 1], noteCount: 0,
  };

  track.beats = a.beats
    .filter((t) => t >= 0 && t <= a.duration)
    .map((t, i) => ({
      time: t,
      s: sAtTime(track, t),
      downbeat: (i - a.downbeatPhase) % 4 === 0,
      intensity: intensity[Math.round(indexAtTime(track, t))],
    }));
  track.drops = a.drops.map((t) => ({ time: t, s: sAtTime(track, t) }));
  const placed = placeBlocks(a, track, rng);
  track.blocks = placed.blocks;
  track.streams = placed.streams;
  track.noteCount = track.blocks.filter((b) => b.kind === 'note' || b.kind === 'pellet').length;
  return track;
}

/**
 * The rare "big moves": a loop on the strongest drops (each with its own radius), and long,
 * slow barrel rolls on some energetic phrases. Everything else is the continuous flow.
 */
function scheduleElements(a: AudioAnalysis, bars: number[], barLen: number, rng: () => number, speedAt: (t: number) => number): TrackElement[] {
  const out: TrackElement[] = [];
  const I = (t: number) => sampleFeature(a.intensity, a.fps, t);
  const free = (start: number, end: number, gap: number) =>
    start > 6 && end < a.duration - 4 && out.every((e) => end < e.start - gap || start > e.end + gap);
  let side: 1 | -1 = rng() < 0.5 ? 1 : -1;
  // Strongest drops first.
  const drops = [...a.drops].sort((p, q) => I(q + 2) - I(p + 2));
  for (const d of drops) {
    if (I(d + 2) < 0.6) continue;
    const radius = lerp(40, 75, rng());
    const len = clamp((2 * Math.PI * radius) / speedAt(d + 1), 2.4, 5.5);
    if (free(d, d + len, 35)) {
      out.push({ kind: 'loop', start: d, end: d + len, dir: side, shift: HALF_WIDTH * 2 + lerp(8, 30, rng()) });
      side = side === 1 ? -1 : 1;
    }
  }
  let rollDir: 1 | -1 = rng() < 0.5 ? 1 : -1;
  for (let b = 8; b < bars.length; b += 8) {
    const t = bars[b];
    if (I(t + barLen) < 0.55 || rng() > 0.45) continue;
    const len = clamp(barLen * (rng() < 0.5 ? 3 : 4), 5, 10);
    if (free(t, t + len, 25)) {
      out.push({ kind: 'roll', start: t, end: t + len, dir: rollDir, shift: 0 });
      rollDir = rollDir === 1 ? -1 : 1;
    }
  }
  return out.sort((p, q) => p.start - q.start);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

type Mode = 'pitch' | 'stairs' | 'zigzag' | 'stream';

function placeBlocks(a: AudioAnalysis, tr: Track, rng: () => number): { blocks: Block[]; streams: Stream[] } {
  const I = (t: number) => sampleFeature(a.intensity, a.fps, t);

  // 0. Streams: dense runs of hits (rolls, fast hats, arps) in energetic parts become chains
  //    of small linked blocks instead of being thinned away. A few per song, never back to back.
  const all = a.onsets.filter((o) => o.time > 3 && o.time < a.duration - 3).sort((p, q) => p.time - q.time);
  const windows: { start: number; end: number; times: number[] }[] = [];
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].time - all[j].time <= 0.17 && all[j + 1].time - all[i].time < 2.4) j++;
    const start = all[i].time, end = all[j].time;
    const times: number[] = [];
    for (let k = i; k <= j; k++) if (!times.length || all[k].time - times[times.length - 1] >= 0.1) times.push(all[k].time);
    const last = windows[windows.length - 1];
    if (times.length >= 6 && end - start >= 0.6 && I(start) > 0.4 && (!last || start - last.end > 11) && rng() < 0.55) {
      windows.push({ start, end, times });
    }
    i = j + 1;
  }
  const inStream = (t: number, pad = 0) => windows.some((w) => t >= w.start - pad && t <= w.end + pad);

  // 1. Thin the onsets: strongest first, respecting spacing and a density cap that
  //    grows with the song's intensity.
  const candidates = a.onsets.filter((o) => o.time > 1.2 && o.time < a.duration - 0.5 && o.strength > 0.05 && !inStream(o.time, 0.22));
  const byStrength = [...candidates].sort((p, q) => q.strength - p.strength);
  const accepted: typeof candidates = [];
  const sortedTimes: number[] = [];
  const insertSorted = (t: number) => {
    let lo = 0, hi = sortedTimes.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sortedTimes[m] < t) lo = m + 1; else hi = m; }
    sortedTimes.splice(lo, 0, t);
    return lo;
  };
  const countNear = (t: number, r: number) => {
    let n = 0;
    for (const x of sortedTimes) if (Math.abs(x - t) <= r) n++;
    return n;
  };
  for (const o of byStrength) {
    const inten = I(o.time);
    // Readable density: every block should be catchable by a good player.
    const minGap = lerp(0.32, 0.2, inten);
    const maxPerSec = lerp(1.2, 3.3, inten);
    let tooClose = false;
    for (const x of sortedTimes) if (Math.abs(x - o.time) < minGap) { tooClose = true; break; }
    if (tooClose || countNear(o.time, 1) >= maxPerSec * 2) continue;
    // Weak onsets only survive in busy sections.
    if (o.strength < 0.18 && inten < 0.6) continue;
    insertSorted(o.time);
    accepted.push(o);
  }
  accepted.sort((p, q) => p.time - q.time);

  const pitches = accepted.map((o) => o.pitch).sort((p, q) => p - q);
  const pitchRank = (p: number) => {
    let lo = 0, hi = pitches.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pitches[m] < p) lo = m + 1; else hi = m; }
    return pitches.length > 1 ? lo / (pitches.length - 1) : 0.5;
  };

  const barLen = (60 / a.bpm) * 4;
  const blocks: Block[] = [];
  let id = 0;
  const mk = (time: number, lane: number, kind: BlockKind, tier: number, strength: number): Block => ({
    id: id++, time, s: sAtTime(tr, time), lane, kind, tier, strength, partner: -1, takenBy: -1, resolved: false, holdState: 0,
  });

  let lane = 2;
  let dir = 1;
  let mode: Mode = 'pitch';
  let modeBar = -1;
  let zig = [1, 3];
  let prevTime = -10;
  let hazardLane = -1;
  let hazardTime = -10;
  for (let n = 0; n < accepted.length; n++) {
    const o = accepted[n];
    const inten = I(o.time);
    const bar = Math.floor(o.time / barLen);
    if (bar !== modeBar && bar % 2 === 0) {
      modeBar = bar;
      const r = rng();
      mode = r < 0.4 ? 'pitch' : r < 0.62 ? 'stairs' : r < 0.82 ? 'zigzag' : 'stream';
      const c = Math.floor(rng() * 4);
      zig = [c, c + 1 + (rng() < inten ? 1 : 0)].map((v) => Math.min(4, v));
    }
    const gap = o.time - prevTime;
    // Lane jumps scale with the time available to make them.
    const maxStep = gap < 0.3 ? 1 : gap < 0.55 ? 2 : 3;
    let want = lane;
    switch (mode) {
      case 'pitch': want = Math.round(pitchRank(o.pitch) * 4); break;
      case 'stairs':
        want = lane + dir;
        if (want < 0 || want > 4) { dir = -dir; want = lane + dir; }
        break;
      case 'zigzag': want = lane === zig[0] ? zig[1] : zig[0]; break;
      case 'stream': want = rng() < 0.25 ? lane + (rng() < 0.5 ? -1 : 1) : lane; break;
    }
    want = clamp(want, 0, 4);
    const before = lane;
    lane = clamp(lane + clamp(want - lane, -maxStep, maxStep), 0, 4);
    // Never ask the player to be exactly where an obstacle just was.
    if (lane === hazardLane && o.time - hazardTime < 0.3) lane = lane >= 2 ? lane - 1 : lane + 1;
    prevTime = o.time;

    const heat = clamp(o.strength * 0.55 + inten * 0.6, 0, 1);
    const tier = Math.min(4, Math.floor(heat * 5));
    const next = accepted[n + 1];

    // Hazards: in energetic sections, weak onsets become obstacles placed where the
    // player probably is, nudging them toward the next note.
    // Greys come from the softer hits *relative to their neighbours*, so every song gets
    // them in its busier parts, however loud or compressed it is.
    let localMax = 0;
    for (let m = Math.max(0, n - 4); m <= Math.min(accepted.length - 1, n + 4); m++) localMax = Math.max(localMax, accepted[m].strength);
    const soft = o.strength < localMax * 0.75;
    if (inten > 0.3 && soft && rng() < 0.1 + inten * 0.13 && next && n > 0 && gap > 0.2) {
      let hl = before;
      if (hl === lane || gap < 0.2) {
        const options = [0, 1, 2, 3, 4].filter((l) => Math.abs(l - lane) >= 2 && l !== before);
        hl = options.length ? options[Math.floor(rng() * options.length)] : -1;
      }
      if (hl >= 0) {
        blocks.push(mk(o.time, hl, 'grey', 4, o.strength));
        hazardLane = hl;
        hazardTime = o.time;
        lane = hl === before ? lane : before;
        continue;
      }
    }

    const b = mk(o.time, lane, 'note', tier, o.strength);
    blocks.push(b);

    // Chords on big hits force a choice between two lanes.
    if (o.strength > 0.8 && inten > 0.6 && rng() < 0.2) {
      const other = lane <= 1 ? lane + 2 + Math.floor(rng() * 2) : lane >= 3 ? lane - 2 - Math.floor(rng() * 2) : rng() < 0.5 ? 0 : 4;
      const c = mk(o.time, clamp(other, 0, 4), 'note', Math.min(4, tier + 1), o.strength);
      c.partner = b.id;
      b.partner = c.id;
      blocks.push(c);
    }
  }

  // Long blocks: on a strong hit followed by a sustained sound, a trail takes over the
  // next beat or two, absorbing the smaller hits inside it, and ends on a beat.
  blocks.sort((p, q) => p.time - q.time);
  const spb = 60 / a.bpm;
  const fi = (t: number) => Math.min(a.loudness.length - 1, Math.max(0, Math.round(t * a.fps)));
  const snapBeat = (t: number) => a.beats.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), t);
  let lastHoldEnd = -10;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== 'note' || b.partner >= 0 || b.time - lastHoldEnd < 4) continue;
    const inten = I(b.time);
    if (rng() > lerp(0.4, 0.14, inten)) continue;
    // Strong relative to its neighbours.
    const near = blocks.filter((o) => Math.abs(o.time - b.time) < 2 && o.kind === 'note');
    if (near.some((o) => o.strength > b.strength * 1.25)) continue;
    const beats = inten < 0.5 ? (rng() < 0.5 ? 3 : 4) : rng() < 0.6 ? 2 : 3;
    const end = snapBeat(b.time + beats * spb);
    const len = Math.min(end - b.time, 3.2);
    if (len < 0.6) continue;
    const windowEnd = b.time + len + 0.3;
    const inside = blocks.filter((o) => o !== b && o.time > b.time - 0.01 && o.time < windowEnd);
    if (inside.some((o) => o.kind === 'gem' || o.partner >= 0) || windows.some((w) => w.start < windowEnd && w.end > b.time)) continue;
    let sum = 0, n = 0;
    for (let f = fi(b.time + 0.1); f <= fi(b.time + len); f++) { sum += a.loudness[f]; n++; }
    if (!n || sum / n < 0.25) continue;
    for (const o of inside) blocks.splice(blocks.indexOf(o), 1);
    b.holdEnd = b.time + len;
    b.holdEndS = sAtTime(tr, b.holdEnd);
    if (len >= 1.2 && rng() < 0.45) {
      b.holdLane2 = clamp(b.lane + (b.lane === 0 ? 1 : b.lane === 4 ? -1 : rng() < 0.5 ? -1 : 1), 0, 4);
      b.holdShift = snapBeat(b.time + len * lerp(0.4, 0.6, rng()));
      if (b.holdShift <= b.time + 0.3 || b.holdShift >= b.holdEnd - 0.3) b.holdShift = b.time + len / 2;
    }
    // The next block must be reachable from where the trail ends.
    const nextB = blocks.find((o) => o.time >= windowEnd);
    if (nextB && nextB.time - b.holdEnd < 0.55) {
      const from = b.holdLane2 ?? b.lane;
      if (Math.abs(nextB.lane - from) > 1 && nextB.partner < 0) nextB.lane = from + Math.sign(nextB.lane - from);
    }
    lastHoldEnd = b.holdEnd;
  }

  // Streams: pellets snake from the lane of the note before, one lane every few pellets.
  const streams: Stream[] = [];
  for (const w of windows) {
    const prev = [...blocks].reverse().find((b) => b.time < w.start && b.kind !== 'grey');
    let l = prev ? (prev.holdLane2 ?? prev.lane) : 2;
    let d = l >= 3 ? -1 : l <= 1 ? 1 : rng() < 0.5 ? -1 : 1;
    const every = rng() < 0.5 ? 3 : 4;
    const st: Stream = { id: streams.length, start: w.times[0], end: w.times[w.times.length - 1], count: w.times.length, tier: 0, broken: false };
    streams.push(st);
    w.times.forEach((t, k) => {
      if (k > 0 && k % every === 0) {
        if (l + d < 0 || l + d > 4) d = -d;
        l += d;
      }
      const p = mk(t, l, 'pellet', 0, 0.5);
      p.stream = st.id;
      blocks.push(p);
    });
    // Keep the exit of a stream clear of greys.
    for (let k = blocks.length - 1; k >= 0; k--) {
      const b = blocks[k];
      if (b.kind === 'grey' && b.time > st.end && b.time - st.end < 0.4 && Math.abs(b.lane - l) <= 1) blocks.splice(k, 1);
    }
  }

  // Gems: one on every drop, plus the strongest hit in each long stretch without one.
  const gemTimes: number[] = [...a.drops];
  const window = 24;
  for (let t0 = 8; t0 < a.duration - 8; t0 += window) {
    if (gemTimes.some((g) => g >= t0 && g < t0 + window)) continue;
    let best: Block | null = null;
    for (const b of blocks) if (b.kind === 'note' && b.time >= t0 && b.time < t0 + window && (!best || b.strength > best.strength)) best = b;
    if (best) gemTimes.push(best.time);
  }
  for (const g of gemTimes) {
    // Turn the note closest to that time into a gem.
    let best: Block | null = null;
    for (const b of blocks) if (b.kind === 'note' && b.partner < 0 && (!best || Math.abs(b.time - g) < Math.abs(best.time - g))) best = b;
    if (best && Math.abs(best.time - g) < 0.6) {
      best.kind = 'gem';
      best.holdEnd = best.holdEndS = best.holdLane2 = best.holdShift = undefined;
    }
  }

  // Colour tiers by rank: calm passages come out purple/blue, hot ones yellow/red, and the
  // song as a whole uses every colour evenly.
  const notes = blocks.filter((b) => b.kind === 'note' || b.kind === 'gem');
  const heat = new Map(notes.map((b) => [b.id, b.strength * 0.12 + I(b.time) * 0.88 + (rng() - 0.5) * 0.05]));
  const ranked = [...notes].sort((p, q) => heat.get(p.id)! - heat.get(q.id)!);
  ranked.forEach((b, i) => (b.tier = Math.min(4, Math.floor((i / ranked.length) * 5))));
  // A stream takes the colour of the music around it.
  for (const st of streams) {
    const near = notes.reduce<Block | null>((best, b) => (!best || Math.abs(b.time - st.start) < Math.abs(best.time - st.start) ? b : best), null);
    st.tier = near ? near.tier : 2;
    for (const b of blocks) if (b.stream === st.id) b.tier = st.tier;
  }

  blocks.sort((p, q) => p.time - q.time || p.lane - q.lane);
  return { blocks, streams };
}

export function resetBlocks(tr: Track) {
  for (const b of tr.blocks) { b.takenBy = -1; b.resolved = false; b.holdState = 0; }
  for (const st of tr.streams) st.broken = false;
}
