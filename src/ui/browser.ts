import { LOBBY_SIZE, type LobbySummary, type Visibility } from '../net/protocol.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface BrowserHandlers {
  join(code: string): void;
  quick(): void;
  create(visibility: Visibility): void;
}

/** Casual: browse public lobbies, or create one (public or private). */
export class LobbyBrowser {
  private visibility: Visibility = 'public';
  private timer = 0;
  private lobbies: LobbySummary[] = [];
  /** local time minus server time */
  private skew = 0;

  constructor(private h: BrowserHandlers) {
    $('casual-browse').addEventListener('click', () => this.open());
    $('casual-create').addEventListener('click', () => this.h.create(this.visibility));
    $('casual-vis').querySelectorAll<HTMLButtonElement>('[data-vis]').forEach((b) =>
      b.addEventListener('click', () => {
        this.visibility = b.dataset.vis as Visibility;
        $('casual-vis').querySelectorAll('[data-vis]').forEach((o) => o.classList.toggle('active', o === b));
      }),
    );
    $('browse-close').addEventListener('click', () => this.close());
    $('browse').addEventListener('click', (e) => e.target === $('browse') && this.close());
    $('browse-quick').addEventListener('click', () => {
      this.close();
      this.h.quick();
    });
    window.addEventListener('keydown', (e) => e.key === 'Escape' && this.close());
  }

  open() {
    $('browse').classList.remove('hidden');
    $('browse-list').innerHTML = '<li class="empty">…</li>';
    this.fetch();
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.fetch(), 3000);
  }

  close() {
    clearInterval(this.timer);
    $('browse').classList.add('hidden');
  }

  private async fetch() {
    try {
      const res = await fetch('/api/lobbies');
      const body = (await res.json()) as { lobbies: LobbySummary[]; now: number };
      this.skew = Date.now() - body.now;
      this.lobbies = body.lobbies;
    } catch {
      this.lobbies = [];
    }
    if (!$('browse').classList.contains('hidden')) this.render();
  }

  private render() {
    const list = $('browse-list');
    const n = this.lobbies.length;
    $('browse-count').textContent = n ? `${n} open` : '';
    if (!n) {
      list.innerHTML = `<li class="empty">No open lobbies<button class="btn ghost small" id="browse-create">Create one</button></li>`;
      $('browse-create').addEventListener('click', () => {
        this.close();
        this.h.create('public');
      });
      return;
    }
    list.innerHTML = this.lobbies
      .map((l) => {
        const seats = Array.from({ length: LOBBY_SIZE }, (_, i) => `<i class="${i < l.players ? 'on' : ''}"></i>`).join('');
        const starts = l.startsAt ? Math.max(0, Math.round((l.startsAt + this.skew - Date.now()) / 1000)) : null;
        const when = starts === null ? 'Waiting for pilots' : `Starts in ${starts}s`;
        return `<li>
          <div class="grow">
            <div class="title">${esc(l.host)}'s lobby</div>
            <div class="meta">${when} · ${l.avgElo} Elo${l.songs ? ` · ${l.songs} ♫` : ''}</div>
          </div>
          <div class="seats" title="${l.players}/${LOBBY_SIZE} pilots">${seats}</div>
          <button class="btn primary small" data-code="${esc(l.code)}">Join</button>
        </li>`;
      })
      .join('');
    list.querySelectorAll<HTMLButtonElement>('[data-code]').forEach((b) =>
      b.addEventListener('click', () => {
        this.close();
        this.h.join(b.dataset.code!);
      }),
    );
  }
}
