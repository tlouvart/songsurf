import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

// node:sqlite is still flagged experimental; keep its one-time warning out of the logs.
const emit = process.emitWarning;
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (String(w).includes('SQLite')) return;
  return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import('node:sqlite');
import { findItem, isOwned, itemKey, sanitizeLoadout, START_CREDITS, type ItemSlot, type Loadout } from '../src/ship/catalog.ts';

const DIR = join(process.cwd(), '.cache');
mkdirSync(DIR, { recursive: true });
// The project used to be called RideX: carry its database over on first start.
const DB_FILE = process.env.SONGSURF_DB || process.env.RIDEX_DB || join(DIR, 'songsurf.db');
if (!process.env.SONGSURF_DB && !process.env.RIDEX_DB && !existsSync(DB_FILE) && existsSync(join(DIR, 'ridex.db'))) {
  for (const ext of ['', '-wal', '-shm']) {
    if (existsSync(join(DIR, `ridex.db${ext}`))) renameSync(join(DIR, `ridex.db${ext}`), `${DB_FILE}${ext}`);
  }
}
const db = new DatabaseSync(DB_FILE);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    elo INTEGER NOT NULL DEFAULT 1000,
    fun INTEGER NOT NULL DEFAULT 0,
    ranked_matches INTEGER NOT NULL DEFAULT 0,
    casual_matches INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS friends (
    player_id INTEGER NOT NULL,
    friend_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (player_id, friend_id)
  );
  CREATE TABLE IF NOT EXISTS games (
    id INTEGER PRIMARY KEY,
    player_id INTEGER NOT NULL,
    mode TEXT NOT NULL,
    match_id TEXT,
    song_key TEXT NOT NULL,
    song_title TEXT NOT NULL,
    song_artist TEXT NOT NULL DEFAULT '',
    score INTEGER NOT NULL,
    placement INTEGER,
    players INTEGER,
    points INTEGER,
    rating_delta INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS games_player ON games (player_id, created_at DESC);
  -- Each pilot's song library: every song they loaded or raced (hidden = removed by them).
  CREATE TABLE IF NOT EXISTS library (
    player_id INTEGER NOT NULL,
    song_key TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    added_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (player_id, song_key)
  );
`);
// Songs raced before the library existed.
db.exec(`INSERT OR IGNORE INTO library (player_id, song_key, title, artist, added_at, last_at)
  SELECT player_id, song_key, song_title, song_artist, MIN(created_at), MAX(created_at) FROM games GROUP BY player_id, song_key`);
// Migrations for databases created by earlier versions.
const columns = (db.prepare('PRAGMA table_info(players)').all() as unknown as { name: string }[]).map((c) => c.name);
if (!columns.includes('loadout')) db.exec('ALTER TABLE players ADD COLUMN loadout TEXT');
if (!columns.includes('credits')) db.exec(`ALTER TABLE players ADD COLUMN credits INTEGER NOT NULL DEFAULT ${START_CREDITS}`);
if (!columns.includes('owned')) db.exec("ALTER TABLE players ADD COLUMN owned TEXT NOT NULL DEFAULT '[]'");
if (!columns.includes('ranked_wins')) db.exec('ALTER TABLE players ADD COLUMN ranked_wins INTEGER NOT NULL DEFAULT 0');
if (!columns.includes('socials')) db.exec("ALTER TABLE players ADD COLUMN socials TEXT NOT NULL DEFAULT '{}'");

export interface Player {
  id: number;
  name: string;
  elo: number;
  fun: number;
  ranked_matches: number;
  casual_matches: number;
  loadout: Loadout;
  credits: number;
  owned: string[];
  ranked_wins: number;
  games_played: number;
  socials: Record<string, string>;
}

const PUBLIC = 'id, name, elo, fun, ranked_matches, casual_matches, loadout, credits, owned, ranked_wins, socials, ' +
  "casual_matches + (SELECT COUNT(*) FROM games g WHERE g.player_id = players.id AND g.mode = 'solo') AS games_played";

/** Rows store the loadout and owned items as JSON; callers get valid objects. */
function hydrate<T extends { loadout?: unknown; owned?: unknown; socials?: unknown } | undefined>(row: T): T {
  if (!row) return row;
  const r = row as unknown as { loadout: unknown; owned: unknown; socials: unknown };
  try {
    r.socials = typeof r.socials === 'string' ? JSON.parse(r.socials) : {};
  } catch {
    r.socials = {};
  }
  let owned: string[] = [];
  try {
    owned = typeof r.owned === 'string' ? JSON.parse(r.owned) : [];
  } catch {
    owned = [];
  }
  r.owned = owned;
  let raw: unknown = null;
  try {
    raw = typeof r.loadout === 'string' ? JSON.parse(r.loadout) : null;
  } catch {
    raw = null;
  }
  r.loadout = sanitizeLoadout(raw, owned);
  return row;
}

/** Save a ship; anything not owned falls back to the default part. */
export function saveLoadout(id: number, raw: unknown): Player {
  const p = byId(id)!;
  db.prepare('UPDATE players SET loadout = ? WHERE id = ?').run(JSON.stringify(sanitizeLoadout(raw, p.owned)), id);
  return byId(id)!;
}

export function addCredits(id: number, amount: number) {
  if (amount > 0) db.prepare('UPDATE players SET credits = credits + ? WHERE id = ?').run(Math.round(amount), id);
}

/** Buy a hangar item with credits. */
export function buy(id: number, slot: ItemSlot, itemId: string): Player | { error: string } {
  const p = byId(id);
  if (!p) return { error: 'unknown pilot' };
  const item = findItem(slot, itemId);
  if (!item) return { error: 'Unknown item' };
  if (isOwned(p.owned, slot, itemId)) return p;
  if (p.credits < item.price) return { error: 'Not enough credits' };
  const owned = [...p.owned, itemKey(slot, itemId)];
  db.prepare('UPDATE players SET credits = credits - ?, owned = ? WHERE id = ? AND credits >= ?').run(item.price, JSON.stringify(owned), id, item.price);
  return byId(id)!;
}

export function cleanName(raw: unknown): string | null {
  const name = String(raw ?? '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 16);
  return name.length >= 2 ? name : null;
}

export function register(rawName: unknown): { token: string; player: Player } | { error: string } {
  const name = cleanName(rawName);
  if (!name) return { error: 'Pick a name of 2–16 letters or digits' };
  if (db.prepare('SELECT 1 FROM players WHERE name = ?').get(name)) return { error: 'That name is taken' };
  const token = randomBytes(24).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO players (token, name, created_at, last_seen) VALUES (?, ?, ?, ?)').run(token, name, now, now);
  return { token, player: byToken(token)! };
}

export function byToken(token: unknown): Player | null {
  if (typeof token !== 'string' || token.length < 10) return null;
  return hydrate(db.prepare(`SELECT ${PUBLIC} FROM players WHERE token = ?`).get(token) as unknown as Player) ?? null;
}

export function byId(id: number): Player | null {
  return hydrate(db.prepare(`SELECT ${PUBLIC} FROM players WHERE id = ?`).get(id) as unknown as Player) ?? null;
}

export function byName(name: string): Player | null {
  return hydrate(db.prepare(`SELECT ${PUBLIC} FROM players WHERE name = ?`).get(name) as unknown as Player) ?? null;
}

export function rename(id: number, rawName: unknown): Player | { error: string } {
  const name = cleanName(rawName);
  if (!name) return { error: 'Pick a name of 2–16 letters or digits' };
  const other = byName(name);
  if (other && other.id !== id) return { error: 'That name is taken' };
  db.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, id);
  return byId(id)!;
}

export function touch(id: number) {
  db.prepare('UPDATE players SET last_seen = ? WHERE id = ?').run(Date.now(), id);
}

export function leaderboard(limit = 100) {
  return (db.prepare(`SELECT ${PUBLIC} FROM players WHERE ranked_matches > 0 ORDER BY elo DESC, ranked_matches DESC LIMIT ?`).all(limit) as unknown as Player[]).map(hydrate);
}

/** 1-based position in the Elo ranking, or null before any ranked match. */
export function rankOf(p: Player): number | null {
  if (p.ranked_matches === 0) return null;
  const above = db.prepare('SELECT COUNT(*) AS n FROM players WHERE ranked_matches > 0 AND (elo > ? OR (elo = ? AND ranked_matches > ?))').get(p.elo, p.elo, p.ranked_matches) as { n: number };
  return above.n + 1;
}

export function topSongs(id: number, limit = 5) {
  return db
    .prepare('SELECT song_key, song_title, song_artist, COUNT(*) AS plays, MAX(score) AS best FROM games WHERE player_id = ? GROUP BY song_key ORDER BY plays DESC, best DESC LIMIT ?')
    .all(id, limit);
}

export function soloRuns(id: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM games WHERE player_id = ? AND mode = 'solo'").get(id) as { n: number }).n;
}

export function profile(p: Player) {
  return { player: p, rank: rankOf(p), solo_runs: soloRuns(p.id), top_songs: topSongs(p.id) };
}

const SOCIAL_KEYS = ['twitch', 'youtube', 'x', 'discord'] as const;

/** Social handles: short, plain text (links are built by the client). */
export function saveSocials(id: number, raw: unknown): Player {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of SOCIAL_KEYS) {
    const v = String(src[k] ?? '').trim().replace(/^@/, '').replace(/[^\w.#\-]/g, '').slice(0, 40);
    if (v) out[k] = v;
  }
  db.prepare('UPDATE players SET socials = ? WHERE id = ?').run(JSON.stringify(out), id);
  return byId(id)!;
}

export function addRankedWin(id: number) {
  db.prepare('UPDATE players SET ranked_wins = ranked_wins + 1 WHERE id = ?').run(id);
}

// --- friends -------------------------------------------------------------------

export function addFriend(id: number, name: string): Player | { error: string } {
  const f = byName(String(name).trim());
  if (!f) return { error: 'No pilot with that name' };
  if (f.id === id) return { error: "That's you" };
  db.prepare('INSERT OR IGNORE INTO friends (player_id, friend_id, created_at) VALUES (?, ?, ?)').run(id, f.id, Date.now());
  return f;
}

export function removeFriend(id: number, friendId: number) {
  db.prepare('DELETE FROM friends WHERE player_id = ? AND friend_id = ?').run(id, friendId);
}

export function friendsOf(id: number): Player[] {
  return (db
    .prepare(`SELECT ${PUBLIC} FROM players WHERE id IN (SELECT friend_id FROM friends WHERE player_id = ?) ORDER BY name`)
    .all(id) as unknown as Player[]).map(hydrate);
}

// --- games & history ---------------------------------------------------------------

export interface GameRow {
  player_id: number;
  mode: 'solo' | 'ranked' | 'casual';
  match_id?: string | null;
  song_key: string;
  song_title: string;
  song_artist?: string;
  score: number;
  placement?: number | null;
  players?: number | null;
  points?: number | null;
  rating_delta?: number | null;
}

export function recordGame(g: GameRow) {
  db.prepare(
    `INSERT INTO games (player_id, mode, match_id, song_key, song_title, song_artist, score, placement, players, points, rating_delta, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    g.player_id, g.mode, g.match_id ?? null, g.song_key, g.song_title.slice(0, 200), (g.song_artist ?? '').slice(0, 120),
    Math.round(g.score), g.placement ?? null, g.players ?? null, g.points ?? null, g.rating_delta ?? null, Date.now(),
  );
  addToLibrary(g.player_id, g.song_key, g.song_title, g.song_artist ?? '');
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/** Add a song to a pilot's library (or bring it back and bump it to the top). */
export function addToLibrary(playerId: number, key: string, title: string, artist: string) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO library (player_id, song_key, title, artist, added_at, last_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (player_id, song_key) DO UPDATE SET last_at = excluded.last_at, hidden = 0,
       title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE title END,
       artist = CASE WHEN excluded.artist <> '' THEN excluded.artist ELSE artist END`,
  ).run(playerId, key.slice(0, 200), title.slice(0, 200), artist.slice(0, 120), now, now);
}

export interface LibrarySong {
  song_key: string;
  title: string;
  artist: string;
  added_at: number;
  last_at: number;
  plays: number;
  best: number | null;
}

/** A pilot's songs, with how often they raced each one and their best score. */
export function library(playerId: number): LibrarySong[] {
  return db
    .prepare(
      `SELECT l.song_key, l.title, l.artist, l.added_at, l.last_at, COUNT(g.id) AS plays, MAX(g.score) AS best
       FROM library l LEFT JOIN games g ON g.player_id = l.player_id AND g.song_key = l.song_key
       WHERE l.player_id = ? AND l.hidden = 0
       GROUP BY l.song_key ORDER BY l.last_at DESC LIMIT 500`,
    )
    .all(playerId) as unknown as LibrarySong[];
}

export function librarySize(playerId: number): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM library WHERE player_id = ? AND hidden = 0').get(playerId) as { n: number }).n;
}

export function removeFromLibrary(playerId: number, key: string) {
  db.prepare('UPDATE library SET hidden = 1 WHERE player_id = ? AND song_key = ?').run(playerId, key);
}

export function history(id: number, limit = 60) {
  return db
    .prepare('SELECT mode, match_id, song_key, song_title, song_artist, score, placement, players, points, rating_delta, created_at FROM games WHERE player_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(id, limit);
}

/** Songs people played recently: the fallback pool when a lobby runs out of submissions. */
export function recentSongs(limit = 30): { key: string; title: string; artist: string }[] {
  return db
    .prepare("SELECT song_key AS key, song_title AS title, song_artist AS artist, MAX(created_at) AS t FROM games WHERE song_key LIKE 'yt:%' GROUP BY song_key ORDER BY t DESC LIMIT ?")
    .all(limit) as unknown as { key: string; title: string; artist: string }[];
}

/** Apply a finished match: Elo changes (ranked) and match counters. */
export function applyMatch(mode: 'ranked' | 'casual', changes: { id: number; delta: number }[]) {
  if (mode === 'ranked') {
    const stmt = db.prepare('UPDATE players SET elo = MAX(0, elo + ?), ranked_matches = ranked_matches + 1 WHERE id = ?');
    for (const c of changes) stmt.run(Math.round(c.delta), c.id);
  } else {
    const stmt = db.prepare('UPDATE players SET casual_matches = casual_matches + 1 WHERE id = ?');
    for (const c of changes) stmt.run(c.id);
  }
}

/** Store a match's rating / casual-point change on the player's rounds, for their history. */
export function setMatchDelta(matchId: string, playerId: number, delta: number) {
  db.prepare('UPDATE games SET rating_delta = ? WHERE match_id = ? AND player_id = ?').run(Math.round(delta), matchId, playerId);
}
