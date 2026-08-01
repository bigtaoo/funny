// Regression coverage for two 2026-08-01 spacing fixes on the Inventory tab, reported as: stars on
// a maxed equipped weapon in the loadout strip read as if they belonged to the filter-tab row above
// it, and the "Equipped" section header sat too far below the loadout strip.
//
//  1. The slot filter bar ("All/Weapon/Armor/Trinket") and the loadout strip below it used to butt
//     up against each other with zero vertical gap (renderHeaderRow's returned y fed straight into
//     renderLoadout) — now separated by TAB_LOADOUT_GAP.
//  2. The first section header ("Equipped"/"Backpack") used the inter-row CELL_GAP (36) as its top
//     padding, which — stacked under LOADOUT_H's own bottom breathing room — read as an oversized
//     gap. Now uses the smaller, dedicated LIST_TOP_PAD (12).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { MAT_BAND_H, FILTER_H, TAB_LOADOUT_GAP, LOADOUT_H, LIST_TOP_PAD, SECTION_H } from '../../src/scenes/EquipmentScene/base';
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
initI18n('en', memStore, ['zh', 'en', 'de']);

const LANDSCAPE: [number, number] = [1280, 800];

interface Rect { x: number; y: number; w: number; h: number; }
interface SceneInternals {
  headerH: number;
  w: number;
  hitRects: { rect: Rect; action: () => void }[];
}

/** Every PIXI.Text node whose text matches `label`, with its render position. */
function findLabelPositions(container: PIXI.Container, label: string): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && node.text === label) out.push({ x: node.x, y: node.y });
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

/** Section-header hit rects: full-width (x=0), height SECTION_H — see InventoryMixin.renderSectionHeader.
 *  Item cells, the loadout strip and the filter bar all use different heights/x-offsets. */
function findSectionHeaderYs(internals: SceneInternals): number[] {
  return internals.hitRects
    .filter((h) => h.rect.x === 0 && h.rect.w === internals.w && h.rect.h === SECTION_H)
    .map((h) => h.rect.y)
    .sort((a, b) => a - b);
}

function buildSave(): SaveData {
  const save = makeNewSave('acc_test');
  save.wallet.coins = 100000;
  save.materials = { scrap: 4, lead: 53, binding: 1 };
  save.cardInv = {
    card1: { id: 'card1', defId: 'lichuang', level: 1, gear: { weapon: 'eqWeapon' }, locked: false },
  };
  save.equipmentInv = {
    eqWeapon: { id: 'eqWeapon', defId: 'wp_highlighter', rarity: 'epic', level: 8, affixes: [] },
    bagItem: { id: 'bagItem', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] },
  };
  return save;
}

function buildScene(activeCardInstanceId: string): EquipmentScene {
  const save = buildSave();
  const cb: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: 1 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId,
  };
  return new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
}

describe('EquipmentScene — gap between the filter tabs and the loadout strip (TAB_LOADOUT_GAP)', () => {
  it('the loadout caption sits TAB_LOADOUT_GAP below the filter bar, not flush against it', () => {
    const scene = buildScene('card1');
    const internals = scene as unknown as SceneInternals;
    const expectedBodyTop = internals.headerH + MAT_BAND_H + FILTER_H + TAB_LOADOUT_GAP;

    // renderLoadout draws its "Equipped" caption at (left+10, bodyTop+4).
    const positions = findLabelPositions(scene.container, t('equip.loadout'));
    expect(positions.length).toBeGreaterThanOrEqual(1);
    const caption = positions.reduce((a, b) => (a.y < b.y ? a : b));
    expect(caption.y).toBe(expectedBodyTop + 4);

    // Sanity: the gap is a real, positive separation — not accidentally zero again.
    expect(TAB_LOADOUT_GAP).toBeGreaterThan(0);
    scene.destroy();
  });

  it('bag mode (no loadout strip) is unaffected — the filter bar still returns FILTER_H + TAB_LOADOUT_GAP as bodyTop', () => {
    const scene = buildScene('');
    const internals = scene as unknown as SceneInternals;
    const expectedBodyTop = internals.headerH + MAT_BAND_H + FILTER_H + TAB_LOADOUT_GAP;

    const headerYs = findSectionHeaderYs(internals);
    expect(headerYs.length).toBeGreaterThanOrEqual(1);
    // Bag mode has no loadout strip: listY === bodyTop directly (see renderInventory).
    expect(headerYs[0]).toBe(expectedBodyTop + LIST_TOP_PAD);
    scene.destroy();
  });
});

describe('EquipmentScene — top padding above the first section header (LIST_TOP_PAD)', () => {
  it('the "Equipped" header sits LIST_TOP_PAD (not CELL_GAP) below the loadout strip', () => {
    const scene = buildScene('card1');
    const internals = scene as unknown as SceneInternals;
    const bodyTop = internals.headerH + MAT_BAND_H + FILTER_H + TAB_LOADOUT_GAP;
    const listY = bodyTop + LOADOUT_H;

    const headerYs = findSectionHeaderYs(internals);
    // Equipped (eqWeapon) then Backpack (bagItem) — two headers, Equipped first.
    expect(headerYs.length).toBe(2);
    expect(headerYs[0]).toBe(listY + LIST_TOP_PAD);
    scene.destroy();
  });
});
