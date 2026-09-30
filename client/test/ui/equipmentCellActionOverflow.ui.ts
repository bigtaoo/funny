// Regression coverage for the 2026-09-29 inventory-cell button fix: a cell's action labels are never
// scaled below the legibility floor any more. Actions whose label does not fit go behind a "more"
// button, and the detail modal it opens offers them (cells.ts / cellActionSplit.ts / detail.ts).
//
// The headless adapter measures every character at 7px whatever the size, so the real German labels
// fit here (they only fail at the real font's 11px, which test/equipmentCellActionSplit.test.ts
// covers). `equip.reforge` is therefore mocked to a label too wide for any portrait button.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';

const HUGE_REFORGE = 'Umschmieden-Umschmieden';
vi.mock('../../src/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/i18n')>();
  return {
    ...actual,
    t: (key: string, params?: Record<string, string | number>) =>
      key === 'equip.reforge' ? HUGE_REFORGE : actual.t(key as never, params),
  };
});

import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('de', memStore, ['zh', 'en', 'de']);

interface Rect { x: number; y: number; w: number; h: number; }
interface Hit { rect: Rect; fn: () => void; owner?: string }
interface SceneInternals {
  core: { hitRects: Hit[]; modalHits: Hit[]; modalOpen: boolean; detailId: string | null; bodyLayer: PIXI.Container; modalLayer: PIXI.Container };
  render(): void;
}

function buildSave(): SaveData {
  const save = makeNewSave('acc_test');
  save.wallet.coins = 100000;
  save.materials = { scrap: 100, lead: 100, binding: 100 };
  // Epic target + an unenhanced rare of the same slot as its fuel: Enhance / Equip / Reforge,
  // the row the 2026-09-28 German sweep flagged.
  save.equipmentInv = {
    target: { id: 'target', defId: 'wp_highlighter', rarity: 'epic', level: 2, affixes: [], locked: false },
    fuel: { id: 'fuel', defId: 'wp_marker', rarity: 'rare', level: 0, affixes: [], locked: false },
  };
  return save;
}

function buildScene(): EquipmentScene {
  const save = buildSave();
  const cb: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: 3 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: '',
  };
  return new EquipmentScene(createLayout(360, 640), new InputManager(), cb);
}

function texts(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (n: PIXI.Container): void => {
    if (n instanceof PIXI.Text) out.push(n);
    for (const c of n.children) walk(c as PIXI.Container);
  };
  walk(root);
  return out;
}

const inside = (r: Rect, x: number, y: number): boolean => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

describe('EquipmentScene — cell actions that do not fit go behind "more"', () => {
  it('draws every cell button label at full scale, inside its button', () => {
    const scene = buildScene();
    const internals = scene as unknown as SceneInternals;
    const buttonHits = internals.core.hitRects.filter((h) => Math.abs(h.rect.h - 46) < 0.5);
    const labels = [t('equip.enhance'), t('equip.equip'), HUGE_REFORGE, t('equip.moreActions')];
    const drawn = texts(internals.core.bodyLayer).filter((x) => labels.includes(x.text));
    expect(drawn.length).toBeGreaterThan(0);
    for (const l of drawn) expect(l.scale.x, `"${l.text}"`).toBe(1);
    // The too-wide label never makes it onto the cell; More does.
    expect(drawn.some((l) => l.text === HUGE_REFORGE)).toBe(false);
    const more = drawn.find((l) => l.text === t('equip.moreActions'));
    expect(more).toBeDefined();
    for (const l of drawn) {
      const p = l.getGlobalPosition();
      const hit = buttonHits.find((h) => inside(h.rect, p.x, p.y));
      expect(hit, `"${l.text}" sits on a button`).toBeDefined();
      expect(l.width).toBeLessThanOrEqual(hit!.rect.w);
    }
    scene.destroy();
  });

  it('More opens the detail modal, which offers the hidden action and fires it', () => {
    const scene = buildScene();
    const internals = scene as unknown as SceneInternals;
    const more = texts(internals.core.bodyLayer).find((l) => l.text === t('equip.moreActions'))!;
    const mp = more.getGlobalPosition();
    const moreHit = internals.core.hitRects.find((h) => h.owner === 'target' && Math.abs(h.rect.h - 46) < 0.5 && inside(h.rect, mp.x, mp.y))!;
    moreHit.fn();
    expect(internals.core.modalOpen).toBe(true);
    expect(internals.core.detailId).toBe('target');

    const reforgeLbl = texts(internals.core.modalLayer).find((l) => l.text === HUGE_REFORGE);
    expect(reforgeLbl, 'the modal lists the action the cell had no room for').toBeDefined();
    const p = reforgeLbl!.getGlobalPosition();
    // The first matching modal hit wins (first-match priority), exactly like a tap.
    const hit = internals.core.modalHits.find((h) => inside(h.rect, p.x, p.y));
    expect(hit).toBeDefined();
    hit!.fn();
    // Reforge opens its material picker over the item, which keeps the item's detailId.
    expect(texts(internals.core.modalLayer).some((l) => l.text.startsWith(t('equip.reforgeSelectTitle').slice(0, 6)))).toBe(true);
    expect(internals.core.detailId).toBe('target');
    scene.destroy();
  });
});
