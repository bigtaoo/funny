// Regression coverage for the 2026-08-24 incremental roster grid (design/game/CHARACTER_CARDS_DESIGN_IMPL.md
// §10.5). Scrolling the Hero Roster used to run the scene's whole render() once per frame, which tore
// down and re-minted every visible cell's ~7 PIXI.Text — ~11 ms of canvas rasterize + GPU upload per
// frame, measured in Chrome at dpr 1 with 15 cells on screen.
//
// The grid now moves cell containers instead of rebuilding them. That only stays true if all four of
// these hold, so they are pinned here:
//   1. renderList installs the core.scrollRedraw fast path (update() prefers it over render()).
//   2. A scroll step moves the SAME cell containers and leaves their contents untouched — and does
//      not re-render the rest of the scene (checked via the header overlay, which every render()
//      tears down).
//   3. Cell hit rects follow the cells and do not accumulate across steps.
//   4. Only rows near the viewport are materialized, and rows that leave are dropped.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CardScene, type CardCallbacks } from '../../src/scenes/CardScene';
import { makeNewSave } from '../../src/game/meta/SaveData';
import type { CardInstance } from '../../src/game/meta/SaveData';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

interface Rect { x: number; y: number; w: number; h: number }
interface SceneInternals {
  core: {
    scrollY: number;
    maxScroll: number;
    headerH: number;
    scrollRedraw: (() => void) | null;
    hitRects: { rect: Rect; fn: () => void; owner?: string }[];
    headerOverlayLayer: PIXI.Container;
    gridLayer: PIXI.Container;
  };
  list: {
    cellContainers: Map<string, PIXI.Container>;
    cellRects: Map<string, { x: number; y: number; w: number }>;
  };
  render(): void;
}

/**
 * 40 cards → 8 rows of 5 at 1920x1080, comfortably more than one screenful.
 *
 * All identical (same def, same level, no gear, no SLG state) on purpose, with ZERO-PADDED ids:
 * sortCards orders by power and falls back to comparing ids as strings, so an all-equal fixture is
 * laid out in ascending id order — and padding keeps that the same as ascending NUMERIC order
 * (unpadded, `c10` sorts before `c2`). That is what lets these tests name the cell they mean:
 * `c00` is the top-left cell and `c39` the last.
 */
function buildScene(n = 40): CardScene {
  const cards: CardInstance[] = [];
  for (let i = 0; i < n; i++) {
    cards.push({ id: `c${String(i).padStart(2, '0')}`, defId: 'max', level: 1, gear: {}, locked: false });
  }
  const save = makeNewSave();
  save.cardInv = Object.fromEntries(cards.map((c) => [c.id, c]));
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
  return new CardScene(createLayout(1920, 1080), new InputManager(), cb);
}

describe('CardScene roster grid — a scroll step moves cells instead of rebuilding them (2026-08-24)', () => {
  it('installs the core.scrollRedraw fast path, so update() never falls back to a full render', () => {
    const scene = buildScene();
    const { core } = scene as unknown as SceneInternals;
    expect(typeof core.scrollRedraw).toBe('function');
    expect(core.maxScroll).toBeGreaterThan(0);   // sanity: this fixture really does scroll
    scene.destroy();
  });

  it('keeps the same containers AND the same child nodes, and skips the rest of the scene', () => {
    const scene = buildScene();
    const internals = scene as unknown as SceneInternals;
    const { core, list } = internals;

    const container = list.cellContainers.get('c00')!;
    expect(container).toBeDefined();
    const childrenBefore = [...container.children];
    expect(childrenBefore.length).toBeGreaterThan(0);
    const yBefore = container.y;
    // Every render() tears headerOverlayLayer down and redraws it, so an unchanged node here is
    // proof that no full render ran.
    const headerNodeBefore = core.headerOverlayLayer.children[0];
    expect(headerNodeBefore).toBeDefined();

    const delta = 120;
    core.scrollY = delta;
    core.scrollRedraw!();

    expect(list.cellContainers.get('c00')).toBe(container);
    expect(container.children.length).toBe(childrenBefore.length);
    expect(container.children.every((c, i) => c === childrenBefore[i])).toBe(true);
    expect(container.y).toBeCloseTo(yBefore - delta, 5);
    expect(core.headerOverlayLayer.children[0]).toBe(headerNodeBefore);

    scene.destroy();
  });

  it('moves each cell hit rect with its cell and does not accumulate them across steps', () => {
    const scene = buildScene();
    const { core } = scene as unknown as SceneInternals;

    const hitsBefore = core.hitRects.length;
    const cellHitBefore = core.hitRects.find((h) => h.owner === 'c00')!;
    expect(cellHitBefore).toBeDefined();
    const yBefore = cellHitBefore.rect.y;

    const delta = 90;
    core.scrollY = delta;
    core.scrollRedraw!();
    core.scrollRedraw!();
    core.scrollRedraw!();

    // Same population (the row window is unchanged at this delta), not three copies of it.
    expect(core.hitRects.length).toBe(hitsBefore);
    expect(core.hitRects.filter((h) => h.owner === 'c00')).toHaveLength(1);
    expect(core.hitRects.find((h) => h.owner === 'c00')!.rect.y).toBeCloseTo(yBefore - delta, 5);

    scene.destroy();
  });

  it('materializes only rows near the viewport, and drops the ones that scroll away', () => {
    const scene = buildScene();
    const internals = scene as unknown as SceneInternals;
    const { core, list } = internals;

    // Top of the list: the first row is built, the last row (cards c35..c39) is far below and is not.
    expect(list.cellContainers.has('c00')).toBe(true);
    expect(list.cellContainers.has('c39')).toBe(false);
    expect(list.cellContainers.size).toBeLessThan(40);
    // Whatever is materialized is parented to the (masked) grid layer, never to bodyLayer.
    for (const c of list.cellContainers.values()) expect(c.parent).toBe(core.gridLayer);

    core.scrollY = core.maxScroll;
    core.scrollRedraw!();

    expect(list.cellContainers.has('c39')).toBe(true);
    expect(list.cellContainers.has('c00')).toBe(false);
    // The dropped cell is really gone, not just untracked.
    expect(list.cellRects.has('c00')).toBe(false);
    expect(core.gridLayer.children.length).toBe(list.cellContainers.size);

    scene.destroy();
  });

  it('a full render() after a scroll keeps the scroll position and reuses the built cells', () => {
    const scene = buildScene();
    const internals = scene as unknown as SceneInternals;
    const { core, list } = internals;

    core.scrollY = 150;
    core.scrollRedraw!();
    const container = list.cellContainers.get('c05')!;
    const childrenBefore = [...container.children];

    internals.render();

    expect(core.scrollY).toBe(150);
    expect(list.cellContainers.get('c05')).toBe(container);
    expect(container.children.every((c, i) => c === childrenBefore[i])).toBe(true);

    scene.destroy();
  });
});

describe('CardScene roster grid — leaving the list tab tears the persistent grid layer down', () => {
  it('clears every cell when switching to the skins tab (bodyLayer teardown no longer reaches them)', () => {
    const scene = buildScene();
    const internals = scene as unknown as SceneInternals;
    const { core, list } = internals;
    expect(list.cellContainers.size).toBeGreaterThan(0);

    (scene as unknown as { core: { tab: string } }).core.tab = 'skins';
    internals.render();

    expect(list.cellContainers.size).toBe(0);
    expect(core.gridLayer.children).toHaveLength(0);
    expect(core.scrollRedraw).toBeNull();

    scene.destroy();
  });
});
