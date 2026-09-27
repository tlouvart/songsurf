import {
  COLOR_SLOTS, ITEM_SLOTS, isOwned, missingItems, randomLoadout, rarity, type ColorSlot, type ItemSlot, type Loadout,
} from '../ship/catalog.ts';
import { drawShipThumb, ShipViewer } from '../ship/viewer.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

export interface HangarDeps {
  loadout(): Loadout;
  owned(): string[];
  credits(): number | null;
  save(l: Loadout): Promise<void>;
  buy(slot: ItemSlot, id: string): Promise<void>;
}

type Tab = ItemSlot | 'colors';

/** The hangar: try parts on, buy them with credits, paint every zone. */
export class Hangar {
  private viewer: ShipViewer | null = null;
  private draft: Loadout;
  private tab: Tab = 'hull';
  private thumbJob = 0;
  private error = '';

  constructor(private d: HangarDeps) {
    this.draft = { ...d.loadout() };
    $('hangar-cancel').addEventListener('click', () => this.close());
    $('hangar-random').addEventListener('click', () => this.apply(randomLoadout(this.d.owned())));
    $('hangar-save').addEventListener('click', async () => {
      const btn = $<HTMLButtonElement>('hangar-save');
      btn.disabled = true;
      try {
        await this.d.save({ ...this.draft });
        this.close();
      } catch (e) {
        this.error = (e as Error).message;
        this.renderBar();
      } finally {
        this.renderBar();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('hangar').classList.contains('hidden')) this.close();
    });
  }

  open() {
    this.draft = { ...this.d.loadout() };
    this.error = '';
    $('hangar').classList.remove('hidden');
    this.viewer = new ShipViewer($<HTMLCanvasElement>('hangar-canvas'));
    this.viewer.setLoadout(this.draft);
    this.viewer.start();
    this.render();
  }

  close() {
    this.thumbJob++;
    this.viewer?.dispose();
    this.viewer = null;
    $('hangar').classList.add('hidden');
  }

  private apply(l: Loadout) {
    this.draft = l;
    this.error = '';
    this.viewer?.setLoadout(l);
    this.render();
  }

  private render() {
    this.renderTabs();
    this.renderPanel();
    this.renderBar();
  }

  private renderTabs() {
    const el = $('hangar-cats');
    const owned = this.d.owned();
    const tabs = [
      ...ITEM_SLOTS.map((s) => {
        const locked = !isOwned(owned, s.key, this.draft[s.key]);
        return `<button class="${this.tab === s.key ? 'active' : ''}" data-tab="${s.key}">${s.label}${locked ? '<span class="lock">◈</span>' : ''}</button>`;
      }),
      `<button class="${this.tab === 'colors' ? 'active' : ''}" data-tab="colors">Colors<span class="swatch-mini" style="background:${this.draft.body}"></span></button>`,
    ];
    el.innerHTML = tabs.join('');
    el.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
      b.addEventListener('click', () => {
        this.tab = b.dataset.tab as Tab;
        this.render();
      }),
    );
    const name = (slot: ItemSlot) => ITEM_SLOTS.find((s) => s.key === slot)!.items.find((i) => i.id === this.draft[slot])?.name ?? '';
    $('hangar-name').textContent = [name('hull'), name('wings'), name('engines')].join(' · ');
    const credits = this.d.credits();
    $('hangar-credits').textContent = credits === null ? '' : `◈ ${fmt(credits)}`;
  }

  private renderPanel() {
    const el = $('hangar-options');
    this.thumbJob++;
    if (this.tab === 'colors') {
      el.className = 'hangar-options colors-panel';
      el.innerHTML = COLOR_SLOTS.map((c) => `
        <div class="color-zone">
          <div class="zone-head"><span>${c.label}</span><label class="picker" style="background:${this.draft[c.key]}"><input type="color" data-color="${c.key}" value="${this.draft[c.key]}" /></label></div>
          <div class="zone-swatches">${c.swatches.map((hex) => `<div class="swatch ${hex === this.draft[c.key] ? 'on' : ''}" data-zone="${c.key}" data-hex="${hex}" style="background:${hex};color:${hex}"></div>`).join('')}</div>
        </div>`).join('') + `
        <div class="color-zone">
          <div class="zone-head"><span>Texture scale</span><b>${this.draft.scale.toFixed(2)}×</b></div>
          <input type="range" id="tex-scale" min="0.5" max="2" step="0.05" value="${this.draft.scale}" />
        </div>`;
      el.querySelectorAll<HTMLElement>('[data-zone]').forEach((s) =>
        s.addEventListener('click', () => this.setColor(s.dataset.zone as ColorSlot, s.dataset.hex!)),
      );
      el.querySelectorAll<HTMLInputElement>('[data-color]').forEach((input) =>
        input.addEventListener('input', () => this.setColor(input.dataset.color as ColorSlot, input.value)),
      );
      const range = el.querySelector<HTMLInputElement>('#tex-scale')!;
      range.addEventListener('input', () => {
        this.draft = { ...this.draft, scale: Number(range.value) };
        (range.previousElementSibling!.querySelector('b') as HTMLElement).textContent = `${this.draft.scale.toFixed(2)}×`;
        this.viewer?.setLoadout(this.draft);
      });
      return;
    }

    const slot = ITEM_SLOTS.find((s) => s.key === this.tab)!;
    const owned = this.d.owned();
    el.className = 'hangar-options';
    el.innerHTML = slot.items
      .map((item) => {
        const have = isOwned(owned, slot.key, item.id);
        const on = this.draft[slot.key] === item.id;
        const tag = have ? (on ? '<span class="tag on">✓</span>' : '') : `<span class="tag price">◈ ${fmt(item.price)}</span>`;
        return `<button class="opt ${rarity(item.price)} ${on ? 'on' : ''} ${have ? '' : 'locked'}" data-v="${item.id}"><canvas class="thumb" width="192" height="120"></canvas>${tag}<span class="opt-name">${item.name}</span></button>`;
      })
      .join('');
    el.querySelectorAll<HTMLElement>('[data-v]').forEach((b) => b.addEventListener('click', () => this.select(slot.key, b.dataset.v!)));
    this.fillThumbs(slot.key);
  }

  /** Pick an item in the current tab: only the marks, tabs and buy bar change. */
  private select(slot: ItemSlot, id: string) {
    this.draft = { ...this.draft, [slot]: id };
    this.error = '';
    this.viewer?.setLoadout(this.draft);
    const owned = this.d.owned();
    $('hangar-options').querySelectorAll<HTMLElement>('[data-v]').forEach((b) => {
      const on = b.dataset.v === id;
      b.classList.toggle('on', on);
      const tag = b.querySelector('.tag.on');
      if (tag && !on) tag.remove();
      if (on && !tag && isOwned(owned, slot, id)) b.insertAdjacentHTML('beforeend', '<span class="tag on">✓</span>');
    });
    this.renderTabs();
    this.renderBar();
  }

  /** Change one colour zone: the ship is repainted in place, only the marks update. */
  private setColor(zone: ColorSlot, hex: string) {
    this.draft = { ...this.draft, [zone]: hex };
    this.viewer?.setLoadout(this.draft);
    const panel = $('hangar-options');
    panel.querySelectorAll<HTMLElement>(`[data-zone="${zone}"]`).forEach((s) => s.classList.toggle('on', s.dataset.hex === hex));
    const picker = panel.querySelector<HTMLInputElement>(`[data-color="${zone}"]`);
    if (picker) {
      if (picker.value !== hex) picker.value = hex;
      (picker.parentElement as HTMLElement).style.background = hex;
    }
    if (zone === 'body') this.renderTabs();
  }

  /** Bottom bar: what's still to buy in this draft, and the save state. */
  private renderBar() {
    const bar = $('hangar-bar');
    const missing = missingItems(this.draft, this.d.owned());
    const credits = this.d.credits();
    const save = $<HTMLButtonElement>('hangar-save');
    save.disabled = missing.length > 0;
    if (!missing.length) {
      bar.innerHTML = this.error ? `<span class="bar-error">${this.error}</span>` : '';
      bar.classList.toggle('hidden', !this.error);
      return;
    }
    bar.classList.remove('hidden');
    bar.innerHTML = missing
      .map(({ slot, item }) => {
        const afford = credits !== null && credits >= item.price;
        return `<div class="buy ${rarity(item.price)}"><span>${item.name}</span><button class="btn primary small" data-buy="${slot}:${item.id}" ${afford ? '' : 'disabled'}>◈ ${fmt(item.price)}</button></div>`;
      })
      .join('') + (this.error ? `<span class="bar-error">${this.error}</span>` : '') + (credits === null ? '<span class="bar-error">Sign in to buy</span>' : '');
    bar.querySelectorAll<HTMLButtonElement>('[data-buy]').forEach((b) =>
      b.addEventListener('click', async () => {
        const [slot, id] = b.dataset.buy!.split(':') as [ItemSlot, string];
        b.disabled = true;
        try {
          await this.d.buy(slot, id);
          this.error = '';
        } catch (e) {
          this.error = (e as Error).message;
        }
        this.render();
      }),
    );
  }

  /** Each option previews your ship with that part swapped in, one tile per frame. */
  private fillThumbs(slot: ItemSlot) {
    const job = ++this.thumbJob;
    const tiles = [...$('hangar-options').querySelectorAll<HTMLElement>('[data-v]')];
    const base = { ...this.draft };
    let i = 0;
    const step = () => {
      if (job !== this.thumbJob || i >= tiles.length) return;
      const tile = tiles[i++];
      drawShipThumb({ ...base, [slot]: tile.dataset.v! }, tile.querySelector('canvas')!);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

