// Coverage for the reforge material picker being an icon-card GRID (mirroring the inventory/craft
// grids and AuctionScene's item picker) instead of the old text-row list, and for the new
// never-enhanced-only eligibility rule: only level===0 equipment can be consumed as reforge fuel
// (2026-07-22 — an already-enhanced item's sunk materials/affix rolls would otherwise be silently
// lost by picking it as fuel). Unenhanced instances sharing a defId collapse into one card (×N badge)
// since reforge only ever consumes a single instance from the pick.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData, EquipmentInstance } from '../../src/game/meta/SaveData';

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
  modalHits: { rect: Rect; action: () => void }[];
  openReforgeSelect(target: EquipmentInstance): void;
}

function buildSave(): SaveData {
  const save = makeNewSave('acc_test');
  save.equipmentInv = {
    // Target: epic weapon (requires a 'rare' weapon as fuel, REFORGE_MATERIAL_RARITY).
    target: { id: 'target', defId: 'wp_highlighter', rarity: 'epic', level: 2, affixes: [] },
    // Three never-enhanced rare weapons — should collapse into ONE icon card with ×3.
    fuel_a: { id: 'fuel_a', defId: 'wp_marker', rarity: 'rare', level: 0, affixes: [] },
    fuel_b: { id: 'fuel_b', defId: 'wp_marker', rarity: 'rare', level: 0, affixes: [] },
    fuel_c: { id: 'fuel_c', defId: 'wp_marker', rarity: 'rare', level: 0, affixes: [] },
    // Already-enhanced rare weapon — must be EXCLUDED (the whole point of the new rule).
    enhanced: { id: 'enhanced', defId: 'wp_marker', rarity: 'rare', level: 3, affixes: [] },
    // Unenhanced but equipped — must stay excluded (pre-existing rule).
    worn: { id: 'worn', defId: 'wp_marker', rarity: 'rare', level: 0, affixes: [] },
  };
  save.cardInv = { hero: { id: 'hero', defId: 'lichuang', level: 1, gear: { weapon: 'worn' }, locked: false } };
  return save;
}

function buildScene(cb: Partial<EquipmentCallbacks> = {}): { scene: EquipmentScene; save: SaveData } {
  const save = buildSave();
  const full: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance: async () => ({ ok: true, success: true, level: 1 }),
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: 'hero',
    ...cb,
  };
  return { scene: new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), full), save };
}

describe('EquipmentScene — reforge material picker is an icon-card grid, never-enhanced fuel only', () => {
  it('offers exactly one card (unenhanced fuel collapsed), excluding the enhanced and equipped instances', () => {
    const { scene, save } = buildScene();
    const internals = scene as unknown as SceneInternals;
    internals.openReforgeSelect(save.equipmentInv.target);

    // stack card(s) + close button + panel-catch + outside-catch, in that push order.
    const cardHits = internals.modalHits.slice(0, -3);
    expect(cardHits.length).toBe(1);
    // The card hit is sized like a portrait icon card (glyph + name stacked), not the old
    // full-width 44px-tall text row — height comfortably exceeds width, both well above 44px.
    expect(cardHits[0].rect.h).toBeGreaterThan(cardHits[0].rect.w);
    expect(cardHits[0].rect.w).toBeGreaterThan(44);

    scene.destroy();
  });

  it('tapping the card only ever offers a never-enhanced, unequipped instance as fuel', async () => {
    let reforgedWith: string | null = null;
    const { scene, save } = buildScene({
      reforge: async (_targetId, materialId) => { reforgedWith = materialId; return { ok: true }; },
    });
    const internals = scene as unknown as SceneInternals;
    internals.openReforgeSelect(save.equipmentInv.target);

    const cardHit = internals.modalHits[0];
    cardHit.action(); // opens the OK/Cancel confirm dialog
    const confirmOk = internals.modalHits[0];
    confirmOk.action(); // confirms → doReforge
    await Promise.resolve();
    await Promise.resolve();

    expect(['fuel_a', 'fuel_b', 'fuel_c']).toContain(reforgedWith);
    scene.destroy();
  });

  it('excludes candidates entirely when only enhanced/equipped rare weapons exist (no never-enhanced fuel)', () => {
    const save = makeNewSave('acc_test2');
    save.equipmentInv = {
      target: { id: 'target', defId: 'wp_highlighter', rarity: 'epic', level: 0, affixes: [] },
      enhanced: { id: 'enhanced', defId: 'wp_marker', rarity: 'rare', level: 1, affixes: [] },
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
    const scene = new EquipmentScene(createLayout(...LANDSCAPE), new InputManager(), cb);
    const internals = scene as unknown as SceneInternals;
    internals.openReforgeSelect(save.equipmentInv.target);

    const cardHits = internals.modalHits.slice(0, -3);
    expect(cardHits.length).toBe(0);
    scene.destroy();
  });
});
