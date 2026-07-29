// Regression coverage for "穿戴装备时，equipped 部分默认折叠起来" (2026-07-29): after a successful
// equip, the Equipped section should fold itself back down so the backpack list the player was just
// browsing doesn't visually jump/shrink underneath it. Unequip (and a failed equip) must NOT touch
// the collapse state — only a successful equip does.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks, type EquipResult } from '../../src/scenes/EquipmentScene';
import type { SectionKey } from '../../src/scenes/EquipmentScene/base';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData, EquipSlot } from '../../src/game/meta/SaveData';

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

interface SceneInternals {
  collapsedSections: Set<SectionKey>;
  doEquip(slot: EquipSlot, instanceId: string | null, cardId: string): Promise<void>;
}

function buildSave(): SaveData {
  const save = makeNewSave('acc_test');
  save.wallet.coins = 100000;
  save.cardInv = { card1: { id: 'card1', defId: 'lichuang', level: 1, locked: false, gear: {} } };
  save.equipmentInv = {
    inst_wp: { id: 'inst_wp', defId: 'wp_pencil', rarity: 'rare', level: 0, affixes: [] },
  };
  return save;
}

function buildScene(equip: (slot: EquipSlot, inst: string | null, cardId: string) => Promise<EquipResult>): EquipmentScene {
  const save = buildSave();
  const cb: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: 1 }),
    salvage: async () => ({ ok: true }),
    equip,
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: 'card1',
  };
  return new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
}

describe('EquipmentScene — Equipped section auto-collapses after a successful equip', () => {
  it('collapses "equipped" once doEquip resolves ok with a non-null instanceId', async () => {
    const scene = buildScene(async () => ({ ok: true }));
    const internals = scene as unknown as SceneInternals;
    expect(internals.collapsedSections.has('equipped')).toBe(false);

    await internals.doEquip('weapon', 'inst_wp', 'card1');

    expect(internals.collapsedSections.has('equipped')).toBe(true);
    scene.destroy();
  });

  it('does NOT collapse on unequip (instanceId = null)', async () => {
    const scene = buildScene(async () => ({ ok: true }));
    const internals = scene as unknown as SceneInternals;

    await internals.doEquip('weapon', null, 'card1');

    expect(internals.collapsedSections.has('equipped')).toBe(false);
    scene.destroy();
  });

  it('does NOT collapse when the server rejects the equip', async () => {
    const scene = buildScene(async () => ({ ok: false, key: 'equip.err.generic' }));
    const internals = scene as unknown as SceneInternals;

    await internals.doEquip('weapon', 'inst_wp', 'card1');

    expect(internals.collapsedSections.has('equipped')).toBe(false);
    scene.destroy();
  });
});
