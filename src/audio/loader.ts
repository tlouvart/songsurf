import type { AudioAnalysis } from './analyze.ts';

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

export async function loadYouTube(url: string, status: Status): Promise<LoadedSong> {
  status('Looking up', 0);
  const info = await readJson<{ id: string; title: string; uploader: string; thumbnail: string }>(
    await fetch(`/api/track?url=${encodeURIComponent(url)}`),
  );
  status('Fetching audio', 0);
  const bytes = await download(`/api/audio/${info.id}`, status, 'Downloading audio');
  status('Decoding', 1);
  const buffer = await audioContext().decodeAudioData(bytes);
  const analysis = await analyzeBuffer(buffer, status);
  return {
    meta: { id: `yt:${info.id}`, title: info.title, artist: info.uploader, thumbnail: info.thumbnail },
    buffer,
    analysis,
  };
}

export async function loadFile(file: File, status: Status): Promise<LoadedSong> {
  status('Decoding', 0);
  const buffer = await audioContext().decodeAudioData(await file.arrayBuffer());
  const analysis = await analyzeBuffer(buffer, status);
  const name = file.name.replace(/\.[^.]+$/, '');
  const [artist, title] = name.includes(' - ') ? name.split(' - ', 2) : ['', name];
  return { meta: { id: `file:${file.name}:${file.size}`, title, artist }, buffer, analysis };
}

export async function loadDemo(status: Status): Promise<LoadedSong> {
  status('Synthesizing', 0.2);
  const { renderDemoSong } = await import('./demoSong.ts');
  const buffer = await renderDemoSong();
  const analysis = await analyzeBuffer(buffer, status);
  return { meta: { id: 'demo:neon-drive', title: 'Neon Drive', artist: 'SongSurf synth' }, buffer, analysis };
}
