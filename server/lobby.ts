import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import * as db from './db.ts';
import { ensureAudio, getInfo, parseVideoId } from './youtube.ts';
import {
  LOBBY_SIZE, PLACE_POINTS, RANKED_UNLOCK, ROUNDS,
  type ChatMsg, type ClientMsg, type FinalRow, type LobbySummary, type LobbyView, type Mode, type Phase, type RoundResult, type ServerMsg, type SongRef,
  type Visibility,
} from '../src/net/protocol.ts';
import { creditsForScore, PLACE_CREDITS } from '../src/ship/catalog.ts';
import { Pacer, RunVerifier, type InputChunk, type TrackCore } from '../src/game/replay.ts';
import { STEP } from '../src/game/sim.ts';
import { onSolo } from './solo.ts';
import { songData } from './tracks.ts';

/**
 * Lobbies: up to 8 pilots, launched after 2 minutes (or 10 s once full, needs 2+), then a
 * 3-round match. Each round: vote between 3 submitted songs → everyone loads → synced start
 * → placements. Ranked lobbies are matchmade by Elo and move ratings; casual lobbies are
 * for fun and have a short code so friends can join them. Public casual lobbies are also
 * listed for anyone to browse; private ones are joined by code (or from a friend's profile).
 *
 * Scores are the server's: racers stream their inputs, the server replays them on its own
 * copy of the track (and checks they keep pace with the music), so a modified client can't
 * report a score it didn't ride.
 */

const WAIT_MS = Number(process.env.SONGSURF_LOBBY_WAIT_MS || process.env.RIDEX_LOBBY_WAIT_MS) || 120_000;
const FULL_MS = 10_000;
const EXTEND_MS = 30_000;
const VOTE_MS = 12_000;
const REVEAL_MS = 3_500;
const LOAD_TIMEOUT_MS = 45_000;
const COUNTDOWN_MS = 5_000;
const RESULTS_MS = 9_000;
const FINAL_MS = 60_000;
const GRACE_MS = 15_000;
/** ranked matchmaking: allowed Elo gap to a lobby's average, widening while it waits */
const ELO_WINDOW = 150;
const ELO_WIDEN_PER_S = 8;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_SONG_S = 7 * 60;

export const DEMO_SONG: SongRef = { key: 'demo:neon-drive', title: 'Neon Drive', artist: 'SongSurf synth', duration: 123 };

interface Member {
  player: db.Player;
  ws: WebSocket | null;
  droppedAt: number | null;
  left: boolean;
  submission: SongRef | null;
  vote: string | null;
  readyRound: number;
  finishedRound: number;
  live: number;
  points: number;
  lastChat: number;
  /** this round's run, as replayed by the server */
  run: LobbyRun | null;
}

interface LobbyRun {
  verifier: RunVerifier | null;
  pacer: Pacer;
  queue: InputChunk[];
  /** why the run stopped counting (bad or off-tempo inputs) */
  error: string | null;
}

function newCode(): string {
  for (;;) {
    const bytes = randomBytes(5);
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    if (![...lobbies.values()].some((l) => l.code === code)) return code;
  }
}

class Lobby {
  id = randomBytes(4).toString('hex');
  code = newCode();
  /** casual only: listed in the lobby browser, or code-only */
  visibility: Visibility = 'public';
  createdAt = Date.now();
  matchId = randomBytes(8).toString('hex');
  phase: Phase = 'waiting';
  members = new Map<number, Member>();
  deadline = Date.now() + WAIT_MS;
  startAt: number | null = null;
  raceEnd = 0;
  round = 0;
  song: SongRef | null = null;
  /** the current song's blocks, once the server has them */
  core: TrackCore | null = null;
  candidates: SongRef[] = [];
  played = new Set<string>();
  chat: ChatMsg[] = [];
  results: RoundResult[] = [];
  final: FinalRow[] | null = null;
  lastScores = 0;
  toldWaiting = false;
  constructor(public mode: Mode) {}

  get avgElo() {
    const a = this.active;
    return a.length ? a.reduce((s, m) => s + m.player.elo, 0) / a.length : 1000;
  }

  /** The host: the longest-standing pilot still in (whoever opened it, first). */
  get host(): Member | undefined {
    for (const m of this.members.values()) if (!m.left) return m;
    return undefined;
  }

  get active() {
    return [...this.members.values()].filter((m) => !m.left);
  }
  get connected() {
    return this.active.filter((m) => m.ws && m.droppedAt === null);
  }
}

const lobbies = new Map<string, Lobby>();
const sockets = new Map<number, WebSocket>();
const playerLobby = new Map<number, Lobby>();

const send = (ws: WebSocket | null | undefined, msg: ServerMsg) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};

function view(l: Lobby): LobbyView {
  const votes: Record<string, number> = {};
  for (const m of l.members.values()) if (m.vote) votes[m.vote] = (votes[m.vote] ?? 0) + 1;
  return {
    id: l.id, code: l.mode === 'casual' ? l.code : null, mode: l.mode, visibility: l.visibility, host: l.host?.player.id ?? null,
    phase: l.phase, round: l.round, rounds: ROUNDS,
    deadline: l.phase === 'racing' ? l.raceEnd : l.deadline, startAt: l.startAt, song: l.song,
    candidates: l.candidates, votes,
    players: [...l.members.values()].map((m) => ({
      id: m.player.id, name: m.player.name, loadout: m.player.loadout, elo: m.player.elo, fun: m.player.fun,
      connected: !!m.ws && m.droppedAt === null, left: m.left,
      submission: m.submission, voted: !!m.vote, ready: m.readyRound === l.round, finished: m.finishedRound === l.round,
      points: m.points,
    })),
    chat: l.chat.slice(-50), results: l.results, final: l.final,
  };
}

function broadcast(l: Lobby) {
  const msg: ServerMsg = { type: 'lobby', lobby: view(l), now: Date.now() };
  const json = JSON.stringify(msg);
  for (const m of l.members.values()) if (m.ws && m.ws.readyState === 1) m.ws.send(json);
}

function system(l: Lobby, text: string) {
  l.chat.push({ from: 0, name: 'SongSurf', text, at: Date.now(), system: true });
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

function addMember(l: Lobby, player: db.Player, ws: WebSocket) {
  l.members.set(player.id, {
    player, ws, droppedAt: null, left: false, submission: null, vote: null,
    readyRound: -1, finishedRound: -1, live: 0, points: 0, lastChat: 0, run: null,
  });
  playerLobby.set(player.id, l);
  system(l, `${player.name} joined`);
  if (l.members.size >= LOBBY_SIZE) l.deadline = Math.min(l.deadline, Date.now() + FULL_MS);
  broadcast(l);
}

/** Leave the current lobby. Leaving a running match ranks you last (and costs the Elo that implies). */
function leaveCurrent(playerId: number) {
  const l = playerLobby.get(playerId);
  if (!l) return;
  playerLobby.delete(playerId);
  const m = l.members.get(playerId);
  if (!m) return;
  if (l.phase === 'waiting' || l.phase === 'finished') {
    l.members.delete(playerId);
    system(l, `${m.player.name} left`);
  } else {
    m.left = true;
    m.ws = null;
    system(l, `${m.player.name} left`);
  }
  if (!l.active.length && l.phase !== 'finished') lobbies.delete(l.id);
  else broadcast(l);
}

function createLobby(mode: Mode, visibility: Visibility = 'public'): Lobby {
  const l = new Lobby(mode);
  l.visibility = visibility;
  lobbies.set(l.id, l);
  system(l, 'Lobby opened');
  return l;
}

/**
 * Public matchmaking. Ranked: the open lobby whose average Elo is closest to yours, as long
 * as the gap fits a window that widens the longer the lobby has waited. Casual: the fullest.
 */
function findOrCreate(mode: Mode, elo: number): Lobby {
  const now = Date.now();
  const open = [...lobbies.values()].filter((l) => l.mode === mode && l.phase === 'waiting' && l.members.size < LOBBY_SIZE && l.visibility === 'public');
  let best: Lobby | null = null;
  if (mode === 'ranked') {
    let bestGap = Infinity;
    for (const l of open) {
      const gap = Math.abs(l.avgElo - elo);
      const window = ELO_WINDOW + ((now - l.createdAt) / 1000) * ELO_WIDEN_PER_S;
      if (gap <= window && gap < bestGap) { best = l; bestGap = gap; }
    }
  } else {
    best = open.sort((a, b) => b.members.size - a.members.size)[0] ?? null;
  }
  return best ?? createLobby(mode);
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function startVoting(l: Lobby) {
  const now = Date.now();
  const submitted = l.active.map((m) => m.submission).filter((s): s is SongRef => !!s && !l.played.has(s.key));
  const unique = [...new Map(submitted.map((s) => [s.key, s])).values()];
  let candidates = shuffle(unique).slice(0, 3);
  if (!candidates.length) {
    // Nobody left a song: fall back to what the community played lately, or the demo.
    const recent = db.recentSongs().filter((s) => !l.played.has(s.key));
    candidates = shuffle(recent).slice(0, 3).map((s) => ({ key: s.key, title: s.title, artist: s.artist, duration: 0, by: 'community' }));
    if (!candidates.length) candidates = [DEMO_SONG];
  }
  l.candidates = candidates;
  for (const m of l.members.values()) m.vote = null;
  l.phase = 'voting';
  l.song = null;
  l.startAt = null;
  l.deadline = now + (candidates.length === 1 ? REVEAL_MS : VOTE_MS);
  system(l, `Round ${l.round + 1}`);
}

function pickSong(l: Lobby) {
  const counts = new Map<string, number>();
  for (const m of l.active) if (m.vote) counts.set(m.vote, (counts.get(m.vote) ?? 0) + 1);
  const best = Math.max(0, ...counts.values());
  const top = l.candidates.filter((c) => (counts.get(c.key) ?? 0) === best);
  l.song = top[Math.floor(Math.random() * top.length)];
  l.played.add(l.song.key);
  l.core = null;
  const key = l.song.key;
  songData(key).then(
    (d) => {
      if (l.song?.key !== key) return;
      l.core = d.core;
      for (const m of l.members.values()) if (m.run && !m.run.verifier) startVerifier(l, m);
    },
    (e) => console.error(`lobby song ${key}:`, (e as Error).message),
  );
  l.phase = 'loading';
  l.deadline = Date.now() + LOAD_TIMEOUT_MS;
  system(l, `▶ ${l.song.title}`);
}

async function songDuration(l: Lobby) {
  if (!l.song || l.song.duration) return;
  const id = l.song.key.startsWith('yt:') ? l.song.key.slice(3) : null;
  if (id) l.song.duration = (await getInfo(id).catch(() => null))?.duration ?? 240;
}

function startRace(l: Lobby) {
  const now = Date.now();
  l.phase = 'racing';
  l.startAt = now + COUNTDOWN_MS;
  l.raceEnd = l.startAt + (l.song!.duration || 240) * 1000 + 8000;
  for (const m of l.members.values()) {
    m.live = 0;
    m.run = null;
  }
}

function startVerifier(l: Lobby, m: Member) {
  const run = m.run!;
  run.verifier = new RunVerifier(l.core!);
  for (const c of run.queue.splice(0)) if (!run.error) run.error = run.verifier.feed(c);
  m.live = run.verifier.score;
}

/** A chunk of a racer's inputs: pace check, then replay. */
function raceInput(l: Lobby, m: Member, chunk: unknown) {
  m.run ??= { verifier: null, pacer: new Pacer(l.startAt!), queue: [], error: null };
  const run = m.run;
  if (run.error) return;
  const c = chunk as InputChunk;
  if (!c || !Number.isInteger(c.upTo)) {
    run.error = 'bad input';
    return;
  }
  run.error = run.pacer.check(Date.now(), c.upTo * STEP);
  if (run.error) return;
  if (!l.core) {
    if (run.queue.length >= 2000) run.error = 'too many inputs';
    else run.queue.push(c);
    return;
  }
  if (!run.verifier) startVerifier(l, m);
  run.error = run.verifier!.feed(c);
  m.live = run.verifier!.score;
}

/**
 * Competition ranking ("1-1-3"): equal values share a placement, the next one skips ahead.
 * `values` must be sorted best first.
 */
function placements(values: number[]): number[] {
  return values.map((v, i) => {
    let first = i;
    while (first > 0 && values[first - 1] === v) first--;
    return first + 1;
  });
}

function finishRound(l: Lobby) {
  const song = l.song!;
  const members = [...l.members.values()];
  // A run whose inputs stopped adding up (tampering, slow motion) scores 0.
  for (const m of members) if (m.run?.error) m.live = 0;
  const racing = members.filter((m) => !m.left).sort((a, b) => b.live - a.live);
  const places = placements(racing.map((m) => m.live));
  const rows: RoundResult['rows'] = [];
  racing.forEach((m, i) => {
    // Tied scores share the placement, and so the same round points.
    const placement = places[i];
    const points = PLACE_POINTS[placement - 1] ?? 0;
    // Credits: from the score, plus a bonus for the placement (none for a run that stopped counting).
    const credits = m.run?.error ? 0 : creditsForScore(m.live) + (PLACE_CREDITS[placement - 1] ?? PLACE_CREDITS[PLACE_CREDITS.length - 1]);
    db.addCredits(m.player.id, credits);
    m.points += points;
    rows.push({ id: m.player.id, name: m.player.name, score: m.live, points, placement, left: false, credits });
    db.recordGame({
      player_id: m.player.id, mode: l.mode, match_id: l.matchId, song_key: song.key, song_title: song.title,
      song_artist: song.artist, score: m.live, placement, players: racing.length, points,
    });
  });
  for (const m of members.filter((x) => x.left)) {
    rows.push({ id: m.player.id, name: m.player.name, score: 0, points: 0, placement: rows.length + 1, left: true, credits: 0 });
  }
  l.results.push({ round: l.round, song, rows });
  l.phase = 'results';
  l.deadline = Date.now() + RESULTS_MS;
}

function finishMatch(l: Lobby) {
  const members = [...l.members.values()];
  // Pilots who left are ranked below everyone who stayed, whatever their points. Equal
  // match points are a tie (shared placement, half an Elo "win" against each other).
  const standings = members
    .map((m) => ({ m, total: m.points }))
    .sort((a, b) => Number(a.m.left) - Number(b.m.left) || b.total - a.total);
  const n = standings.length;
  const deltas = new Map<number, number>();
  if (l.mode === 'ranked' && n >= 2) {
    // Multiplayer Elo: every pair of pilots is a game, K spread over the opponents.
    const K = 48 / (n - 1);
    for (let i = 0; i < n; i++) {
      let d = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const ri = standings[i].m.player.elo, rj = standings[j].m.player.elo;
        const expected = 1 / (1 + Math.pow(10, (rj - ri) / 400));
        const above = i < j;
        const tie = !standings[i].m.left && !standings[j].m.left && standings[i].total === standings[j].total;
        const actual = tie ? 0.5 : above ? 1 : 0;
        d += K * (actual - expected);
      }
      deltas.set(standings[i].m.player.id, Math.round(d));
    }
  } else {
    for (const s of standings) deltas.set(s.m.player.id, 0);
  }
  db.applyMatch(l.mode, [...deltas].map(([id, delta]) => ({ id, delta })));
  // Ranked wins: everyone sharing first place (ties included), if they stayed to the end.
  if (l.mode === 'ranked' && n >= 2) {
    for (const s of standings) if (!s.m.left && s.total === standings[0].total) db.addRankedWin(s.m.player.id);
  }
  if (l.mode === 'ranked') for (const [id, delta] of deltas) db.setMatchDelta(l.matchId, id, delta);
  // Ties share a placement; pilots who left come after everyone, in order.
  const stayed = standings.filter((s) => !s.m.left);
  const places = [...placements(stayed.map((s) => s.total)), ...standings.slice(stayed.length).map((_, k) => stayed.length + k + 1)];
  l.final = standings.map((s, i) => {
    const fresh = db.byId(s.m.player.id)!;
    s.m.player = fresh;
    return {
      id: fresh.id, name: fresh.name, total: s.total, placement: places[i],
      delta: deltas.get(fresh.id) ?? 0, after: fresh.elo, left: s.m.left,
    };
  });
  l.phase = 'finished';
  l.deadline = Date.now() + FINAL_MS;
  system(l, `🏆 ${l.final[0].name}`);
}

function closeLobby(l: Lobby) {
  for (const m of l.members.values()) {
    if (playerLobby.get(m.player.id) === l) {
      playerLobby.delete(m.player.id);
      send(m.ws, { type: 'left' });
    }
  }
  lobbies.delete(l.id);
}

function step(l: Lobby, now: number) {
  let changed = false;
  // Pilots who dropped mid-match and didn't come back in time are out (ranked last).
  for (const m of l.members.values()) {
    if (m.droppedAt !== null && !m.left && now - m.droppedAt > GRACE_MS) {
      if (l.phase === 'waiting') {
        l.members.delete(m.player.id);
        playerLobby.delete(m.player.id);
        system(l, `${m.player.name} left`);
      } else if (l.phase !== 'finished') {
        m.left = true;
        playerLobby.delete(m.player.id);
        system(l, `${m.player.name} disconnected`);
      }
      changed = true;
    }
  }
  if (!l.members.size) {
    lobbies.delete(l.id);
    return;
  }

  switch (l.phase) {
    case 'waiting':
      if (now >= l.deadline) {
        if (l.connected.length >= 2) {
          system(l, 'Match starting');
          startVoting(l);
        } else {
          l.deadline = now + EXTEND_MS;
          if (!l.toldWaiting) system(l, 'Waiting for more pilots');
          l.toldWaiting = true;
        }
        changed = true;
      }
      break;
    case 'voting':
      if (now >= l.deadline || (l.candidates.length > 1 && l.connected.every((m) => m.vote))) {
        pickSong(l);
        songDuration(l).then(() => broadcast(l));
        changed = true;
      }
      break;
    case 'loading':
      if (now >= l.deadline || l.connected.every((m) => m.readyRound === l.round)) {
        startRace(l);
        changed = true;
      }
      break;
    case 'racing':
      if (now - l.lastScores > 500) {
        l.lastScores = now;
        const scores: Record<number, number> = {};
        for (const m of l.members.values()) scores[m.player.id] = m.live;
        const json = JSON.stringify({ type: 'scores', round: l.round, scores } satisfies ServerMsg);
        for (const m of l.members.values()) if (m.ws?.readyState === 1) m.ws.send(json);
      }
      if (now >= l.raceEnd || (now > (l.startAt ?? 0) && l.connected.every((m) => m.finishedRound === l.round))) {
        finishRound(l);
        changed = true;
      }
      break;
    case 'results':
      if (now >= l.deadline) {
        l.round++;
        if (l.round < ROUNDS && l.active.length) startVoting(l);
        else finishMatch(l);
        changed = true;
      }
      break;
    case 'finished':
      if (now >= l.deadline) {
        closeLobby(l);
        return;
      }
      break;
  }
  if (changed) broadcast(l);
}

setInterval(() => {
  const now = Date.now();
  for (const l of [...lobbies.values()]) step(l, now);
}, 250);

// ---------------------------------------------------------------------------
// Socket handling
// ---------------------------------------------------------------------------

/** A pilot changed name or ship: show it to their lobby right away. */
export function refreshPlayer(id: number) {
  const l = playerLobby.get(id);
  const m = l?.members.get(id);
  const fresh = db.byId(id);
  if (l && m && fresh) {
    m.player = fresh;
    broadcast(l);
  }
}

/** Public casual lobbies still waiting for pilots, fullest first (the lobby browser). */
export function publicLobbies(): LobbySummary[] {
  return [...lobbies.values()]
    .filter((l) => l.mode === 'casual' && l.visibility === 'public' && l.phase === 'waiting' && l.members.size < LOBBY_SIZE)
    .sort((a, b) => b.members.size - a.members.size || a.createdAt - b.createdAt)
    .slice(0, 50)
    .map((l) => ({
      code: l.code,
      host: l.host?.player.name ?? '',
      players: l.members.size,
      avgElo: Math.round(l.avgElo),
      startsAt: l.members.size >= 2 ? l.deadline : null,
      songs: [...l.members.values()].filter((m) => m.submission).length,
    }));
}

export function presence(id: number) {
  const l = playerLobby.get(id);
  return {
    online: sockets.has(id),
    lobby: l ? { code: l.code, mode: l.mode, phase: l.phase, players: l.members.size, joinable: l.mode === 'casual' && l.phase === 'waiting' && l.members.size < LOBBY_SIZE } : null,
  };
}

export function onConnection(ws: WebSocket) {
  let player: db.Player | null = null;

  ws.on('message', async (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type === 'ping') return send(ws, { type: 'pong', t: msg.t, now: Date.now() });

    if (msg.type === 'hello') {
      player = db.byToken(msg.token);
      if (!player) return send(ws, { type: 'error', message: 'Unknown pilot, please sign in again' });
      const previous = sockets.get(player.id);
      if (previous && previous !== ws) previous.close(4000, 'opened elsewhere');
      sockets.set(player.id, ws);
      db.touch(player.id);
      send(ws, { type: 'welcome', player });
      // Coming back to a lobby we were in (reload, network blip).
      const l = playerLobby.get(player.id);
      const m = l?.members.get(player.id);
      if (l && m && !m.left) {
        m.ws = ws;
        m.droppedAt = null;
        broadcast(l);
      }
      return;
    }
    if (!player) return send(ws, { type: 'error', message: 'Say hello first' });
    const me = player;
    const l = playerLobby.get(me.id);
    const m = l?.members.get(me.id);

    switch (msg.type) {
      case 'queue': {
        if (msg.mode !== 'ranked' && msg.mode !== 'casual') return;
        const fresh = db.byId(me.id)!;
        if (msg.mode === 'ranked' && fresh.games_played < RANKED_UNLOCK) {
          return send(ws, { type: 'error', message: `Ranked unlocks after ${RANKED_UNLOCK} solo or casual games` });
        }
        leaveCurrent(me.id);
        addMember(findOrCreate(msg.mode, fresh.elo), fresh, ws);
        return;
      }
      case 'create': {
        const visibility: Visibility = msg.visibility === 'private' ? 'private' : 'public';
        leaveCurrent(me.id);
        addMember(createLobby('casual', visibility), db.byId(me.id)!, ws);
        return;
      }
      case 'visibility':
        if (l && m && l.mode === 'casual' && l.phase === 'waiting' && l.host === m && (msg.visibility === 'public' || msg.visibility === 'private')) {
          l.visibility = msg.visibility;
          system(l, msg.visibility === 'public' ? 'Lobby is now public' : 'Lobby is now private');
          broadcast(l);
        }
        return;
      case 'join': {
        const code = String(msg.code ?? '').trim().toUpperCase();
        const target = [...lobbies.values()].find((x) => x.code === code && x.mode === 'casual');
        if (!target) return send(ws, { type: 'error', message: `No lobby ${code || ''}`.trim() });
        if (target.phase !== 'waiting') return send(ws, { type: 'error', message: 'Match already started' });
        if (target.members.size >= LOBBY_SIZE) return send(ws, { type: 'error', message: 'Lobby full' });
        if (target === l) return;
        leaveCurrent(me.id);
        addMember(target, db.byId(me.id)!, ws);
        return;
      }
      case 'leave':
        leaveCurrent(me.id);
        send(ws, { type: 'left' });
        return;
      case 'submit': {
        if (!l || !m || l.phase === 'finished') return;
        if (m.submission && l.played.has(m.submission.key)) return send(ws, { type: 'error', message: 'Already played' });
        let song: SongRef;
        const url = String(msg.url ?? '').trim();
        if (url === 'demo' || url === DEMO_SONG.key) song = { ...DEMO_SONG };
        else {
          const id = parseVideoId(url.replace(/^yt:/, ''));
          if (!id) return send(ws, { type: 'error', message: 'That does not look like a YouTube link' });
          try {
            const info = await getInfo(id);
            if (info.duration > MAX_SONG_S) return send(ws, { type: 'error', message: 'Max 7 minutes' });
            song = { key: `yt:${id}`, title: info.title, artist: info.uploader, duration: info.duration, thumbnail: info.thumbnail };
          } catch (e) {
            return send(ws, { type: 'error', message: (e as Error).message });
          }
          ensureAudio(id).catch(() => {}); // warm the cache so the round loads fast
        }
        song.by = me.name;
        m.submission = song;
        send(ws, { type: 'submitted', song });
        broadcast(l);
        return;
      }
      case 'vote':
        if (l && m && l.phase === 'voting' && l.candidates.some((c) => c.key === msg.key)) {
          m.vote = msg.key;
          broadcast(l);
        }
        return;
      case 'chat': {
        const text = String(msg.text ?? '').trim().slice(0, 200);
        if (!l || !m || !text || Date.now() - m.lastChat < 500) return;
        m.lastChat = Date.now();
        l.chat.push({ from: me.id, name: me.name, text, at: Date.now() });
        if (l.chat.length > 80) l.chat.splice(0, l.chat.length - 80);
        broadcast(l);
        return;
      }
      case 'loaded':
        if (l && m && msg.round === l.round && (l.phase === 'loading' || l.phase === 'racing')) {
          m.readyRound = l.round;
          broadcast(l);
        }
        return;
      case 'input':
        if (l && m && l.phase === 'racing' && msg.round === l.round && m.finishedRound !== l.round) raceInput(l, m, msg.chunk);
        return;
      case 'finish':
        if (l && m && l.phase === 'racing' && msg.round === l.round && m.finishedRound !== l.round) {
          if (msg.chunk) raceInput(l, m, msg.chunk);
          m.finishedRound = l.round;
          broadcast(l);
        }
        return;
      case 'solo':
        return onSolo(ws, me, msg);
    }
  });

  ws.on('close', () => {
    if (!player) return;
    if (sockets.get(player.id) === ws) sockets.delete(player.id);
    const l = playerLobby.get(player.id);
    const m = l?.members.get(player.id);
    if (l && m && m.ws === ws) {
      m.ws = null;
      m.droppedAt = Date.now();
      broadcast(l);
    }
  });
}
