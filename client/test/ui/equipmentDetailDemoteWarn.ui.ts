// Regression coverage for the +7/+8 demote-risk warning line in the enhance detail modal (ADR-063,
// 2026-08-10). enhanceDemoteChance(fromLevel) is 0 for +0~+6 (mild tier, no demote) and non-zero for
// +7/+8 (risk tier) — the modal must only show the red warning line in the latter case, with the
// percentage substituted correctly, and must not grow the modal (extra 18px row) when there's nothing
// to warn about.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { EquipmentInstance } from '../../src/game/meta/SaveData';

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

function buildEquipmentSceneWithInstance(inst: EquipmentInstance): EquipmentScene {
  const save = makeNewSave();
  save.equipmentInv[inst.id] = inst;
  const cb: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: inst.level + 1 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: '',
  };
  return new EquipmentScene(createLayout(390, 844), new InputManager(), cb);
}

describe('EquipmentScene detail modal — demote-risk warning (ADR-063)', () => {
  it('shows the demote warning at +7 with the correct percentage', () => {
    const scene = buildEquipmentSceneWithInstance({
      id: 'i7', defId: 'ar_cardstock', rarity: 'fine', level: 7, affixes: [{ id: 'm_hp', value: 10 }],
    });
    (scene as unknown as { detail: { openDetail(id: string): void } }).detail.openDetail('i7');

    const expected = t('equip.enhanceDemoteWarn').replace('{pct}', '20');
    const label = findLabel(scene.container, (text) => text.includes('drop 1 level'));
    expect(label).toBe(expected);

    scene.destroy();
  });

  it('shows 25% at +8', () => {
    const scene = buildEquipmentSceneWithInstance({
      id: 'i8', defId: 'ar_cardstock', rarity: 'fine', level: 8, affixes: [{ id: 'm_hp', value: 10 }],
    });
    (scene as unknown as { detail: { openDetail(id: string): void } }).detail.openDetail('i8');

    const expected = t('equip.enhanceDemoteWarn').replace('{pct}', '25');
    const label = findLabel(scene.container, (text) => text.includes('drop 1 level'));
    expect(label).toBe(expected);

    scene.destroy();
  });

  it('does not show the warning at +6 or below (mild tier, no demote risk)', () => {
    const scene = buildEquipmentSceneWithInstance({
      id: 'i6', defId: 'ar_cardstock', rarity: 'fine', level: 6, affixes: [{ id: 'm_hp', value: 10 }],
    });
    (scene as unknown as { detail: { openDetail(id: string): void } }).detail.openDetail('i6');

    const label = findLabel(scene.container, (text) => text.includes('drop 1 level'));
    expect(label).toBeNull();

    scene.destroy();
  });
});
