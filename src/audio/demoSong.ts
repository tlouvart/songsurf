import { mulberry32 } from '../track/random.ts';
import { audioContext } from './loader.ts';

/**
 * A procedurally synthesized ~2 minute EDM track (intro, build, drop, breakdown, build, drop, outro).
 * It lets anyone try SongSurf instantly, without a YouTube link or the server, and doubles as a test
 * signal for the analysis pipeline.
 *
 * Synthesis is plain sample loops rather than an OfflineAudioContext: scheduling thousands of
 * nodes up front makes browsers process every one of them for the whole render, which is slow.
 */
export async function renderDemoSong(): Promise<AudioBuffer> {
  const { left, right, rate } = synthesize();
  const buf = audioContext().createBuffer(2, left.length, rate);
  buf.copyToChannel(left, 0);
  buf.copyToChannel(right, 1);
  return buf;
}

type Wave = 'saw' | 'square' | 'tri' | 'sine';

export function synthesize() {
  const rate = 44100;
  const bpm = 128;
  const spb = 60 / bpm;
  const bar = spb * 4;
  const bars = 64;
  const offset = 0.5;
  const length = Math.ceil((bars * bar + offset + 2) * rate);
  const drums = new Float32Array(length);
  const musL = new Float32Array(length);
  const musR = new Float32Array(length);
  const duck = new Float32Array(length).fill(1);
  const rng = mulberry32(1337);
  const noise = () => rng() * 2 - 1;
  const midi = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

  const osc = (wave: Wave, ph: number) => {
    switch (wave) {
      case 'saw': return 2 * ph - 1;
      case 'square': return ph < 0.5 ? 1 : -1;
      case 'tri': return 1 - 4 * Math.abs(ph - 0.5);
      default: return Math.sin(2 * Math.PI * ph);
    }
  };

  /** Filtered, enveloped oscillator note. pan: -1..1 */
  const tone = (t: number, len: number, freq: number, wave: Wave, gain: number, cutoff: number, attack = 0.005, detune = 0, pan = 0) => {
    const s0 = Math.floor(t * rate);
    const rel = 0.08;
    const n = Math.floor((len + rel) * rate);
    const f = freq * Math.pow(2, detune / 1200);
    const gl = gain * Math.min(1, 1 - pan), gr = gain * Math.min(1, 1 + pan);
    let ph = rng(), lp1 = 0, lp2 = 0, a = 0, env = 0;
    const inc = f / rate;
    for (let i = 0; i < n && s0 + i < length; i++) {
      ph += inc;
      if (ph >= 1) ph -= 1;
      if ((i & 15) === 0) {
        // Control-rate envelopes: recomputed every 16 samples.
        const ts = i / rate;
        env = ts < attack ? ts / attack : ts < len ? 1 : Math.exp(-(ts - len) / (rel / 4));
        const fc = cutoff * (1 + 2 * Math.exp(-ts / 0.08));
        a = 1 - Math.exp((-2 * Math.PI * fc) / rate);
      }
      lp1 += a * (osc(wave, ph) - lp1);
      lp2 += a * (lp1 - lp2);
      const v = lp2 * env;
      musL[s0 + i] += v * gl;
      musR[s0 + i] += v * gr;
    }
  };

  const kick = (t: number, gain = 1) => {
    const s0 = Math.floor(t * rate);
    const n = Math.floor(0.42 * rate);
    let ph = 0;
    for (let i = 0; i < n && s0 + i < length; i++) {
      const ts = i / rate;
      const f = 42 + 118 * Math.exp(-ts / 0.035);
      ph += f / rate;
      drums[s0 + i] += Math.sin(2 * Math.PI * ph) * Math.exp(-ts / 0.14) * gain * 0.9;
    }
    // Sidechain duck on the music bus.
    const dn = Math.floor(spb * 0.75 * rate);
    for (let i = 0; i < dn && s0 + i < length; i++) duck[s0 + i] = Math.min(duck[s0 + i], 0.25 + 0.75 * (i / dn));
  };

  /** Noise burst through a state-variable filter. */
  const noiseHit = (t: number, len: number, mode: 'hp' | 'bp', fc: number, gain: number, fcEnd = fc) => {
    const s0 = Math.floor(t * rate);
    const n = Math.floor(len * rate);
    let low = 0, band = 0;
    for (let i = 0; i < n && s0 + i < length; i++) {
      const k = i / n;
      const f = 2 * Math.sin((Math.PI * Math.min(fc * Math.pow(fcEnd / fc, k), rate / 6)) / rate);
      const x = noise();
      const high = x - low - 0.7 * band;
      band += f * high;
      low += f * band;
      const env = Math.pow(1 - k, 3);
      drums[s0 + i] += (mode === 'hp' ? high : band) * env * gain;
    }
  };

  const snare = (t: number, gain = 0.5) => {
    noiseHit(t, 0.18, 'bp', 1900, gain);
    const s0 = Math.floor(t * rate);
    let ph = 0;
    for (let i = 0; i < 0.12 * rate && s0 + i < length; i++) {
      const ts = i / rate;
      ph += (140 + 80 * Math.exp(-ts / 0.03)) / rate;
      drums[s0 + i] += osc('tri', ph % 1) * Math.exp(-ts / 0.04) * gain * 0.6;
    }
  };
  const hat = (t: number, open = false, gain = 0.12) => noiseHit(t, open ? 0.22 : 0.045, 'hp', 8000, gain);
  const crash = (t: number) => noiseHit(t, 2.2, 'hp', 5000, 0.3);
  const riser = (t: number, len: number) => noiseHit(t, len, 'bp', 300, 0.25, 9000);

  const chords = [
    [57, 60, 64],
    [53, 57, 60],
    [48, 52, 55],
    [55, 59, 62],
  ];
  type Sec = 'intro' | 'build' | 'drop' | 'break' | 'outro';
  const sections: [number, number, Sec][] = [
    [0, 8, 'intro'],
    [8, 16, 'build'],
    [16, 32, 'drop'],
    [32, 40, 'break'],
    [40, 44, 'build'],
    [44, 60, 'drop'],
    [60, 64, 'outro'],
  ];
  const arp = [0, 1, 2, 1, 2, 0, 1, 2, 0, 2, 1, 2, 0, 1, 2, 1];
  const lead = [12, 12, 14, 16, 16, 14, 12, 11, 12, 12, 16, 19, 17, 16, 14, 12];

  for (const [from, to, kind] of sections) {
    for (let b = from; b < to; b++) {
      const t0 = offset + b * bar;
      const chord = chords[b % 4];
      const inBar = b - from;
      const secLen = to - from;

      if (kind === 'intro' || kind === 'break') {
        for (const n of chord) {
          tone(t0, bar, midi(n), 'saw', 0.035, 900, 0.6, -8, -0.6);
          tone(t0, bar, midi(n), 'saw', 0.035, 900, 0.6, 8, 0.6);
        }
        for (let s = 0; s < 16; s++) {
          if (kind === 'break' || inBar >= 4) {
            tone(t0 + s * spb * 0.25, spb * 0.22, midi(chord[arp[s]] + 12), 'square', 0.04, 1500 + inBar * 250, 0.003, 0, s % 2 ? 0.3 : -0.3);
          }
          if (s % 2 === 0 && inBar >= 2) hat(t0 + s * spb * 0.25, false, 0.05);
        }
        if (kind === 'intro' && inBar >= 4) for (let q = 0; q < 4; q++) kick(t0 + q * spb, 0.7);
      }

      if (kind === 'build') {
        for (let q = 0; q < 4; q++) kick(t0 + q * spb, 0.9);
        for (const n of chord) tone(t0, bar, midi(n), 'saw', 0.03, 700 + inBar * 300, 0.3);
        const progress = inBar / secLen;
        const div = progress < 0.5 ? 4 : progress < 0.75 ? 8 : 16;
        for (let s = 0; s < div; s++) snare(t0 + (s * bar) / div, 0.15 + 0.35 * ((inBar + s / div) / secLen));
        for (let s = 0; s < 8; s++) tone(t0 + s * spb * 0.5 + spb * 0.25, spb * 0.2, midi(chord[0] - 24), 'saw', 0.1, 400);
        if (inBar === 0) riser(t0, secLen * bar);
      }

      if (kind === 'drop') {
        if (inBar === 0) crash(t0);
        for (let q = 0; q < 4; q++) {
          kick(t0 + q * spb);
          if (q % 2 === 1) snare(t0 + q * spb, 0.5);
        }
        for (let s = 0; s < 16; s++) {
          const ts = t0 + s * spb * 0.25;
          hat(ts, s % 4 === 2, s % 2 === 0 ? 0.09 : 0.06);
          if (s % 4 !== 0) tone(ts, spb * 0.2, midi(chord[0] - 24 + (s % 8 === 7 ? 12 : 0)), 'saw', 0.13, 500);
          tone(ts, spb * 0.2, midi(chord[arp[s]] + 24), 'square', 0.025, 2500, 0.003, 0, s % 2 ? 0.4 : -0.4);
        }
        const phrase = Math.floor(inBar / 4) % 2;
        for (let e = 0; e < 8; e++) {
          if (rng() < 0.18) continue;
          const n = 57 + lead[(inBar % 2) * 8 + e] + phrase * 12 - (b % 4 === 1 ? 4 : 0);
          tone(t0 + e * spb * 0.5, spb * 0.42, midi(n), 'saw', 0.045, 3200, 0.005, 7, -0.25);
          tone(t0 + e * spb * 0.5, spb * 0.42, midi(n), 'saw', 0.045, 3200, 0.005, -7, 0.25);
        }
      }

      if (kind === 'outro') {
        for (const n of chord) tone(t0, bar, midi(n), 'saw', 0.03 * (1 - inBar / secLen), 800, 0.3);
        if (inBar < 2) for (let q = 0; q < 4; q++) kick(t0 + q * spb, 0.6);
      }
    }
  }

  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    left[i] = Math.tanh((drums[i] + musL[i] * duck[i]) * 1.1) * 0.85;
    right[i] = Math.tanh((drums[i] + musR[i] * duck[i]) * 1.1) * 0.85;
  }
  return { left, right, rate };
}
