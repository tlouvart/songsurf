import type { AudioAnalysis, Onset } from './analyze.ts';
import { mulberry32 } from '../track/random.ts';

/** A plausible-looking analysis without any audio: used for the menu's attract-mode track. */
export function fakeAnalysis(duration = 150, bpm = 128): AudioAnalysis {
  const rng = mulberry32(42);
  const fps = 43;
  const n = Math.ceil(duration * fps);
  const spb = 60 / bpm;
  const intensity = new Float32Array(n);
  const loudness = new Float32Array(n);
  const low = new Float32Array(n);
  const mid = new Float32Array(n);
  const high = new Float32Array(n);
  const centroid = new Float32Array(n);
  const sections = [0.25, 0.5, 0.95, 0.9, 0.35, 0.6, 1, 0.95, 0.4];
  const secLen = duration / sections.length;
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const s = Math.min(sections.length - 1, Math.floor(t / secLen));
    const next = sections[Math.min(sections.length - 1, s + 1)];
    const k = (t % secLen) / secLen;
    intensity[i] = sections[s] + (next - sections[s]) * Math.pow(k, 6);
    const beatPhase = (t % spb) / spb;
    const kick = Math.exp(-beatPhase * 10);
    low[i] = 0.2 + 0.8 * kick * intensity[i];
    mid[i] = 0.3 + 0.5 * intensity[i] * (0.5 + 0.5 * Math.sin(t * 7));
    high[i] = 0.2 + 0.6 * intensity[i] * Math.exp(-((t * 2) % spb) / spb * 6);
    loudness[i] = 0.3 + 0.6 * intensity[i];
    centroid[i] = 0.5;
  }
  const beats: number[] = [];
  for (let t = 0.2; t < duration; t += spb) beats.push(t);
  const onsets: Onset[] = [];
  let pitch = 0.5;
  for (let t = 0.2; t < duration; t += spb / 2) {
    const I = intensity[Math.floor(t * fps)];
    if (rng() > 0.35 + I * 0.6) continue;
    pitch = Math.min(1, Math.max(0, pitch + (rng() - 0.5) * 0.4));
    onsets.push({ time: t, strength: 0.2 + rng() * 0.8 * I, band: rng() < 0.4 ? 0 : rng() < 0.5 ? 1 : 2, pitch });
  }
  const drops = sections
    .map((v, i) => (i > 0 && v - sections[i - 1] > 0.3 ? i * secLen : -1))
    .filter((t) => t > 0)
    .map((t) => beats.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a)));
  return { duration, fps, loudness, intensity, low, mid, high, centroid, onsets, bpm, beats, downbeatPhase: 0, drops };
}
