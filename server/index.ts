import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { ensureAudio, getInfo, hasYtDlp, keepYtDlpFresh, parseVideoId } from './youtube.ts';
import { BusyError, clientIp, RateLimiter } from './limits.ts';
import { topRuns } from './runs.ts';
import { songData } from './tracks.ts';
import { WebSocketServer } from 'ws';
import * as db from './db.ts';
import { onConnection, presence, refreshPlayer } from './lobby.ts';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const DIST = join(process.cwd(), 'dist');
const PROD = process.env.NODE_ENV === 'production';
/** Browsers may only open the game socket from this origin (production). */
const ORIGIN = process.env.PUBLIC_ORIGIN || '';

// Abuse limits (per client IP unless noted).
const apiLimit = new RateLimiter(300, 60_000);
const writeLimit = new RateLimiter(60, 60_000);
const registerLimit = new RateLimiter(5, 3_600_000);
const youtubeLimit = new RateLimiter(30, 60_000);
const MAX_SOCKETS_PER_IP = 6;

/** Security headers for every response. */
const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://i.ytimg.com",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.m4a': 'audio/mp4',
  '.webm': 'audio/webm',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
};

function json(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string, cache = 'public, max-age=3600') {
  const size = statSync(file).size;
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    ...(type.startsWith('text/html') ? { 'content-security-policy': CSP } : {}),
    'content-type': type,
    'content-length': size,
    'cache-control': cache,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const ip = clientIp(req);
  if (!apiLimit.allow(ip)) return json(res, 429, { error: 'Too many requests, slow down' });
  if (req.method !== 'GET' && req.method !== 'HEAD' && !writeLimit.allow(ip)) return json(res, 429, { error: 'Too many requests, slow down' });
  if ((url.pathname === '/api/track' || url.pathname === '/api/analysis' || url.pathname.startsWith('/api/audio/')) && !youtubeLimit.allow(ip)) {
    return json(res, 429, { error: 'Too many songs at once, wait a minute' });
  }

  if (url.pathname === '/api/health') {
    return json(res, 200, { ok: true, youtube: await hasYtDlp() });
  }

  if (url.pathname === '/api/track') {
    const id = parseVideoId(url.searchParams.get('url') ?? '');
    if (!id) return json(res, 400, { error: 'That does not look like a YouTube link' });
    try {
      return json(res, 200, await getInfo(id));
    } catch (e) {
      return json(res, e instanceof BusyError ? 503 : 422, { error: (e as Error).message });
    }
  }

  // --- pilots ------------------------------------------------------------------
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const me = () => db.byToken(token);

  if (url.pathname === '/api/register' && req.method === 'POST') {
    if (!registerLimit.allow(ip)) return json(res, 429, { error: 'Too many new pilots from here, try later' });
    const body = JSON.parse((await readBody(req, 4096)) || '{}');
    const out = db.register(body.name);
    return json(res, 'error' in out ? 400 : 200, out);
  }
  if (url.pathname === '/api/me/loadout' && req.method === 'POST') {
    const p = me();
    if (!p) return json(res, 401, { error: 'unknown pilot' });
    const body = JSON.parse((await readBody(req, 4096)) || '{}');
    const player = db.saveLoadout(p.id, body.loadout);
    refreshPlayer(p.id);
    return json(res, 200, { player });
  }
  if (url.pathname === '/api/shop/buy' && req.method === 'POST') {
    const p = me();
    if (!p) return json(res, 401, { error: 'unknown pilot' });
    const body = JSON.parse((await readBody(req, 4096)) || '{}');
    const out = db.buy(p.id, body.slot, String(body.id ?? ''));
    if ('error' in out) return json(res, 400, out);
    refreshPlayer(p.id);
    return json(res, 200, { player: out });
  }
  if (url.pathname === '/api/me') {
    const p = me();
    if (!p) return json(res, 401, { error: 'unknown pilot' });
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 4096)) || '{}');
      const out = db.rename(p.id, body.name);
      if (!('error' in out)) refreshPlayer(p.id);
      return json(res, 'error' in out ? 400 : 200, 'error' in out ? out : { player: out });
    }
    return json(res, 200, { player: p });
  }
  if (url.pathname === '/api/history') {
    const p = me();
    if (!p) return json(res, 401, { error: 'unknown pilot' });
    return json(res, 200, { games: db.history(p.id) });
  }
  if (url.pathname === '/api/leaderboard') {
    const p = me();
    return json(res, 200, { players: db.leaderboard(), me: p ? { player: p, rank: db.rankOf(p) } : null });
  }
  if (url.pathname === '/api/profile') {
    const target = url.searchParams.get('id') ? db.byId(Number(url.searchParams.get('id'))) : db.byName(url.searchParams.get('name') ?? '');
    if (!target) return json(res, 404, { error: 'No such pilot' });
    return json(res, 200, db.profile(target));
  }
  if (url.pathname === '/api/me/socials' && req.method === 'POST') {
    const p = me();
    if (!p) return json(res, 401, { error: 'unknown pilot' });
    const body = JSON.parse((await readBody(req, 4096)) || '{}');
    return json(res, 200, { player: db.saveSocials(p.id, body.socials) });
  }
  if (url.pathname === '/api/friends') {
    const p = me();
    if (!p) return json(res, 401, { error: 'unknown pilot' });
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 4096)) || '{}');
      const out = db.addFriend(p.id, String(body.name ?? ''));
      if ('error' in out) return json(res, 400, out);
    } else if (req.method === 'DELETE') {
      db.removeFriend(p.id, Number(url.searchParams.get('id')));
    }
    return json(res, 200, { friends: db.friendsOf(p.id).map((f) => ({ ...f, ...presence(f.id) })) });
  }

  if (url.pathname === '/api/runs' && req.method === 'GET') {
    const song = url.searchParams.get('song') ?? '';
    if (!song || song.length > 200) return json(res, 400, { error: 'missing song' });
    return json(res, 200, { runs: topRuns(song) });
  }

  // The song's analysis, computed by the server: every browser builds the same track from it.
  if (url.pathname === '/api/analysis') {
    try {
      const d = await songData(url.searchParams.get('key') ?? '');
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' });
      return res.end(d.json);
    } catch (e) {
      return json(res, e instanceof BusyError ? 503 : 422, { error: (e as Error).message });
    }
  }


  const audio = url.pathname.match(/^\/api\/audio\/([A-Za-z0-9_-]{11})$/);
  if (audio) {
    try {
      const file = await ensureAudio(audio[1]);
      return sendFile(req, res, file, 'public, max-age=86400');
    } catch (e) {
      return json(res, e instanceof BusyError ? 503 : 422, { error: (e as Error).message });
    }
  }

  json(res, 404, { error: 'not found' });
}

const server = createServer((req, res) => {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return json(res, 400, { error: 'bad request' });
  }
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      // Bad JSON bodies are the client's fault; anything else is logged, never echoed.
      if (e instanceof SyntaxError || (e as Error).message === 'body too large') return json(res, 400, { error: 'bad request' });
      console.error(e);
      json(res, 500, { error: 'server error' });
    });
    return;
  }
  if (!PROD) return json(res, 404, { error: 'In dev, the client is served by Vite on :5173' });

  let rel: string;
  try {
    rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  } catch {
    return json(res, 400, { error: 'bad request' });
  }
  let file = join(DIST, rel);
  if (!file.startsWith(DIST + '/') || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  sendFile(req, res, file, file.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
});

// Realtime lobbies.
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const socketsPerIp = new Map<string, number>();
wss.on('connection', (ws, req: IncomingMessage) => {
  const ip = clientIp(req);
  socketsPerIp.set(ip, (socketsPerIp.get(ip) ?? 0) + 1);
  ws.on('close', () => {
    const n = (socketsPerIp.get(ip) ?? 1) - 1;
    if (n <= 0) socketsPerIp.delete(ip);
    else socketsPerIp.set(ip, n);
  });
  // A client sends a score twice a second and the odd chat or vote; flooding gets cut off.
  let window = Date.now();
  let count = 0;
  ws.on('message', () => {
    const now = Date.now();
    if (now - window > 1000) {
      window = now;
      count = 0;
    }
    if (++count > 40) ws.close(1008, 'too many messages');
  });
  onConnection(ws);
});
server.on('upgrade', (req, socket, head) => {
  let path = '';
  try {
    path = new URL(req.url ?? '/', 'http://localhost').pathname;
  } catch {
    /* rejected below */
  }
  if (path !== '/ws') return socket.destroy();
  if (ORIGIN && req.headers.origin !== ORIGIN) return socket.destroy();
  if ((socketsPerIp.get(clientIp(req)) ?? 0) >= MAX_SOCKETS_PER_IP) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Keep going on unexpected errors instead of taking every lobby down with the process.
process.on('uncaughtException', (e) => console.error('uncaught', e));
process.on('unhandledRejection', (e) => console.error('unhandled', e));

keepYtDlpFresh();
server.listen(PORT, HOST, () => {
  console.log(`SongSurf server on http://${HOST}:${PORT}${PROD ? '' : ' (API only — open the Vite URL)'}`);
});
