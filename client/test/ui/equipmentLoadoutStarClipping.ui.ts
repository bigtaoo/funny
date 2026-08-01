// Regression coverage for a 2026-08-01 EquipmentScene fix: the enhance-level star row on an
// equipped item in the loadout strip (Weapon/Armor/Trinket preview, renderLoadout) was positioned
// as a fraction of the slot cell's height (`cy + cellH * 0.86`) without accounting for the star
// icons' own ~10px height — with LOADOUT_H's original cellH (50), the star row's bottom edge sat
// a few px past the slot cell's bottom border, reading as the stars overlapping/clipping into the
// border line beneath them. Fixed by bottom-anchoring the star row (`cy + cellH - starSize - 4`,
// always leaving a fixed clearance regardless of cellH) and bumping LOADOUT_H (78 -> 90) so
// icon/name/stars have room to stack without crowding.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { MAT_BAND_H, FILTER_H, TAB_LOADOUT_GAP, LOADOUT_H } from '../../src/scenes/EquipmentScene/base';
import { hubTabsHeight } from '../../src/ui/widgets/HubTabs';
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

const PORTRAIT: [number, number] = [800, 1280];
const LANDSCAPE: [number, number] = [1280, 800];
const EQUIP_LEVEL = 8; // > 0 (stars shown), < EQUIP_MAX_LEVEL (9) so it isn't the maxed flip-animation branch

interface SceneInternals { headerH: number; h: number; landscape: boolean; }

/** The loadout's enhance-star row: a plain Container (not Graphics/Sprite/Text) with exactly
 *  `count` children, positioned above the grid's own "Equipped" section item cell (which renders
 *  the same equipped instance a second time, further down, via a bigger star size) — restrict to
 *  `y < belowLoadout` so the two don't get confused. */
function findLoadoutStarRow(root: PIXI.Container, count: number, belowLoadout: number): PIXI.Container | undefined {
  let found: PIXI.Container | undefined;
  const walk = (node: PIXI.Container): void => {
    if (
      node.constructor === PIXI.Container &&
      node.children.length === count &&
      node.children.every((c) => !(c instanceof PIXI.Text)) &&
      node.y > 0 && node.y < belowLoadout
    ) {
      found = node;
    }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(root);
  return found;
}

function buildSave(): SaveData {
  const save = makeNewSave('acc_test');
  save.wallet.coins = 100000;
  save.materials = { scrap: 4, lead: 53, binding: 1 };
  save.cardInv = {
    card1: { id: 'card1', defId: 'lichuang', level: 1, gear: { weapon: 'eqWeapon' }, locked: false },
  };
  save.equipmentInv = {
    eqWeapon: { id: 'eqWeapon', defId: 'wp_highlighter', rarity: 'epic', level: EQUIP_LEVEL, affixes: [] },
  };
  return save;
}

function buildScene(size: [number, number]): EquipmentScene {
  const save = buildSave();
  const cb: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: 1 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: 'card1',
  };
  return new EquipmentScene(createLayout(...size), new InputManager(), cb);
}

describe.each([
  ['landscape', LANDSCAPE],
  ['portrait', PORTRAIT],
] as const)('EquipmentScene loadout — enhance stars stay clear of the slot cell border (%s)', (_label, size) => {
  it('the star row bottom edge sits inside the slot cell, not past its bottom border', () => {
    const scene = buildScene(size as [number, number]);
    const internals = scene as unknown as SceneInternals;
    // Portrait's header row also draws the Inventory/Craft sub-tabs strip (hubTabsHeight) above the
    // materials band — landscape has no such strip (see renderHeaderRow).
    const subTabsH = internals.landscape ? 0 : hubTabsHeight(internals.h);
    const bodyTop = internals.headerH + subTabsH + MAT_BAND_H + FILTER_H + TAB_LOADOUT_GAP;
    const cy = bodyTop + 22; // renderLoadout: const cy = y + 22
    const cellH = LOADOUT_H - 28;
    const listY = bodyTop + LOADOUT_H; // grid section starts here — anything above is the loadout strip

    const starRow = findLoadoutStarRow(scene.container, EQUIP_LEVEL, listY);
    expect(starRow).toBeDefined();
    expect(starRow!.y).toBeGreaterThanOrEqual(cy);
    // The regression: bottom edge used to overrun cy + cellH by a few px (fraction-of-height y
    // ignored the row's own height). Now bottom-anchored with a fixed clearance.
    expect(starRow!.y + starRow!.height).toBeLessThanOrEqual(cy + cellH);
    scene.destroy();
  });
});
