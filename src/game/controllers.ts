import { holdLaneAt, LANES, laneX, LANE_WIDTH, type Block } from '../track/track.ts';
import { clamp, mulberry32 } from '../track/random.ts';
import type { Controller, RaceSim, Racer } from './sim.ts';

/** Keyboard (discrete lanes), mouse / touch (analog, softly snapped to lanes). */
export class LocalController implements Controller {
  private lane = 2;
  private mode: 'keys' | 'pointer' = 'keys';
  private pointerX = 0.5;
  private held: { dir: number; next: number } | null = null;
  private overdrive = false;
  enabled = true;
  private cleanup: () => void;

  constructor(target: HTMLElement) {
    const step = (dir: number) => {
      this.mode = 'keys';
      this.lane = clamp(this.lane + dir, 0, LANES - 1);
    };
    const keydown = (e: KeyboardEvent) => {
      if (!this.enabled || e.repeat) return;
      const k = e.key.toLowerCase();
      if (k === 'arrowleft' || k === 'a' || k === 'q') { step(-1); this.held = { dir: -1, next: performance.now() + 150 }; }
      else if (k === 'arrowright' || k === 'd') { step(1); this.held = { dir: 1, next: performance.now() + 150 }; }
      else if (k === ' ' || k === 'arrowup' || k === 'w' || k === 'z' || k === 'shift') { this.overdrive = true; e.preventDefault(); }
      else if (k >= '1' && k <= '5') { this.mode = 'keys'; this.lane = Number(k) - 1; }
    };
    const keyup = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (this.held && ((this.held.dir < 0 && ['arrowleft', 'a', 'q'].includes(k)) || (this.held.dir > 0 && ['arrowright', 'd'].includes(k)))) this.held = null;
    };
    const move = (clientX: number) => {
      if (!this.enabled) return;
      this.mode = 'pointer';
      const w = target.clientWidth || window.innerWidth;
      this.pointerX = clamp((clientX / w - 0.2) / 0.6, 0, 1);
    };
    const mouse = (e: MouseEvent) => {
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 0) move(e.clientX);
    };
    const touch = (e: TouchEvent) => {
      if (e.touches[0]) move(e.touches[0].clientX);
    };
    let lastTap = 0;
    const touchStart = (e: TouchEvent) => {
      const now = performance.now();
      if (now - lastTap < 280) this.overdrive = true;
      lastTap = now;
      touch(e);
    };
    const click = (e: MouseEvent) => { if (e.button === 2 || e.detail === 2) this.overdrive = true; };
    const ctx = (e: Event) => e.preventDefault();
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    target.addEventListener('mousemove', mouse);
    target.addEventListener('touchstart', touchStart, { passive: true });
    target.addEventListener('touchmove', touch, { passive: true });
    target.addEventListener('mousedown', click);
    target.addEventListener('contextmenu', ctx);
    this.cleanup = () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      target.removeEventListener('mousemove', mouse);
      target.removeEventListener('touchstart', touchStart);
      target.removeEventListener('touchmove', touch);
      target.removeEventListener('mousedown', click);
      target.removeEventListener('contextmenu', ctx);
    };
  }

  dispose() {
    this.cleanup();
  }

  update(r: Racer) {
    const now = performance.now();
    if (this.held && now > this.held.next) {
      this.lane = clamp(this.lane + this.held.dir, 0, LANES - 1);
      this.held.next = now + 80;
    }
    if (this.overdrive) {
      r.wantsOverdrive = true;
      this.overdrive = false;
    }
    if (this.mode === 'keys') {
      r.targetX = laneX(this.lane);
    } else {
      const raw = laneX(0) + this.pointerX * (laneX(LANES - 1) - laneX(0));
      const nearest = clamp(Math.round(raw / LANE_WIDTH + (LANES - 1) / 2), 0, LANES - 1);
      this.lane = nearest;
      // Soft magnetic snap toward the lane centre keeps analog control precise.
      r.targetX = laneX(nearest) + (raw - laneX(nearest)) * 0.3;
    }
  }
}

export interface BotSkill {
  /** seconds before a block the bot commits to its lane */
  reaction: number;
  /** probability of picking the right lane */
  accuracy: number;
  /** probability of noticing a grey block */
  awareness: number;
  /** how far off lane centre it tends to ride */
  sloppiness: number;
}

export class BotController implements Controller {
  private rng: () => number;
  private decisions = new Map<number, number>();
  private wobble = 0;
  private odDelay = -1;

  constructor(private skill: BotSkill, seed: number) {
    this.rng = mulberry32(seed);
  }

  private decide(b: Block): number {
    let d = this.decisions.get(b.id);
    if (d === undefined) {
      const ok = this.rng() < this.skill.accuracy;
      const lane = ok ? b.lane : clamp(b.lane + (this.rng() < 0.5 ? -1 : 1), 0, LANES - 1);
      d = laneX(lane) + (this.rng() * 2 - 1) * this.skill.sloppiness;
      this.decisions.set(b.id, d);
    }
    return d;
  }

  update(r: Racer, sim: RaceSim, dt: number) {
    const t = sim.time;
    // Ride long blocks to the end (a good bot follows their slides too).
    if (r.hold) {
      r.targetX = laneX(holdLaneAt(r.hold.block, t + 0.08));
      return;
    }
    const soon = sim.upcoming(t, t + this.skill.reaction + 0.6);
    let target: Block | null = null;
    for (const b of soon) {
      if (b.kind === 'grey' || b.resolved) continue;
      if (b.time - t > this.skill.reaction) break;
      if (!target) target = b;
      else if (b.time === target.time && Math.abs(laneX(b.lane) - r.x) < Math.abs(laneX(target.lane) - r.x)) target = b;
    }
    let x = target ? this.decide(target) : r.targetX;

    // Dodge grey blocks it notices.
    for (const b of soon) {
      if (b.kind !== 'grey' || b.time - t > 0.45) continue;
      if (Math.abs(laneX(b.lane) - x) < LANE_WIDTH * 0.6 && (this.decisions.get(-b.id - 1) ?? (this.rng() < this.skill.awareness ? 1 : 0)) === 1) {
        this.decisions.set(-b.id - 1, 1);
        x = laneX(clamp(b.lane + (b.lane >= 2 ? -1 : 1), 0, LANES - 1));
      } else this.decisions.set(-b.id - 1, 0);
    }

    this.wobble += dt;
    r.targetX = x + Math.sin(this.wobble * 1.7) * this.skill.sloppiness * 0.4;

    if (r.overdrive >= 1 && !sim.overdriveActive(r)) {
      if (this.odDelay < 0) this.odDelay = t + 0.5 + this.rng() * 4;
      else if (t > this.odDelay) {
        r.wantsOverdrive = true;
        this.odDelay = -1;
      }
    }
    if (this.decisions.size > 400) this.decisions.clear();
  }
}

/** Autopilot for the menu's attract mode: near perfect, always centred. */
export class AutopilotController extends BotController {
  constructor() {
    super({ reaction: 0.35, accuracy: 0.97, awareness: 1, sloppiness: 0 }, 7);
  }
}
