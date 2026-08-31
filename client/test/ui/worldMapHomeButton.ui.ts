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
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { HUD_H } from '../../src/scenes/worldmap/logic/constants';
import type { ILayout } from '../../src/layout/ILayout';

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
    teamPanelExpanded: false,
    teams: [],
    teamsLoaded: false,
    occupations: [],
    stationed: [],
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
    teamBadgeRect: zeroRect(),
    replayBadgeRect: zeroRect(),
    chatBarRect: zeroRect(),
    resClusterRect: zeroRect(),
    teamRowRects: [],
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
    // Bare `PIXI.Container` identity alone doesn't single out the readout any more: the shop entry
    // button's `coinSack` icon (raster since 2026-08-25) is also a bare `new PIXI.Container()` (see
    // buildRasterTabIcon) — the readout is the only one of the two that holds PIXI.Text children.
    const cluster = (ctx.headerHudLayer.children as PIXI.Container[])
      .find((c) => c.constructor === PIXI.Container
        && c.children.some((ch) => ch instanceof PIXI.Text))!;
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

  // Boundary check: headerHud.ts lays the two buttons out with an 8px gap between them
  // (`shopBtn.x = homeBtn.x + homeW + 8` — see renderHeaderHud), so a tap right at either
  // button's own edge must fire only that button, never bleed into its neighbour.
  it('adjacent shop/home buttons each fire only their own action at their shared boundary', () => {
    const homeBtnRect = { x: 300, y: 10, w: 100, h: 40 };
    const shopBtnRect = { x: homeBtnRect.x + homeBtnRect.w + 8, y: 10, w: 100, h: 40 };
    const { ctx, input, centerAt } = buildInputHarness({ mainBaseTile: `${WORLD_ID}:${BASE.x}:${BASE.y}`, homeBtnRect });
    (ctx as unknown as { shopBtnRect: typeof shopBtnRect }).shopBtnRect = shopBtnRect;
    const openShopPanel = vi.fn();
    (ctx.panels as unknown as { openShopPanel: () => void }).openShopPanel = openShopPanel;

    // Rightmost pixel of the home button — still home, not shop.
    input.handleDown(homeBtnRect.x + homeBtnRect.w - 1, homeBtnRect.y + homeBtnRect.h / 2);
    expect(centerAt).toHaveBeenCalledTimes(1);
    expect(openShopPanel).not.toHaveBeenCalled();

    // Leftmost pixel of the shop button (8px further right, across the gap) — now shop, not home.
    input.handleDown(shopBtnRect.x, shopBtnRect.y + shopBtnRect.h / 2);
    expect(openShopPanel).toHaveBeenCalledTimes(1);
    expect(centerAt).toHaveBeenCalledTimes(1); // unchanged — still just the first tap
  });

  // The header-button hit-tests were pulled into headerButtons.ts (hitTestHeaderButtons) so
  // WorldMapInput.ts would fit back under the 500-line convention; guard that the extraction
  // didn't disturb handleDown's fallthrough to the team-row loop that runs right after it.
  it('a tap that misses every header button still falls through to team-row click-to-center', () => {
    const { ctx, input, centerAt: homeCenterAt } = buildInputHarness({ mainBaseTile: `${WORLD_ID}:${BASE.x}:${BASE.y}` });
    const rowRect = { x: 10, y: TOP_INSET + 5, w: 50, h: 20 };
    (ctx as unknown as { teamRowRects: unknown[] }).teamRowRects = [
      { marchId: 'm1', stationedTeamId: null, worldId: WORLD_ID, jumpX: 77, jumpY: 88, rowRect, recallRect: null, instantReturnRect: null, recallStationRect: null },
    ];
    input.handleDown(rowRect.x + 5, rowRect.y + 5);
    expect(homeCenterAt).toHaveBeenCalledWith(77, 88);
  });
});

// End-to-end sanity check through the REAL wiring (WorldMapContext + WorldMapRenderer +
// WorldMapPanels + WorldMapInput — mirrors worldMapZoom3CityAnchor.ui.ts's harness), not a
// hand-rolled ctx: proves the header actually renders a clickable home button at the rect it
// reports, and that clicking it through the full handleDown→hitTestHeaderButtons→view.centerAt
// chain really moves the camera, not just that the mocked collaborators were called.
describe('WorldMap home button — real scene wiring end-to-end', () => {
  const LAYOUT = { designWidth: 1280, designHeight: 800 } as ILayout;
  const CB: WorldMapCallbacks = {
    onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
    onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'],
    worldId: WORLD_ID, playerName: 'dbg', accountId: 'acc_dbg', storage: memStore,
  };

  function buildScene(mainBaseTile: string | undefined): WorldMapContext {
    const ctx = new WorldMapContext(LAYOUT, CB);
    ctx.view = new WorldMapRenderer(ctx);
    ctx.panels = new WorldMapPanels(ctx);
    ctx.input = new WorldMapInput(ctx);
    ctx.net = { loadMapViewport: async () => {} } as WorldMapContext['net'];
    ctx.view.build();
    ctx.me = { joined: true, mainBaseTile, troops: 10, troopCap: 100, territoryCount: 1, resources: {}, yieldRate: {} } as WorldMapContext['me'];
    return ctx;
  }

  it('clicking the rendered home button recenters the viewport on the real base tile', () => {
    const ctx = buildScene(`${WORLD_ID}:${BASE.x}:${BASE.y}`);
    // Start centered somewhere else entirely, then confirm the click actually moves us.
    ctx.view.centerAt(200, 200);
    const screenCx = ctx.w / 2;
    const screenCy = (ctx.topInset + ctx.h - HUD_H) / 2;
    expect(ctx.view.screenToTile(screenCx, screenCy)).not.toEqual({ x: BASE.x, y: BASE.y });

    ctx.panels.renderHud();
    const r = ctx.homeBtnRect;
    expect(r.w).toBeGreaterThan(0); // sanity: the real render actually produced a clickable rect
    ctx.input.handleDown(r.x + r.w / 2, r.y + r.h / 2);

    expect(ctx.view.screenToTile(screenCx, screenCy)).toEqual({ x: BASE.x, y: BASE.y });
  });

  it('has no clickable home rect (and a click there is a no-op) before a base is placed', () => {
    const ctx = buildScene(undefined);
    ctx.view.centerAt(200, 200);
    ctx.panels.renderHud();
    expect(ctx.homeBtnRect).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    const screenCx = ctx.w / 2;
    const screenCy = (ctx.topInset + ctx.h - HUD_H) / 2;
    const before = ctx.view.screenToTile(screenCx, screenCy);
    // Clicking where the button would have been (top-right cluster of the header) changes nothing.
    ctx.input.handleDown(ctx.w - 60, ctx.topInset / 2);
    expect(ctx.view.screenToTile(screenCx, screenCy)).toEqual(before);
  });
});
