// Regression coverage for the "[Equipped · Weapon]" tag overflow fix (2026-07-17): the tag text
// in the right column of an equipped inventory cell (renderInstanceCell) had no width constraint,
// so at the default EQUIP_CELL_W_TARGET (360) it could render wider than the cell's own right edge
// and visually bleed into the next column's rarity/tag text. Fixed by scaling the tag down to fit
// `colW`, mirroring the existing scale-to-fit already applied to the name label above it.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { EQUIP_CELL_H } from '../../src/scenes/EquipmentScene/base';
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

interface Rect { x: number; y: number; w: number; h: number; }

/** Every top-level cell panel Graphics — same identification trick as equipmentGridLayout.ui.ts:
 *  the `sketchPanel(cellW, EQUIP_CELL_H, …)` fill rect is the only Graphics whose local shape
 *  height matches EQUIP_CELL_H (the inner glyph frame / action button are smaller). */
function findCellPanels(root: PIXI.Container): Rect[] {
  const out: Rect[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Graphics && node.geometry?.graphicsData?.length) {
      const shape = node.geometry.graphicsData[0].shape as { width: number; height: number };
      if (shape.height === EQUIP_CELL_H) out.push({ x: node.x, y: node.y, w: shape.width, h: shape.height });
    }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(root);
  return out;
}

/** Every PIXI.Text node whose text matches "[Equipped · <slot>]", with its rendered (post-scale)
 *  bounding box — `node.width`/`node.height` already reflect the current `scale`. */
function findEquippedTags(root: PIXI.Container): Array<{ x: number; y: number; width: number }> {
  const out: Array<{ x: number; y: number; width: number }> = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && /^\[Equipped · /.test(node.text)) {
      out.push({ x: node.x, y: node.y, width: node.width });
    }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(root);
  return out;
}

function buildSave(): SaveData {
  const save = makeNewSave('acc_test');
  save.wallet.coins = 100000;
  save.materials = { scrap: 4, lead: 53, binding: 1 };
  save.cardInv = {
    card1: {
      id: 'card1', defId: 'lichuang', level: 1, locked: false,
      gear: { weapon: 'eqWeapon', armor: 'eqArmor', trinket: 'eqTrinket' },
    },
  };
  save.equipmentInv = {
    eqWeapon: { id: 'eqWeapon', defId: 'wp_marker', rarity: 'rare', level: 0, affixes: [] },
    eqArmor: { id: 'eqArmor', defId: 'ar_foil', rarity: 'epic', level: 0, affixes: [] },
    eqTrinket: { id: 'eqTrinket', defId: 'tk_sticker', rarity: 'rare', level: 0, affixes: [] },
  };
  return save;
}

function buildScene(w: number, h: number): EquipmentScene {
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
  return new EquipmentScene(createLayout(w, h), new InputManager(), cb);
}

describe('EquipmentScene — equipped-tag text stays within its cell', () => {
  for (const [label, [w, h]] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const) {
    it(`"[Equipped · <slot>]" never extends past its cell's right edge — ${label}`, () => {
      const scene = buildScene(w, h);
      const cells = findCellPanels(scene.container);
      const tags = findEquippedTags(scene.container);
      expect(cells.length).toBeGreaterThanOrEqual(3); // weapon + armor + trinket cells
      expect(tags.length).toBe(3);

      for (const tag of tags) {
        const cell = cells.find((c) => tag.y >= c.y && tag.y <= c.y + c.h && tag.x >= c.x && tag.x <= c.x + c.w);
        expect(cell).toBeDefined();
        expect(tag.x + tag.width).toBeLessThanOrEqual(cell!.x + cell!.w);
      }
      scene.destroy();
    });
  }
});
