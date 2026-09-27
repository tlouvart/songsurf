import { FFT } from './fft.ts';

export type Band = 0 | 1 | 2; // low / mid / high

export interface Onset {
  time: number;
  /** 0..1, how much the onset stands out from its surroundings */
  strength: number;
  /** dominant band of the transient */
  band: Band;
  /** 0..1 brightness (spectral centroid, log scale) right after the onset */
  pitch: number;
}

export interface AudioAnalysis {
  duration: number;
  /** feature frames per second */
  fps: number;
  /** short-term loudness, 0..1 */
  loudness: Float32Array;
  /** long-term smoothed energy — the "mood" of the song, 0..1 */
  intensity: Float32Array;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  centroid: Float32Array;
  onsets: Onset[];
  bpm: number;
  beats: number[];
  /** index into `beats` of the first downbeat (bar start) */
  downbeatPhase: number;
  /** moments where the energy jumps up hard */
  drops: number[];
}

const TARGET_RATE = 22050;
const FRAME = 1024;
const HOP = 512;

function percentile(arr: ArrayLike<number>, p: number): number {
  const a = Float32Array.from(arr).sort();
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))];
}

function normalize(arr: Float32Array, lo = 0.05, hi = 0.98): Float32Array {
  const a = percentile(arr, lo);
  const b = percentile(arr, hi);
  const span = b - a || 1;
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Math.min(1, Math.max(0, (arr[i] - a) / span));
  return out;
}

/** Centered moving average over ±radius frames, O(n) via prefix sums. */
function smooth(arr: Float32Array, radius: number): Float32Array {
  const n = arr.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + arr[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - radius);
    const b = Math.min(n, i + radius + 1);
    out[i] = (prefix[b] - prefix[a]) / (b - a);
  }
  return out;
}

function resample(samples: Float32Array, rate: number): { data: Float32Array; rate: number } {
  const factor = Math.max(1, Math.round(rate / TARGET_RATE));
  if (factor === 1) return { data: samples, rate };
  const n = Math.floor(samples.length / factor);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += samples[i * factor + k];
    data[i] = s / factor;
  }
  return { data, rate: rate / factor };
}

export function analyzeAudio(
  input: Float32Array,
  inputRate: number,
  onProgress: (p: number) => void = () => {},
): AudioAnalysis {
  const { data, rate } = resample(input, inputRate);
  const duration = input.length / inputRate;
  const fps = rate / HOP;
  const frames = Math.max(1, Math.floor((data.length - FRAME) / HOP) + 1);
  const bins = FRAME / 2;
  const binHz = rate / FRAME;
  const lowEnd = Math.max(2, Math.round(160 / binHz));
  const midEnd = Math.round(2200 / binHz);

  const fft = new FFT(FRAME);
  const win = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const logMag = new Float32Array(bins);
  const prevLog = new Float32Array(bins);

  const rms = new Float32Array(frames);
  const eLow = new Float32Array(frames);
  const eMid = new Float32Array(frames);
  const eHigh = new Float32Array(frames);
  const flux = new Float32Array(frames);
  const fLow = new Float32Array(frames);
  const fMid = new Float32Array(frames);
  const fHigh = new Float32Array(frames);
  const centroid = new Float32Array(frames);

  const logLo = Math.log(80);
  const logHi = Math.log(8000);

  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let sq = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = data[off + i];
      sq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sq / FRAME);
    fft.transform(re, im);

    let lo = 0, mi = 0, hi = 0, fl = 0, fm = 0, fh = 0, wsum = 0, msum = 0;
    for (let k = 1; k < bins; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const p = mag * mag;
      const l = Math.log1p(mag);
      const d = l - prevLog[k];
      const pos = d > 0 ? d : 0;
      logMag[k] = l;
      if (k < lowEnd) { lo += p; fl += pos; }
      else if (k < midEnd) { mi += p; fm += pos; }
      else { hi += p; fh += pos; }
      wsum += k * mag;
      msum += mag;
    }
    prevLog.set(logMag);
    eLow[f] = lo; eMid[f] = mi; eHigh[f] = hi;
    // Weight low-band flux up: few bins, but kicks drive the feel of a track.
    fLow[f] = fl * 4;
    fMid[f] = fm;
    fHigh[f] = fh * 0.6;
    flux[f] = fLow[f] + fMid[f] + fHigh[f];
    const hz = msum > 0 ? (wsum / msum) * binHz : 80;
    centroid[f] = Math.min(1, Math.max(0, (Math.log(Math.max(80, hz)) - logLo) / (logHi - logLo)));

    if ((f & 255) === 0) onProgress((f / frames) * 0.8);
  }
  flux[0] = fLow[0] = fMid[0] = fHigh[0] = 0;

  const toDb = (a: Float32Array) => a.map((v) => 10 * Math.log10(v + 1e-10));
  const loudness = normalize(rms.map((v) => 20 * Math.log10(v + 1e-6)));
  const low = normalize(toDb(eLow));
  const mid = normalize(toDb(eMid));
  const high = normalize(toDb(eHigh));

  // ---- onset detection -------------------------------------------------
  const fluxScale = percentile(flux, 0.97) || 1;
  const nflux = flux.map((v) => v / fluxScale);
  const localMean = smooth(nflux, Math.round(fps * 0.35));
  const odf = new Float32Array(frames);
  for (let i = 0; i < frames; i++) odf[i] = Math.max(0, nflux[i] - localMean[i]);
  const odfScale = percentile(odf, 0.985) || 1;

  const bandMeans = [fLow, fMid, fHigh].map((b) => {
    let s = 0;
    for (let i = 0; i < b.length; i++) s += b[i];
    return s / b.length || 1;
  });

  const onsets: Onset[] = [];
  const peakRadius = 3;
  const minGap = 0.075;
  const silence = percentile(rms, 0.1) * 1.5;
  for (let i = peakRadius; i < frames - peakRadius; i++) {
    const v = odf[i];
    if (v < 0.06) continue;
    let isPeak = true;
    for (let k = -peakRadius; k <= peakRadius; k++) {
      if (k !== 0 && odf[i + k] > v) { isPeak = false; break; }
    }
    if (!isPeak || rms[i] < silence) continue;
    const time = (i * HOP + FRAME / 2) / rate;
    const strength = Math.min(1, v / odfScale);
    const last = onsets[onsets.length - 1];
    if (last && time - last.time < minGap) {
      if (strength > last.strength) onsets.pop();
      else continue;
    }
    const scores = [fLow[i] / bandMeans[0], fMid[i] / bandMeans[1], fHigh[i] / bandMeans[2]];
    const band = (scores[0] >= scores[1] && scores[0] >= scores[2] ? 0 : scores[1] >= scores[2] ? 1 : 2) as Band;
    const pitch = centroid[Math.min(frames - 1, i + 1)];
    onsets.push({ time, strength, band, pitch });
  }
  onProgress(0.85);

  // ---- tempo + beat tracking -------------------------------------------
  const tracked = trackBeats(odf, fps);
  const bpm = tracked.bpm;
  let beats = tracked.beats;
  // The tracker can lock onto the off-beats (a loud snare on 2 and 4, common in rock and
  // punk). Kicks belong on the beat: if the bass hits land half a beat off, shift the grid.
  {
    const spb = 60 / bpm;
    // Bass level right at the beat vs half a beat later (the level, not onsets: distorted
    // guitars blur low-band onsets in rock).
    const bassAt = (t: number) => low[Math.min(frames - 1, Math.max(0, Math.round(t * fps)))];
    let on = 0, off = 0;
    for (const b of beats) { on += bassAt(b); off += bassAt(b + spb / 2); }
    if (off > on * 1.06) {
      beats = beats.map((b) => b + spb / 2).filter((b) => b < duration);
      if (beats.length && beats[0] - spb >= 0) beats.unshift(beats[0] - spb);
    }
  }
  let downbeatPhase = 0;
  {
    let best = -1;
    for (let ph = 0; ph < 4; ph++) {
      let s = 0;
      for (let b = ph; b < beats.length; b += 4) {
        const fi = Math.round(beats[b] * fps);
        if (fi >= 0 && fi < frames) s += fLow[fi] + 0.3 * flux[fi];
      }
      if (s > best) { best = s; downbeatPhase = ph; }
    }
  }
  onProgress(0.93);

  // ---- intensity: long-term energy + onset density ----------------------
  const density = new Float32Array(frames);
  for (const o of onsets) {
    const fi = Math.round(o.time * fps);
    if (fi < frames) density[fi] += 0.5 + o.strength;
  }
  const loudSmooth = smooth(loudness, Math.round(fps * 1.5));
  const densSmooth = normalize(smooth(density, Math.round(fps * 2)), 0.02, 0.98);
  const highSmooth = smooth(high, Math.round(fps * 1.5));
  const raw = new Float32Array(frames);
  for (let i = 0; i < frames; i++) raw[i] = 0.6 * loudSmooth[i] + 0.28 * densSmooth[i] + 0.12 * highSmooth[i];
  // Blend absolute level with rank (histogram equalisation) so heavily compressed songs
  // still get calm and hot sections relative to themselves.
  const absolute = normalize(raw, 0.03, 0.97);
  const order = Array.from(raw.keys()).sort((p, q) => raw[p] - raw[q]);
  const rank = new Float32Array(frames);
  order.forEach((fi, r) => (rank[fi] = r / Math.max(1, frames - 1)));
  const blended = new Float32Array(frames);
  for (let i = 0; i < frames; i++) blended[i] = 0.45 * absolute[i] + 0.55 * rank[i];
  const intensity = smooth(blended, Math.round(fps * 0.6));

  // ---- drops: sharp rises of intensity ----------------------------------
  const drops: number[] = [];
  const winBefore = Math.round(fps * 4);
  const winAfter = Math.round(fps * 3);
  const iPrefix = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) iPrefix[i + 1] = iPrefix[i] + intensity[i];
  const mean = (a: number, b: number) => {
    a = Math.max(0, a); b = Math.min(frames, b);
    return b > a ? (iPrefix[b] - iPrefix[a]) / (b - a) : 0;
  };
  let lastDrop = -Infinity;
  const step = Math.max(1, Math.round(fps / 8));
  let bestI = -1, bestD = 0;
  for (let i = winBefore; i < frames - winAfter; i += step) {
    const d = mean(i, i + winAfter) - mean(i - winBefore, i);
    const after = mean(i, i + winAfter);
    if (d > 0.22 && after > 0.55) {
      if (d > bestD) { bestD = d; bestI = i; }
    } else if (bestI >= 0) {
      // The long windows find the region; the exact moment is the sharpest short-term jump
      // in loudness + bass within a few seconds of it.
      let jumpI = bestI, jump = -Infinity;
      const r = Math.round(fps * 0.5);
      for (let k = Math.max(r, bestI - Math.round(fps * 3)); k < Math.min(frames - r, bestI + Math.round(fps * 5)); k++) {
        let after = 0, before = 0;
        for (let m = 0; m < r; m++) {
          after += loudness[k + m] + low[k + m];
          before += loudness[k - 1 - m] + low[k - 1 - m];
        }
        if (after - before > jump) { jump = after - before; jumpI = k; }
      }
      const t = snapToBeat(jumpI / fps, beats);
      if (t - lastDrop > 10) { drops.push(t); lastDrop = t; }
      bestI = -1; bestD = 0;
    }
  }
  onProgress(1);

  return {
    duration, fps, loudness, intensity, low, mid, high, centroid, onsets, bpm, beats, downbeatPhase, drops,
  };
}

function snapToBeat(t: number, beats: number[]): number {
  let best = t, bd = Infinity;
  for (const b of beats) {
    const d = Math.abs(b - t);
    if (d < bd) { bd = d; best = b; }
    if (b > t + 1) break;
  }
  return bd < 0.4 ? best : t;
}

/** Tempo by autocorrelation, then Ellis-style dynamic-programming beat tracking. */
function trackBeats(odf: Float32Array, fps: number): { bpm: number; beats: number[] } {
  const n = odf.length;
  const env = smooth(odf, 1);
  const minLag = Math.floor((fps * 60) / 200);
  const maxLag = Math.ceil((fps * 60) / 60);
  const ac = new Float32Array(maxLag * 2 + 2);
  for (let lag = minLag; lag < ac.length; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += env[i] * env[i + lag];
    ac[lag] = s / (n - lag);
  }
  let bestLag = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (fps * 60) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.9, 2));
    const score = (ac[lag] + 0.5 * (ac[2 * lag] ?? 0)) * prior;
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  // Parabolic refinement for a fractional period.
  let period = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
    const den = a - 2 * b + c;
    if (den < 0) period = bestLag + (0.5 * (a - c)) / den;
  }
  let bpm = (fps * 60) / period;
  while (bpm < 85) { bpm *= 2; period /= 2; }
  while (bpm > 185) { bpm /= 2; period *= 2; }

  if (n < period * 4) {
    const beats: number[] = [];
    for (let t = 0; t < n / fps; t += 60 / bpm) beats.push(t);
    return { bpm, beats };
  }

  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) variance += (env[i] - mean) ** 2;
  const std = Math.sqrt(variance / n) || 1;
  const local = env.map((v) => v / std);

  const alpha = 120;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let i = 0; i < n; i++) {
    let best = 0, bi = -1;
    for (let prev = i - hi; prev <= i - lo; prev++) {
      if (prev < 0) continue;
      const r = Math.log((i - prev) / period);
      const s = score[prev] - alpha * r * r;
      if (bi < 0 || s > best) { best = s; bi = prev; }
    }
    score[i] = local[i] + (bi >= 0 ? Math.max(0, best) : 0);
    back[i] = bi >= 0 && best > 0 ? bi : -1;
  }
  let end = n - 1;
  for (let i = n - Math.round(period); i < n; i++) if (score[i] > score[end]) end = i;
  const frames: number[] = [];
  for (let i = end; i >= 0; i = back[i]) frames.push(i);
  frames.reverse();

  // The DP may not reach the start/end of the song; extend with the tempo grid.
  const beats = frames.map((f) => (f * HOP + FRAME / 2) / (fps * HOP));
  const spb = 60 / bpm;
  const duration = n / fps;
  while (beats.length && beats[0] - spb > 0) beats.unshift(beats[0] - spb);
  while (beats.length && beats[beats.length - 1] + spb < duration) beats.push(beats[beats.length - 1] + spb);
  return { bpm, beats };
}
