// Regression coverage for the world-info nations list not being scrollable: overflow rows used to
// be silently skipped (`if (ly > bodyBottom) break`), so a long nations list was partly
// unreachable — no way to see or tap rows past the fold. Fix: PIXI-masked scroll region
// (WorldMapPanels.beginScrollList/panelButtonIn) + drag-to-scroll and mouse-wheel input wired
// through WorldMapInput (handleDown/handleMove/handleUp/handleWheel).
//
// The standalone world-info button/modal (renderInfoPanel) was folded into the Territory Overview
// panel as its third tab — 'world' (SLG_DESIGN_LOG.md §26 / world-tab merge). That tab originally
// held three nations/season/shop sub-tabs; the shop sub-tab was pulled out into its own standalone
// panel and the nations/season split was dropped in the same pass (2026-08-02, see
// SLG_DESIGN_LOG.md) since only two sections were left — season is now a short static summary
// pinned above the scrollable nations list, both always visible together under the World tab
// (WorldMapPanels.renderWorldTabBody). Shop coverage now lives in worldMapShopPanel.ui.ts.
//
// Tests build a minimal hand-rolled WorldMapContext (only the fields renderTerritoryPanel /
// renderWorldTabBody / handle* actually read — TS field privacy is erased at runtime) rather than a
// full WorldMapScene, since the scroll logic doesn't touch tile cache / net / zoom. Mirrors the
// "verifying a single UI-rendering method" pattern used for WorldMapPanels.showModal() during manual
// debugging.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { NationView, SeasonView } from '../../src/net/WorldApiClient';

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

/** Same as makeNations, but capital #0 is owned by 'me' — the only way a Rename button (rather
 *  than a plain owned/free status label) appears in the list, for the tap-vs-drag tests below. */
function makeNationsOneMine(n: number): NationView[] {
  const list = makeNations(n);
  list[0] = { ...list[0], ownerId: 'me' };
  return list;
}

/** Builds a fake ctx + real WorldMapPanels/WorldMapInput wired against it. Only the fields
 *  renderTerritoryPanel / renderWorldTabBody / beginScrollList / panelButton(In) / closeModal /
 *  handleDown/Move/Up/Wheel actually touch are populated — enough to drive the scroll code paths
 *  headlessly. territoryTab is pinned to 'world' so renderTerritoryPanel dispatches to the folded-in
 *  world-info body (season summary + nations list, merged). */
function buildHarness(opts: { nations?: NationView[]; season?: SeasonView | null } = {}) {
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
    // Territory Overview panel, world tab (hosts the merged season summary + nations list under test).
    me: { joined: true },
    territoryPanelOpen: true,
    territoryTab: 'world',
    territories: [],
    territoryHiddenLevels: new Set<number>(),
    nations: opts.nations ?? [],
    season: opts.season ?? null,
    shopItems: [],
    selectedTile: null,
    hiddenInput: null,
    cb: { accountId: 'me', getCoins: () => 999 },
    view: { renderMap: () => {} },
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  (ctx as unknown as { panels: WorldMapPanels }).panels = panels;
  const input = new WorldMapInput(ctx);
  return { ctx, panels, input };
}

/** All PIXI.Text strings drawn directly into the modal layer (not inside a masked scroll-list
 *  child container) — enough to assert the static season summary's content without needing to
 *  parse layout. */
function modalTexts(ctx: WorldMapContext): string[] {
  return (ctx.modalLayer.children as PIXI.DisplayObject[])
    .filter((c): c is PIXI.Text => c instanceof PIXI.Text)
    .map((t) => t.text);
}

describe('WorldMapPanels.renderTerritoryPanel (world tab) — nations + season merged, scroll region setup', () => {
  it('a long nations list sets a scroll rect and a positive max scroll', () => {
    const { ctx, panels } = buildHarness({ nations: makeNations(20) });
    panels.renderTerritoryPanel();
    expect(ctx.infoScrollRect).not.toBeNull();
    expect(ctx.infoMaxScroll).toBeGreaterThan(0);
  });

  it('a short nations list that fits has no scroll room (maxScroll stays 0)', () => {
    const { ctx, panels } = buildHarness({ nations: makeNations(2) });
    panels.renderTerritoryPanel();
    expect(ctx.infoScrollRect).not.toBeNull();
    expect(ctx.infoMaxScroll).toBe(0);
  });

  it('an empty nations list has no scrollable list — infoScrollRect stays null (season summary still renders above it)', () => {
    const { ctx, panels } = buildHarness({ nations: [] });
    panels.renderTerritoryPanel();
    expect(ctx.infoScrollRect).toBeNull();
  });

  it('re-rendering after scrolling clamps infoScrollY to the (possibly-shrunk) new maxScroll', () => {
    const { ctx, panels } = buildHarness({ nations: makeNations(20) });
    panels.renderTerritoryPanel();
    ctx.infoScrollY = ctx.infoMaxScroll;
    // Catalog shrinks (e.g. server refresh) — old scrollY must not point past the new bottom.
    ctx.nations = makeNations(3);
    panels.renderTerritoryPanel();
    expect(ctx.infoScrollY).toBe(ctx.infoMaxScroll);
    expect(ctx.infoScrollY).toBeLessThanOrEqual(ctx.infoMaxScroll);
  });
});

describe('WorldMapPanels.renderTerritoryPanel (world tab) — season summary content', () => {
  function makeSeason(overrides: Partial<SeasonView> = {}): SeasonView {
    return {
      worldId: 'w1', season: 3, shard: 0, status: 'active', openAt: 0,
      capacity: 8000, population: 4200, mapW: 1500, mapH: 1500,
      ...overrides,
    };
  }

  it('renders the season number, status, and population above the nations list', () => {
    const { ctx, panels } = buildHarness({ season: makeSeason(), nations: makeNations(2) });
    panels.renderTerritoryPanel();
    const texts = modalTexts(ctx);
    expect(texts).toContain('Season 3');
    expect(texts).toContain('Active');
    expect(texts).toContain('Pop 4200/8000');
  });

  it('shows a reset countdown when resetAt is set, and omits it otherwise', () => {
    const withReset = buildHarness({ season: makeSeason({ resetAt: Date.now() + 5 * 86400000 }) });
    withReset.panels.renderTerritoryPanel();
    expect(modalTexts(withReset.ctx).some((s) => /\d+d to reset/.test(s))).toBe(true);

    const noReset = buildHarness({ season: makeSeason({ resetAt: undefined }) });
    noReset.panels.renderTerritoryPanel();
    expect(noReset.ctx as unknown, 'sanity: distinct ctx per harness').not.toBe(withReset.ctx);
    expect(modalTexts(noReset.ctx).some((s) => /d to reset/.test(s))).toBe(false);
  });

  it('falls back to a placeholder dash when no season data has loaded yet', () => {
    const { ctx, panels } = buildHarness({ season: null });
    panels.renderTerritoryPanel();
    expect(modalTexts(ctx)).toContain('—');
  });

  it('an empty nations list still shows the season summary and the "no nations" empty state', () => {
    const { ctx, panels } = buildHarness({ season: makeSeason(), nations: [] });
    panels.renderTerritoryPanel();
    const texts = modalTexts(ctx);
    expect(texts).toContain('Season 3');
    expect(texts).toContain('No nations yet');
  });
});

describe('WorldMapInput — world-info nations list wheel scroll', () => {
  it('scrolling the wheel inside the list rect moves and clamps infoScrollY', () => {
    const { ctx, panels, input } = buildHarness({ nations: makeNations(20) });
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
    const { ctx, panels, input } = buildHarness({ nations: makeNations(20) });
    panels.renderTerritoryPanel();
    input.handleWheel(0, 0, 100);
    expect(ctx.infoScrollY).toBe(0);
  });

  it('wheel is a no-op when no scrollable list is on screen (infoScrollRect null)', () => {
    const { ctx, panels, input } = buildHarness({ nations: [] });
    panels.renderTerritoryPanel();
    expect(() => input.handleWheel(400, 300, 100)).not.toThrow();
    expect(ctx.infoScrollY).toBe(0);
  });
});

describe('WorldMapInput — world-info nations list drag-to-scroll', () => {
  it('dragging up inside the list moves infoScrollY forward, clamped to infoMaxScroll', () => {
    const { ctx, panels, input } = buildHarness({ nations: makeNations(20) });
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
    const { ctx, panels, input } = buildHarness({ nations: makeNations(20) });
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
    const { ctx, panels, input } = buildHarness({ nations: makeNations(20) });
    panels.renderTerritoryPanel();
    const sr = ctx.infoScrollRect!;
    const midX = sr.x + sr.w / 2, midY = sr.y + sr.h / 2;

    input.handleDown(midX, midY);
    input.handleMove(midX, midY - 3);
    expect(ctx.infoScrollY).toBe(0);
  });

  it('a tap-and-release inside the list (no drag) does not close the modal', () => {
    const { ctx, panels, input } = buildHarness({ nations: makeNations(20) });
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
    const { ctx, input } = buildHarness({ nations: makeNations(20) });
    // Force a render so infoScrollRect/modalBtnRects are populated for a click well above the list.
    (input as unknown as { ctx: WorldMapContext }).ctx.panels.renderTerritoryPanel();
    input.handleDown(1, 1);
    expect(ctx.modalDimRect).toBeNull();
  });
});

// The nations list carries a tappable Rename button (for the capital the player owns) INSIDE the
// scroll region. That button lives in modalBtnRects, which handleDown used to fire on pointer-DOWN
// before the scroll branch ran — so a drag that started on Rename fired it instead of scrolling.
// The fix: a press inside infoScrollRect captures any in-list button hit as ctx.infoScrollPendingTap
// and fires it on pointer-UP only if the pointer never dragged past the threshold.
describe('WorldMapInput — in-list button tap-vs-drag (infoScrollPendingTap)', () => {
  /** Renders the nations list and returns the centre of the (sole) Rename button + the ctx.
   *  openRenameInput itself (document.createElement + a floating <input>) isn't under test here —
   *  it's stubbed so this suite doesn't need a DOM global — only whether the tap/drag gesture
   *  routes to it at all. */
  function nationsHarness() {
    const { ctx, panels, input } = buildHarness({ nations: makeNationsOneMine(15) });
    panels.renderTerritoryPanel();
    const openRenameInput = vi.spyOn(panels, 'openRenameInput').mockImplementation(() => {});
    const sr = ctx.infoScrollRect!;
    const inSr = (r: { x: number; y: number; w: number; h: number }): boolean => {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      return cx >= sr.x && cx <= sr.x + sr.w && cy >= sr.y && cy <= sr.y + sr.h;
    };
    const renameBtn = ctx.modalBtnRects.find((b) => inSr(b.rect))!;
    expect(renameBtn, 'no Rename button rect inside the scroll region').toBeTruthy();
    return { ctx, input, openRenameInput, cx: renameBtn.rect.x + renameBtn.rect.w / 2, cy: renameBtn.rect.y + renameBtn.rect.h / 2 };
  }

  it('a tap (down+up, no drag) on the in-list Rename button opens the rename input', () => {
    const { input, openRenameInput, cx, cy } = nationsHarness();
    input.handleDown(cx, cy);
    input.handleUp(cx, cy);
    expect(openRenameInput).toHaveBeenCalledTimes(1);
  });

  it('a drag that STARTS on the in-list Rename button scrolls the list and does NOT open the rename input', () => {
    const { ctx, input, openRenameInput, cx, cy } = nationsHarness();
    input.handleDown(cx, cy);
    input.handleMove(cx, cy - 40); // past the 6px drag threshold
    input.handleUp(cx, cy - 40);
    expect(openRenameInput).not.toHaveBeenCalled();
    expect(ctx.infoScrollY).toBe(40); // the gesture scrolled instead
  });

  it('closeModal clears a pending in-list tap so it cannot fire against the next panel', () => {
    const { ctx, input, openRenameInput, cx, cy } = nationsHarness();
    input.handleDown(cx, cy); // pending tap captured, not yet released
    ctx.panels.closeModal();
    expect((ctx as unknown as { infoScrollPendingTap: unknown }).infoScrollPendingTap).toBeNull();
    input.handleUp(cx, cy);
    expect(openRenameInput).not.toHaveBeenCalled();
  });
});

describe('WorldMapPanels — closing the modal clears stale scroll state', () => {
  it('closeModal() nulls out infoScrollRect so a later tap in that screen area is not swallowed', () => {
    const { ctx, panels } = buildHarness({ nations: makeNations(20) });
    panels.renderTerritoryPanel();
    expect(ctx.infoScrollRect).not.toBeNull();
    panels.closeModal();
    expect(ctx.infoScrollRect).toBeNull();
  });
});
