/** Player settings, kept in this browser. */

export type Quality = 'high' | 'medium' | 'low';

export interface Settings {
  music: number;
  effects: number;
  blockSounds: boolean;
  showFps: boolean;
  quality: Quality;
  screenEffects: boolean;
  /** hide lobby codes (on screen and in the URL) */
  streamer: boolean;
}

const DEFAULTS: Settings = { music: 0.9, effects: 0.8, blockSounds: true, showFps: false, quality: 'high', screenEffects: true, streamer: false };
const KEY = 'songsurf:settings';

let current: Settings = load();
const listeners = new Set<(s: Settings) => void>();

function load(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function settings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable: settings last for this session */
  }
  for (const fn of listeners) fn(current);
}

/** Call now and on every change. */
export function onSettings(fn: (s: Settings) => void) {
  listeners.add(fn);
  fn(current);
}
