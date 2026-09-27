import * as api from '../net/api.ts';
import { RANKED_UNLOCK, type Mode, type PlayerInfo } from '../net/protocol.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');


export interface MenuHandlers {
  openProfile(): void;
  openLeaderboard(): void;
  openPilot(id: number): void;
  queue(mode: Mode): void;
  joinLobby(code: string): void;
  identified(p: PlayerInfo): void;
}

/** Main menu: profile, pilot name, and the social sidebar (friends, history, ranking). */
export class Menu {
  player: PlayerInfo | null = null;
  private tab = 'friends';
  private refreshTimer = 0;

  constructor(private h: MenuHandlers) {
    $('profile-chip').addEventListener('click', () => (this.player ? this.h.openProfile() : this.askName(false)));
    $('ranking-all').addEventListener('click', () => this.h.openLeaderboard());
    $('lb-open').addEventListener('click', () => this.h.openLeaderboard());
    $<HTMLFormElement>('name-form').addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitName();
    });
    $('name-cancel').addEventListener('click', () => $('name-modal').classList.add('hidden'));
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-queue]')) {
      b.addEventListener('click', () => this.h.queue(b.dataset.queue as Mode));
    }
    for (const t of document.querySelectorAll<HTMLButtonElement>('.tab')) {
      t.addEventListener('click', () => this.showTab(t.dataset.tab!));
    }
    $<HTMLFormElement>('code-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = $<HTMLInputElement>('code-input').value.trim().toUpperCase();
      if (code) this.h.joinLobby(code);
    });
    $<HTMLFormElement>('friend-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $<HTMLInputElement>('friend-name');
      const name = input.value.trim();
      if (!name) return;
      try {
        this.renderFriends(await api.addFriend(name));
        input.value = '';
      } catch (err) {
        input.value = '';
        input.placeholder = (err as Error).message;
      }
    });
  }

  /** Sign in with the stored token, or ask for a pilot name. */
  async init() {
    try {
      const p = await api.me();
      if (p) this.setPlayer(p);
      else this.askName(false);
    } catch {
      this.setStatus('Server offline — solo still works', true);
    }
  }

  setPlayer(p: PlayerInfo) {
    this.player = p;
    $('me-name').textContent = p.name;
    $('me-avatar').textContent = p.name.slice(0, 1).toUpperCase();
    $('me-elo').textContent = String(p.elo);
    $('me-credits').textContent = fmt(p.credits);
    this.applyLocks();
    this.h.identified(p);
  }

  setStatus(text: string, off = false) {
    const el = $('net-status');
    el.textContent = text;
    el.classList.toggle('off', off);
  }

  private online = false;

  /** Online buttons need a pilot and a live connection; ranked also needs a few games. */
  setOnline(on: boolean) {
    this.online = on;
    this.applyLocks();
  }

  private applyLocks() {
    const played = this.player?.games_played ?? 0;
    const locked = played < RANKED_UNLOCK;
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-queue], #code-form button')) {
      b.disabled = !this.online || (b.dataset.queue === 'ranked' && locked);
    }
    const note = $('ranked-lock');
    note.classList.toggle('hidden', !locked || !this.player);
    note.textContent = `🔒 ${Math.min(played, RANKED_UNLOCK)}/${RANKED_UNLOCK} games`;
  }

  setQueued(mode: Mode | null) {
    for (const b of document.querySelectorAll<HTMLButtonElement>('[data-queue]')) {
      b.classList.toggle('queued', b.dataset.queue === mode);
    }
  }

  askName(canCancel: boolean) {
    $('name-modal').classList.remove('hidden');
    $('name-cancel').classList.toggle('hidden', !canCancel);
    $('name-error').textContent = '';
    const input = $<HTMLInputElement>('name-input');
    input.value = this.player?.name ?? '';
    setTimeout(() => input.focus(), 50);
  }

  private async submitName() {
    const name = $<HTMLInputElement>('name-input').value.trim();
    try {
      const p = this.player ? await api.rename(name) : await api.register(name);
      this.setPlayer(p);
      $('name-modal').classList.add('hidden');
      this.refresh();
    } catch (e) {
      $('name-error').textContent = (e as Error).message;
    }
  }

  showTab(tab: string) {
    this.tab = tab;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.tab === tab));
    for (const id of ['friends', 'ranking']) $(`tab-${id}`).classList.toggle('hidden', id !== tab);
    this.refresh();
  }

  /** Refresh the visible panel now, and every 10 s while the menu is up. */
  refresh() {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => this.refresh(), 10_000);
    if ($('menu').classList.contains('hidden') || !this.player) return;
    if (this.tab === 'friends') api.friends().then((f) => this.renderFriends(f)).catch(() => {});
    if (this.tab === 'ranking') api.leaderboard().then((lb) => this.renderRanking(lb.players.slice(0, 10))).catch(() => {});
    api.me().then((p) => p && this.setPlayer(p)).catch(() => {});
  }

  private renderFriends(list: api.Friend[]) {
    const el = $('friend-list');
    if (!list.length) {
      el.innerHTML = '<li class="empty">No friends yet</li>';
      return;
    }
    el.innerHTML = list
      .map((f) => {
        const where = f.lobby ? `${f.lobby.mode} · ${f.lobby.players}/8 · ${f.lobby.phase === 'waiting' ? 'in lobby' : 'in match'}` : f.online ? 'online' : 'offline';
        const join = f.lobby?.joinable ? `<button class="btn primary small" data-join="${f.lobby.code}">Join</button>` : '';
        return `<li><span class="dot ${f.online ? 'on' : ''}"></span><div class="grow" data-pilot="${f.id}"><div class="title">${esc(f.name)}</div><div class="meta">${where} · ${f.elo} Elo</div></div>${join}<button class="icon-btn" title="Remove" data-unfriend="${f.id}">✕</button></li>`;
      })
      .join('');
    el.querySelectorAll<HTMLButtonElement>('[data-join]').forEach((b) => b.addEventListener('click', () => this.h.joinLobby(b.dataset.join!)));
    el.querySelectorAll<HTMLElement>('[data-pilot]').forEach((d) => d.addEventListener('click', () => this.h.openPilot(Number(d.dataset.pilot))));
    el.querySelectorAll<HTMLButtonElement>('[data-unfriend]').forEach((b) =>
      b.addEventListener('click', async () => this.renderFriends(await api.removeFriend(Number(b.dataset.unfriend)))),
    );
  }

  private renderRanking(players: PlayerInfo[]) {
    const el = $('ranking-list');
    if (!players.length) {
      el.innerHTML = '<li class="empty">No ranked matches yet</li>';
      return;
    }
    el.innerHTML = players
      .map((p, i) => {
        const games = p.ranked_matches;
        return `<li class="${p.id === this.player?.id ? 'me' : ''}" data-pilot="${p.id}"><span class="pos">${i + 1}</span><div class="grow"><div class="title">${esc(p.name)}</div><div class="meta">${games} match${games === 1 ? '' : 'es'}</div></div><span class="num">${p.elo}</span></li>`;
      })
      .join('');
    el.querySelectorAll<HTMLElement>('[data-pilot]').forEach((li) => li.addEventListener('click', () => this.h.openPilot(Number(li.dataset.pilot))));
  }
}
