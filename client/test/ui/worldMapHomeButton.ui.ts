// Regression coverage for the 2026-08-12 "回家" (go home) button: a header-bar entry, immediately
// left of the Shop button, that recenters the camera on the player's own base without leaving the
// world map — added alongside the existing Shop/Auction pair (see headerHud.ts's
// renderHeaderHud). Two things are covered here: the button only renders once the player actually
// has a base (mainBaseTile), and tapping it drives WorldMapRenderer.centerAt with the base's own
// coordinates (parsed off ctx.me.mainBaseTile, same as WorldMapNet's on-join recenter).
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles) — WorldMapPanels/Input
// import pixi.js-legacy.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
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
const TOP_INSET = 86;
const WORLD_ID = 'world:1:0';
const BASE = { x: 30, y: 40 };

function zeroRect(): { x: number; y: number; w: number; h: number } {
  return { x: 0, y: 0, w: 0, h: 0 };
}

function buildHudHarness(mainBaseTile: string | undefined) {
  const ctx = {
    w: W, h: H,
    topInset: TOP_INSET,
    backRect: { x: 0, y: 0, w: 160, h: TOP_INSET },
    hudLayer: new PIXI.Container(),
    headerHudLayer: new PIXI.Container(),
    worldChatLatest: null,
    worldChatUnread: 0,
    zoom: 1 as const,
    me: { joined: true, mainBaseTile, troops: 10, troopCap: 100, territoryCount: 1, resources: {}, yieldRate: {} },
    marches: [],
    marchesExpanded: false,
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[p.length - 2]), Number(p[p.length - 1])]; },
    cb: { accountId: 'me', getCoins: () => 0 },
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  return { ctx, panels };
}

function buildInputHarness(opts: { mainBaseTile?: string; homeBtnRect?: { x: number; y: number; w: number; h: number } } = {}) {
  const centerAt = vi.fn();
  const renderMap = vi.fn();
  const ctx = {
    w: W, h: H,
    topInset: TOP_INSET,
    panX: 0, panY: 0,
    dragging: false, dragMoved: false, dragStartX: 0, dragStartY: 0,
    modalDimRect: null,
    modalBtnRects: [],
    infoScrollRect: null,
    zoomBtnRect: zeroRect(),
    backRect: zeroRect(),
    aucBtnRect: zeroRect(),
    shopBtnRect: zeroRect(),
    homeBtnRect: opts.homeBtnRect ?? { x: 300, y: 10, w: 100, h: 40 },
    marchBadgeRect: zeroRect(),
    replayBadgeRect: zeroRect(),
    chatBarRect: zeroRect(),
    resClusterRect: zeroRect(),
    marchRowRects: [],
    mapW: 500, mapH: 500,
    me: { joined: true, mainBaseTile: opts.mainBaseTile },
    tileCache: new Map(),
    selectedTile: null,
    stationed: [],
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[p.length - 2]), Number(p[p.length - 1])]; },
    view: { renderMap, screenToTile: () => ({ x: 0, y: 0 }), centerAt },
    net: { loadMapViewport: vi.fn().mockResolvedValue(undefined) },
    panels: { showModal: vi.fn(), closeModal: vi.fn() },
  } as unknown as WorldMapContext;

  const input = new WorldMapInput(ctx);
  return { ctx, input, centerAt, renderMap };
}

describe('WorldMapPanels.renderHud — home button (回家)', () => {
  it('renders immediately left of the shop button once the player has a base', () => {
    const { ctx, panels } = buildHudHarness(`${WORLD_ID}:${BASE.x}:${BASE.y}`);
    panels.renderHud();
    expect(ctx.homeBtnRect.w).toBeGreaterThan(0);
    expect(ctx.homeBtnRect.x + ctx.homeBtnRect.w).toBeLessThanOrEqual(ctx.shopBtnRect.x);
    expect(ctx.homeBtnRect.y).toBeGreaterThanOrEqual(0);
    expect(ctx.homeBtnRect.y + ctx.homeBtnRect.h).toBeLessThanOrEqual(TOP_INSET);
  });

  it('is omitted before the player has placed a base (no mainBaseTile)', () => {
    const { ctx, panels } = buildHudHarness(undefined);
    panels.renderHud();
    expect(ctx.homeBtnRect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it('the resource cluster stays clear of the home button, not just the shop button', () => {
    const { ctx, panels } = buildHudHarness(`${WORLD_ID}:${BASE.x}:${BASE.y}`);
    panels.renderHud();
    const cluster = (ctx.headerHudLayer.children as PIXI.DisplayObject[])
      .find((c): c is PIXI.Container => c.constructor === PIXI.Container)!;
    expect(cluster.x + cluster.width).toBeLessThanOrEqual(ctx.homeBtnRect.x);
  });

  it('re-rendering (as the ~5s march poll does) tears down and rebuilds without leaking home-button children', () => {
    const { ctx, panels } = buildHudHarness(`${WORLD_ID}:${BASE.x}:${BASE.y}`);
    panels.renderHud();
    const firstCount = ctx.headerHudLayer.children.length;
    panels.renderHud();
    panels.renderHud();
    expect(ctx.headerHudLayer.children.length).toBe(firstCount);
  });
});

describe('WorldMapInput.handleDown — home button recenters the camera on the player\'s base', () => {
  it('a tap inside homeBtnRect centers the camera on the parsed mainBaseTile coordinates', () => {
    const { ctx, input, centerAt, renderMap } = buildInputHarness({ mainBaseTile: `${WORLD_ID}:${BASE.x}:${BASE.y}` });
    const r = ctx.homeBtnRect;
    input.handleDown(r.x + r.w / 2, r.y + r.h / 2);
    expect(centerAt).toHaveBeenCalledWith(BASE.x, BASE.y);
    expect(renderMap).toHaveBeenCalledTimes(1);
  });

  it('a tap outside homeBtnRect does not recenter the camera', () => {
    const { ctx, input, centerAt } = buildInputHarness({ mainBaseTile: `${WORLD_ID}:${BASE.x}:${BASE.y}` });
    input.handleDown(5, TOP_INSET + 20);
    expect(centerAt).not.toHaveBeenCalled();
    // Falls through to the drag-begin gate instead (below the header, above the bottom HUD).
    expect(ctx.dragging).toBe(true);
  });

  it('does nothing (but is still consumed) when tapped with no base placed yet', () => {
    const { ctx, input, centerAt } = buildInputHarness({ mainBaseTile: undefined });
    const r = ctx.homeBtnRect;
    input.handleDown(r.x + r.w / 2, r.y + r.h / 2);
    expect(centerAt).not.toHaveBeenCalled();
    // Consumed by the homeBtnRect hit-test, not passed through to the drag-begin gate.
    expect(ctx.dragging).toBe(false);
  });
});
