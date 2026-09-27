/**
 * Ship customization catalog: items (with prices), colours and validation. No three.js here
 * so the server can check loadouts and purchases with the same source of truth; geometry
 * lives in ./build.ts.
 */

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';

export interface Item {
  id: string;
  name: string;
  /** price in credits; 0 = owned by everyone */
  price: number;
}

const items = (list: [string, string, number][]): Item[] => list.map(([id, name, price]) => ({ id, name, price }));

export const HULLS = items([
  ['dart', 'Dart', 0], ['arrow', 'Arrow', 0], ['manta', 'Manta', 1500], ['shark', 'Shark', 2500],
  ['falcon', 'Falcon', 3500], ['stingray', 'Stingray', 5000], ['phantom', 'Phantom', 8000],
]);

export const WINGS = items([
  ['delta', 'Delta', 0], ['swept', 'Swept', 0], ['blade', 'Blade', 1500], ['bat', 'Bat', 3000],
  ['xsplit', 'X-Split', 4000], ['scythe', 'Scythe', 6000], ['halo', 'Halo', 9000],
]);

export const ENGINES = items([
  ['twin', 'Twin', 0], ['mono', 'Mono', 0], ['triple', 'Triple', 2000], ['heavy', 'Heavy', 3500],
  ['ring', 'Ring', 6000], ['quad', 'Quad pods', 8000],
]);

export const FINS = items([
  ['none', 'None', 0], ['twin', 'Twin', 0], ['spine', 'Spine', 1000], ['tall', 'Tall', 2500], ['spoiler', 'Spoiler', 4000],
]);

export const COCKPITS = items([
  ['bubble', 'Bubble', 0], ['long', 'Long', 800], ['visor', 'Visor', 1500], ['twin', 'Twin', 2500], ['crystal', 'Crystal', 4000],
]);

export const FINISHES = items([
  ['matte', 'Matte', 0], ['metal', 'Metal', 0], ['satin', 'Satin', 500], ['carbon', 'Carbon', 2500],
  ['chrome', 'Chrome', 3000], ['pearl', 'Pearl', 4000], ['holo', 'Holo', 7500],
]);

export const TEXTURES = items([
  ['none', 'None', 0], ['stripes', 'Stripes', 0], ['chevrons', 'Chevrons', 800], ['split', 'Split', 800],
  ['fade', 'Fade', 1500], ['hex', 'Hex', 1500], ['tiger', 'Tiger', 2000], ['camo', 'Digital', 2000],
  ['circuit', 'Circuit', 3500], ['flames', 'Flames', 4500],
]);

export const TRAILS = items([
  ['ribbon', 'Ribbon', 0], ['twin', 'Twin jets', 800], ['comet', 'Comet', 1500], ['dashed', 'Dashed', 2000],
  ['wide', 'Wide glow', 2500], ['lightning', 'Lightning', 4500], ['rainbow', 'Rainbow', 7000], ['none', 'None', 0],
]);

export function rarity(price: number): Rarity {
  return price === 0 ? 'common' : price <= 2000 ? 'rare' : price <= 5000 ? 'epic' : 'legendary';
}

/** Curated swatches; any colour can also be picked freely. */
export const SWATCHES = [
  '#11131c', '#2a2f40', '#8d93a8', '#e8eaf2', '#3a1b6b', '#1a2f7a', '#0e5a6b', '#0f5c3a',
  '#7a3312', '#6b0f24', '#a3155e', '#e03a3a', '#ff8a1a', '#ffd23f', '#2bd67b', '#2f7bff',
];
export const NEON_SWATCHES = [
  '#33e1ff', '#00ffc6', '#3dff6e', '#b6ff3d', '#ffe83d', '#ffb03d', '#ff6a3d', '#ff3d6e',
  '#ff2bd0', '#d23dff', '#8a5cff', '#5c7bff', '#ffffff', '#ff9ad5', '#9af0ff', '#c8ff9a',
];

export interface Loadout {
  hull: string;
  wings: string;
  engines: string;
  fins: string;
  cockpit: string;
  finish: string;
  texture: string;
  trail: string;
  /** colour zones */
  body: string;
  wing: string;
  trim: string;
  pattern: string;
  neon: string;
  glow: string;
  /** texture scale, 0.5 – 2 */
  scale: number;
}

export const DEFAULT_LOADOUT: Loadout = {
  hull: 'dart', wings: 'delta', engines: 'twin', fins: 'twin', cockpit: 'bubble',
  finish: 'metal', texture: 'none', trail: 'ribbon',
  body: '#2a2f40', wing: '#11131c', trim: '#8d93a8', pattern: '#33e1ff', neon: '#33e1ff', glow: '#33e1ff', scale: 1,
};

export type ItemSlot = 'hull' | 'wings' | 'engines' | 'fins' | 'cockpit' | 'finish' | 'texture' | 'trail';
export type ColorSlot = 'body' | 'wing' | 'trim' | 'pattern' | 'neon' | 'glow';

export const ITEM_SLOTS: { key: ItemSlot; label: string; items: Item[] }[] = [
  { key: 'hull', label: 'Hull', items: HULLS },
  { key: 'wings', label: 'Wings', items: WINGS },
  { key: 'engines', label: 'Engines', items: ENGINES },
  { key: 'fins', label: 'Fins', items: FINS },
  { key: 'cockpit', label: 'Cockpit', items: COCKPITS },
  { key: 'finish', label: 'Finish', items: FINISHES },
  { key: 'texture', label: 'Texture', items: TEXTURES },
  { key: 'trail', label: 'Trail', items: TRAILS },
];

export const COLOR_SLOTS: { key: ColorSlot; label: string; swatches: string[] }[] = [
  { key: 'body', label: 'Body', swatches: SWATCHES },
  { key: 'wing', label: 'Wings & fins', swatches: SWATCHES },
  { key: 'trim', label: 'Trim', swatches: SWATCHES },
  { key: 'pattern', label: 'Texture', swatches: [...NEON_SWATCHES.slice(0, 8), ...SWATCHES.slice(0, 8)] },
  { key: 'neon', label: 'Neon', swatches: NEON_SWATCHES },
  { key: 'glow', label: 'Engine glow', swatches: NEON_SWATCHES },
];

export const itemKey = (slot: ItemSlot, id: string) => `${slot}:${id}`;

export function findItem(slot: ItemSlot, id: string): Item | undefined {
  return ITEM_SLOTS.find((s) => s.key === slot)?.items.find((i) => i.id === id);
}

export function isOwned(owned: Iterable<string>, slot: ItemSlot, id: string): boolean {
  const item = findItem(slot, id);
  if (!item) return false;
  if (item.price === 0) return true;
  for (const k of owned) if (k === itemKey(slot, id)) return true;
  return false;
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Keep only valid values; unknown (or, when `owned` is given, not owned) items fall back to
 * the default, colours must be hex, the scale is clamped.
 */
export function sanitizeLoadout(raw: unknown, owned?: Iterable<string>): Loadout {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_LOADOUT };
  const have = owned ? [...owned] : null;
  for (const s of ITEM_SLOTS) {
    const v = String(src[s.key] ?? '');
    if (s.items.some((i) => i.id === v) && (!have || isOwned(have, s.key, v))) out[s.key] = v;
  }
  for (const c of COLOR_SLOTS) {
    const v = String(src[c.key] ?? '');
    if (HEX.test(v)) out[c.key] = v.toLowerCase();
  }
  const scale = Number(src.scale);
  if (Number.isFinite(scale)) out.scale = Math.min(2, Math.max(0.5, scale));
  return out;
}

/** Random ship. With `owned`, only from what you own (colours are always free). */
export function randomLoadout(owned?: Iterable<string>): Loadout {
  const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  const have = owned ? [...owned] : null;
  const out = { ...DEFAULT_LOADOUT };
  for (const s of ITEM_SLOTS) {
    const pool = have ? s.items.filter((i) => isOwned(have, s.key, i.id)) : s.items;
    out[s.key] = pick(pool).id;
  }
  for (const c of COLOR_SLOTS) out[c.key] = pick(c.swatches);
  out.scale = pick([0.75, 1, 1.25, 1.5]);
  return out;
}

/** Items in this loadout that aren't owned yet (to buy before saving). */
export function missingItems(l: Loadout, owned: Iterable<string>): { slot: ItemSlot; item: Item }[] {
  const have = [...owned];
  return ITEM_SLOTS.filter((s) => !isOwned(have, s.key, l[s.key])).map((s) => ({ slot: s.key, item: findItem(s.key, l[s.key])! }));
}

/** Stable key for caching renders of a loadout. */
export const loadoutKey = (l: Loadout) => [...ITEM_SLOTS.map((s) => l[s.key]), ...COLOR_SLOTS.map((c) => l[c.key]), l.scale].join('|');

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

export const START_CREDITS = 1500;
/** credits per point of score, and the cap for one song */
export const CREDIT_RATE = 1 / 40;
export const CREDIT_CAP = 2500;
/** extra credits per lobby round, by placement */
export const PLACE_CREDITS = [150, 100, 60, 30];

export function creditsForScore(score: number): number {
  return Math.min(CREDIT_CAP, Math.max(0, Math.round(score * CREDIT_RATE)));
}
