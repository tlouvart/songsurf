import type { AudioAnalysis, Band } from './analyze.ts';

/**
 * Song analysis as JSON, exactly: feature curves travel as base64 Float32 and the rest as
 * plain numbers (JSON round-trips doubles exactly). The server analyses every song once and
 * both sides build the track from this same data, so everyone rides the same blocks and the
 * server can replay anyone's run.
 */

/** Bump when the analysis changes: cached analyses are recomputed. */
export const ANALYSIS_VERSION = 1;

const CURVES = ['loudness', 'intensity', 'low', 'mid', 'high', 'centroid'] as const;

export interface EncodedAnalysis {
  v: number;
  duration: number;
  fps: number;
  bpm: number;
  beats: number[];
  downbeatPhase: number;
  drops: number[];
  /** [time, strength, band, pitch, …] */
  onsets: number[];
  curves: Record<(typeof CURVES)[number], string>;
}

function toBase64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Float32Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export function encodeAnalysis(a: AudioAnalysis): EncodedAnalysis {
  return {
    v: ANALYSIS_VERSION,
    duration: a.duration,
    fps: a.fps,
    bpm: a.bpm,
    beats: a.beats,
    downbeatPhase: a.downbeatPhase,
    drops: a.drops,
    onsets: a.onsets.flatMap((o) => [o.time, o.strength, o.band, o.pitch]),
    curves: Object.fromEntries(CURVES.map((k) => [k, toBase64(a[k])])) as EncodedAnalysis['curves'],
  };
}

export function decodeAnalysis(e: EncodedAnalysis): AudioAnalysis {
  const onsets = [];
  for (let i = 0; i < e.onsets.length; i += 4) {
    onsets.push({ time: e.onsets[i], strength: e.onsets[i + 1], band: e.onsets[i + 2] as Band, pitch: e.onsets[i + 3] });
  }
  return {
    duration: e.duration,
    fps: e.fps,
    bpm: e.bpm,
    beats: e.beats,
    downbeatPhase: e.downbeatPhase,
    drops: e.drops,
    onsets,
    loudness: fromBase64(e.curves.loudness),
    intensity: fromBase64(e.curves.intensity),
    low: fromBase64(e.curves.low),
    mid: fromBase64(e.curves.mid),
    high: fromBase64(e.curves.high),
    centroid: fromBase64(e.curves.centroid),
  };
}
