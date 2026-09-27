import * as api from '../net/api.ts';
import type { PlayerInfo, PublicProfile, Socials } from '../net/protocol.ts';
import { settings, updateSettings, type Quality } from '../settings.ts';
import { shipThumb } from '../ship/viewer.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export function ago(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function statsHtml(p: PlayerInfo, rank: number | null, soloRuns: number) {
  const stat = (v: string | number, l: string) => `<div><b>${v}</b><span>${l}</span></div>`;
  return stat(p.elo, 'Elo') + stat(rank ? `#${rank}` : '—', 'Rank') + stat(p.ranked_wins, 'Ranked wins') +
    stat(p.ranked_matches, 'Ranked') + stat(p.casual_matches, 'Casual') + stat(soloRuns, 'Solo runs');
}

export function socialsHtml(s: Socials) {
  const links: string[] = [];
  if (s.twitch) links.push(`<a href="https://twitch.tv/${encodeURIComponent(s.twitch)}" target="_blank" rel="noopener">Twitch · ${esc(s.twitch)}</a>`);
  if (s.youtube) links.push(`<a href="https://youtube.com/@${encodeURIComponent(s.youtube)}" target="_blank" rel="noopener">YouTube · ${esc(s.youtube)}</a>`);
  if (s.x) links.push(`<a href="https://x.com/${encodeURIComponent(s.x)}" target="_blank" rel="noopener">X · ${esc(s.x)}</a>`);
  if (s.discord) links.push(`<span>Discord · ${esc(s.discord)}</span>`);
  return links.join('');
}

export function topSongsHtml(p: PublicProfile, replay: boolean) {
  if (!p.top_songs.length) return '<li class="empty">—</li>';
  return p.top_songs
    .map((t, i) => `<li><span class="pos">${i + 1}</span><div class="grow"><div class="title">${esc(t.song_title || t.song_key)}</div><div class="meta">${t.plays}× · best ${fmt(t.best)}</div></div>${
      replay && !t.song_key.startsWith('file:') ? `<button class="icon-btn" data-replay-key="${esc(t.song_key)}" data-replay-title="${esc(t.song_title)}">▶</button>` : ''
    }</li>`)
    .join('');
}

export interface ProfileHandlers {
  player(): PlayerInfo | null;
  replay(songKey: string, title: string): void;
  playerChanged(p: PlayerInfo): void;
}

/** Your profile (rename, stats, socials, top songs, history) and settings. */
export class ProfileScreen {
  constructor(private h: ProfileHandlers) {
    $('profile-close').addEventListener('click', () => this.close());
    $('settings-open').addEventListener('click', () => this.open('settings'));
    document.querySelectorAll<HTMLButtonElement>('[data-ptab]').forEach((b) => b.addEventListener('click', () => this.showTab(b.dataset.ptab!)));

    $<HTMLFormElement>('rename-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        this.h.playerChanged(await api.rename($<HTMLInputElement>('rename-input').value.trim()));
        $('rename-error').textContent = '';
      } catch (err) {
        $('rename-error').textContent = (err as Error).message;
      }
    });
    $<HTMLFormElement>('socials-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target as HTMLFormElement);
      const p = await api.saveSocials(Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)])));
      this.h.playerChanged(p);
      this.fillSocials(p.socials);
    });

    // Settings controls
    const bindRange = (id: string, key: 'music' | 'effects') =>
      $<HTMLInputElement>(id).addEventListener('input', (e) => updateSettings({ [key]: Number((e.target as HTMLInputElement).value) }));
    bindRange('set-music', 'music');
    bindRange('set-effects', 'effects');
    const bindSwitch = (id: string, key: 'blockSounds' | 'showFps' | 'screenEffects') =>
      $<HTMLInputElement>(id).addEventListener('change', (e) => updateSettings({ [key]: (e.target as HTMLInputElement).checked }));
    bindSwitch('set-block', 'blockSounds');
    bindSwitch('set-fps', 'showFps');
    bindSwitch('set-fx', 'screenEffects');
    $('set-quality').querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) =>
      b.addEventListener('click', () => {
        updateSettings({ quality: b.dataset.q as Quality });
        this.fillSettings();
      }),
    );
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('profile').classList.contains('hidden')) this.close();
    });
  }

  open(tab: 'profile' | 'settings' = 'profile') {
    $('profile').classList.remove('hidden');
    this.showTab(tab);
  }

  close() {
    $('profile').classList.add('hidden');
  }

  private showTab(tab: string) {
    document.querySelectorAll<HTMLElement>('[data-ptab]').forEach((b) => b.classList.toggle('active', b.dataset.ptab === tab));
    $('ptab-profile').classList.toggle('hidden', tab !== 'profile');
    $('ptab-settings').classList.toggle('hidden', tab !== 'settings');
    if (tab === 'settings') this.fillSettings();
    else this.fillProfile();
  }

  private fillSettings() {
    const s = settings();
    $<HTMLInputElement>('set-music').value = String(s.music);
    $<HTMLInputElement>('set-effects').value = String(s.effects);
    $<HTMLInputElement>('set-block').checked = s.blockSounds;
    $<HTMLInputElement>('set-fps').checked = s.showFps;
    $<HTMLInputElement>('set-fx').checked = s.screenEffects;
    $('set-quality').querySelectorAll<HTMLElement>('[data-q]').forEach((b) => b.classList.toggle('active', b.dataset.q === s.quality));
  }

  private fillSocials(s: Socials) {
    const form = $<HTMLFormElement>('socials-form');
    for (const k of ['twitch', 'youtube', 'x', 'discord'] as const) (form.elements.namedItem(k) as HTMLInputElement).value = s[k] ?? '';
  }

  private async fillProfile() {
    // Editable fields come from the profile already in memory, right away: a late network
    // answer must never overwrite what you're typing.
    const me = this.h.player();
    if (!me) {
      $('pf-stats').innerHTML = '';
      return;
    }
    $<HTMLImageElement>('pf-ship').src = shipThumb(me.loadout);
    $<HTMLInputElement>('rename-input').value = me.name;
    this.fillSocials(me.socials);
    const [prof, games] = await Promise.all([api.profile({ id: me.id }), api.history()]);
    $('pf-stats').innerHTML = statsHtml(prof.player, prof.rank, prof.solo_runs) + `<div><b class="gold">◈ ${fmt(me.credits)}</b><span>Credits</span></div>`;
    $('pf-top').innerHTML = topSongsHtml(prof, true);
    const hist = $('history-list');
    hist.innerHTML = games.length
      ? games.map((g) => {
          const place = g.placement ? `#${g.placement}/${g.players}` : '';
          const delta = g.rating_delta !== null && g.mode === 'ranked'
            ? `<span class="${g.rating_delta >= 0 ? 'delta-up' : 'delta-down'}">${g.rating_delta >= 0 ? '+' : ''}${g.rating_delta}</span>` : '';
          const replay = g.song_key.startsWith('file:') ? '' : `<button class="icon-btn" data-replay-key="${esc(g.song_key)}" data-replay-title="${esc(g.song_title)}">▶</button>`;
          return `<li><div class="grow"><div class="title">${esc(g.song_title || g.song_key)}</div><div class="meta"><span class="tag-mode ${g.mode}">${g.mode.toUpperCase()}</span> ${fmt(g.score)} ${place} ${delta} · ${ago(g.created_at)}</div></div>${replay}</li>`;
        }).join('')
      : '<li class="empty">—</li>';
    $('ptab-profile').querySelectorAll<HTMLButtonElement>('[data-replay-key]').forEach((b) =>
      b.addEventListener('click', () => {
        this.close();
        this.h.replay(b.dataset.replayKey!, b.dataset.replayTitle!);
      }),
    );
  }
}
