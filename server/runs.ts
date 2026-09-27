import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-song leaderboards with ghost data, stored as one JSON file per song. Only runs the
 * server replayed and scored itself get here. Plenty for a community server; swap for a
 * database if it ever needs to scale.
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

/**
 * Store a run the server scored itself (see ./solo.ts). Returns the run's rank (1-based) and
 * the board.
 */
export function addVerifiedRun(r: { songId: string; name: string; score: number; x: number[]; s: number[] }): {
  rank: number;
  board: { name: string; score: number; date: number }[];
} {
  const run: Run = { v: 1, songId: r.songId, name: r.name, score: r.score, date: Date.now(), rate: 10, x: r.x, s: r.s };
  let runs = load(run.songId);
  // One entry per pilot name: keep their best.
  const existing = runs.find((o) => o.name === run.name);
  if (!existing || existing.score < run.score) {
    runs = runs.filter((o) => o.name !== run.name);
    runs.push(run);
    runs.sort((a, b) => b.score - a.score);
    runs = runs.slice(0, KEEP);
    writeFileSync(fileFor(run.songId), JSON.stringify(runs));
  }
  const rank = runs.filter((o) => o.score > run.score).length + 1;
  return { rank, board: runs.slice(0, 10).map(({ name, score, date }) => ({ name, score, date })) };
}
