import * as api from '../net/api.ts';
import type { LibrarySong } from '../net/api.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

type Sort = 'recent' | 'plays' | 'best';

function ago(t: number): string {
  const s = (Date.now() - t) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

const thumb = (key: string) =>
  key.startsWith('yt:') ? `<img src="https://i.ytimg.com/vi/${esc(key.slice(3))}/mqdefault.jpg" alt="" loading="lazy" />` : '<div class="lib-art">♫</div>';

/** Your library: every song you loaded or raced, to ride again. */
export class Library {
  private songs: LibrarySong[] = [];
  private sort: Sort = 'recent';

  constructor(private ride: (key: string, title: string) => void) {
    $('library-open').addEventListener('click', () => this.open());
    $('library-close').addEventListener('click', () => this.close());
    $('library').addEventListener('click', (e) => e.target === $('library') && this.close());
    $('lib-search').addEventListener('input', () => this.render());
    $('lib-sort').querySelectorAll<HTMLButtonElement>('[data-sort]').forEach((b) =>
      b.addEventListener('click', () => {
        this.sort = b.dataset.sort as Sort;
        $('lib-sort').querySelectorAll('[data-sort]').forEach((o) => o.classList.toggle('active', o === b));
        this.render();
      }),
    );
    window.addEventListener('keydown', (e) => e.key === 'Escape' && this.close());
  }

  async open() {
    $('library').classList.remove('hidden');
    $('lib-list').innerHTML = '<li class="empty">…</li>';
    try {
      this.songs = await api.library();
      this.render();
    } catch {
      $('lib-list').innerHTML = '<li class="empty">Sign in to keep a library</li>';
    }
  }

  close() {
    $('library').classList.add('hidden');
  }

  private render() {
    const q = $<HTMLInputElement>('lib-search').value.trim().toLowerCase();
    const list = this.songs
      .filter((s) => !q || `${s.title} ${s.artist}`.toLowerCase().includes(q))
      .sort((a, b) => (this.sort === 'plays' ? b.plays - a.plays : this.sort === 'best' ? (b.best ?? -1) - (a.best ?? -1) : 0) || b.last_at - a.last_at);
    const el = $('lib-list');
    if (!list.length) {
      el.innerHTML = `<li class="empty">${this.songs.length ? 'No match' : 'Songs you ride show up here'}</li>`;
      return;
    }
    el.innerHTML = list
      .map(
        (s) => `<li>
          ${thumb(s.song_key)}
          <div class="grow">
            <div class="title">${esc(s.title || s.song_key)}</div>
            <div class="meta">${esc(s.artist)}${s.artist ? ' · ' : ''}${s.plays ? `${s.plays} ride${s.plays > 1 ? 's' : ''}` : 'not finished yet'} · ${ago(s.last_at)}</div>
          </div>
          <div class="lib-best">${s.best !== null ? `<b>${fmt(s.best)}</b><small>best</small>` : ''}</div>
          <button class="btn primary small" data-ride="${esc(s.song_key)}">Ride</button>
          <button class="icon-btn" title="Remove from library" data-remove="${esc(s.song_key)}">✕</button>
        </li>`,
      )
      .join('');
    el.querySelectorAll<HTMLButtonElement>('[data-ride]').forEach((b) =>
      b.addEventListener('click', () => {
        const song = this.songs.find((s) => s.song_key === b.dataset.ride)!;
        this.close();
        this.ride(song.song_key, song.title);
      }),
    );
    el.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) =>
      b.addEventListener('click', async () => {
        this.songs = await api.removeFromLibrary(b.dataset.remove!);
        this.render();
      }),
    );
  }
}
