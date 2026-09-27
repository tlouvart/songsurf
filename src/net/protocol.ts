/** Messages exchanged over the /ws socket. Shared by the browser and the server. */

export type Mode = 'ranked' | 'casual';
export type Phase = 'waiting' | 'voting' | 'loading' | 'racing' | 'results' | 'finished';

export const LOBBY_SIZE = 8;
export const ROUNDS = 3;
/** placement → round points */
export const PLACE_POINTS = [10, 8, 6, 5, 4, 3, 2, 1];
/** solo runs + casual matches needed before ranked opens */
export const RANKED_UNLOCK = 3;

import type { Loadout } from '../ship/catalog.ts';

export interface PlayerInfo {
  id: number;
  name: string;
  elo: number;
  fun: number;
  ranked_matches: number;
  casual_matches: number;
  loadout: Loadout;
  credits: number;
  owned: string[];
  ranked_wins: number;
  /** solo runs + casual matches (ranked unlocks at RANKED_UNLOCK) */
  games_played: number;
  socials: Socials;
}

export interface Socials {
  twitch?: string;
  youtube?: string;
  x?: string;
  discord?: string;
}

export interface TopSong {
  song_key: string;
  song_title: string;
  song_artist: string;
  plays: number;
  best: number;
}

export interface PublicProfile {
  player: PlayerInfo;
  /** position in the Elo ranking, or null before any ranked match */
  rank: number | null;
  solo_runs: number;
  top_songs: TopSong[];
}

export interface SongRef {
  /** 'yt:<id>' or 'demo:neon-drive' */
  key: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail?: string;
  /** who submitted it */
  by?: string;
}

export interface LobbyPlayer {
  id: number;
  name: string;
  loadout: Loadout;
  elo: number;
  fun: number;
  connected: boolean;
  left: boolean;
  submission: SongRef | null;
  voted: boolean;
  ready: boolean;
  finished: boolean;
  /** match total so far */
  points: number;
}

export interface ChatMsg {
  from: number;
  name: string;
  text: string;
  at: number;
  system?: boolean;
}

export interface RoundResult {
  round: number;
  song: SongRef;
  rows: { id: number; name: string; score: number; points: number; placement: number; left: boolean; credits: number }[];
}

export interface FinalRow {
  id: number;
  name: string;
  total: number;
  placement: number;
  /** Elo change (ranked only; 0 in casual) */
  delta: number;
  /** Elo after the match */
  after: number;
  /** left before the end: ranked last */
  left: boolean;
}

export interface LobbyView {
  id: string;
  /** casual lobbies: short code to invite friends (?lobby=CODE); null for ranked */
  code: string | null;
  mode: Mode;
  phase: Phase;
  /** 0-based round index */
  round: number;
  rounds: number;
  /** server time (ms) when the current phase ends, if timed */
  deadline: number | null;
  /** server time (ms) when the race music starts */
  startAt: number | null;
  song: SongRef | null;
  candidates: SongRef[];
  votes: Record<string, number>;
  players: LobbyPlayer[];
  chat: ChatMsg[];
  results: RoundResult[];
  final: FinalRow[] | null;
}

export type ClientMsg =
  | { type: 'hello'; token: string }
  | { type: 'ping'; t: number }
  | { type: 'queue'; mode: Mode }
  | { type: 'join'; code: string }
  | { type: 'leave' }
  | { type: 'submit'; url: string }
  | { type: 'vote'; key: string }
  | { type: 'chat'; text: string }
  | { type: 'loaded'; round: number }
  | { type: 'score'; round: number; score: number }
  | { type: 'finish'; round: number; score: number };

export type ServerMsg =
  | { type: 'welcome'; player: PlayerInfo }
  | { type: 'error'; message: string }
  | { type: 'pong'; t: number; now: number }
  | { type: 'lobby'; lobby: LobbyView; now: number }
  | { type: 'left' }
  | { type: 'scores'; round: number; scores: Record<number, number> }
  | { type: 'submitted'; song: SongRef };
