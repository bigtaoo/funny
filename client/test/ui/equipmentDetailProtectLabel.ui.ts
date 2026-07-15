// Regression coverage for the protect-item label in the enhance detail modal (2026-07-15).
//
// `equip.protect` already embeds the `×{n}` placeholder in its i18n string, but detail.ts used to
// build the label as `${t('equip.protect')} ×${protectCount}` — appending a second `×count` after
// the untouched literal `{n}`, e.g. "Protection Stone ×{n} (keep materials on fail) ×3". Fixed to
// `t('equip.protect').replace('{n}', String(protectCount))`.
//
// This pins: the rendered label has the placeholder substituted exactly once, with no leftover
// `{n}` and no duplicated `×count` suffix.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import { PROTECT_ENHANCE_ITEM_ID } from '../../src/game/meta/equipmentDefs';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function findLabel(container: PIXI.Container, predicate: (text: string) => boolean): string | null {
  let found: string | null = null;
  const walk = (node: PIXI.Container): void => {
    if (found !== null) return;
    if (node instanceof PIXI.Text && predicate(node.text)) { found = node.text; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

function buildEquipmentSceneWithProtectStock(protectCount: number): EquipmentScene {
  const save = makeNewSave();
  save.inventory.items[PROTECT_ENHANCE_ITEM_ID] = protectCount;
  save.equipmentInv['inst_1'] = {
    id: 'inst_1',
    defId: 'ar_cardstock',
    rarity: 'fine',
    level: 0, // unmaxed, so the protect-item row renders
    affixes: [{ id: 'm_hp', value: 0.1 }],
  };
  const cb: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: 1 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: '',
  };
  return new EquipmentScene(createLayout(390, 844), new InputManager(), cb);
}

describe('EquipmentScene detail modal — protect-item label', () => {
  it('substitutes {n} exactly once, with no leftover placeholder or duplicated ×count', () => {
    const scene = buildEquipmentSceneWithProtectStock(3);
    scene.openDetail('inst_1');

    const expected = t('equip.protect').replace('{n}', '3');
    const label = findLabel(scene.container, (text) => text.startsWith('Protection Stone'));

    expect(label).toBe(expected);
    expect(label).not.toContain('{n}');
    expect(label?.match(/×/g)?.length ?? 0).toBe(1);

    scene.destroy();
  });

  it('reflects a zero protect-item count the same way', () => {
    const scene = buildEquipmentSceneWithProtectStock(0);
    scene.openDetail('inst_1');

    const expected = t('equip.protect').replace('{n}', '0');
    const label = findLabel(scene.container, (text) => text.startsWith('Protection Stone'));

    expect(label).toBe(expected);
    expect(label).not.toContain('{n}');

    scene.destroy();
  });
});
