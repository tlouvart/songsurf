import type { AudioAnalysis } from './analyze.ts';
import { ANALYSIS_VERSION, decodeAnalysis, type EncodedAnalysis } from './codec.ts';

export interface SongMeta {
  /** stable identifier, used as the track seed (same song → same track for everyone) */
  id: string;
  title: string;
  artist: string;
  thumbnail?: string;
}

export interface LoadedSong {
  meta: SongMeta;
  buffer: AudioBuffer;
  analysis: AudioAnalysis;
  /** the analysis is the server's: runs on it can be verified and ranked */
  official: boolean;
}

export type Status = (label: string, progress: number) => void;

let ctx: AudioContext | null = null;
export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: 'interactive' });
  return ctx;
}

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}

export async function serverHasYouTube(): Promise<boolean> {
  try {
    const r = await fetch('/api/health');
    return !!(await r.json()).youtube;
  } catch {
    return false;
  }
}

async function download(url: string, status: Status, label: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) await readJson(res);
  const total = Number(res.headers.get('content-length') || 0);
  if (!res.body || !total) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    status(label, got / total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}

export function analyzeBuffer(buffer: AudioBuffer, status: Status): Promise<AudioAnalysis> {
  const n = buffer.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += d[i] / buffer.numberOfChannels;
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      if (e.data.type === 'progress') status('Analyzing', e.data.value);
      else {
        resolve(e.data.result);
        worker.terminate();
      }
    };
    worker.onerror = (e) => {
      reject(new Error(e.message || 'analysis failed'));
      worker.terminate();
    };
    worker.postMessage({ samples: mono, sampleRate: buffer.sampleRate }, [mono.buffer]);
  });
}

/** The server's analysis of a song (the same for every player). */
async function fetchAnalysis(key: string): Promise<AudioAnalysis> {
  const res = await fetch(`/api/analysis?key=${encodeURIComponent(key)}&v=${ANALYSIS_VERSION}`);
  return decodeAnalysis(await readJson<EncodedAnalysis>(res));
}

/** Server analysis when available; otherwise analyse here (then the run is practice only). */
async function analysisFor(buffer: AudioBuffer | Promise<AudioBuffer>, pending: Promise<AudioAnalysis>, status: Status) {
  try {
    return { analysis: await pending, official: true };
  } catch {
    return { analysis: await analyzeBuffer(await buffer, status), official: false };
  }
}

export async function loadYouTube(url: string, status: Status): Promise<LoadedSong> {
  status('Looking up', 0);
  const info = await readJson<{ id: string; title: string; uploader: string; thumbnail: string }>(
    await fetch(`/api/track?url=${encodeURIComponent(url)}`),
  );
  const key = `yt:${info.id}`;
  status('Fetching audio', 0);
  const bytes = await download(`/api/audio/${info.id}`, status, 'Downloading audio');
  // The server analyses the song while the browser decodes it.
  const pending = fetchAnalysis(key);
  pending.catch(() => {});
  status('Decoding', 1);
  const buffer = await audioContext().decodeAudioData(bytes);
  status('Analyzing', 1);
  const { analysis, official } = await analysisFor(buffer, pending, status);
  return {
    meta: { id: key, title: info.title, artist: info.uploader, thumbnail: info.thumbnail },
    buffer,
    analysis,
    official,
  };
}

export async function loadFile(file: File, status: Status): Promise<LoadedSong> {
  status('Decoding', 0);
  const buffer = await audioContext().decodeAudioData(await file.arrayBuffer());
  const analysis = await analyzeBuffer(buffer, status);
  const name = file.name.replace(/\.[^.]+$/, '');
  const [artist, title] = name.includes(' - ') ? name.split(' - ', 2) : ['', name];
  // The server never sees your file, so it can't check the run: practice only.
  return { meta: { id: `file:${file.name}:${file.size}`, title, artist }, buffer, analysis, official: false };
}

export async function loadDemo(status: Status): Promise<LoadedSong> {
  const key = 'demo:neon-drive';
  const pending = fetchAnalysis(key);
  pending.catch(() => {});
  status('Synthesizing', 0.2);
  const { renderDemoSong } = await import('./demoSong.ts');
  const buffer = renderDemoSong();
  const { analysis, official } = await analysisFor(buffer, pending, status);
  return { meta: { id: key, title: 'Neon Drive', artist: 'SongSurf synth' }, buffer: await buffer, analysis, official };
}
