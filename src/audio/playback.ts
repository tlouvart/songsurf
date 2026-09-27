import type { AudioAnalysis } from './analyze.ts';
import { audioContext } from './loader.ts';

/** Plays the song and is the single source of truth for "song time". */
export class MusicPlayer {
  private ctx = audioContext();
  private source: AudioBufferSourceNode | null = null;
  private startAt = 0;
  private offset = 0;
  readonly gain: GainNode;
  readonly analyser: AnalyserNode;
  volume = 0.9;

  constructor() {
    this.gain = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.55;
    this.gain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  /** Start `buffer` after `delay` seconds; song time is negative until then. */
  async play(buffer: AudioBuffer, delay: number, offset = 0) {
    this.stop();
    if (this.ctx.state !== 'running') await this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.gain);
    this.gain.gain.value = this.volume;
    this.startAt = this.ctx.currentTime + delay;
    this.offset = Math.max(0, Math.min(offset, buffer.duration - 1));
    src.start(this.startAt, this.offset);
    this.source = src;
  }

  get time(): number {
    // Compensate output latency so visuals line up with what you hear.
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return this.ctx.currentTime - this.startAt - latency + this.offset;
  }

  get playing() {
    return !!this.source;
  }

  pause() {
    return this.ctx.suspend();
  }

  setVolume(v: number) {
    this.volume = v;
    this.gain.gain.value = v;
  }

  resume() {
    return this.ctx.resume();
  }

  stop() {
    if (this.source) {
      try { this.source.stop(); } catch { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
}

/** 16 log-spaced bands + bass/energy, from the live analyser or (in attract mode) the analysis. */
export class AudioFeed {
  bands = new Float32Array(16);
  bass = 0;
  energy = 0;
  private data: Uint8Array<ArrayBuffer> | null = null;
  private edges: number[] = [];

  constructor(private analyser: AnalyserNode | null) {
    if (analyser) {
      this.data = new Uint8Array(analyser.frequencyBinCount);
      const binHz = analyser.context.sampleRate / analyser.fftSize;
      for (let i = 0; i <= 16; i++) {
        const hz = 35 * Math.pow(14000 / 35, i / 16);
        this.edges.push(Math.max(1, Math.round(hz / binHz)));
      }
    }
  }

  update(time: number, a: AudioAnalysis, live: boolean, dt: number) {
    const fi = Math.max(0, Math.min(a.loudness.length - 1, Math.floor(time * a.fps)));
    const inSong = time >= 0 && time <= a.duration;
    const targetEnergy = inSong ? a.intensity[fi] : 0;
    this.energy += (targetEnergy - this.energy) * Math.min(1, dt * 4);

    if (live && this.analyser && this.data) {
      this.analyser.getByteFrequencyData(this.data);
      for (let b = 0; b < 16; b++) {
        let m = 0;
        for (let k = this.edges[b]; k < Math.max(this.edges[b] + 1, this.edges[b + 1]); k++) m = Math.max(m, this.data[k]);
        // Emphasise the top of the range so quiet songs still move things.
        const v = Math.max(0, (m / 255 - 0.35) / 0.65);
        this.bands[b] += (v - this.bands[b]) * Math.min(1, dt * 20);
      }
    } else {
      const lo = inSong ? a.low[fi] : 0.2, mi = inSong ? a.mid[fi] : 0.2, hi = inSong ? a.high[fi] : 0.2;
      for (let b = 0; b < 16; b++) {
        const t = b / 15;
        const v = t < 0.5 ? lo + (mi - lo) * t * 2 : mi + (hi - mi) * (t - 0.5) * 2;
        const wob = 0.15 * Math.sin(time * (3 + b) + b);
        this.bands[b] += (Math.max(0, v * 0.9 + wob) - this.bands[b]) * Math.min(1, dt * 15);
      }
    }
    this.bass = (this.bands[0] + this.bands[1] + this.bands[2]) / 3;
  }
}

/** Tiny synthesized sound effects. They sit on top of the music without clashing with its key. */
export class Sfx {
  private ctx = audioContext();
  private out: GainNode;
  private noise: AudioBuffer;
  /** hit sounds (catches, chains, greys, trails) can be turned off on their own */
  blockSounds = true;

  constructor() {
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.35;
    this.out.connect(this.ctx.destination);
    this.noise = this.ctx.createBuffer(1, this.ctx.sampleRate * 0.5, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  setVolume(v: number) {
    this.out.gain.value = 0.4 * v;
  }

  private blip(freq: number, len: number, gain: number, type: OscillatorType = 'sine', slide = 1) {
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * slide, t + len);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + len + 0.02);
  }

  private hiss(len: number, gain: number, type: BiquadFilterType, freq: number, sweep = 1) {
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(freq * sweep, t + len);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(f).connect(g).connect(this.out);
    s.start(t);
    s.stop(t + len + 0.02);
  }

  catch(tier: number) {
    if (!this.blockSounds) return;
    this.hiss(0.05, 0.18, 'highpass', 6000 + tier * 800);
    this.blip(1800 + tier * 250, 0.06, 0.05, 'triangle', 1.4);
  }
  gem() {
    this.blip(880, 0.5, 0.18, 'triangle', 2);
    this.blip(1320, 0.6, 0.12, 'sine', 2);
    this.hiss(0.5, 0.2, 'bandpass', 2000, 4);
  }
  grey() {
    if (!this.blockSounds) return;
    this.hiss(0.18, 0.35, 'lowpass', 900, 0.4);
    this.blip(110, 0.2, 0.25, 'square', 0.7);
  }
  multiplier(level: number) {
    // A soft rising chime, a step higher per multiplier level.
    const base = 520 * Math.pow(2, (level - 2) / 6);
    [0, 4, 7].forEach((semi, i) => setTimeout(() => this.blip(base * Math.pow(2, semi / 12), 0.25, 0.05, 'sine', 1), i * 45));
  }
  pellet(index: number) {
    if (!this.blockSounds) return;
    // Each pellet of a stream climbs a pentatonic step.
    const steps = [0, 2, 4, 7, 9];
    const semi = steps[index % 5] + 12 * Math.floor(index / 5);
    this.blip(880 * Math.pow(2, Math.min(semi, 24) / 12), 0.06, 0.05, 'triangle', 1.05);
  }
  holdTick() {
    if (!this.blockSounds) return;
    this.hiss(0.05, 0.05, 'bandpass', 5000);
  }
  overdrive() {
    this.hiss(0.9, 0.35, 'bandpass', 400, 12);
    this.blip(220, 0.8, 0.15, 'sawtooth', 4);
  }
  tick(high = false) {
    this.blip(high ? 1320 : 660, 0.12, 0.2, 'sine');
  }
}
