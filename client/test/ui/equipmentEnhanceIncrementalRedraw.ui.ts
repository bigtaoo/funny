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
  hitRects: { rect: Rect; action: () => void; owner?: string }[];
  cellContainers: Map<string, PIXI.Container>;
  bt: { busy: boolean; start(): void; stop(): void };
  modalScale: number;
  detailId: string | null;
  render(): void;
  openDetail(id: string): void;
}

/**
 * Grid-cell action buttons (Enhance/Equip/Reforge/Salvage) are pushed at `btnBandH = 46` tall
 * (renderInstanceCell); the whole-card "open detail" tap is pushed separately at the full
 * `EQUIP_CELL_H` (266). Filtering to the 46-tall rects isolates the actual action buttons — the
 * card-body tap is *never* gated by `disabled`, so counting it would hide a stuck-disabled bug.
 */
function actionHitsFor(internals: SceneInternals, owner: string): { rect: Rect; action: () => void; owner?: string }[] {
  return internals.hitRects.filter((h) => h.owner === owner && Math.abs(h.rect.h - 46) < 0.5);
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

// Regression coverage for the 2026-08-02 follow-up fix (see EQUIPMENT_DESIGN.md §11.4).
//
// The real enhance() wiring (src/app/nav/game.ts) applies the server response via
// saveManager.adoptServerPartial *before* returning from the async call — and SaveManager notifies
// its onSaveChanged subscribers synchronously. EquipmentScene subscribes to that with `() =>
// this.render()`, so a FULL grid render can fire mid-await, while doEnhance's own `bt.busy` is still
// true — greying every cell's buttons, not just the one being enhanced. The single-cell incremental
// path above only ever fixes the touched cell, so every other cell was left stuck grey until the next
// unrelated full render() (e.g. a scroll).
describe('EquipmentScene — enhance mid-flight save-push does not leave sibling cells stuck grey (2026-08-02)', () => {
  /** Builds a scene whose `enhance()` callback mirrors the real wiring: it mutates the save and fires
   *  onSaveChanged listeners *synchronously*, before returning — same ordering as
   *  saveManager.adoptServerPartial inside src/app/nav/game.ts's enhance(). */
  function buildRealisticScene(save: SaveData): { scene: EquipmentScene; internals: SceneInternals } {
    const listeners = new Set<() => void>();
    const cb: EquipmentCallbacks = {
      onBack() {},
      getSave: () => save,
      onSaveChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      craft: async () => ({ ok: true }),
      async enhance(id: string) {
        await Promise.resolve(); // the network round trip
        save.equipmentInv[id].level += 1;
        for (const l of listeners) l(); // saveManager.adoptServerPartial's synchronous notify
        return { ok: true as const, success: true, level: save.equipmentInv[id].level };
      },
      salvage: async () => ({ ok: true }),
      equip: async () => ({ ok: true }),
      reforge: async () => ({ ok: true }),
      activeCardInstanceId: '',
    };
    const scene = new EquipmentScene(createLayout(1280, 800), new InputManager(), cb);
    return { scene, internals: scene as unknown as SceneInternals };
  }

  it('a sibling cell touched only by the mid-flight busy=true render has its action buttons back as soon as the enhance settles', async () => {
    const save = buildSave();
    const { scene, internals } = buildRealisticScene(save);

    internals.openDetail('inst_A');
    const confirm = findConfirmHit(internals);
    expect(confirm).toBeDefined();
    confirm!.action();
    await flush();

    // inst_B was never enhanced — only ever touched by the mid-flight busy=true render. Its action
    // buttons (Enhance/Equip — the 46-tall band, not the always-present card-body tap) must already be
    // registered by the time doEnhance settles, matching what a forced full render() gives — no extra
    // scroll/render should be required to un-grey it.
    const settled = actionHitsFor(internals, 'inst_B');
    internals.render();
    const forced = actionHitsFor(internals, 'inst_B');
    expect(forced.length).toBeGreaterThan(0); // sanity: the sibling does have action buttons at all
    expect(settled.length).toBe(forced.length);

    scene.destroy();
  });

  it('closing the detail modal after a settled enhance (no extra render) leaves sibling action buttons enabled', async () => {
    const save = buildSave();
    const { scene, internals } = buildRealisticScene(save);

    internals.openDetail('inst_A');
    const confirm = findConfirmHit(internals);
    expect(confirm).toBeDefined();
    confirm!.action();
    await flush();

    // Close the modal exactly the way a tap-outside does: DetailMixin's closeDetail() just clears
    // detailId and tears down the modal layer — it never touches the grid/hitRects. If the grid was
    // already correct at settle time, closing the modal changes nothing about it.
    const outerHit = internals.modalHits[internals.modalHits.length - 1];
    outerHit.action();
    expect(internals.detailId).toBeNull();

    const afterClose = actionHitsFor(internals, 'inst_B');
    internals.render();
    const forced = actionHitsFor(internals, 'inst_B');
    expect(forced.length).toBeGreaterThan(0);
    expect(afterClose.length).toBe(forced.length);

    scene.destroy();
  });

  it('matches the reported repro: enhancing one piece out of a 24-item stack leaves the rest of the (now split-off) stack clickable without scrolling', async () => {
    const save = makeNewSave('acc_test');
    save.wallet.coins = 100000;
    save.materials = { scrap: 100, lead: 100, binding: 100 };
    save.equipmentInv = {};
    for (let i = 0; i < 24; i++) {
      const id = `inst_${i}`;
      save.equipmentInv[id] = { id, defId: 'wp_pencil', rarity: 'epic', level: 0, affixes: [], locked: false };
    }
    const { scene, internals } = buildRealisticScene(save);

    // Enhance whichever instance the grid picked as the stack's representative — enhancing it splits
    // it off (level > 0) from the remaining 23-item stack, which gets a new representative id.
    const repId = [...internals.cellContainers.keys()][0];
    internals.openDetail(repId);
    const confirm = findConfirmHit(internals);
    expect(confirm).toBeDefined();
    confirm!.action();
    await flush();

    const outerHit = internals.modalHits[internals.modalHits.length - 1];
    outerHit.action(); // close, like the user tapping outside the modal

    const otherOwners = [...new Set(internals.hitRects.map((h) => h.owner).filter((o): o is string => !!o && o !== repId))];
    expect(otherOwners.length).toBeGreaterThan(0); // the remaining stack must still be represented by some row

    const settled = otherOwners.flatMap((o) => actionHitsFor(internals, o));
    internals.render();
    const forced = otherOwners.flatMap((o) => actionHitsFor(internals, o));
    expect(forced.length).toBeGreaterThan(0);
    expect(settled.length).toBe(forced.length);

    scene.destroy();
  });
});
