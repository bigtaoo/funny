// Regression coverage for the 2026-08-01 roster gear-icon redesign (design/game/CHARACTER_CARDS_DESIGN.md
// §10.1 addendum): the three gear-slot icons at the bottom-right of each roster card cell used to be
// purely decorative — the whole cell was a single hit rect that always opened the detail modal, so the
// icons looked clickable but weren't. Each icon now gets its own hit rect that jumps straight to
// EquipmentScene for that slot (openEquipment(cardId, slot)), matching what tapping the same slot in the
// detail modal already does (renderDetailGearSlots, detail.ts). This pins:
//   1. each gear icon has its own hit rect, sized/centered on the icon, wired to openEquipment(cardId, slot).
//   2. it is registered before the whole-cell hit rect, so it wins the first-match hit test (base.ts
//      handlePointerDown iterates hitRects in order and stops at the first rect containing the point).
//   3. offline (no cb.openEquipment) falls back to exactly the old behavior — no per-icon hit rects at all.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { CardInstance, EquipSlot } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function makeCard(id: string, defId: string, level: number): CardInstance {
  return { id, defId, level, gear: {}, locked: false };
}

interface Rect { x: number; y: number; w: number; h: number; }
interface HitRect { rect: Rect; action: () => void; owner?: string; }
interface SceneInternals { hitRects: HitRect[]; }

/** Named nodes anywhere in the tree, in scene-graph order. */
function findByName(container: PIXI.Container, name: string): PIXI.DisplayObject[] {
  const out: PIXI.DisplayObject[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node.name === name) out.push(node);
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return out;
}

function buildScene(openEquipment?: (cardId: string, slot?: EquipSlot) => void): CardScene {
  const save = makeNewSave();
  const card = makeCard('a', 'max', 3);
  save.cardInv = { a: card };
  const cb: CardCallbacks = {
    onBack() {},
    getSave: () => save,
    fuseCards: async () => ({ ok: true }),
    setCardLock: async () => ({ ok: true }),
    getOwnedSkins: () => [],
    getEquippedSkin: () => null,
    equipSkin: () => {},
    ...(openEquipment ? { openEquipment } : {}),
  };
  return new CardScene(createLayout(1920, 1080), new InputManager(), cb);
}

/** The hit rect whose rect contains the icon's own center point. */
function hitRectAt(hitRects: HitRect[], icon: PIXI.DisplayObject): { hit: HitRect | undefined; index: number } {
  const index = hitRects.findIndex((h) => (
    icon.x >= h.rect.x && icon.x <= h.rect.x + h.rect.w
    && icon.y >= h.rect.y && icon.y <= h.rect.y + h.rect.h
  ));
  return { hit: index === -1 ? undefined : hitRects[index], index };
}

describe('CardScene roster list — gear icons are individually clickable, straight to EquipmentScene (2026-08-01)', () => {
  it.each(['weapon', 'armor', 'trinket'] as const)(
    'tapping the "%s" gear icon calls openEquipment(cardId, slot), not openDetail',
    (slot) => {
      const openEquipment = vi.fn();
      const scene = buildScene(openEquipment);
      const internals = scene as unknown as SceneInternals;

      const icon = findByName(scene.container, `gearIcon:${slot}`)[0]!;
      expect(icon).toBeDefined();
      const { hit } = hitRectAt(internals.hitRects, icon);
      expect(hit, `no hit rect covers the "${slot}" icon`).toBeDefined();

      hit!.action();
      expect(openEquipment).toHaveBeenCalledWith('a', slot);

      scene.destroy();
    },
  );

  it('each gear icon\'s hit rect is registered before the whole-cell hit rect (wins the first-match hit test)', () => {
    const openEquipment = vi.fn();
    const scene = buildScene(openEquipment);
    const internals = scene as unknown as SceneInternals;

    // renderCardCell pushes the 3 gear-icon hit rects (in weapon/armor/trinket order) and only then
    // the whole-cell hit rect — base.ts's handlePointerDown takes the *first* rect in `hitRects` whose
    // bounds contain the tap, so registration order doubles as click priority here.
    const ownedByA = internals.hitRects.filter((h) => h.owner === 'a');
    expect(ownedByA).toHaveLength(4); // 3 gear icons + 1 whole-cell, single card in this scene
    const wholeCellRect = ownedByA[3]!.rect;
    const cellIsWholeCard = wholeCellRect.w > 200 && wholeCellRect.h > 200; // vs. a ~44px icon box
    expect(cellIsWholeCard).toBe(true);

    for (let i = 0; i < 3; i++) {
      const slot = (['weapon', 'armor', 'trinket'] as const)[i]!;
      const icon = findByName(scene.container, `gearIcon:${slot}`)[0]!;
      // The icon's own hit rect (index i within ownedByA) sits at a global index strictly before the
      // whole-cell one (index 3 within ownedByA) — first-match iteration hits the icon first.
      const globalIconIndex = internals.hitRects.indexOf(ownedByA[i]!);
      const globalCellIndex = internals.hitRects.indexOf(ownedByA[3]!);
      expect(globalIconIndex).toBeLessThan(globalCellIndex);
      // Sanity: that hit rect really is the one covering this icon.
      expect(icon.x).toBeGreaterThanOrEqual(ownedByA[i]!.rect.x);
      expect(icon.x).toBeLessThanOrEqual(ownedByA[i]!.rect.x + ownedByA[i]!.rect.w);
    }

    scene.destroy();
  });

  it('offline (no cb.openEquipment): gear icons render but get no per-icon hit rect — only the old whole-cell tap remains', () => {
    const scene = buildScene(undefined);
    const internals = scene as unknown as SceneInternals;

    for (const slot of ['weapon', 'armor', 'trinket'] as const) {
      expect(findByName(scene.container, `gearIcon:${slot}`)[0]).toBeDefined();
    }

    const ownedByA = internals.hitRects.filter((h) => h.owner === 'a');
    expect(ownedByA).toHaveLength(1); // whole-cell only

    scene.destroy();
  });
});
