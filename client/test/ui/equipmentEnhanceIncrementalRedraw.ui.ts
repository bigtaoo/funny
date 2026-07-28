// Regression coverage for the 2026-07-28 enhance incremental-redraw fix.
//
// Before this fix, clicking a piece's Enhance confirm button fully tore down and rebuilt the whole
// inventory grid twice (once entering busy, once on the result) — and while busy, every cell's
// instanceActions() were entirely omitted (not just this cell's) rather than greyed out, which
// shrank every cell's button band and grew its glyph frame to fill the freed space. Two full
// relayouts plus every cell's glyph frame resizing read as the whole grid getting "stretched".
//
// This pins:
//  1. A successful, non-reordering enhance tears down and redraws only the touched cell's own
//     container — an untouched sibling cell's container and its children stay the exact same
//     object instances (proof the rest of the grid was never touched, not just visually unchanged).
//  2. A failed/errored enhance (no level change) doesn't touch the grid at all.
//  3. Busy state keeps a cell's action buttons in place (greyed) instead of omitting them, so its
//     glyph-frame size is identical whether busy or idle.
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

interface Rect { x: number; y: number; w: number; h: number; }
interface SceneInternals {
  modalHits: { rect: Rect; action: () => void }[];
  cellContainers: Map<string, PIXI.Container>;
  bt: { busy: boolean; start(): void; stop(): void };
  modalScale: number;
  render(): void;
  openDetail(id: string): void;
}

/** modalHits store screen-space rects (post toModalScreen(), scaled by modalScale) — the confirm
 *  button's *local* height is detail.ts's `btnH = 32`, so match against that scaled by modalScale
 *  rather than the raw 32 (see detail.ts openDetail's `scale = h*0.8/mh` popup-scale transform). */
function findConfirmHit(internals: SceneInternals): { rect: Rect; action: () => void } | undefined {
  const expected = 32 * internals.modalScale;
  return internals.modalHits.find((h) => Math.abs(h.rect.h - expected) < 0.5);
}

function buildSave(): SaveData {
  const save = makeNewSave('acc_test');
  save.wallet.coins = 100000;
  save.materials = { scrap: 100, lead: 100, binding: 100 };
  save.equipmentInv = {
    inst_A: { id: 'inst_A', defId: 'wp_pencil', rarity: 'epic', level: 0, affixes: [], locked: false },
    inst_B: { id: 'inst_B', defId: 'wp_pen', rarity: 'rare', level: 0, affixes: [], locked: false },
  };
  return save;
}

function buildScene(save: SaveData, enhance: EquipmentCallbacks['enhance']): EquipmentScene {
  const cb: EquipmentCallbacks = {
    onBack() {},
    getSave: () => save,
    craft: async () => ({ ok: true }),
    enhance,
    salvage: async () => ({ ok: true }),
    equip: async () => ({ ok: true }),
    reforge: async () => ({ ok: true }),
    activeCardInstanceId: '',
  };
  return new EquipmentScene(createLayout(1280, 800), new InputManager(), cb);
}

/** Flush the microtask queue (promise .then chains) so an already-resolved async doEnhance settles. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function sameRefs(a: PIXI.DisplayObject[], b: PIXI.DisplayObject[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The glyph frame is the one square Graphics rect smaller than the cell itself (name/rarity/affix
 *  text and the outer cell panel are all wider than tall or as tall as EQUIP_CELL_H). */
function findGlyphFrame(container: PIXI.Container): Rect | null {
  let found: Rect | null = null;
  const walk = (node: PIXI.Container): void => {
    if (found) return;
    if (node instanceof PIXI.Graphics && node.geometry?.graphicsData?.length) {
      const shape = node.geometry.graphicsData[0].shape as { width: number; height: number };
      if (shape.width === shape.height && shape.width > 0 && shape.width < EQUIP_CELL_H) {
        found = { x: node.x, y: node.y, w: shape.width, h: shape.height };
        return;
      }
    }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return found;
}

describe('EquipmentScene — enhance incremental redraw (2026-07-28)', () => {
  it('a successful, non-reordering enhance redraws only the touched cell; an untouched sibling cell is never torn down', async () => {
    const save = buildSave();
    const scene = buildScene(save, async (id) => {
      save.equipmentInv[id].level += 1;
      return { ok: true, success: true, level: save.equipmentInv[id].level };
    });
    const internals = scene as unknown as SceneInternals;

    const containerA = internals.cellContainers.get('inst_A');
    const containerB = internals.cellContainers.get('inst_B');
    expect(containerA).toBeDefined();
    expect(containerB).toBeDefined();
    const childrenBBefore = [...containerB!.children];

    internals.openDetail('inst_A');
    const confirm = findConfirmHit(internals);
    expect(confirm).toBeDefined();
    confirm!.action();
    await flush();

    expect(internals.cellContainers.get('inst_A')).toBe(containerA); // redrawn in place, same container
    expect(internals.cellContainers.get('inst_B')).toBe(containerB); // completely untouched
    expect(sameRefs([...containerB!.children], childrenBBefore)).toBe(true); // not even torn down

    scene.destroy();
  });

  it('a failed enhance (no level change) does not touch the grid at all', async () => {
    const save = buildSave();
    const scene = buildScene(save, async () => ({ ok: true, success: false, level: 0 }));
    const internals = scene as unknown as SceneInternals;

    const containerA = internals.cellContainers.get('inst_A');
    const childrenABefore = [...containerA!.children];

    internals.openDetail('inst_A');
    const confirm = findConfirmHit(internals);
    expect(confirm).toBeDefined();
    confirm!.action();
    await flush();

    expect(internals.cellContainers.get('inst_A')).toBe(containerA);
    expect(sameRefs([...containerA!.children], childrenABefore)).toBe(true);

    scene.destroy();
  });

  it('busy state keeps a cell glyph frame the same size as idle (buttons grey out, not disappear)', () => {
    const save = buildSave();
    const scene = buildScene(save, async () => ({ ok: true, success: true, level: 1 }));
    const internals = scene as unknown as SceneInternals;

    const frameIdle = findGlyphFrame(internals.cellContainers.get('inst_A')!);
    expect(frameIdle).not.toBeNull();

    internals.bt.start();
    internals.render();
    const frameBusy = findGlyphFrame(internals.cellContainers.get('inst_A')!);
    internals.bt.stop();

    expect(frameBusy).not.toBeNull();
    expect(frameBusy!.w).toBe(frameIdle!.w);

    scene.destroy();
  });
});
