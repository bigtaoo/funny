// Regression coverage for the world-info nations/shop lists not being scrollable: overflow rows
// used to be silently skipped (`if (ly > bodyBottom) break`), so a long nations/shop list was
// partly unreachable — no way to see or tap rows past the fold. Fix: PIXI-masked scroll region
// (WorldMapPanels.beginScrollList/panelButtonIn) + drag-to-scroll and mouse-wheel input wired
// through WorldMapInput (handleDown/handleMove/handleUp/handleWheel).
//
// The standalone world-info button/modal (renderInfoPanel) was folded into the Territory Overview
// panel as its third tab — 'world' (SLG_DESIGN_LOG.md §26 / world-tab merge). The nations/season/shop
// sub-tabs and their scroll behavior now live in WorldMapPanels.renderWorldTabBody, reached by
// calling renderTerritoryPanel() with territoryTab === 'world'. These tests drive that path.
//
// Tests build a minimal hand-rolled WorldMapContext (only the fields renderTerritoryPanel /
// renderWorldTabBody / handle* actually read — TS field privacy is erased at runtime) rather than a
// full WorldMapScene, since the scroll logic doesn't touch tile cache / net / zoom. Mirrors the
// "verifying a single UI-rendering method" pattern used for WorldMapPanels.showModal() during manual
// debugging.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { NationView, SlgShopItemView } from '../../src/net/WorldApiClient';

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

function makeNations(n: number): NationView[] {
  return Array.from({ length: n }, (_, i) => ({
    capitalIdx: i, x: i, y: i,
    nationName: `Nation${i}`,
    ownerId: i % 3 === 0 ? `acct${i}` : undefined,
  }));
}

function makeShopItems(n: number): SlgShopItemView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `item${i}`, cost: 10 + i, kind: 'resource_pack', effect: { each: 100 }, description: '',
  }));
}

/** Builds a fake ctx + real WorldMapPanels/WorldMapInput wired against it. Only the fields
 *  renderTerritoryPanel / renderWorldTabBody / beginScrollList / panelButton(In) / closeModal /
 *  handleDown/Move/Up/Wheel actually touch are populated — enough to drive the scroll code paths
 *  headlessly. territoryTab is pinned to 'world' so renderTerritoryPanel dispatches to the folded-in
 *  world-info body. */
function buildHarness(opts: { infoTab?: 'nations' | 'season' | 'shop'; nations?: NationView[]; shopItems?: SlgShopItemView[] } = {}) {
  const ctx = {
    w: W, h: H,
    modalLayer: new PIXI.Container(),
    modalBtnRects: [],
    modalDimRect: { x: 0, y: 0, w: W, h: H },
    infoScrollRect: null,
    infoScrollY: 0,
    infoMaxScroll: 0,
    infoScrollRerender: null,
    infoScrollDragging: false,
    infoScrollDragMoved: false,
    infoScrollDragStartY: 0,
    infoScrollDragStartScroll: 0,
    // Territory Overview panel, world tab (hosts the nations/season/shop sub-tabs under test).
    me: { joined: true },
    territoryPanelOpen: true,
    territoryTab: 'world',
    territories: [],
    territoryHiddenLevels: new Set<number>(),
    infoTab: opts.infoTab ?? 'nations',
    nations: opts.nations ?? [],
    season: null,
    shopItems: opts.shopItems ?? [],
    selectedTile: null,
    trainPanelOpen: false,
    cb: { accountId: 'me', getCoins: () => 999 },
    view: { renderMap: () => {} },
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  (ctx as unknown as { panels: WorldMapPanels }).panels = panels;
  const input = new WorldMapInput(ctx);
  return { ctx, panels, input };
}

describe('WorldMapPanels.renderTerritoryPanel (world tab) — scroll region setup', () => {
  it('nations tab: overflowing content sets a scroll rect and a positive max scroll', () => {
    const { ctx, panels } = buildHarness({ infoTab: 'nations', nations: makeNations(20) });
    panels.renderTerritoryPanel();
    expect(ctx.infoScrollRect).not.toBeNull();
    expect(ctx.infoMaxScroll).toBeGreaterThan(0);
  });

  it('nations tab: a short list that fits has no scroll room (maxScroll stays 0)', () => {
    const { ctx, panels } = buildHarness({ infoTab: 'nations', nations: makeNations(2) });
    panels.renderTerritoryPanel();
    expect(ctx.infoScrollRect).not.toBeNull();
    expect(ctx.infoMaxScroll).toBe(0);
  });

  it('shop tab: overflowing catalog also sets a scroll rect and positive max scroll', () => {
    const { ctx, panels } = buildHarness({ infoTab: 'shop', shopItems: makeShopItems(15) });
    panels.renderTerritoryPanel();
    expect(ctx.infoScrollRect).not.toBeNull();
    expect(ctx.infoMaxScroll).toBeGreaterThan(0);
  });

  it('season tab has no scrollable list — infoScrollRect stays null', () => {
    const { ctx, panels } = buildHarness({ infoTab: 'season' });
    panels.renderTerritoryPanel();
    expect(ctx.infoScrollRect).toBeNull();
  });

  it('re-rendering after scrolling clamps infoScrollY to the (possibly-shrunk) new maxScroll', () => {
    const { ctx, panels } = buildHarness({ infoTab: 'nations', nations: makeNations(20) });
    panels.renderTerritoryPanel();
    ctx.infoScrollY = ctx.infoMaxScroll;
    // Catalog shrinks (e.g. server refresh) — old scrollY must not point past the new bottom.
    ctx.nations = makeNations(3);
    panels.renderTerritoryPanel();
    expect(ctx.infoScrollY).toBe(ctx.infoMaxScroll);
    expect(ctx.infoScrollY).toBeLessThanOrEqual(ctx.infoMaxScroll);
  });
});

describe('WorldMapInput — world-info list wheel scroll', () => {
  it('scrolling the wheel inside the list rect moves and clamps infoScrollY', () => {
    const { ctx, panels, input } = buildHarness({ infoTab: 'nations', nations: makeNations(20) });
    panels.renderTerritoryPanel();
    const sr = ctx.infoScrollRect!;
    const midX = sr.x + sr.w / 2, midY = sr.y + sr.h / 2;

    input.handleWheel(midX, midY, 50);
    expect(ctx.infoScrollY).toBe(50);

    // Overshoot past maxScroll must clamp, not overshoot.
    input.handleWheel(midX, midY, 100000);
    expect(ctx.infoScrollY).toBe(ctx.infoMaxScroll);

    // Scrolling back up clamps at 0.
    input.handleWheel(midX, midY, -100000);
    expect(ctx.infoScrollY).toBe(0);
  });

  it('wheel events outside the list rect are ignored', () => {
    const { ctx, panels, input } = buildHarness({ infoTab: 'nations', nations: makeNations(20) });
    panels.renderTerritoryPanel();
    input.handleWheel(0, 0, 100);
    expect(ctx.infoScrollY).toBe(0);
  });

  it('wheel is a no-op when no scrollable list is on screen (infoScrollRect null)', () => {
    const { ctx, input } = buildHarness({ infoTab: 'season' });
    expect(() => input.handleWheel(400, 300, 100)).not.toThrow();
    expect(ctx.infoScrollY).toBe(0);
  });
});

describe('WorldMapInput — world-info list drag-to-scroll', () => {
  it('dragging up inside the list moves infoScrollY forward, clamped to infoMaxScroll', () => {
    const { ctx, panels, input } = buildHarness({ infoTab: 'nations', nations: makeNations(20) });
    panels.renderTerritoryPanel();
    const sr = ctx.infoScrollRect!;
    const midX = sr.x + sr.w / 2, midY = sr.y + sr.h / 2;

    input.handleDown(midX, midY);
    input.handleMove(midX, midY - 40);
    expect(ctx.infoScrollY).toBe(40);

    input.handleMove(midX, midY - 100000);
    expect(ctx.infoScrollY).toBe(ctx.infoMaxScroll);

    input.handleUp(midX, midY - 100000);
    expect(ctx.infoScrollDragging).toBe(false);
  });

  it('dragging back down retreats infoScrollY, clamped to 0', () => {
    const { ctx, panels, input } = buildHarness({ infoTab: 'nations', nations: makeNations(20) });
    panels.renderTerritoryPanel();
    const sr = ctx.infoScrollRect!;
    const midX = sr.x + sr.w / 2, midY = sr.y + sr.h / 2;

    input.handleDown(midX, midY);
    input.handleMove(midX, midY - 40);
    input.handleUp(midX, midY - 40);

    input.handleDown(midX, midY);
    input.handleMove(midX, midY + 1000);
    expect(ctx.infoScrollY).toBe(0);
  });

  it('a small move under the drag threshold does not change infoScrollY', () => {
    const { ctx, panels, input } = buildHarness({ infoTab: 'nations', nations: makeNations(20) });
    panels.renderTerritoryPanel();
    const sr = ctx.infoScrollRect!;
    const midX = sr.x + sr.w / 2, midY = sr.y + sr.h / 2;

    input.handleDown(midX, midY);
    input.handleMove(midX, midY - 3);
    expect(ctx.infoScrollY).toBe(0);
  });

  it('a tap-and-release inside the list (no drag) does not close the modal', () => {
    const { ctx, panels, input } = buildHarness({ infoTab: 'nations', nations: makeNations(20) });
    panels.renderTerritoryPanel();
    const sr = ctx.infoScrollRect!;
    const midX = sr.x + sr.w / 2, midY = sr.y + sr.h / 2;

    input.handleDown(midX, midY);
    input.handleUp(midX, midY);
    // Regression: before the scroll-drag branch existed, any pointer-down inside the modal
    // that missed a button rect fell straight through to closeModal().
    expect(ctx.modalDimRect).not.toBeNull();
  });

  it('a tap outside the list rect (and outside any button) still closes the modal as before', () => {
    const { ctx, input } = buildHarness({ infoTab: 'nations', nations: makeNations(20) });
    // Force a render so infoScrollRect/modalBtnRects are populated for a click well above the list.
    (input as unknown as { ctx: WorldMapContext }).ctx.panels.renderTerritoryPanel();
    input.handleDown(1, 1);
    expect(ctx.modalDimRect).toBeNull();
  });
});

describe('WorldMapPanels — closing the modal clears stale scroll state', () => {
  it('closeModal() nulls out infoScrollRect so a later tap in that screen area is not swallowed', () => {
    const { ctx, panels } = buildHarness({ infoTab: 'nations', nations: makeNations(20) });
    panels.renderTerritoryPanel();
    expect(ctx.infoScrollRect).not.toBeNull();
    panels.closeModal();
    expect(ctx.infoScrollRect).toBeNull();
  });

  it('switching world sub-tabs resets infoScrollY to 0', () => {
    const { ctx, panels } = buildHarness({ infoTab: 'nations', nations: makeNations(20) });
    panels.renderTerritoryPanel();
    ctx.infoScrollY = ctx.infoMaxScroll;
    expect(ctx.infoScrollY).toBeGreaterThan(0);

    // Button order: 3 territory tabs (overview/list/world) are pushed first, then the world-tab
    // sub-tabs in [nations, season, shop] order — so index 5 is the "shop" sub-tab.
    const shopTabAction = ctx.modalBtnRects[5]?.action;
    expect(shopTabAction).toBeTruthy();
    shopTabAction!();
    expect(ctx.infoTab).toBe('shop');
    expect(ctx.infoScrollY).toBe(0);
  });
});
