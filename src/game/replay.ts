import type { Block, Stream } from '../track/track.ts';
import { RaceSim, STEP, X_QUANT, type Controller, type InputSink, type Racer } from './sim.ts';
import { GHOST_RATE } from './ghosts.ts';

/**
 * Runs as input logs. A live run records what the pilot asked for, step by step (lateral
 * target changes and overdrive requests), and streams it to the server in small chunks. The
 * server feeds the same inputs to its own simulation of the same track: the score it gets is
 * the score that counts, so a modified client can't simply claim one.
 */

export interface InputChunk {
  /** first step this chunk covers (the one after the previous chunk's upTo) */
  from: number;
  /** inputs are recorded up to and including this step */
  upTo: number;
  /** [step, target×100, step, target×100, …], steps increasing */
  moves: number[];
  /** steps where overdrive was requested */
  od: number[];
}

/** Collects inputs from a live sim and hands them out in chunks. */
export class InputLog implements InputSink {
  private moves: number[] = [];
  private od: number[] = [];
  private lastX = 0;
  private last: number | null = null;
  private from: number | null = null;

  record(step: number, xq: number, overdrive: boolean) {
    this.from ??= step;
    this.last = step;
    if (xq !== this.lastX) {
      this.moves.push(step, xq);
      this.lastX = xq;
    }
    if (overdrive) this.od.push(step);
  }

  /** Everything recorded since the previous take, or null before the first step. */
  take(): InputChunk | null {
    if (this.last === null || this.from === null || this.from > this.last) return null;
    const chunk = { from: this.from, upTo: this.last, moves: this.moves, od: this.od };
    this.from = this.last + 1;
    this.moves = [];
    this.od = [];
    return chunk;
  }
}

/** Plays inputs back into a sim. */
class ReplayController implements Controller {
  moves: number[] = [];
  od: number[] = [];
  private mi = 0;
  private oi = 0;
  private x = 0;

  update(r: Racer, sim: RaceSim) {
    const step = sim.step!;
    while (this.mi < this.moves.length && this.moves[this.mi] <= step) {
      this.x = this.moves[this.mi + 1] / X_QUANT;
      this.mi += 2;
    }
    r.targetX = this.x;
    while (this.oi < this.od.length && this.od[this.oi] <= step) {
      if (this.od[this.oi] === step) r.wantsOverdrive = true;
      this.oi++;
    }
  }
}

/** The part of a track the simulation needs (the server never builds the geometry). */
export interface TrackCore {
  duration: number;
  blocks: Block[];
  streams: Stream[];
}

const MAX_MOVES_PER_CHUNK = 4000;
const MAX_X = 7 * X_QUANT;

/**
 * Server side: replays a run chunk by chunk and keeps its authoritative score. Also samples
 * the run as a ghost (lateral position and score at GHOST_RATE), for the song's board.
 */
export class RunVerifier {
  readonly sim: RaceSim;
  private ctrl = new ReplayController();
  private lastStep: number | null = null;
  private lastMove = -Infinity;
  ghostX: number[] = [];
  ghostS: number[] = [];

  constructor(private track: TrackCore) {
    // Blocks carry per-run state: every run gets its own copy.
    const run = { ...track, blocks: track.blocks.map((b) => ({ ...b })), streams: track.streams.map((s) => ({ ...s })) };
    this.sim = new RaceSim(run as never, this.ctrl, 0, () => {});
  }

  get score() {
    return this.sim.racer.score;
  }

  /** Song time the run has reached. */
  get time() {
    return this.lastStep === null ? -Infinity : this.lastStep * STEP;
  }

  /** Apply one chunk; returns an error for anything a real client could not have sent. */
  feed(c: unknown): string | null {
    const chunk = c as InputChunk;
    if (!chunk || !Number.isInteger(chunk.from) || !Number.isInteger(chunk.upTo) || !Array.isArray(chunk.moves) || !Array.isArray(chunk.od)) return 'bad input';
    if (chunk.upTo < chunk.from) return 'bad input';
    if (this.lastStep !== null && chunk.from !== this.lastStep + 1) return 'missing inputs';
    if (chunk.moves.length % 2 || chunk.moves.length > MAX_MOVES_PER_CHUNK * 2 || chunk.od.length > 64) return 'bad input';
    if (chunk.upTo * STEP > this.track.duration + 30) return 'past the end of the song';
    const first = chunk.from - 1;
    for (let i = 0; i < chunk.moves.length; i += 2) {
      const step = chunk.moves[i], x = chunk.moves[i + 1];
      if (!Number.isInteger(step) || !Number.isInteger(x) || Math.abs(x) > MAX_X) return 'bad input';
      if (step <= first || step <= this.lastMove || step > chunk.upTo) return 'bad input';
      this.lastMove = step;
    }
    let prevOd = first;
    for (const step of chunk.od) {
      if (!Number.isInteger(step) || step <= prevOd || step > chunk.upTo) return 'bad input';
      prevOd = step;
    }
    this.ctrl.moves.push(...chunk.moves);
    this.ctrl.od.push(...chunk.od);
    // The run starts where the pilot started (late joiners start mid-song).
    if (this.lastStep === null) this.sim.step = chunk.from - 1;
    this.lastStep = chunk.upTo;
    while (this.sim.step! < chunk.upTo) {
      this.sim.advanceTo(this.sim.step! + 1);
      const t = this.sim.time;
      if (t >= 0) {
        while (this.ghostX.length <= t * GHOST_RATE) {
          this.ghostX.push(Math.round(this.sim.racer.x * 10));
          this.ghostS.push(this.sim.racer.score);
        }
      }
    }
    return null;
  }

  /** Did the run reach the end of the song? */
  get complete() {
    return this.time >= this.track.duration - 0.5;
  }
}

/**
 * Checks that a run keeps pace with the music in real time: a client that plays faster
 * (bots generating a run offline) or slower (slow motion) than the clock drifts away from
 * the anchor. `anchor` is the wall time (ms) at which song time 0 is expected; pauses are
 * declared and timed by the server.
 */
export class Pacer {
  private pausedTotal = 0;
  private pausedAt: number | null = null;
  pauses = 0;

  constructor(private anchor: number, private ahead = 2000, private behind = 8000) {}

  check(now: number, songTime: number): string | null {
    if (this.pausedAt !== null) return 'inputs while paused';
    const off = now - songTime * 1000 - this.pausedTotal - this.anchor;
    if (off < -this.ahead) return 'ahead of the music';
    if (off > this.behind) return 'behind the music';
    return null;
  }

  pause(now: number) {
    if (this.pausedAt === null) {
      this.pausedAt = now;
      this.pauses++;
    }
  }

  resume(now: number) {
    if (this.pausedAt !== null) {
      this.pausedTotal += now - this.pausedAt;
      this.pausedAt = null;
    }
  }
}
