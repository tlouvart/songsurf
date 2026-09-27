import { HALF_WIDTH, holdLaneAt, LANE_WIDTH, LANES, laneX, type Block, type Track } from '../track/track.ts';
import { clamp } from '../track/random.ts';

/**
 * The race simulation, independent of rendering and of where inputs come from: the racer
 * is driven by a Controller (local input or autopilot). Everything is keyed on song time,
 * so a run can be recorded and replayed as a ghost on the same track.
 *
 * Scoring is catch & combo: every caught block scores by colour × the combo multiplier.
 * Missing a block halves the combo, catching a grey block resets it.
 */

/** points per block, by colour tier (cool → hot) */
export const NOTE_POINTS = [10, 15, 20, 30, 40];
export const GEM_POINTS = 250;
export const GREY_PENALTY = 50;
export const COMBO_STEP = 10;
export const MAX_MULT = 8;
const CATCH_RADIUS = LANE_WIDTH * 0.6;
const MAGNET_RADIUS = LANE_WIDTH * 1.55;
export const OVERDRIVE_TIME = 8;
/** long blocks: points per tick while riding, and the tick period */
export const HOLD_TICK_POINTS = 4;
export const HOLD_TICK = 0.125;
/** chains: bonus per block when every block of the chain was caught */
export const STREAM_BONUS = 20;

export interface Controller {
  /** Called every tick; set racer.targetX (lateral target) and optionally request overdrive. */
  update(r: Racer, sim: RaceSim, dt: number): void;
}

export interface Racer {
  color: number;
  controller: Controller;
  x: number;
  targetX: number;
  vx: number;
  score: number;
  combo: number;
  maxCombo: number;
  notes: number;
  missed: number;
  greys: number;
  gems: number;
  overdrive: number;
  overdriveUntil: number;
  wantsOverdrive: boolean;
  hurtAt: number;
  /** the long block being ridden, if any */
  hold: { block: Block; nextTick: number } | null;
  holds: number;
  streamsPerfect: number;
}

export type RaceEvent =
  | { type: 'catch'; block: Block; points: number; mult: number }
  | { type: 'gem'; block: Block; points: number }
  | { type: 'grey'; block: Block }
  | { type: 'miss'; block: Block; comboBefore: number }
  | { type: 'multiplier'; mult: number }
  | { type: 'overdrive' }
  | { type: 'holdTick'; block: Block; points: number }
  | { type: 'holdBreak'; block: Block }
  | { type: 'holdDone'; block: Block; points: number }
  | { type: 'pellet'; block: Block; points: number; index: number; total: number }
  | { type: 'streamDone'; id: number; caught: number; total: number; points: number };

export const multiplierOf = (r: Racer) => Math.min(MAX_MULT, 1 + Math.floor(r.combo / COMBO_STEP));

export class RaceSim {
  racer: Racer;
  time = -Infinity;
  private next = 0;
  private streamCaught = new Map<number, number>();
  private streamSeen = new Map<number, number>();

  constructor(
    public track: Track,
    controller: Controller,
    color: number,
    private emit: (e: RaceEvent) => void,
  ) {
    this.racer = {
      color, controller,
      x: 0, targetX: 0, vx: 0, score: 0, combo: 0, maxCombo: 0, notes: 0, missed: 0, greys: 0, gems: 0,
      overdrive: 0, overdriveUntil: -1, wantsOverdrive: false, hurtAt: -10, hold: null, holds: 0, streamsPerfect: 0,
    };
  }

  overdriveActive(r: Racer = this.racer) {
    return this.time < r.overdriveUntil;
  }

  /** Blocks whose time is within [t0, t1]. Handy for controllers. */
  upcoming(t0: number, t1: number): Block[] {
    const out: Block[] = [];
    const bl = this.track.blocks;
    for (let i = this.next; i < bl.length && bl[i].time <= t1; i++) if (bl[i].time >= t0) out.push(bl[i]);
    return out;
  }

  update(time: number, frameDt: number) {
    // Movement runs on song time too, so a slow frame never leaves the ship behind the music.
    const dt = Number.isFinite(this.time) ? clamp(time - this.time, 0, 0.1) : frameDt;
    this.time = time;
    const r = this.racer;
    r.controller.update(r, this, dt);
    r.targetX = clamp(r.targetX, laneX(0), laneX(LANES - 1));
    // Exact critically damped spring (stable at any dt): a lane switch settles in ~0.1 s.
    const w = 38;
    const e = r.x - r.targetX;
    const j = r.vx + w * e;
    const decay = Math.exp(-w * dt);
    r.x = clamp(r.targetX + (e + j * dt) * decay, -HALF_WIDTH + 0.8, HALF_WIDTH - 0.8);
    r.vx = (r.vx - w * j * dt) * decay;

    if (r.wantsOverdrive) {
      r.wantsOverdrive = false;
      if (r.overdrive >= 1 && !this.overdriveActive(r)) {
        r.overdrive = 0;
        r.overdriveUntil = time + OVERDRIVE_TIME;
        this.emit({ type: 'overdrive' });
      }
    }

    this.updateHold(time);

    const bl = this.track.blocks;
    while (this.next < bl.length && bl[this.next].time <= time) {
      const b = bl[this.next++];
      // Blocks that went by long ago (seek, tab stall) are simply missed.
      if (time - b.time > 0.3) b.resolved = true;
      else this.resolve(b);
    }
  }

  /** Riding a long block: tick points while on its lane, break when you leave it. */
  private updateHold(time: number) {
    const r = this.racer;
    const h = r.hold;
    if (!h) return;
    const b = h.block;
    const end = b.holdEnd!;
    const onIt = Math.abs(r.x - laneX(holdLaneAt(b, Math.min(time, end)))) < CATCH_RADIUS * 1.15;
    if (!onIt) {
      b.holdState = 3;
      r.hold = null;
      this.emit({ type: 'holdBreak', block: b });
      return;
    }
    const od = this.overdriveActive(r) ? 2 : 1;
    while (h.nextTick <= Math.min(time, end)) {
      h.nextTick += HOLD_TICK;
      const points = HOLD_TICK_POINTS * multiplierOf(r) * od;
      r.score += points;
      this.emit({ type: 'holdTick', block: b, points });
    }
    if (time >= end) {
      b.holdState = 2;
      r.hold = null;
      r.holds++;
      const points = Math.round((50 + (end - b.time) * 60) * multiplierOf(r) * od);
      r.score += points;
      this.emit({ type: 'holdDone', block: b, points });
    }
  }

  private pellet(b: Block, caught: boolean) {
    const r = this.racer;
    const id = b.stream!;
    const st = this.track.streams[id];
    const seen = (this.streamSeen.get(id) ?? 0) + 1;
    this.streamSeen.set(id, seen);
    if (caught) {
      const n = (this.streamCaught.get(id) ?? 0) + 1;
      this.streamCaught.set(id, n);
      this.emit({ type: 'pellet', block: b, points: 0, index: n, total: st.count });
    } else st.broken = true;
    if (seen === st.count) {
      const got = this.streamCaught.get(id) ?? 0;
      const perfect = got === st.count;
      const points = perfect ? STREAM_BONUS * st.count * multiplierOf(r) * (this.overdriveActive(r) ? 2 : 1) : 0;
      if (perfect) r.streamsPerfect++;
      r.score += points;
      this.emit({ type: 'streamDone', id, caught: got, total: st.count, points });
    }
  }

  private partnerOf(b: Block) {
    return b.partner >= 0 ? this.track.blocks.find((o) => o.id === b.partner) : undefined;
  }

  private resolve(b: Block) {
    b.resolved = true;
    const r = this.racer;
    const partner = this.partnerOf(b);
    // Greys are only caught when you are really in their lane — the magnet ignores them.
    const radius = b.kind === 'grey' ? CATCH_RADIUS * 0.8 : this.overdriveActive(r) ? MAGNET_RADIUS : CATCH_RADIUS;
    const inReach = Math.abs(r.x - laneX(b.lane)) < radius && !(partner && partner.takenBy >= 0);

    // Chain blocks are ordinary blocks; the chain also tracks whether you got every one.
    if (b.kind === 'pellet') this.pellet(b, inReach);

    if (!inReach) {
      if (b.kind === 'grey') return;
      if (b.holdEnd !== undefined) b.holdState = 3;
      // One half of a chord is enough; the miss is decided when the second half resolves.
      if (partner && (!partner.resolved || partner.takenBy >= 0)) return;
      r.missed++;
      if (r.combo > 0) {
        const before = r.combo;
        const multBefore = multiplierOf(r);
        r.combo = Math.floor(r.combo / 2);
        this.emit({ type: 'miss', block: b, comboBefore: before });
        if (multiplierOf(r) !== multBefore) this.emit({ type: 'multiplier', mult: multiplierOf(r) });
      }
      return;
    }

    b.takenBy = 0;
    if (b.kind === 'grey') {
      r.greys++;
      const hadMult = multiplierOf(r) > 1;
      r.combo = 0;
      r.score = Math.max(0, r.score - GREY_PENALTY);
      r.hurtAt = this.time;
      this.emit({ type: 'grey', block: b });
      if (hadMult) this.emit({ type: 'multiplier', mult: 1 });
      return;
    }

    const od = this.overdriveActive(r) ? 2 : 1;
    if (b.kind === 'gem') {
      r.gems++;
      r.overdrive = Math.min(1, r.overdrive + 0.5);
      const points = GEM_POINTS * multiplierOf(r) * od;
      r.score += points;
      this.emit({ type: 'gem', block: b, points });
      return;
    }

    const multBefore = multiplierOf(r);
    r.notes++;
    r.combo++;
    r.maxCombo = Math.max(r.maxCombo, r.combo);
    r.overdrive = Math.min(1, r.overdrive + 0.006);
    const mult = multiplierOf(r);
    const points = NOTE_POINTS[b.tier] * mult * od;
    r.score += points;
    this.emit({ type: 'catch', block: b, points, mult });
    if (mult !== multBefore) this.emit({ type: 'multiplier', mult });
    if (b.holdEnd !== undefined) {
      b.holdState = 1;
      r.hold = { block: b, nextTick: b.time + HOLD_TICK };
    }
  }
}
