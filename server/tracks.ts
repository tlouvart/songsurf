import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ANALYSIS_VERSION, type EncodedAnalysis } from '../src/audio/codec.ts';
import type { TrackCore } from '../src/game/replay.ts';
import { TRACK_VERSION } from '../src/track/track.ts';
import { Semaphore } from './limits.ts';
import { ensureAudio } from './youtube.ts';

/**
 * The server's copy of every song it serves: the analysis (sent to browsers, so everyone
 * builds the same track) and the track's blocks (to replay and score runs). Computed once
 * per song in a worker thread, kept on disk and the most recent ones in memory.
 */

export interface SongData {
  /** the encoded analysis, ready to send */
  json: string;
  core: TrackCore;
}

const DIR = join(process.cwd(), '.cache', 'analysis');
mkdirSync(DIR, { recursive: true });
const KEEP_FILES = 4000;
const memory = new Map<string, SongData>();
const MEMORY = 24;
const pending = new Map<string, Promise<SongData>>();
const workers = new Semaphore(2, 16);

export const DEMO_KEY = 'demo:neon-drive';
export const isSongKey = (key: string) => key === DEMO_KEY || /^yt:[A-Za-z0-9_-]{11}$/.test(key);

const fileFor = (key: string) =>
  join(DIR, `${createHash('sha1').update(key).digest('hex')}.a${ANALYSIS_VERSION}t${TRACK_VERSION}.json`);

function remember(key: string, d: SongData) {
  memory.delete(key);
  memory.set(key, d);
  while (memory.size > MEMORY) memory.delete(memory.keys().next().value!);
  return d;
}

function compute(key: string, file: string | null): Promise<{ encoded: EncodedAnalysis; core: TrackCore }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./analysis.worker.ts', import.meta.url), { workerData: { key, file } });
    const timer = setTimeout(() => w.terminate(), 120_000);
    w.once('message', (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    w.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    w.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Could not analyse that song'));
    });
  });
}

function prune() {
  const files = readdirSync(DIR);
  if (files.length <= KEEP_FILES) return;
  const aged = files.map((f) => ({ f, t: statSync(join(DIR, f)).mtimeMs })).sort((a, b) => a.t - b.t);
  for (const { f } of aged.slice(0, files.length - KEEP_FILES)) unlinkSync(join(DIR, f));
}

/** Analysis and blocks for a song key ('yt:<id>' or the demo). */
export function songData(key: string): Promise<SongData> {
  if (!isSongKey(key)) return Promise.reject(new Error('Unknown song'));
  const hit = memory.get(key);
  if (hit) return Promise.resolve(remember(key, hit));
  let p = pending.get(key);
  if (p) return p;
  p = (async () => {
    const f = fileFor(key);
    if (existsSync(f)) {
      try {
        const { encoded, core } = JSON.parse(readFileSync(f, 'utf8'));
        return remember(key, { json: JSON.stringify(encoded), core });
      } catch {
        /* recompute below */
      }
    }
    const audio = key.startsWith('yt:') ? await ensureAudio(key.slice(3)) : null;
    const { encoded, core } = await workers.run(() => compute(key, audio));
    writeFileSync(f, JSON.stringify({ encoded, core }));
    prune();
    return remember(key, { json: JSON.stringify(encoded), core });
  })().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}
