// Regression coverage for the card detail modal's gear-slot level display (2026-08-30 roster
// feedback): the weapon/armor/trinket cells used to show enhancement level as a "+N" text badge
// in the corner; now a row of gold stars (renderDetailGearSlots, detail.ts), matching the star-row
// convention used everywhere else a level is shown (see cardSceneLevelStars.ui.ts). Pins:
//   1. an equipped, enhanced item (level > 0) gets a `gearLevelStars:<slot>` star row with exactly
//      `level` stars, and the old "+N" text is gone.
//   2. an equipped item at level 0 (freshly equipped, unenhanced) gets no star row at all — matches
//      the `if (inst.level > 0)` convention at every other buildLevelStars call site.
//   3. the star row sits entirely above the slot icon (icon shifted down to make room for it, not
//      drawn on top of it).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { CardInstance, EquipmentInstance, EquipSlot, SaveData } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function makeCard(id: string, defId: string, level: number, gear: Partial<Record<EquipSlot, string>>): CardInstance {
  return { id, defId, level, gear, locked: false };
}

function makeEquip(id: string, defId: string, level: number): EquipmentInstance {
  return { id, defId, rarity: 'rare', level, affixes: [] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function priv(scene: CardScene): any {
  return scene as unknown as Record<string, unknown>;
}

function modalLayerOf(scene: CardScene): PIXI.Container {
  return (scene as unknown as { core: { modalLayer: PIXI.Container } }).core.modalLayer;
}

/** Named nodes anywhere under `container`, in scene-graph order. */
function findByName(container: PIXI.Container, name: string): PIXI.Container[] {
  const out: PIXI.Container[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node.name === name) out.push(node);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

/** True if any Text node in the tree still renders a legacy "+N" enhancement badge. */
function hasPlusLevelText(container: PIXI.Container): boolean {
  let found = false;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Text && /^\+\d+$/.test(node.text)) { found = true; return; }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

function buildScene(card: CardInstance, equipmentInv: Record<string, EquipmentInstance>): CardScene {
  const save: SaveData = makeNewSave();
  save.cardInv = { [card.id]: card };
  save.equipmentInv = equipmentInv;
  const cb: CardCallbacks = {
    onBack() {},
    getSave: () => save,
    fuseCards: async () => ({ ok: true }),
    fuseCardsBatch: async () => ({ ok: true, completed: 0 }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin: () => {},
  };
  const scene = new CardScene(createLayout(1920, 1080), new InputManager(), cb);
  priv(scene).detail.openDetail(card.id);
  return scene;
}

describe('CardScene detail modal — gear-slot level as stars, not a "+N" badge (2026-08-30)', () => {
  it('an enhanced item gets a gearLevelStars row with exactly `level` stars, and no "+N" text', () => {
    const card = makeCard('a', 'max', 3, { weapon: 'w1', armor: 'ar1', trinket: 'tk1' });
    const scene = buildScene(card, {
      w1: makeEquip('w1', 'wp_pencil', 4),
      ar1: makeEquip('ar1', 'ar_leather', 9),
      tk1: makeEquip('tk1', 'tk_seal', 1),
    });
    const layer = modalLayerOf(scene);

    expect(findByName(layer, 'gearLevelStars:weapon')[0]?.children.length).toBe(4);
    expect(findByName(layer, 'gearLevelStars:armor')[0]?.children.length).toBe(9);
    expect(findByName(layer, 'gearLevelStars:trinket')[0]?.children.length).toBe(1);
    expect(hasPlusLevelText(layer)).toBe(false);

    scene.destroy();
  });

  it('an equipped item at level 0 gets no star row', () => {
    const card = makeCard('a', 'max', 3, { weapon: 'w1' });
    const scene = buildScene(card, { w1: makeEquip('w1', 'wp_pencil', 0) });
    const layer = modalLayerOf(scene);

    expect(findByName(layer, 'gearLevelStars:weapon')).toHaveLength(0);
    expect(hasPlusLevelText(layer)).toBe(false);

    scene.destroy();
  });

  it('an empty slot gets no star row', () => {
    const card = makeCard('a', 'max', 3, {});
    const scene = buildScene(card, {});
    const layer = modalLayerOf(scene);

    for (const slot of ['weapon', 'armor', 'trinket'] as const) {
      expect(findByName(layer, `gearLevelStars:${slot}`)).toHaveLength(0);
    }

    scene.destroy();
  });

  it('the star row sits above the icon (icon moved down to make room, not overlapped)', () => {
    const card = makeCard('a', 'max', 3, { weapon: 'w1' });
    const scene = buildScene(card, { w1: makeEquip('w1', 'wp_pencil', 5) });
    const layer = modalLayerOf(scene);

    const stars = findByName(layer, 'gearLevelStars:weapon')[0]!;
    const icon = findByName(layer, 'detailGearIcon:weapon')[0]!;
    expect(stars).toBeDefined();
    expect(icon).toBeDefined();
    // Star row's bottom edge must clear the icon's top edge. Real (world-space) bounding boxes,
    // not a symmetric-height assumption on `.y` — the weapon glyph is a diagonal pen stroke, not a
    // box centered evenly around its own origin.
    const starsBounds = stars.getBounds();
    const iconBounds = icon.getBounds();
    expect(starsBounds.y + starsBounds.height).toBeLessThanOrEqual(iconBounds.y + 0.5); // +0.5: float slack

    scene.destroy();
  });
});
