import type { PlayerInfo, PublicProfile, Socials } from './protocol.ts';
import type { Loadout } from '../ship/catalog.ts';

/** Identity is a pilot name plus a secret token kept in this browser (no passwords yet). */

const TOKEN_KEY = 'songsurf:token';

export function token(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* private mode: identity lasts for this tab only */
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const t = token();
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}), ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { status: res.status });
  return body as T;
}

export async function register(name: string): Promise<PlayerInfo> {
  const out = await call<{ token: string; player: PlayerInfo }>('/api/register', { method: 'POST', body: JSON.stringify({ name }) });
  setToken(out.token);
  return out.player;
}

export async function me(): Promise<PlayerInfo | null> {
  if (!token()) return null;
  try {
    return (await call<{ player: PlayerInfo }>('/api/me')).player;
  } catch (e) {
    if ((e as { status?: number }).status === 401) return null;
    throw e;
  }
}

export async function saveLoadout(loadout: Loadout): Promise<PlayerInfo> {
  return (await call<{ player: PlayerInfo }>('/api/me/loadout', { method: 'POST', body: JSON.stringify({ loadout }) })).player;
}

export async function rename(name: string): Promise<PlayerInfo> {
  return (await call<{ player: PlayerInfo }>('/api/me', { method: 'POST', body: JSON.stringify({ name }) })).player;
}

export interface HistoryGame {
  mode: 'solo' | 'ranked' | 'casual';
  match_id: string | null;
  song_key: string;
  song_title: string;
  song_artist: string;
  score: number;
  placement: number | null;
  players: number | null;
  points: number | null;
  rating_delta: number | null;
  created_at: number;
}

export async function history(): Promise<HistoryGame[]> {
  return (await call<{ games: HistoryGame[] }>('/api/history')).games;
}

/** Record a solo run; returns the credits it earned and the updated pilot. */
export async function recordSolo(songKey: string, title: string, artist: string, score: number): Promise<{ earned: number; player: PlayerInfo } | null> {
  return call<{ earned: number; player: PlayerInfo }>('/api/solo', { method: 'POST', body: JSON.stringify({ songKey, title, artist, score }) }).catch(() => null);
}

export async function buy(slot: string, id: string): Promise<PlayerInfo> {
  return (await call<{ player: PlayerInfo }>('/api/shop/buy', { method: 'POST', body: JSON.stringify({ slot, id }) })).player;
}

export async function leaderboard(): Promise<{ players: PlayerInfo[]; me: { player: PlayerInfo; rank: number | null } | null }> {
  return call('/api/leaderboard');
}

export async function profile(q: { id?: number; name?: string }): Promise<PublicProfile> {
  return call(q.id ? `/api/profile?id=${q.id}` : `/api/profile?name=${encodeURIComponent(q.name ?? '')}`);
}

export async function saveSocials(socials: Socials): Promise<PlayerInfo> {
  return (await call<{ player: PlayerInfo }>('/api/me/socials', { method: 'POST', body: JSON.stringify({ socials }) })).player;
}

export interface Friend extends PlayerInfo {
  online: boolean;
  lobby: { code: string; mode: 'ranked' | 'casual'; phase: string; players: number; joinable: boolean } | null;
}

export async function friends(): Promise<Friend[]> {
  return (await call<{ friends: Friend[] }>('/api/friends')).friends;
}

export async function addFriend(name: string): Promise<Friend[]> {
  return (await call<{ friends: Friend[] }>('/api/friends', { method: 'POST', body: JSON.stringify({ name }) })).friends;
}

export async function removeFriend(id: number): Promise<Friend[]> {
  return (await call<{ friends: Friend[] }>(`/api/friends?id=${id}`, { method: 'DELETE' })).friends;
}
