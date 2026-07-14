// Regression coverage for the 2026-07-13 SLG header unification: WorldMapScene's top-left
// floating back chip became a full SceneHeader bar (opaque paper fill), reserving
// `ctx.topInset` at the top of the screen exactly like `HUD_H` is already reserved at the
// bottom. Two things had to move in lockstep with that or the new bar either gets tapped
// through to the map underneath, or the right-column HUD (status/marches/world-info) draws
// on top of / behind it:
//
//  1. WorldMapInput.handleDown/handleUp's map-drag/tile-click gate only checked `y < h - HUD_H`
//     (bottom bound) — taps inside [0, topInset] used to fall straight through to the map.
//  2. WorldMapPanels.renderHud()'s right column started at a fixed y=8, which now sits under
//     the opaque header instead of below it.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — both WorldMapInput
// and WorldMapPanels import pixi.js-legacy.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import { HUD_H } from '../../src/scenes/worldmap/constants';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [800, 600];
const TOP_INSET = 86; // matches sceneHeaderHeight(600) = round(600*0.12)

/** Zero-area rects for every floating HUD button so handleDown's early hit-tests never match —
 *  isolates the drag-begin gate itself (the thing under test) from unrelated button hits. */
function zeroRect(): { x: number; y: number; w: number; h: number } {
  return { x: 0, y: 0, w: 0, h: 0 };
}

function buildInputHarness(topInset = TOP_INSET) {
  const ctx = {
    w: W, h: H,
    topInset,
    panX: 0, panY: 0,
    dragging: false, dragMoved: false, dragStartX: 0, dragStartY: 0,
    modalDimRect: null,
    modalBtnRects: [],
    infoScrollRect: null,
    zoomBtnRect: zeroRect(),
    infoBtnRect: zeroRect(),
    backRect: zeroRect(),
    aucBtnRect: zeroRect(),
    marchBadgeRect: zeroRect(),
    chatBarRect: zeroRect(),
    marchRowRects: [],
    mapW: 500, mapH: 500,
    me: { joined: true, mainBaseTile: undefined },
    tileCache: new Map(),
    selectedTile: null,
    view: { renderMap: () => {}, screenToTile: () => ({ x: 0, y: 0 }) },
    net: { loadMapViewport: vi.fn().mockResolvedValue(undefined) },
    panels: { showModal: vi.fn(), closeModal: vi.fn() },
  } as unknown as WorldMapContext;

  const input = new WorldMapInput(ctx);
  return { ctx, input };
}

function buildHudHarness(topInset: number) {
  const ctx = {
    w: W, h: H,
    topInset,
    // Same shape drawSceneHeader() returns: the WHOLE bar, not just a back-chip pill —
    // renderHud's left column (Zoom/Auction) stacks directly under this.
    backRect: { x: 0, y: 0, w: 160, h: topInset },
    hudLayer: new PIXI.Container(),
    headerHudLayer: new PIXI.Container(),
    worldChatLatest: null,
    worldChatUnread: 0,
    zoom: 1 as const,
    me: { joined: true, troops: 10, troopCap: 100, territoryCount: 1, resources: {} },
    marches: [],
    marchesExpanded: false,
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[1]), Number(p[2])]; },
    cb: { accountId: 'me', getCoins: () => 0 },
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  return { ctx, panels };
}

describe('WorldMapInput — map drag/tap gated below the header bar (not just above the bottom HUD)', () => {
  it('a pointer-down inside the header strip (y < topInset) does not start a map drag', () => {
    const { ctx, input } = buildInputHarness();
    input.handleDown(400, TOP_INSET - 10);
    expect(ctx.dragging).toBe(false);
  });

  it('a pointer-down just below the header strip does start a map drag', () => {
    const { ctx, input } = buildInputHarness();
    input.handleDown(400, TOP_INSET + 10);
    expect(ctx.dragging).toBe(true);
  });

  it('releasing a non-drag tap inside the header strip does not resolve to a tile click', () => {
    const { ctx, input } = buildInputHarness();
    const onTileClick = vi.spyOn(input, 'onTileClick');
    // Simulate down+up without crossing the drag-move threshold, both inside the header.
    input.handleDown(400, TOP_INSET - 20);
    ctx.dragging = true; // pretend a drag armed anyway (defensive: only handleUp's gate is under test)
    ctx.dragMoved = false;
    input.handleUp(400, TOP_INSET - 20);
    expect(onTileClick).not.toHaveBeenCalled();
  });

  it('releasing a non-drag tap below the header strip (and above the bottom HUD) resolves to a tile click', () => {
    const { ctx, input } = buildInputHarness();
    const onTileClick = vi.spyOn(input, 'onTileClick');
    ctx.dragging = true;
    ctx.dragMoved = false;
    input.handleUp(400, TOP_INSET + 20);
    expect(onTileClick).toHaveBeenCalledTimes(1);
  });

  it('the bottom HUD bound is untouched by topInset — a tap just above HUD_H still resolves to a tile click', () => {
    const { ctx, input } = buildInputHarness();
    const onTileClick = vi.spyOn(input, 'onTileClick');
    ctx.dragging = true;
    ctx.dragMoved = false;
    input.handleUp(400, H - HUD_H - 5);
    expect(onTileClick).toHaveBeenCalledTimes(1);
  });
});

describe('WorldMapPanels.renderHud — right column HUD moves with topInset', () => {
  it('the world-info button sits below the header bar, not at the old fixed y=8', () => {
    const { ctx, panels } = buildHudHarness(TOP_INSET);
    panels.renderHud();
    expect(ctx.infoBtnRect.y).toBeGreaterThan(TOP_INSET);
  });

  it('a taller header pushes the whole right column down by exactly the difference', () => {
    const short = buildHudHarness(60);
    short.panels.renderHud();
    const tall = buildHudHarness(120);
    tall.panels.renderHud();
    expect(tall.ctx.infoBtnRect.y - short.ctx.infoBtnRect.y).toBe(60);
  });
});
