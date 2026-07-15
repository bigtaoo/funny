// Regression coverage for two EquipmentScene alignment fixes (2026-07-15, see
// design/game/EQUIPMENT_DESIGN.md "标题居中 + loadout 三槽条移过红边线"):
//
// 1. The header title used `titleAlign: 'left'` to dodge a right-side currency cluster that no
//    longer exists in that form (materials moved out to their own band long ago) — switched back
//    to the default centered title, matching every other scene's header.
// 2. `renderLoadout` (the "Equipped" Weapon/Armor/Trinket preview strip) ignored the sidebar rail
//    entirely and spanned the full design width from x=8, crossing over the left nav rail / red
//    margin rule that every other row in this scene (materials band, slot filter, item grid) is
//    already confined to the right of. Fixed by threading `sidebarNavW(...)` through as a `left`
//    offset.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { sidebarNavW } from '../../src/ui/widgets/HubTabs';
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
initI18n('en', memStore, ['zh', 'en', 'de']);

const PORTRAIT: [number, number] = [800, 1280];
const LANDSCAPE: [number, number] = [1280, 800];

/** Every PIXI.Text node whose text matches `label`, with its render position (tab/loadout
 *  labels are all center-anchored — see sidebarRailOrientation.ui.ts). */
function findLabelPositions(container: PIXI.Container, label: string): Array<{ x: number; y: number; anchorX: number }> {
  const out: Array<{ x: number; y: number; anchorX: number }> = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text && node.text === label) {
      out.push({ x: node.x, y: node.y, anchorX: node.anchor?.x ?? 0 });
    }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

function buildSave(): SaveData {
  const save = makeNewSave('acc_test');
  save.wallet.coins = 100000;
  save.materials = { scrap: 4, lead: 53, binding: 1 };
  save.cardInv = {
    card1: { id: 'card1', defId: 'lichuang', level: 1, xp: 0, gear: { trinket: 'eqTrinket' }, locked: false },
  };
  save.equipmentInv = {
    eqTrinket: { id: 'eqTrinket', defId: 'sticker', rarity: 'rare', level: 0, affixes: [] },
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

describe('EquipmentScene — header title centered', () => {
  for (const [label, [w, h]] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const) {
    it(`renders "${t('equip.title')}" centered on the design width — ${label}`, () => {
      const scene = buildScene(w, h);
      const layout = createLayout(w, h);
      const positions = findLabelPositions(scene.container, t('equip.title'));
      expect(positions.length).toBe(1);
      expect(positions[0].anchorX).toBe(0.5);
      expect(positions[0].x).toBe(layout.designWidth / 2);
      scene.destroy();
    });
  }
});

describe('EquipmentScene — loadout strip confined to the right of the sidebar rail', () => {
  for (const [label, [w, h]] of [['portrait', PORTRAIT], ['landscape', LANDSCAPE]] as const) {
    it(`Weapon/Armor/Trinket loadout cells start at/after sidebarNavW — ${label}`, () => {
      const scene = buildScene(w, h);
      const layout = createLayout(w, h);
      const landscape = layout.orientation === 'landscape';
      const railW = sidebarNavW(layout.designWidth, layout.designHeight, landscape);

      for (const slotLabel of [t('equip.slot.weapon'), t('equip.slot.armor'), t('equip.slot.trinket')]) {
        const positions = findLabelPositions(scene.container, slotLabel);
        // Each slot label appears twice: once in the top slot-filter bar, once in the loadout strip.
        expect(positions.length).toBeGreaterThanOrEqual(1);
        for (const pos of positions) {
          expect(pos.x).toBeGreaterThanOrEqual(railW);
        }
      }
      scene.destroy();
    });

    it(`the "${t('equip.loadout')}" caption sits right of the sidebar rail, not at the old fixed x=10 — ${label}`, () => {
      const scene = buildScene(w, h);
      const layout = createLayout(w, h);
      const landscape = layout.orientation === 'landscape';
      const railW = sidebarNavW(layout.designWidth, layout.designHeight, landscape);

      // 'equip.loadout' and 'equip.equipped' (the section-divider label, aligned to the narrower
      // marginLineX gutter — a separate, pre-existing convention untouched by this fix) both
      // localize to "Equipped" in en — the loadout caption is the topmost occurrence.
      const positions = findLabelPositions(scene.container, t('equip.loadout'));
      expect(positions.length).toBeGreaterThanOrEqual(1);
      const loadoutCaption = positions.reduce((a, b) => (a.y < b.y ? a : b));
      expect(loadoutCaption.x).toBeGreaterThanOrEqual(railW);
      scene.destroy();
    });
  }
});
