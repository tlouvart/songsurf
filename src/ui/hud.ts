import type { SongMeta } from '../audio/loader.ts';
import type { BoardEntry, Ghost } from '../game/ghosts.ts';

export interface Rival {
  id: number;
  name: string;
  color: number;
}
import { multiplierOf, OVERDRIVE_TIME, type RaceEvent, type RaceSim } from '../game/sim.ts';
import { PRE_ROLL, type Track } from '../track/track.ts';
import { intensityColor, TIER_COLORS } from '../render/palette.ts';
import type { Stage } from '../render/stage.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class Hud {
  private root = $('hud');
  private score = $('hud-score');
  private mult = $('hud-mult');
  private combo = $('hud-combo');
  private best = $('hud-best');
  private od = $('hud-od');
  private odBox = this.od.parentElement!;
  private odLabel = $('hud-od-label');
  private board = $('board');
  private tags = $('tags');
  private popups = $('popups');
  private countdown = $('countdown');
  private hint = $('hud-hint');
  private progress = $<HTMLCanvasElement>('hud-progress');
  private graph: HTMLCanvasElement | null = null;
  private shownScore = 0;
  private lastCount = '';
  private duration = 1;
  private bestValue = 0;
  private rivals: Rival[] = [];
  private rivalScores: Record<number, number> = {};
  private pace = $('hud-pace');
  private paceRun: Ghost | null = null;
  private rows: HTMLLIElement[] = [];
  private screen = { x: 0, y: 0, visible: false };

  show(on: boolean) {
    this.root.classList.toggle('hidden', !on);
  }

  /** rivals: lobby opponents (live scores come from the server); paceRun: your best, for the pace line. */
  setup(meta: SongMeta, track: Track, rivals: Rival[], best: number, playerColor: number, paceRun: Ghost | null = null) {
    $('hud-title').textContent = meta.title;
    $('hud-artist').textContent = meta.artist;
    this.duration = track.duration;
    this.shownScore = 0;
    this.lastCount = '';
    this.popups.innerHTML = '';
    this.hint.style.opacity = '1';
    this.bestValue = best;
    this.best.textContent = best ? `BEST ${fmt(best)}` : '';
    this.best.classList.remove('beaten');
    this.graph = this.renderGraph(track);

    // Live board: you + your lobby rivals, updated from the server.
    this.rivals = rivals;
    this.rivalScores = {};
    this.paceRun = paceRun;
    this.pace.textContent = '';
    this.board.innerHTML = '';
    this.tags.innerHTML = '';
    const row = (name: string, color: number, me: boolean) => {
      const li = document.createElement('li');
      li.className = me ? 'me' : '';
      li.innerHTML = `<span class="dot" style="color:${hex(color)}"></span><span class="name">${esc(name)}</span><span class="pts">0</span>`;
      this.board.appendChild(li);
      return li;
    };
    this.rows = rivals.length ? [row('YOU', playerColor, true), ...rivals.map((r) => row(r.name, r.color, false))] : [];
    this.board.style.height = `${this.rows.length * 30}px`;
  }

  /** Pre-render the song's intensity profile as the progress bar background. */
  private renderGraph(track: Track): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.progress.width;
    c.height = this.progress.height;
    const g = c.getContext('2d')!;
    const w = c.width, h = c.height;
    const n = w / 3;
    for (let i = 0; i < n; i++) {
      const t = (i / n) * track.duration;
      const idx = Math.min(track.count - 1, Math.round((t + PRE_ROLL) * 60));
      const v = track.intensity[idx];
      const col = intensityColor(v);
      g.fillStyle = `rgb(${col.r * 255},${col.g * 255},${col.b * 255})`;
      const bh = 4 + v * (h - 8);
      g.fillRect(i * 3, h - bh, 2, bh);
    }
    return c;
  }

  update(sim: RaceSim, stage: Stage, time: number) {
    const me = sim.racer;

    // Score counts up smoothly.
    const diff = me.score - this.shownScore;
    this.shownScore += Math.abs(diff) < 2 ? diff : diff * 0.2;
    this.score.textContent = fmt(this.shownScore);
    const m = multiplierOf(me) * (sim.overdriveActive(me) ? 2 : 1);
    this.mult.textContent = `x${m}`;
    this.mult.classList.toggle('hot', m >= 6);
    this.combo.textContent = me.combo >= 5 ? `${me.combo} COMBO` : '';
    if (this.bestValue && me.score > this.bestValue && !this.best.classList.contains('beaten')) {
      this.best.classList.add('beaten');
      this.best.textContent = 'NEW BEST!';
    }
    document.documentElement.style.setProperty('--heat', `#${intensityColor(stage.heat).getHexString()}`);

    const odActive = sim.overdriveActive(me);
    const odFill = odActive ? (me.overdriveUntil - time) / OVERDRIVE_TIME : me.overdrive;
    this.od.style.width = `${Math.max(0, Math.min(1, odFill)) * 100}%`;
    this.odBox.classList.toggle('ready', me.overdrive >= 1 && !odActive);
    this.odBox.classList.toggle('active', odActive);
    this.odLabel.textContent = odActive ? 'OVERDRIVE ×2' : me.overdrive >= 1 ? 'PRESS SPACE' : 'OVERDRIVE';

    if (this.paceRun && time > 2) {
      const d = me.score - this.paceRun.scoreAt(time);
      this.pace.textContent = `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))} vs best`;
      this.pace.style.color = d >= 0 ? '#3dffb0' : '#ff8a7a';
    }

    if (this.rivals.length) {
      const scores = [me.score, ...this.rivals.map((r) => this.rivalScores[r.id] ?? 0)];
      const order = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
      order.forEach(([s, i], rank) => {
        const li = this.rows[i];
        li.style.transform = `translateY(${rank * 30}px)`;
        (li.lastElementChild as HTMLElement).textContent = fmt(s);
      });
    }

    // Progress
    const g = this.progress.getContext('2d')!;
    const w = this.progress.width, h = this.progress.height;
    g.clearRect(0, 0, w, h);
    if (this.graph) {
      const px = Math.max(0, Math.min(1, time / this.duration)) * w;
      g.globalAlpha = 0.35;
      g.drawImage(this.graph, 0, 0);
      g.globalAlpha = 1;
      if (px > 0) g.drawImage(this.graph, 0, 0, px, h, 0, 0, px, h);
      g.fillStyle = '#fff';
      g.fillRect(px - 1.5, 0, 3, h);
    }

    // Countdown
    let label = '';
    if (time < 0 && time > -3) label = String(Math.ceil(-time));
    else if (time >= 0 && time < 0.7) label = 'GO!';
    if (label !== this.lastCount) {
      this.lastCount = label;
      this.countdown.innerHTML = label ? `<span>${label}</span>` : '';
    }
    if (time > 8) this.hint.style.opacity = '0';
  }

  setRivalScores(scores: Record<number, number>) {
    this.rivalScores = scores;
  }

  onEvent(e: RaceEvent, stage: Stage, sim: RaceSim) {
    // Feedback stays close to the ship: no screen-wide call-outs.
    if (e.type === 'catch') {
      const combo = sim.racer.combo;
      this.combo.classList.remove('tick');
      void this.combo.offsetWidth;
      this.combo.classList.add('tick');
      if (combo % 25 === 0) this.pop(`${combo} COMBO`, '#33e1ff', 16 + Math.min(12, combo / 25 * 2), stage);
    } else if (e.type === 'grey') {
      this.pop('GREY', '#c8ccd8', 16, stage);
    } else if (e.type === 'miss' && e.comboBefore >= 10) {
      this.pop(`COMBO ${e.comboBefore} → ${sim.racer.combo}`, '#a79cc9', 13, stage);
    } else if (e.type === 'gem') {
      this.pop(`+${fmt(e.points)}`, '#fff1c2', 18, stage);
      this.bump();
    } else if (e.type === 'multiplier' && e.mult > 1) {
      this.pop(`×${e.mult}`, '#ffd84a', 16 + e.mult * 2, stage);
      this.bump();
    } else if (e.type === 'holdDone') {
      this.pop(`+${fmt(e.points)}`, `#${TIER_COLORS[e.block.tier].getHexString()}`, 17, stage);
      this.bump();
    } else if (e.type === 'streamDone') {
      if (e.caught === e.total) {
        this.pop(`STREAM ${e.total}/${e.total}  +${fmt(e.points)}`, '#ffd84a', 18, stage);
        this.bump();
      } else this.pop(`STREAM ${e.caught}/${e.total}`, '#a79cc9', 13, stage);
    } else if (e.type === 'overdrive') {
      this.pop('OVERDRIVE', '#ffd84a', 18, stage);
    }
  }

  private bump() {
    this.score.classList.remove('bump');
    void this.score.offsetWidth;
    this.score.classList.add('bump');
  }

  private pop(text: string, color: string, size: number, stage: Stage) {
    const p = stage.shipScreen(this.screen);
    const el = document.createElement('div');
    el.className = 'pop';
    el.textContent = text;
    el.style.color = color;
    el.style.fontSize = `${size}px`;
    el.style.left = `${p.visible ? p.x : window.innerWidth / 2}px`;
    el.style.top = `${(p.visible ? p.y : window.innerHeight * 0.5) - 10}px`;
    this.popups.appendChild(el);
    setTimeout(() => el.remove(), 850);
    while (this.popups.childElementCount > 6) this.popups.firstElementChild?.remove();
  }

  results(meta: SongMeta, sim: RaceSim, track: Track, previousBest: number, counted = true) {
    const me = sim.racer;
    const acc = track.noteCount ? me.notes / track.noteCount : 0;
    const grade = acc >= 0.95 && me.greys === 0 ? 'S' : acc >= 0.85 ? 'A' : acc >= 0.7 ? 'B' : acc >= 0.5 ? 'C' : 'D';
    $('res-place').textContent = grade;
    $('res-song').textContent = `${meta.title}${meta.artist ? ' — ' + meta.artist : ''}`;
    $('res-score').textContent = fmt(me.score);
    const stat = (v: string | number, l: string) => `<div><b>${v}</b><span>${l}</span></div>`;
    $('res-stats').innerHTML =
      stat(`${Math.round(acc * 100)}%`, 'caught') + stat(me.maxCombo, 'max combo') + stat(me.missed, 'missed') +
      stat(me.greys, 'greys hit') + stat(me.holds, 'trails ridden') + stat(me.streamsPerfect, 'perfect streams');
    const el = $('res-best');
    if (!counted) {
      el.textContent = 'PRACTICE';
      el.classList.remove('record');
    } else if (me.score > previousBest) {
      el.textContent = previousBest ? `NEW RECORD · was ${fmt(previousBest)}` : 'NEW RECORD';
      el.classList.add('record');
    } else {
      el.textContent = `BEST ${fmt(previousBest)}`;
      el.classList.remove('record');
    }
    $('res-board').innerHTML = '';
  }

  /** Fill the results leaderboard once the server has answered. */
  leaderboard(board: BoardEntry[], me: string, myScore: number) {
    $('res-board').innerHTML = board
      .map((r, i) => {
        const mine = r.name === me && r.score >= myScore;
        return `<li class="${mine ? 'me' : ''}"><span>${i + 1}</span><span class="name">${esc(r.name)}</span><span>${fmt(r.score)}</span></li>`;
      })
      .join('');
  }
}
