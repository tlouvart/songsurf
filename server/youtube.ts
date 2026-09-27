import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { Semaphore } from './limits.ts';

export interface TrackInfo {
  id: string;
  title: string;
  uploader: string;
  duration: number;
  thumbnail: string;
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_DURATION = 15 * 60;
/** Disk budget for cached song audio; least recently played songs are evicted past it. */
const CACHE_BUDGET = (Number(process.env.AUDIO_CACHE_MB) || 3000) * 1024 * 1024;
/** yt-dlp is heavy (a Python process each): bound how many run at once. */
const infoLimit = new Semaphore(4, 24);
const downloadLimit = new Semaphore(2, 12);

export const CACHE_DIR = join(process.cwd(), '.cache', 'audio');
mkdirSync(CACHE_DIR, { recursive: true });

const LOCAL_BIN = join(process.cwd(), '.cache', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
/** Prefer $YTDLP_PATH, then the copy fetched by `npm run setup`, then whatever is on PATH. */
const YTDLP = process.env.YTDLP_PATH || (existsSync(LOCAL_BIN) ? LOCAL_BIN : 'yt-dlp');
// YouTube requires solving JS challenges; the Node running this server does the job.
const BASE_ARGS = ['--js-runtimes', `node:${process.execPath}`, '--no-warnings'];
// YouTube blocks most datacenter IPs: in production yt-dlp goes out through a proxy.
if (process.env.YTDLP_PROXY) BASE_ARGS.push('--proxy', process.env.YTDLP_PROXY);

/** Pull the 11-char video id out of any common YouTube URL shape (or a bare id). */
export function parseVideoId(input: string): string | null {
  const s = input.trim();
  if (YT_ID.test(s)) return s;
  let url: URL;
  try {
    url = new URL(s.startsWith('http') ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?]+)/);
      if (m) id = m[1];
    }
  }
  return id && YT_ID.test(id) ? id : null;
}

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(YTDLP, [...BASE_ARGS, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('yt-dlp timed out'));
    }, timeoutMs);
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run yt-dlp (${e.message}). Is it installed and on PATH?`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      const msg = err.split('\n').filter((l) => l.includes('ERROR') || l.includes('error:')).join(' ') || `yt-dlp exited with ${code}`;
      // The details are for the server log; players get a short, useful message.
      console.warn(`yt-dlp: ${msg}`);
      if (/Sign in to confirm|403/i.test(msg)) reject(new Error('YouTube is refusing our server right now. Try again in a moment, or another song'));
      else if (/unavailable|private video|removed/i.test(msg)) reject(new Error('This video is unavailable'));
      else if (/no such option/i.test(msg)) reject(new Error('The server needs a yt-dlp update'));
      else reject(new Error("Couldn't get this song from YouTube"));
    });
  });
}

export async function hasYtDlp(): Promise<boolean> {
  try {
    await run(['--version'], 10_000);
    return true;
  } catch {
    return false;
  }
}

const infoCache = new Map<string, TrackInfo>();
const infoPending = new Map<string, Promise<TrackInfo>>();

export function getInfo(id: string): Promise<TrackInfo> {
  const cached = infoCache.get(id);
  if (cached) return Promise.resolve(cached);
  let p = infoPending.get(id);
  if (!p) {
    p = infoLimit.run(() => lookup(id)).finally(() => infoPending.delete(id));
    infoPending.set(id, p);
  }
  return p;
}

async function lookup(id: string): Promise<TrackInfo> {
  const json = JSON.parse(
    await run(['-J', '--no-playlist', `https://www.youtube.com/watch?v=${id}`], 45_000),
  );
  if (json.is_live) throw new Error('Live streams are not supported');
  const info: TrackInfo = {
    id,
    title: String(json.title ?? id),
    uploader: String(json.uploader ?? json.channel ?? ''),
    duration: Number(json.duration ?? 0),
    thumbnail: String(json.thumbnail ?? ''),
  };
  if (info.duration > MAX_DURATION) throw new Error(`Track is too long (max ${MAX_DURATION / 60} min)`);
  infoCache.set(id, info);
  if (infoCache.size > 5000) infoCache.delete(infoCache.keys().next().value!);
  return info;
}

export function cachedAudioFile(id: string): string | null {
  const f = readdirSync(CACHE_DIR).find((n) => n.startsWith(`${id}.`) && !n.endsWith('.part'));
  return f ? join(CACHE_DIR, f) : null;
}

const downloads = new Map<string, Promise<string>>();

/** Download the best browser-decodable audio stream once; concurrent callers share the same download. */
export function ensureAudio(id: string): Promise<string> {
  const existing = cachedAudioFile(id);
  if (existing) {
    // Mark as recently played, for eviction order.
    const now = new Date();
    try { utimesSync(existing, now, now); } catch { /* best effort */ }
    return Promise.resolve(existing);
  }
  let p = downloads.get(id);
  if (!p) {
    p = (async () => {
      await getInfo(id); // enforces duration / live checks before downloading
      await downloadLimit.run(() =>
        run(
          [
            '-f',
            'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
            '--no-playlist',
            '--no-part',
            '--max-filesize',
            '60M',
            '-o',
            join(CACHE_DIR, '%(id)s.%(ext)s'),
            `https://www.youtube.com/watch?v=${id}`,
          ],
          180_000,
        ),
      );
      const file = cachedAudioFile(id);
      if (!file || !existsSync(file)) throw new Error('Download finished but no audio file was produced');
      pruneCache(file);
      return file;
    })().finally(() => downloads.delete(id));
    downloads.set(id, p);
  }
  return p;
}

/** Keep the audio cache under its disk budget: drop the least recently played files. */
function pruneCache(keep: string) {
  const files = readdirSync(CACHE_DIR)
    .map((n) => {
      const path = join(CACHE_DIR, n);
      try {
        const st = statSync(path);
        return { path, size: st.size, t: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((f): f is { path: string; size: number; t: number } => !!f)
    .sort((a, b) => a.t - b.t);
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files) {
    if (total <= CACHE_BUDGET) break;
    if (f.path === keep) continue;
    try {
      unlinkSync(f.path);
      total -= f.size;
    } catch {
      /* in use or already gone */
    }
  }
}

/**
 * YouTube keeps changing; old yt-dlp versions get refused. When we run our own standalone
 * copy, update it at start and then daily.
 */
export function keepYtDlpFresh() {
  if (YTDLP !== LOCAL_BIN && YTDLP !== process.env.YTDLP_PATH) return;
  const update = () => run(['-U'], 120_000).then(() => console.log('yt-dlp is up to date')).catch((e) => console.warn(`yt-dlp update failed: ${e.message}`));
  setTimeout(update, 5_000).unref();
  setInterval(update, 24 * 3600 * 1000).unref();
}
