import type { HistoryGame } from '../net/api.ts';
import { LOBBY_SIZE, type LobbyView, type Mode, type SongRef } from '../net/protocol.ts';
import type { Loadout } from '../ship/catalog.ts';
import { shipThumb } from '../ship/viewer.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export interface LobbyHandlers {
  inspect(name: string, loadout: Loadout): void;
  copyInvite(code: string): void;
  submit(url: string): void;
  vote(key: string): void;
  chat(text: string): void;
  leave(): void;
  again(mode: Mode): void;
}

const PHASE_TITLE: Record<string, string> = {
  waiting: 'Lobby',
  voting: 'Vote',
  loading: 'Loading',
  racing: 'Racing',
  results: 'Results',
  finished: 'Final standings',
};

/** The lobby screen. It only redraws the parts whose content actually changed. */
export class LobbyScreen {
  view: LobbyView | null = null;
  me = 0;
  /** local load progress of the current round's song, 0..1 (or null when not loading) */
  loadProgress: number | null = null;
  loadLabel = '';
  submitError = '';
  /** what I voted for this round (kept locally so re-renders keep the highlight) */
  myVote: string | null = null;
  private centerSig = '';
  private chatSig = '';
  private recent: HistoryGame[] = [];

  constructor(private h: LobbyHandlers, private serverNow: () => number) {
    $('lobby-leave').addEventListener('click', () => this.h.leave());
    $('lobby-code').addEventListener('click', () => this.view?.code && this.h.copyInvite(this.view.code));
    $<HTMLFormElement>('chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $<HTMLInputElement>('chat-input');
      if (input.value.trim()) this.h.chat(input.value.trim());
      input.value = '';
    });
    setInterval(() => this.tickTimer(), 250);
  }

  setRecent(games: HistoryGame[]) {
    const seen = new Set<string>();
    this.recent = games.filter((g) => g.song_key.startsWith('yt:') && !seen.has(g.song_key) && seen.add(g.song_key)).slice(0, 4);
    this.centerSig = '';
    if (this.view) this.render(this.view);
  }

  show(on: boolean) {
    $('lobby').classList.toggle('hidden', !on);
    if (on) setTimeout(() => this.scrollChat(), 0);
  }

  render(v: LobbyView) {
    this.view = v;
    const badge = $('lobby-mode');
    badge.textContent = v.mode === 'ranked' ? 'RANKED' : 'CASUAL';
    $('lobby-code').classList.toggle('hidden', !v.code);
    $('lobby-code-text').textContent = v.code ?? '';
    badge.classList.toggle('casual', v.mode === 'casual');
    $('lobby-phase').textContent = PHASE_TITLE[v.phase] ?? v.phase;
    $('lobby-sub').textContent =
      v.phase === 'waiting'
        ? `${v.players.length}/${LOBBY_SIZE} pilots`
        : v.song && (v.phase === 'loading' || v.phase === 'racing')
          ? v.song.title
          : `Round ${Math.min(v.round + 1, v.rounds)}/${v.rounds}`;
    $('lobby-rounds').innerHTML = Array.from({ length: v.rounds }, (_, i) => {
      const cls = i < v.round || v.phase === 'finished' ? 'done' : i === v.round && v.phase !== 'waiting' ? 'now' : '';
      return `<i class="${cls}"></i>`;
    }).join('');
    this.renderPlayers(v);
    this.renderCenter(v);
    this.renderChat(v);
    this.tickTimer();
  }

  private renderPlayers(v: LobbyView) {
    const inMatch = v.phase !== 'waiting';
    const rows = [...v.players].sort((a, b) => (inMatch ? b.points - a.points : 0));
    const html = rows.map((p) => {
      const chips: string[] = [];
      if (v.phase === 'waiting' && p.submission) chips.push('<span class="chip ok">♫</span>');
      if (v.phase === 'voting' && p.voted) chips.push('<span class="chip ok">✓</span>');
      if (v.phase === 'loading') chips.push(`<span class="chip ${p.ready ? 'ok' : ''}">${p.ready ? '✓' : '…'}</span>`);
      if (v.phase === 'racing' && p.finished) chips.push('<span class="chip ok">🏁</span>');
      if (p.left) chips.push('<span class="chip">LEFT</span>');
      else if (!p.connected) chips.push('<span class="chip">…</span>');
      const rating = `${p.elo} Elo`;
      const meta = v.phase === 'waiting' && p.submission ? esc(p.submission.title) : rating;
      const pts = inMatch ? `<span class="ppts">${p.points}</span>` : '';
      return `<li class="${p.id === this.me ? 'me' : ''} ${p.connected && !p.left ? '' : 'off'}"><img class="pship" data-ship="${p.id}" src="${shipThumb(p.loadout)}" alt="" /><div class="pinfo"><div class="pname">${esc(p.name)}</div><div class="pmeta">${meta}</div><div class="chips">${chips.join('')}</div></div>${pts}</li>`;
    });
    if (v.phase === 'waiting') for (let i = v.players.length; i < LOBBY_SIZE; i++) html.push('<li class="slot"></li>');
    const list = $('lobby-players');
    list.innerHTML = html.join('');
    list.querySelectorAll<HTMLElement>('[data-ship]').forEach((img) =>
      img.addEventListener('click', () => {
        const p = v.players.find((x) => x.id === Number(img.dataset.ship));
        if (p) this.h.inspect(p.name, p.loadout);
      }),
    );
  }

  private songCard(s: SongRef, extra = '', cls = '', attrs = '') {
    const thumb = s.thumbnail ? `<img src="${esc(s.thumbnail)}" alt="" loading="lazy" />` : '<div class="thumb"></div>';
    const by = s.by ? ` · by ${esc(s.by)}` : '';
    return `<div class="song-card ${cls}" ${attrs}>${thumb}<div class="grow"><div class="title">${esc(s.title)}</div><div class="meta">${esc(s.artist || '')}${by}</div></div>${extra}</div>`;
  }

  private renderCenter(v: LobbyView) {
    const me = v.players.find((p) => p.id === this.me);
    const sig = JSON.stringify([
      v.phase, v.round, me?.submission?.key, v.candidates.map((c) => c.key), v.votes, v.results.length, !!v.final,
      v.song?.key, this.loadProgress === null ? null : Math.round(this.loadProgress * 20), this.loadLabel, this.submitError,
      v.players.map((p) => [p.ready, p.finished]), this.recent.length, this.myVote,
    ]);
    if (sig === this.centerSig) return;
    this.centerSig = sig;
    const el = $('lobby-center');

    if (v.phase === 'waiting') {
      const mine = me?.submission;
      const recent = this.recent
        .map((g) => `<button class="btn ghost small" data-pick="${esc(g.song_key)}" title="${esc(g.song_title)}">♫ ${esc(g.song_title.slice(0, 26))}${g.song_title.length > 26 ? '…' : ''}</button>`)
        .join('');
      el.innerHTML = `
        <h3>Your track</h3>
        ${mine ? this.songCard(mine, '<span class="chip ok">✓</span>') : ''}
        <form class="inline-form" id="submit-form" autocomplete="off">
          <input type="text" id="submit-url" placeholder="YouTube link" spellcheck="false" />
          <button class="btn primary small" type="submit">${mine ? 'Change' : 'Submit'}</button>
        </form>
        <div class="modal-error">${esc(this.submitError)}</div>
        <div class="pick-row"><button class="btn ghost small" data-pick="demo">♫ Neon Drive</button>${recent}</div>`;
      el.querySelector<HTMLFormElement>('#submit-form')!.addEventListener('submit', (e) => {
        e.preventDefault();
        const url = el.querySelector<HTMLInputElement>('#submit-url')!.value.trim();
        if (url) this.h.submit(url);
      });
      el.querySelectorAll<HTMLButtonElement>('[data-pick]').forEach((b) => b.addEventListener('click', () => this.h.submit(b.dataset.pick!)));
    } else if (v.phase === 'voting') {
      el.innerHTML = `<h3>Round ${v.round + 1}</h3><div class="candidates">${v.candidates
        .map((c) => this.songCard(c, `<span class="votes">${v.votes[c.key] ?? 0}</span>`, `candidate ${c.key === this.myVote ? 'mine' : ''}`, `data-vote="${esc(c.key)}"`))
        .join('')}</div>`;
      el.querySelectorAll<HTMLElement>('[data-vote]').forEach((c) =>
        c.addEventListener('click', () => {
          this.myVote = c.dataset.vote!;
          this.h.vote(this.myVote);
          el.querySelectorAll('.candidate').forEach((x) => x.classList.toggle('mine', x === c));
        }),
      );
    } else if (v.phase === 'loading' || v.phase === 'racing') {
      const ready = v.players.filter((p) => p.ready && !p.left).length;
      const active = v.players.filter((p) => !p.left).length;
      const pct = this.loadProgress === null ? 100 : Math.round(this.loadProgress * 100);
      el.innerHTML = `<h3>Round ${v.round + 1}</h3>${v.song ? this.songCard(v.song) : ''}
        <div class="big-status"><div class="big">${v.phase === 'racing' ? '🏁' : this.loadProgress === null ? 'Ready' : `${pct}%`}</div>
        <p class="hint">${v.phase === 'racing' ? '' : `${ready}/${active} ready`}</p>
        <div class="bar" style="margin-top:12px"><div class="bar-fill" style="width:${pct}%"></div></div></div>`;
    } else if (v.phase === 'results') {
      const r = v.results[v.results.length - 1];
      el.innerHTML = `<h3>Round ${r.round + 1} · ${esc(r.song.title)}</h3>
        <table class="table"><tr><th>#</th><th>PILOT</th><th class="r">SCORE</th><th class="r">POINTS</th><th class="r">◈</th></tr>${r.rows
          .map((x) => `<tr class="${x.id === this.me ? 'me' : ''}"><td>${x.left ? '—' : x.placement}</td><td>${esc(x.name)}${x.left ? ' · left' : ''}</td><td class="r">${fmt(x.score)}</td><td class="r">+${x.points}</td><td class="r gold">+${fmt(x.credits)}</td></tr>`)
          .join('')}</table>`;
    } else if (v.phase === 'finished' && v.final) {
      const f = v.final;
      const ranked = v.mode === 'ranked';
      const order = [f[1], f[0], f[2]].filter(Boolean);
      el.innerHTML = `<div class="podium">${order
        .map((x) => {
          const lo = v.players.find((p) => p.id === x.id)?.loadout;
          return `<div class="${x === f[0] ? 'p1' : ''}">${lo ? `<img src="${shipThumb(lo)}" alt="" />` : ''}<b>${x.placement === 1 ? '👑 ' : ''}${esc(x.name)}</b><span>#${x.placement} · ${x.total} pts</span></div>`;
        })
        .join('')}</div>
        <table class="table"><tr><th>#</th><th>PILOT</th><th class="r">POINTS</th>${ranked ? '<th class="r">ELO</th>' : ''}</tr>${f
          .map((x) => {
            const d = `<span class="${x.delta >= 0 ? 'delta-up' : 'delta-down'}">${x.delta >= 0 ? '+' : ''}${x.delta}</span>`;
            return `<tr class="${x.id === this.me ? 'me' : ''}"><td>${x.placement}</td><td>${esc(x.name)}${x.left ? ' · left' : ''}</td><td class="r">${x.total}</td>${ranked ? `<td class="r">${x.after} ${d}</td>` : ''}</tr>`;
          })
          .join('')}</table>
        <div class="menu-row"><button class="btn primary" id="lobby-again">Play again</button><button class="btn ghost" id="lobby-menu">Menu</button></div>`;
      el.querySelector('#lobby-again')!.addEventListener('click', () => this.h.again(v.mode));
      el.querySelector('#lobby-menu')!.addEventListener('click', () => this.h.leave());
    }
  }

  private renderChat(v: LobbyView) {
    const last = v.chat[v.chat.length - 1];
    const sig = `${v.chat.length}:${last?.at}`;
    if (sig === this.chatSig) return;
    this.chatSig = sig;
    $('chat-log').innerHTML = v.chat
      .map((m) => (m.system ? `<li class="sys">${esc(m.text)}</li>` : `<li class="${m.from === this.me ? 'mine' : ''}"><b>${esc(m.name)}</b>${esc(m.text)}</li>`))
      .join('');
    this.scrollChat();
  }

  private scrollChat() {
    const log = $('chat-log');
    log.scrollTop = log.scrollHeight;
  }

  private tickTimer() {
    const v = this.view;
    const el = $('lobby-timer');
    if (!v || !v.deadline || v.phase === 'racing' || v.phase === 'finished') {
      el.textContent = '';
      return;
    }
    const left = Math.max(0, Math.ceil((v.deadline - this.serverNow()) / 1000));
    el.textContent = left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : `${left}`;
    el.classList.toggle('urgent', left <= 5 && v.phase !== 'results');
  }

  resetCenter() {
    this.centerSig = '';
  }
}
