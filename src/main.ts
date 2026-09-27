import './storage-migrate.ts'; // must run before any module reads localStorage
import { fakeAnalysis } from './audio/fake.ts';
import { loadDemo, loadFile, loadYouTube, serverHasYouTube, type LoadedSong, type Status } from './audio/loader.ts';
import { AudioFeed, MusicPlayer, Sfx } from './audio/playback.ts';
import type { AudioAnalysis } from './audio/analyze.ts';
import { AutopilotController, LocalController } from './game/controllers.ts';
import { RaceSim, type RaceEvent } from './game/sim.ts';
import { Ghost, localBest, Recorder, saveLocalBest } from './game/ghosts.ts';
import { InputLog } from './game/replay.ts';
import * as api from './net/api.ts';
import { Net } from './net/client.ts';
import type { LobbyView, Mode as LobbyMode } from './net/protocol.ts';
import { PLAYER_COLOR } from './render/palette.ts';
import { Stage } from './render/stage.ts';
import { generateTrack, PRE_ROLL, resetBlocks, TRACK_VERSION, type Track } from './track/track.ts';
import { Hud, type Rival } from './ui/hud.ts';
import { LobbyScreen } from './ui/lobby.ts';
import { Menu } from './ui/menu.ts';
import { Hangar } from './ui/hangar.ts';
import { ProfileScreen } from './ui/profile.ts';
import { Leaderboard } from './ui/leaderboard.ts';
import { onSettings } from './settings.ts';
import { DEFAULT_LOADOUT, loadoutKey, sanitizeLoadout, type Loadout } from './ship/catalog.ts';
import { ShipViewer, shipThumb } from './ship/viewer.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('stage');
const stage = new Stage(canvas);
const hud = new Hud();
const music = new MusicPlayer();
const sfx = new Sfx();
const net = new Net(api.token);
const COUNTDOWN = 3;
/** how often race inputs are streamed to the server (ms) */
const INPUT_EVERY = 250;

type Mode = 'attract' | 'race' | 'paused' | 'results';

interface Session {
  mode: Mode;
  track: Track;
  sim: RaceSim;
  analysis: AudioAnalysis;
  feed: AudioFeed;
  song?: LoadedSong;
  local?: LocalController;
  /** attract mode clock */
  clock: number;
  finished: boolean;
  recorder?: Recorder;
  previousBest: number;
  /** set when this race is a lobby round */
  multi?: { round: number; lastSent: number; log: InputLog };
  /** set when this solo run is streamed to the server to be verified and ranked */
  solo?: { log: InputLog; lastSent: number; started: boolean };
}

let session: Session;

// ---------------------------------------------------------------------------
// Your ship: saved on your profile (or in this browser before you pick a name)
// ---------------------------------------------------------------------------

function localLoadout(): Loadout {
  try {
    // Before signing in you only have the free parts.
    return sanitizeLoadout(JSON.parse(localStorage.getItem('songsurf:loadout') || 'null'), []);
  } catch {
    return { ...DEFAULT_LOADOUT };
  }
}

function myLoadout(): Loadout {
  return menu?.player?.loadout ?? localLoadout();
}

async function saveMyLoadout(l: Loadout) {
  try {
    localStorage.setItem('songsurf:loadout', JSON.stringify(l));
  } catch {
    /* storage unavailable */
  }
  if (menu.player) menu.setPlayer(await api.saveLoadout(l));
  refreshMyShip();
}

/** Show the ship everywhere (hangar button, background ride), only when it changed. */
let shownShip = '';
function refreshMyShip() {
  const l = myLoadout();
  const key = loadoutKey(l);
  if (key === shownShip) return;
  shownShip = key;
  $<HTMLImageElement>('hangar-thumb').src = shipThumb(l);
  if (session?.mode === 'attract') startAttract();
}
let loadToken = 0;
let lastSong: LoadedSong | null = null;

// ---------------------------------------------------------------------------
// Songs: loaded once per key, shared by solo replays and lobby rounds
// ---------------------------------------------------------------------------

const songCache = new Map<string, Promise<LoadedSong>>();

function loadByKey(key: string, status: Status): Promise<LoadedSong> {
  let p = songCache.get(key);
  if (!p) {
    if (key.startsWith('demo:')) p = loadDemo(status);
    else if (key.startsWith('yt:')) p = loadYouTube(`https://youtu.be/${key.slice(3)}`, status);
    else return Promise.reject(new Error('Local file: drop it again'));
    p.catch(() => songCache.delete(key));
    songCache.set(key, p);
    // Keep memory in check: decoded songs are big.
    if (songCache.size > 4) songCache.delete(songCache.keys().next().value!);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Race sessions
// ---------------------------------------------------------------------------

function onRaceEvent(e: RaceEvent) {
  if (!session) return;
  stage.onEvent(e, session.sim);
  if (session.mode !== 'race') return;
  hud.onEvent(e, stage, session.sim);
  if (e.type === 'catch' && e.block.kind !== 'pellet') sfx.catch(e.block.tier);
  else if (e.type === 'gem') sfx.gem();
  else if (e.type === 'grey') sfx.grey();
  else if (e.type === 'multiplier' && e.mult > 1) sfx.multiplier(e.mult);
  else if (e.type === 'overdrive') sfx.overdrive();
  else if (e.type === 'pellet') sfx.pellet(e.index);
  else if (e.type === 'holdTick') sfx.holdTick();
  else if (e.type === 'holdDone') sfx.multiplier(3);
  else if (e.type === 'streamDone' && e.caught === e.total) sfx.multiplier(5);
}

function buildSim(track: Track, withPlayer: boolean): { sim: RaceSim; local?: LocalController } {
  resetBlocks(track);
  if (withPlayer) {
    const local = new LocalController(canvas);
    return { sim: new RaceSim(track, local, PLAYER_COLOR, onRaceEvent), local };
  }
  return { sim: new RaceSim(track, new AutopilotController(), PLAYER_COLOR, onRaceEvent) };
}

function startAttract() {
  session?.local?.dispose();
  music.stop();
  const analysis = fakeAnalysis();
  const track = generateTrack(analysis, 'attract');
  const { sim } = buildSim(track, false);
  stage.load(track, myLoadout());
  session = { mode: 'attract', track, sim, analysis, feed: new AudioFeed(null), clock: 6, finished: false, previousBest: 0 };
  hud.show(false);
}

const runKey = (song: LoadedSong) => `${song.meta.id}#t${TRACK_VERSION}`;

async function startSolo(song: LoadedSong) {
  session?.local?.dispose();
  const best = localBest(runKey(song));
  const track = generateTrack(song.analysis, song.meta.id);
  const { sim, local } = buildSim(track, true);
  stage.load(track, myLoadout());
  hud.setup(song.meta, track, [], best?.score ?? 0, PLAYER_COLOR, best ? new Ghost(best, 0, '') : null);
  hud.show(true);
  // ?seek=<seconds> starts mid-song: handy when working on a specific part of a track.
  const seek = Number(new URLSearchParams(location.search).get('seek')) || 0;
  // Runs on the server's analysis are streamed as they're ridden, then scored by the server.
  const solo = song.official && menu.player && net.connected && !seek ? { log: new InputLog(), lastSent: 0, started: false } : undefined;
  sim.input = solo?.log ?? null;
  abortSolo();
  session = {
    mode: 'race', track, sim, analysis: song.analysis, feed: new AudioFeed(music.analyser), song, local, clock: 0,
    finished: false, recorder: new Recorder(), previousBest: best?.score ?? 0, solo,
  };
  const s = session;
  lastSong = song;
  for (const id of ['menu', 'loading', 'results', 'pause', 'lobby']) show(id, false);
  await music.play(song.buffer, COUNTDOWN, seek);
  if (solo && session === s) {
    net.send({ type: 'solo', action: 'start', key: song.meta.id, t: music.time });
    solo.started = true;
  }
}

/** Stop streaming the current solo run (quit, restart). */
function abortSolo() {
  if (session?.solo?.started && !session.finished) net.send({ type: 'solo', action: 'abort' });
}

/** The run waiting for the server's verdict. */
let verdict: { name: string; local: number; timer: number } | null = null;

net.on('soloResult', (m) => {
  if (!verdict) return;
  const { name, local, timer } = verdict;
  verdict = null;
  clearTimeout(timer);
  if (!m.verified) return notRanked(m.reason);
  // The server's score is the one that counts (it only differs if something went wrong here).
  if (m.score !== local) console.warn(`server scored ${m.score}, this browser ${local}`);
  $('res-score').textContent = m.score.toLocaleString('en-US');
  $('res-credits').textContent = `+${m.earned.toLocaleString('en-US')} ◈`;
  hud.leaderboard(m.board, name, m.score);
  menu.setPlayer(m.player);
});

function notRanked(reason: string) {
  $('res-credits').textContent = `Not ranked · ${reason}`;
}

function finishSolo() {
  const s = session;
  s.finished = true;
  // Seeking skips part of the song, so those runs are not records.
  const seeked = !!new URLSearchParams(location.search).get('seek');
  hud.results(s.song!.meta, s.sim, s.track, s.previousBest, !seeked);
  const name = menu.player?.name ?? 'ANON';
  const run = s.recorder!.finish(runKey(s.song!), name, s.sim.racer.score);
  $('res-credits').textContent = '';
  if (!seeked && run.score > s.previousBest) saveLocalBest(run);
  if (s.solo?.started) {
    net.send({ type: 'solo', action: 'finish', chunk: s.solo.log.take() });
    $('res-credits').textContent = 'Verifying…';
    if (verdict) clearTimeout(verdict.timer);
    verdict = { name, local: s.sim.racer.score, timer: window.setTimeout(() => { verdict = null; notRanked('connection lost'); }, 8000) };
  } else if (!seeked) {
    notRanked(!s.song!.official ? 'local file' : !menu.player ? 'no pilot name' : 'offline');
  }
  setTimeout(() => {
    if (session !== s) return;
    music.stop();
    s.local?.dispose();
    hud.show(false);
    show('results', true);
    // Keep the scene alive behind the results: the autopilot takes over.
    startAttract();
    show('menu', false);
  }, 2200);
}

// ---------------------------------------------------------------------------
// Lobby rounds
// ---------------------------------------------------------------------------

let lobby: LobbyView | null = null;
let prepared: { round: number; key: string; song: LoadedSong | null } | null = null;
let racedRound = -1;

function onLobby(v: LobbyView) {
  const firstSight = !lobby || lobby.id !== v.id;
  if (!lobby || lobby.round !== v.round || lobby.phase !== v.phase) {
    if (v.phase === 'voting') lobbyScreen.myVote = null;
  }
  lobby = v;
  menu.setQueued(null);
  setLobbyUrl(v.code);
  if (firstSight) {
    racedRound = -1;
    prepared = null;
    api.history().then((g) => lobbyScreen.setRecent(g)).catch(() => {});
  }
  lobbyScreen.render(v);

  if ((v.phase === 'loading' || v.phase === 'racing') && v.song && (!prepared || prepared.round !== v.round)) prepareRound(v);
  if (v.phase === 'racing' && v.startAt && prepared?.song && prepared.round === v.round && racedRound !== v.round) startLobbyRace(v);
  if ((v.phase === 'results' || v.phase === 'finished') && session.multi) endLobbyRace(false);

  const racing = session.mode !== 'attract' && !!session.multi && !session.finished;
  show('lobby', !racing);
  show('menu', false);
  show('results', false);
  if (v.phase === 'finished') menu.refresh();
}

function prepareRound(v: LobbyView) {
  const round = v.round;
  const key = v.song!.key;
  prepared = { round, key, song: null };
  lobbyScreen.loadProgress = 0;
  lobbyScreen.loadLabel = 'Loading';
  loadByKey(key, (label, p) => {
    if (prepared?.round !== round) return;
    lobbyScreen.loadLabel = label;
    lobbyScreen.loadProgress = p;
    if (lobby) lobbyScreen.render(lobby);
  })
    .then((song) => {
      if (prepared?.round !== round || prepared.key !== key) return;
      prepared.song = song;
      lobbyScreen.loadProgress = null;
      net.send({ type: 'loaded', round });
      if (lobby) onLobby(lobby);
    })
    .catch((e) => {
      lobbyScreen.loadLabel = `Couldn't load: ${(e as Error).message}`;
      if (lobby) lobbyScreen.render(lobby);
    });
}

function startLobbyRace(v: LobbyView) {
  closeShip();
  const song = prepared!.song!;
  racedRound = v.round;
  session?.local?.dispose();
  const track = generateTrack(song.analysis, song.meta.id);
  const { sim, local } = buildSim(track, true);
  stage.load(track, myLoadout());
  // Rivals show in their own ship's glow colour.
  const rivals: Rival[] = v.players
    .filter((p) => p.id !== menu.player?.id && !p.left)
    .map((p) => ({ id: p.id, name: p.name, color: parseInt(p.loadout.glow.slice(1), 16) }));
  hud.setup(song.meta, track, rivals, 0, PLAYER_COLOR, null);
  hud.show(true);
  session = {
    mode: 'race', track, sim, analysis: song.analysis, feed: new AudioFeed(music.analyser), song, local, clock: 0,
    finished: false, previousBest: 0, multi: { round: v.round, lastSent: 0, log: new InputLog() },
  };
  sim.input = session.multi!.log;
  // Everyone's music starts at the same server instant; late loaders jump in mid-song.
  const delay = (v.startAt! - net.serverNow()) / 1000;
  music.play(song.buffer, Math.max(0, delay), Math.max(0, -delay));
}

/** The race is over for us (crossed the line, or the server moved on). */
function endLobbyRace(crossed: boolean) {
  const s = session;
  if (!s.multi) return;
  if (crossed) net.send({ type: 'finish', round: s.multi.round, chunk: s.multi.log.take() });
  s.finished = true;
  music.stop();
  s.local?.dispose();
  hud.show(false);
  show('pause', false);
  startAttract();
  if (lobby) {
    lobbyScreen.render(lobby);
    show('lobby', true);
  }
}

function leaveLobby() {
  net.send({ type: 'leave' });
}

/** The address bar mirrors the casual lobby you're in, so it can be shared as is. */
function setLobbyUrl(code: string | null) {
  const url = new URL(location.href);
  if ((url.searchParams.get('lobby') ?? null) === code) return;
  if (code) url.searchParams.set('lobby', code);
  else url.searchParams.delete('lobby');
  history.replaceState(null, '', url);
}

function backToMenuFromLobby() {
  setLobbyUrl(null);
  lobby = null;
  prepared = null;
  if (session.multi) endLobbyRace(false);
  show('lobby', false);
  show('pause', false);
  show('menu', true);
  menu.refresh();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

const menu = new Menu({
  queue(mode: LobbyMode) {
    if (!net.connected) return toast('Offline');
    menu.setQueued(mode);
    net.send({ type: 'queue', mode });
  },
  joinLobby(code) {
    if (!net.connected) return toast('Offline');
    net.send({ type: 'join', code });
  },
  openProfile() {
    profileScreen.open('profile');
  },
  openLeaderboard() {
    leaderboard.open();
  },
  openPilot(id) {
    leaderboard.pilot(id);
  },
  identified() {
    if (!net.connected) net.connect();
    refreshMyShip();
  },
});

const profileScreen = new ProfileScreen({
  player: () => menu.player,
  replay: (key, title) => load(title, (st) => loadByKey(key, st)),
  playerChanged: (p) => menu.setPlayer(p),
});
const leaderboard = new Leaderboard((name, loadout) => showShip(name, loadout));

// Settings apply live.
onSettings((s) => {
  music.setVolume(s.music);
  sfx.setVolume(s.effects);
  sfx.blockSounds = s.blockSounds;
  stage.setQuality(s.quality);
  stage.effects = s.screenEffects;
  show('fps', s.showFps);
});

const hangar = new Hangar({
  loadout: myLoadout,
  owned: () => menu.player?.owned ?? [],
  credits: () => menu.player?.credits ?? null,
  save: saveMyLoadout,
  async buy(slot, id) {
    if (!menu.player) throw new Error('Sign in to buy');
    menu.setPlayer(await api.buy(slot, id));
  },
});
$('hangar-open').addEventListener('click', () => hangar.open());

/** Inspect another pilot's ship in 3D (lobby cards). */
let modalViewer: ShipViewer | null = null;
function showShip(name: string, loadout: Loadout) {
  $('ship-modal-name').textContent = name;
  show('ship-modal', true);
  modalViewer?.dispose();
  modalViewer = new ShipViewer($<HTMLCanvasElement>('ship-modal-canvas'));
  modalViewer.setLoadout(loadout);
  modalViewer.start();
}
function closeShip() {
  modalViewer?.dispose();
  modalViewer = null;
  show('ship-modal', false);
}
$('ship-modal-close').addEventListener('click', closeShip);
$('ship-modal').addEventListener('click', (e) => e.target === $('ship-modal') && closeShip());

const lobbyScreen = new LobbyScreen(
  {
    inspect(name, loadout) {
      showShip(name, loadout);
    },
    copyInvite(code) {
      const link = `${location.origin}${location.pathname}?lobby=${code}`;
      navigator.clipboard?.writeText(link).then(
        () => toast('Invite link copied'),
        () => prompt('Invite link', link),
      ) ?? prompt('Invite link', link);
    },
    submit(url) {
      lobbyScreen.submitError = '';
      net.send({ type: 'submit', url });
    },
    vote(key) {
      net.send({ type: 'vote', key });
    },
    chat(text) {
      net.send({ type: 'chat', text });
    },
    leave() {
      const inMatch = lobby && lobby.phase !== 'waiting' && lobby.phase !== 'finished';
      if (inMatch && !confirm('Leave the match? You will finish last.')) return;
      leaveLobby();
    },
    again(mode) {
      net.send({ type: 'queue', mode });
    },
  },
  () => net.serverNow(),
);

// Invite links: ?lobby=CODE joins that lobby as soon as we're signed in and connected.
let pendingCode = new URLSearchParams(location.search).get('lobby')?.toUpperCase() ?? null;

net.on('welcome', (m) => {
  menu.setPlayer(m.player);
  lobbyScreen.me = m.player.id;
  menu.setOnline(true);
  menu.setStatus('');
  menu.refresh();
  if (pendingCode) {
    net.send({ type: 'join', code: pendingCode });
    pendingCode = null;
  }
});
net.on('lobby', (m) => onLobby(m.lobby));
net.on('left', () => backToMenuFromLobby());
net.on('scores', (m) => {
  if (session.multi && m.round === session.multi.round) hud.setRivalScores(m.scores);
});
net.on('submitted', () => {
  lobbyScreen.submitError = '';
  if (lobby) lobbyScreen.render(lobby);
});
net.on('error', (m) => {
  if (m.message === '__disconnected') {
    menu.setOnline(false);
    menu.setStatus('Reconnecting…', true);
    return;
  }
  if (lobby && !$('lobby').classList.contains('hidden')) {
    lobbyScreen.submitError = m.message;
    lobbyScreen.resetCenter();
    lobbyScreen.render(lobby);
  } else {
    toast(m.message);
    setLobbyUrl(null); // e.g. an invite link to a lobby that no longer exists
  }
  menu.setQueued(null);
});

function show(id: string, on: boolean) {
  $(id).classList.toggle('hidden', !on);
}

function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  show('toast', true);
  clearTimeout((toast as unknown as { h: number }).h);
  (toast as unknown as { h: number }).h = window.setTimeout(() => show('toast', false), 6000);
}

async function load(title: string, fn: (status: Status) => Promise<LoadedSong>) {
  if (lobby) return toast('Leave the lobby first');
  const token = ++loadToken;
  show('menu', false);
  show('results', false);
  show('loading', true);
  $('loading-title').textContent = title;
  const bar = $('loading-bar');
  const status = $('loading-status');
  const update = (label: string, p: number) => {
    if (token !== loadToken) return;
    status.textContent = label;
    bar.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`;
  };
  try {
    const song = await fn(update);
    if (token !== loadToken) return;
    update('Generating the track', 1);
    $('loading-title').textContent = song.meta.title;
    await new Promise((r) => setTimeout(r, 50));
    await startSolo(song);
  } catch (e) {
    if (token !== loadToken) return;
    console.error(e);
    show('loading', false);
    show('menu', true);
    toast(`Couldn't load that: ${(e as Error).message}`);
  }
}

function toMenu() {
  abortSolo();
  loadToken++;
  for (const id of ['pause', 'results', 'loading']) show(id, false);
  show('menu', true);
  startAttract();
  menu.refresh();
}

function pause() {
  if (session.mode !== 'race') return;
  if (session.multi) {
    // Lobby races can't be paused: the overlay just offers to leave.
    $('pause-title').textContent = 'LEAVE MATCH?';
    $('btn-resume').textContent = 'Keep racing';
    $('btn-quit').textContent = 'Leave (finish last)';
    show('btn-restart', false);
    show('pause', true);
    return;
  }
  $('pause-title').textContent = 'PAUSED';
  $('btn-resume').textContent = 'Resume';
  $('btn-quit').textContent = 'Quit to menu';
  show('btn-restart', true);
  session.mode = 'paused';
  if (session.solo?.started) net.send({ type: 'solo', action: 'pause', chunk: session.solo.log.take() });
  if (session.local) session.local.enabled = false;
  music.pause();
  show('pause', true);
}

function resume() {
  show('pause', false);
  if (session.mode !== 'paused') return;
  session.mode = 'race';
  if (session.local) session.local.enabled = true;
  if (session.solo?.started) net.send({ type: 'solo', action: 'resume' });
  music.resume();
}

$<HTMLFormElement>('yt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $<HTMLInputElement>('yt-url').value.trim();
  if (!url) return $('yt-url').focus();
  load('Fetching from YouTube', (st) => loadYouTube(url, st));
});
$('btn-demo').addEventListener('click', () => load('Neon Drive (demo)', (st) => loadByKey('demo:neon-drive', st)));
$<HTMLInputElement>('file-input').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) load(f.name, (st) => loadFile(f, st));
  (e.target as HTMLInputElement).value = '';
});
$('loading-cancel').addEventListener('click', toMenu);
$('about-open').addEventListener('click', () => show('about', true));
$('about-close').addEventListener('click', () => show('about', false));
$('about').addEventListener('click', (e) => e.target === $('about') && show('about', false));
window.addEventListener('keydown', (e) => e.key === 'Escape' && show('about', false));
$('btn-resume').addEventListener('click', resume);
$('btn-restart').addEventListener('click', () => lastSong && startSolo(lastSong));
$('btn-quit').addEventListener('click', () => {
  if (session.multi) {
    show('pause', false);
    leaveLobby();
    return;
  }
  music.stop();
  toMenu();
});
$('btn-again').addEventListener('click', () => lastSong && startSolo(lastSong));
$('btn-menu').addEventListener('click', toMenu);

window.addEventListener('keydown', (e) => {
  if (!session) return;
  const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
  if (e.key === 'Escape') {
    if (!$('ship-modal').classList.contains('hidden')) return closeShip();
    if (!$('hangar').classList.contains('hidden')) return;
    if (!$('pause').classList.contains('hidden')) resume();
    else if (session.mode === 'race') pause();
  }
  if (!typing && e.key === 'Enter' && !$('results').classList.contains('hidden') && lastSong) startSolo(lastSong);
});
document.addEventListener('visibilitychange', () => {
  if (session && document.hidden && !session.multi) pause();
});

// Drag & drop any audio file.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; show('drop-zone', true); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; show('drop-zone', false); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  show('drop-zone', false);
  const f = e.dataTransfer?.files?.[0];
  if (f && session?.mode !== 'race') load(f.name, (st) => loadFile(f, st));
});

serverHasYouTube().then((ok) => show('server-note', !ok));
menu.setOnline(false);

// Deep link: ?v=<youtube url or id> pre-fills the solo box.
{
  const v = new URLSearchParams(location.search).get('v');
  if (v) $<HTMLInputElement>('yt-url').value = v;
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

let last = performance.now();
const OVERLAYS = ['menu', 'lobby', 'results', 'loading'].map((id) => $(id));
/** Full-screen views with their own 3D preview: the game scene can stop rendering. */
const OPAQUE = ['hangar', 'ship-modal', 'profile', 'leaderboard'].map((id) => $(id));
const fpsEl = $('fps');
let fpsFrames = 0;
let fpsSince = performance.now();

function tick(now: number) {
  requestAnimationFrame(tick);
  const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
  last = now;
  fpsFrames++;
  if (now - fpsSince > 500) {
    fpsEl.textContent = `${Math.round((fpsFrames * 1000) / (now - fpsSince))} FPS`;
    fpsFrames = 0;
    fpsSince = now;
  }
  const s = session;
  if (s.mode === 'attract' && OPAQUE.some((el) => !el.classList.contains('hidden'))) return;

  let time: number;
  if (s.mode === 'attract') {
    s.clock += dt;
    if (s.clock > s.track.duration + 2) {
      startAttract();
      return;
    }
    time = s.clock;
  } else {
    time = s.mode === 'paused' ? s.sim.time : music.time;
    time = Math.max(-PRE_ROLL + 0.5, time);
  }

  stage.setCovered(OVERLAYS.some((el) => !el.classList.contains('hidden')));
  if (s.mode !== 'paused') s.sim.update(time);
  if (s.mode === 'race' && !s.finished) s.recorder?.push(time, s.sim.racer.x, s.sim.racer.score);
  s.feed.update(time, s.analysis, s.mode === 'race', dt);
  stage.frame(s.sim, { time, dt: s.mode === 'paused' ? 0 : dt, bands: s.feed.bands, bass: s.feed.bass, energy: s.feed.energy });

  if (s.mode === 'race') {
    hud.update(s.sim, stage, time);
    // Inputs go to the server as they're ridden; it keeps the score that counts.
    if (s.multi && !s.finished && now - s.multi.lastSent > INPUT_EVERY) {
      s.multi.lastSent = now;
      const chunk = s.multi.log.take();
      if (chunk) net.send({ type: 'input', round: s.multi.round, chunk });
    }
    if (s.solo?.started && !s.finished && now - s.solo.lastSent > INPUT_EVERY) {
      s.solo.lastSent = now;
      const chunk = s.solo.log.take();
      if (chunk) net.send({ type: 'solo', action: 'input', chunk });
    }
    if (!s.finished && time > s.track.duration + 0.8) {
      if (s.multi) endLobbyRace(true);
      else finishSolo();
    }
  }
}
// The menu (plain HTML + CSS) paints first; the 3D scene and sign-in follow right after.
requestAnimationFrame(() =>
  setTimeout(() => {
    refreshMyShip(); // before the first attract run, so it doesn't rebuild twice
    startAttract();
    last = performance.now();
    requestAnimationFrame(tick);
    menu.init().then(() => menu.player && net.connect());
  }, 0),
);

// Handy for debugging from the console.
Object.assign(window, {
  songsurf: {
    stage, net,
    get session() { return session; },
    get lobby() { return lobby; },
    /** Cross the finish line now (testing lobby flows without riding whole songs). */
    finishRace: () => (session.multi ? endLobbyRace(true) : session.mode === 'race' && finishSolo()),
  },
});
