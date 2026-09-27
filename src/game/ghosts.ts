/**
 * Ghost runs: a run is recorded as the ship's lateral position and the score over song
 * time. Because the track is fully determined by the song, that is enough to replay the
 * run as a ghost ship next to anyone else riding the same song.
 */

export interface GhostRun {
  v: 1;
  songId: string;
  name: string;
  score: number;
  date: number;
  /** samples per second */
  rate: number;
  /** lateral position ×10, rounded */
  x: number[];
  /** score at each sample */
  s: number[];
}

export const GHOST_RATE = 10;
export const GHOST_COLORS = [0xffd23f, 0x3dffb0, 0xff7a3a, 0xb07aff];

export class Recorder {
  private x: number[] = [];
  private s: number[] = [];

  /** Call every frame; it samples at a fixed rate on song time. */
  push(time: number, x: number, score: number) {
    if (time < 0) return;
    while (this.x.length <= time * GHOST_RATE) {
      this.x.push(Math.round(x * 10));
      this.s.push(score);
    }
  }

  finish(songId: string, name: string, score: number): GhostRun {
    return { v: 1, songId, name, score, date: Date.now(), rate: GHOST_RATE, x: this.x, s: this.s };
  }
}

export class Ghost {
  constructor(public run: GhostRun, public color: number, public label: string) {}

  private at(arr: number[], time: number) {
    if (!arr.length) return 0;
    const f = Math.max(0, time * this.run.rate);
    const i = Math.min(arr.length - 1, Math.floor(f));
    const j = Math.min(arr.length - 1, i + 1);
    return arr[i] + (arr[j] - arr[i]) * (f - i);
  }

  xAt(time: number) {
    return this.at(this.run.x, time) / 10;
  }

  /** lateral velocity, for banking */
  vxAt(time: number) {
    return (this.xAt(time + 0.05) - this.xAt(time - 0.05)) / 0.1;
  }

  scoreAt(time: number) {
    if (time < 0) return 0;
    const i = Math.min(this.run.s.length - 1, Math.floor(time * this.run.rate));
    return i >= 0 ? this.run.s[i] : 0;
  }
}

// ---------------------------------------------------------------------------
// Persistence: personal best locally, shared leaderboard on the SongSurf server.
// ---------------------------------------------------------------------------

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export function playerName(): string {
  return safe(() => localStorage.getItem('songsurf:name') || '', '');
}

export function setPlayerName(name: string) {
  safe(() => localStorage.setItem('songsurf:name', name.slice(0, 16)), undefined);
}

export function localBest(songId: string): GhostRun | null {
  return safe(() => JSON.parse(localStorage.getItem(`songsurf:pb:${songId}`) || 'null') as GhostRun | null, null);
}

export function saveLocalBest(run: GhostRun) {
  safe(() => localStorage.setItem(`songsurf:pb:${run.songId}`, JSON.stringify(run)), undefined);
}

export interface BoardEntry {
  name: string;
  score: number;
  date: number;
}

/** Top runs for a song (with ghost data). Resolves to [] when the server is unreachable. */
export async function fetchTopRuns(songId: string, timeoutMs = 2500): Promise<GhostRun[]> {
  try {
    const res = await fetch(`/api/runs?song=${encodeURIComponent(songId)}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    return ((await res.json()).runs as GhostRun[]) ?? [];
  } catch {
    return [];
  }
}

export async function submitRun(run: GhostRun): Promise<{ rank: number; board: BoardEntry[] } | null> {
  try {
    const res = await fetch('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(run),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Pick who to race: the top of the board, and your own best, without duplicates. */
export function pickGhosts(songId: string, top: GhostRun[], me: string): Ghost[] {
  const pb = localBest(songId);
  const chosen: { run: GhostRun; label: string }[] = [];
  // Two at most, so the track stays readable: the run to beat, and your own best.
  for (const run of top.slice(0, 1)) chosen.push({ run, label: run.name });
  if (pb && !chosen.some((c) => c.run.name === pb.name && c.run.score === pb.score)) {
    chosen.push({ run: pb, label: me && pb.name === me ? 'YOUR BEST' : pb.name });
  } else {
    const mine = chosen.find((c) => pb && c.run.name === pb.name && c.run.score === pb.score);
    if (mine) mine.label = 'YOUR BEST';
  }
  return chosen.slice(0, 2).map((c, i) => new Ghost(c.run, GHOST_COLORS[i % GHOST_COLORS.length], c.label));
}
