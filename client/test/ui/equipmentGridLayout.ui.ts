// Regression coverage for two EquipmentScene grid-layout fixes (2026-07-17):
//
// 1. The item grid (Inventory + Craft tabs) is drawn into a masked sub-layer clipped to
//    [listY, listY+listH) — before this fix, a row that scrolled to straddle that boundary
//    rendered in full and visually bled up over the slot filter bar / materials band above it
//    (only rows fully outside the visible range were skipped, not clipped).
// 2. CELL_GAP_X (double CELL_GAP) is now used for the horizontal gap between grid cells only;
//    vertical spacing between rows is unchanged.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { EquipmentScene, type EquipmentCallbacks } from '../../src/scenes/EquipmentScene';
import { CELL_GAP, CELL_GAP_X, EQUIP_CELL_H, CRAFT_CELL_H } from '../../src/scenes/EquipmentScene/base';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { SaveData, EquipRarity } from '../../src/game/meta/SaveData';

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
  hitRects: { rect: Rect; action: () => void }[];
  headerH: number;
  scrollY: number;
  activeTab: 'inv' | 'craft';
  render(): void;
}

/** A generous bag of distinct, unstackable (locked) equipment instances — enough to fill
 *  multiple columns and rows so the grid must wrap (and, with a small viewport, scroll). */
function buildSave(): SaveData {
  const save = makeNewSave('acc_test');
  save.wallet.coins = 100000;
  save.materials = { scrap: 4, lead: 53, binding: 1 };
  save.cardInv = {
    card1: { id: 'card1', defId: 'lichuang', level: 1, xp: 0, gear: {}, locked: false },
  };
  const defIds = ['wp_pencil', 'wp_pen', 'wp_marker', 'ar_draft'];
  const rarities: EquipRarity[] = ['common', 'fine', 'rare', 'epic'];
  save.equipmentInv = {};
  for (let i = 0; i < 24; i++) {
    const id = `inst_${i}`;
    save.equipmentInv[id] = {
      id, defId: defIds[i % defIds.length], rarity: rarities[i % rarities.length],
      level: 0, affixes: [], locked: true, // locked ⇒ always its own row, never merged into a stack
    };
  }
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

/** Every Container (incl. Graphics) in the tree with a truthy `.mask`, paired with the mask's own drawn rect. */
function findMaskedLayers(root: PIXI.Container): { layer: PIXI.Container; maskRect: Rect }[] {
  const out: { layer: PIXI.Container; maskRect: Rect }[] = [];
  const walk = (node: PIXI.Container): void => {
    const mask = (node as unknown as { mask?: PIXI.Graphics }).mask;
    if (mask?.geometry?.graphicsData?.length) {
      const shape = mask.geometry.graphicsData[0].shape as { x: number; y: number; width: number; height: number };
      out.push({ layer: node, maskRect: { x: shape.x, y: shape.y, w: shape.width, h: shape.height } });
    }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(root);
  return out;
}

/** Every top-level cell panel Graphics — identified as the `sketchPanel(cellW, cellH, …)` fill
 *  rect whose local shape height matches `cellH` (the inner glyph frame / action button are
 *  smaller and don't match); world position is `(g.x, g.y)` since no ancestor is scaled/offset. */
function findCellPanels(root: PIXI.Container, cellH: number): Rect[] {
  const out: Rect[] = [];
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Graphics && node.geometry?.graphicsData?.length) {
      const shape = node.geometry.graphicsData[0].shape as { width: number; height: number };
      if (shape.height === cellH) out.push({ x: node.x, y: node.y, w: shape.width, h: shape.height });
    }
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(root);
  return out;
}

function groupByRow(cells: Rect[]): Rect[][] {
  const rows = new Map<number, Rect[]>();
  for (const r of cells) {
    const row = rows.get(r.y) ?? [];
    row.push(r);
    rows.set(r.y, row);
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, row]) => row.sort((a, b) => a.x - b.x));
}

describe('EquipmentScene — inventory grid: horizontal-only gap doubling', () => {
  it('cells in the same row sit CELL_GAP_X apart horizontally; rows stay CELL_GAP apart vertically', () => {
    const scene = buildScene(...LANDSCAPE);
    const cells = (scene as unknown as SceneInternals).hitRects
      .map((h) => h.rect)
      .filter((r) => r.h === EQUIP_CELL_H);
    expect(cells.length).toBeGreaterThan(4); // several rows × several columns

    const rows = groupByRow(cells);
    expect(rows.length).toBeGreaterThan(1);
    let checkedHorizontal = 0;
    for (const row of rows) {
      for (let i = 1; i < row.length; i++) {
        expect(row[i].x - (row[i - 1].x + row[i - 1].w)).toBe(CELL_GAP_X);
        checkedHorizontal++;
      }
    }
    expect(checkedHorizontal).toBeGreaterThan(0);

    const rowYs = rows.map((row) => row[0].y);
    for (let i = 1; i < rowYs.length; i++) {
      expect(rowYs[i] - rowYs[i - 1]).toBe(EQUIP_CELL_H + CELL_GAP);
    }
    scene.destroy();
  });

  it('the item grid renders into a layer masked to the visible list band (clips overscroll instead of bleeding into the header row)', () => {
    const scene = buildScene(...LANDSCAPE);
    const internals = scene as unknown as SceneInternals;
    // Scroll to a value that lands a row mid-straddle across the old unclipped boundary.
    internals.scrollY = Math.round(EQUIP_CELL_H / 2);
    internals.render();

    const masked = findMaskedLayers(scene.container);
    expect(masked.length).toBeGreaterThan(0);
    // At least one masked layer's clip rect starts below the header — i.e. it is confined to
    // the body list band, not covering the whole screen (which would defeat the point).
    expect(masked.some((m) => m.maskRect.y > internals.headerH)).toBe(true);
    scene.destroy();
  });
});

describe('EquipmentScene — craft grid: horizontal-only gap doubling + scroll mask', () => {
  it('craft cells in the same row sit CELL_GAP_X apart horizontally; rows stay CELL_GAP apart vertically', () => {
    const scene = buildScene(...LANDSCAPE);
    const internals = scene as unknown as SceneInternals;
    internals.activeTab = 'craft';
    internals.render();

    const cells = findCellPanels(scene.container, CRAFT_CELL_H);
    expect(cells.length).toBeGreaterThan(4);

    const rows = groupByRow(cells);
    expect(rows.length).toBeGreaterThan(1);
    let checkedHorizontal = 0;
    for (const row of rows) {
      for (let i = 1; i < row.length; i++) {
        expect(row[i].x - (row[i - 1].x + row[i - 1].w)).toBe(CELL_GAP_X);
        checkedHorizontal++;
      }
    }
    expect(checkedHorizontal).toBeGreaterThan(0);

    const rowYs = rows.map((row) => row[0].y);
    for (let i = 1; i < rowYs.length; i++) {
      expect(rowYs[i] - rowYs[i - 1]).toBe(CRAFT_CELL_H + CELL_GAP);
    }
    scene.destroy();
  });

  it('the craft grid renders into a layer masked to the visible list band', () => {
    const scene = buildScene(...LANDSCAPE);
    const internals = scene as unknown as SceneInternals;
    internals.activeTab = 'craft';
    internals.scrollY = Math.round(CRAFT_CELL_H / 2);
    internals.render();

    const masked = findMaskedLayers(scene.container);
    expect(masked.length).toBeGreaterThan(0);
    expect(masked.some((m) => m.maskRect.y > internals.headerH)).toBe(true);
    scene.destroy();
  });
});
