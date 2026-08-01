// Regression coverage for two related 2026-07-29 UX fixes on successful equip, plus the 2026-08-01
// follow-up that starts the Equipped section collapsed from scene open (not just after an equip):
//  1. "穿戴装备时，equipped 部分默认折叠起来" — the Equipped section folds itself back down so the
//     backpack list the player was just browsing doesn't visually jump/shrink underneath it.
//  2. "装备完之后，这个界面能自动关闭，回到角色卡界面" — a successful *equip* (not unequip) leaves the
//     Equipment scene entirely via cb.onBack(), returning to wherever it was opened from (Hero Roster).
// Unequip and a failed equip must do neither — the player stays on this screen. Since the section
// now starts collapsed by default (2026-08-01), "left open" only matters when it was explicitly
// expanded first — see the "stays expanded" test below.
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

function buildScene(
  equip: (slot: EquipSlot, inst: string | null, cardId: string) => Promise<EquipResult>,
  onBack: () => void = () => {},
): EquipmentScene {
  const save = buildSave();
  const cb: EquipmentCallbacks = {
    onBack,
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

describe('EquipmentScene — Equipped section starts collapsed, and stays collapsed after a successful equip', () => {
  it('starts with "equipped" already collapsed on scene construction (2026-08-01)', () => {
    const scene = buildScene(async () => ({ ok: true }));
    const internals = scene as unknown as SceneInternals;
    expect(internals.collapsedSections.has('equipped')).toBe(true);
    scene.destroy();
  });

  it('stays collapsed once doEquip resolves ok with a non-null instanceId', async () => {
    const scene = buildScene(async () => ({ ok: true }));
    const internals = scene as unknown as SceneInternals;

    await internals.doEquip('weapon', 'inst_wp', 'card1');

    expect(internals.collapsedSections.has('equipped')).toBe(true);
    scene.destroy();
  });

  it('does NOT re-collapse an explicitly-expanded section on unequip (instanceId = null)', async () => {
    const scene = buildScene(async () => ({ ok: true }));
    const internals = scene as unknown as SceneInternals;
    internals.collapsedSections.delete('equipped'); // player tapped the header open

    await internals.doEquip('weapon', null, 'card1');

    expect(internals.collapsedSections.has('equipped')).toBe(false);
    scene.destroy();
  });

  it('does NOT re-collapse an explicitly-expanded section when the server rejects the equip', async () => {
    const scene = buildScene(async () => ({ ok: false, key: 'equip.err.generic' }));
    const internals = scene as unknown as SceneInternals;
    internals.collapsedSections.delete('equipped'); // player tapped the header open

    await internals.doEquip('weapon', 'inst_wp', 'card1');

    expect(internals.collapsedSections.has('equipped')).toBe(false);
    scene.destroy();
  });
});

describe('EquipmentScene — leaves the scene (cb.onBack) after a successful equip', () => {
  it('calls cb.onBack() once doEquip resolves ok with a non-null instanceId', async () => {
    let backCalls = 0;
    const scene = buildScene(async () => ({ ok: true }), () => { backCalls++; });
    const internals = scene as unknown as SceneInternals;

    await internals.doEquip('weapon', 'inst_wp', 'card1');

    expect(backCalls).toBe(1);
    scene.destroy();
  });

  it('does NOT call cb.onBack() on unequip (instanceId = null)', async () => {
    let backCalls = 0;
    const scene = buildScene(async () => ({ ok: true }), () => { backCalls++; });
    const internals = scene as unknown as SceneInternals;

    await internals.doEquip('weapon', null, 'card1');

    expect(backCalls).toBe(0);
    scene.destroy();
  });

  it('does NOT call cb.onBack() when the server rejects the equip', async () => {
    let backCalls = 0;
    const scene = buildScene(async () => ({ ok: false, key: 'equip.err.generic' }), () => { backCalls++; });
    const internals = scene as unknown as SceneInternals;

    await internals.doEquip('weapon', 'inst_wp', 'card1');

    expect(backCalls).toBe(0);
    scene.destroy();
  });
});
