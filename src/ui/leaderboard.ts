import * as api from '../net/api.ts';
import type { Loadout } from '../ship/catalog.ts';
import { shipThumb } from '../ship/viewer.ts';
import { socialsHtml, statsHtml, topSongsHtml } from './profile.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Global leaderboard (Elo) and pilots' public profiles. */
export class Leaderboard {
  constructor(private inspect: (name: string, loadout: Loadout) => void) {
    $('lb-close').addEventListener('click', () => $('leaderboard').classList.add('hidden'));
    $('pilot-close').addEventListener('click', () => $('pilot').classList.add('hidden'));
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('pilot').classList.contains('hidden')) $('pilot').classList.add('hidden');
      else if (!$('leaderboard').classList.contains('hidden')) $('leaderboard').classList.add('hidden');
    });
  }

  async open() {
    $('leaderboard').classList.remove('hidden');
    const { players, me } = await api.leaderboard();
    const row = (p: (typeof players)[number], rank: number | string, mine: boolean) =>
      `<tr class="${mine ? 'me' : ''}" data-pilot="${p.id}"><td>${rank}</td><td><img src="${shipThumb(p.loadout)}" alt="" /></td><td>${esc(p.name)}</td><td class="r">${p.ranked_wins}</td><td class="r">${p.ranked_matches}</td><td class="r"><b>${p.elo}</b></td></tr>`;
    const head = '<tr><th>#</th><th></th><th>PILOT</th><th class="r">WINS</th><th class="r">MATCHES</th><th class="r">ELO</th></tr>';
    $('lb-table').innerHTML = head + (players.length ? players.map((p, i) => row(p, i + 1, p.id === me?.player.id)).join('') : '<tr><td colspan="6" class="empty">—</td></tr>');
    // Your own row, pinned under the table when you're not in the top list.
    const inTop = me && players.some((p) => p.id === me.player.id);
    $('lb-me').innerHTML = me && !inTop ? row(me.player, me.rank ?? '—', true) : '';
    document.querySelectorAll<HTMLElement>('#leaderboard [data-pilot]').forEach((tr) =>
      tr.addEventListener('click', () => this.pilot(Number(tr.dataset.pilot))),
    );
  }

  /** A pilot's public profile card. */
  async pilot(id: number) {
    const prof = await api.profile({ id });
    const p = prof.player;
    $('pilot-name').textContent = p.name;
    $('pilot-body').innerHTML = `
      <div class="profile-top"><img class="pf-ship" src="${shipThumb(p.loadout)}" alt="" id="pilot-ship" style="cursor:zoom-in" />
      <div class="pf-id"><div class="pf-stats">${statsHtml(p, prof.rank, prof.solo_runs)}</div></div></div>
      <div class="social-links">${socialsHtml(p.socials)}</div>
      <section><h3>Top songs</h3><ol class="list">${topSongsHtml(prof, false)}</ol></section>`;
    $('pilot-ship').addEventListener('click', () => this.inspect(p.name, p.loadout));
    $('pilot').classList.remove('hidden');
  }
}
