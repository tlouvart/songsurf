import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-song leaderboards with ghost data, stored as one JSON file per song. Plenty for a
 * community server; swap for a database if it ever needs to scale.
 */

interface Run {
  v: 1;
  songId: string;
  name: string;
  score: number;
  date: number;
  rate: number;
  x: number[];
  s: number[];
}

const DIR = join(process.cwd(), '.cache', 'runs');
mkdirSync(DIR, { recursive: true });
const KEEP = 20;
const MAX_DURATION = 16 * 60;

const fileFor = (songId: string) => join(DIR, `${createHash('sha1').update(songId).digest('hex')}.json`);

function load(songId: string): Run[] {
  const f = fileFor(songId);
  if (!existsSync(f)) return [];
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return [];
  }
}

export function topRuns(songId: string, n = 10): Run[] {
  return load(songId).slice(0, n);
}

const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);

/** Validate and store a run. Returns the run's rank (1-based) and the board, or an error. */
export function addRun(body: unknown): { rank: number; board: { name: string; score: number; date: number }[] } | { error: string } {
  const r = body as Partial<Run>;
  if (!r || r.v !== 1) return { error: 'bad run' };
  if (typeof r.songId !== 'string' || r.songId.length > 200) return { error: 'bad song id' };
  const name = String(r.name ?? '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 16) || 'ANON';
  if (!isInt(r.score) || r.score! < 0 || r.score! > 50_000_000) return { error: 'bad score' };
  if (r.rate !== 10 || !Array.isArray(r.x) || !Array.isArray(r.s)) return { error: 'bad samples' };
  if (r.x.length !== r.s.length || r.x.length > MAX_DURATION * 10 || !r.x.every(isInt) || !r.s.every(isInt)) {
    return { error: 'bad samples' };
  }
  const run: Run = { v: 1, songId: r.songId, name, score: r.score!, date: Date.now(), rate: 10, x: r.x, s: r.s };

  let runs = load(run.songId);
  // One entry per pilot name: keep their best.
  const existing = runs.find((o) => o.name === name);
  if (existing && existing.score >= run.score) {
    runs.sort((a, b) => b.score - a.score);
  } else {
    runs = runs.filter((o) => o.name !== name);
    runs.push(run);
    runs.sort((a, b) => b.score - a.score);
    runs = runs.slice(0, KEEP);
    writeFileSync(fileFor(run.songId), JSON.stringify(runs));
  }
  const rank = runs.filter((o) => o.score > run.score).length + 1;
  return { rank, board: runs.slice(0, 10).map(({ name, score, date }) => ({ name, score, date })) };
}
