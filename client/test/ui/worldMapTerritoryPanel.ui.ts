// Regression coverage for the Territory Overview panel (SLG_DESIGN.md §26): tapping the header
// resource cluster opens a 2-tab modal — Overview (production/storage/troops/territory count/season)
// and Territory (level-filter checkbox grid + scrollable list of owned tiles with Jump/Abandon).
//
// Mirrors the "hand-rolled minimal WorldMapContext" pattern used by worldMapInfoScroll.ui.ts /
// worldMapHeaderProduction.ui.ts — only the fields the code under test actually reads are populated.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { WorldTileView } from '../../src/net/WorldApiClient';

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

function makeTerritories(): WorldTileView[] {
  return [
    { x: 1, y: 1, type: 'territory', level: 1, garrison: 5 },
    { x: 2, y: 2, type: 'territory', level: 1, garrison: 7 },
    { x: 3, y: 3, type: 'territory', level: 2, garrison: 9 },
  ];
}

function buildHarness(opts: {
  territoryTab?: 'overview' | 'list';
  territories?: WorldTileView[];
  joined?: boolean;
  refreshTerritories?: () => Promise<void>;
  doAbandonFromList?: (x: number, y: number) => Promise<void>;
} = {}) {
  const centerAt = vi.fn();
  const renderMap = vi.fn();
  const refreshTerritories = opts.refreshTerritories ?? vi.fn(async () => {});
  const doAbandonFromList = opts.doAbandonFromList ?? vi.fn(async () => {});

  const ctx = {
    w: W, h: H,
    modalLayer: new PIXI.Container(),
    toastLayer: new PIXI.Container(),
    modalBtnRects: [],
    modalDimRect: null,
    infoScrollRect: null,
    infoScrollY: 0,
    infoMaxScroll: 0,
    infoScrollRerender: null,
    infoScrollDragging: false,
    infoScrollDragMoved: false,
    infoScrollDragStartY: 0,
    infoScrollDragStartScroll: 0,
    territoryPanelOpen: false,
    territoryTab: opts.territoryTab ?? 'overview',
    territories: opts.territories ?? [],
    territoryHiddenLevels: new Set<number>(),
    season: null,
    selectedTile: null,
    trainPanelOpen: false,
    toastTimer: 0,
    me: opts.joined === false ? { joined: false } : {
      joined: true,
      resources: { ink: 100, paper: 200, graphite: 300, metal: 400, sticker: 500 },
      yieldRate: { ink: 12, paper: 7, graphite: 3, metal: 20, sticker: 1 },
      troops: 320, troopCap: 800, territoryCount: 12,
    },
    cb: { accountId: 'me', getCoins: () => 999 },
    view: { renderMap, centerAt },
    net: { refreshTerritories, doAbandonFromList },
    // Header/HUD hit-rects WorldMapInput.handleDown checks before resClusterRect — zeroed so a
    // click aimed at resClusterRect doesn't accidentally match one of these first.
    topInset: 0,
    dragging: false, dragMoved: false, dragStartX: 0, dragStartY: 0, panX: 0, panY: 0,
    resClusterRect: { x: 0, y: 0, w: 0, h: 0 },
    zoomBtnRect: { x: 0, y: 0, w: 0, h: 0 },
    infoBtnRect: { x: 0, y: 0, w: 0, h: 0 },
    backRect: { x: 0, y: 0, w: 0, h: 0 },
    aucBtnRect: { x: 0, y: 0, w: 0, h: 0 },
    marchBadgeRect: { x: 0, y: 0, w: 0, h: 0 },
    chatBarRect: { x: 0, y: 0, w: 0, h: 0 },
    marchRowRects: [],
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  (ctx as unknown as { panels: WorldMapPanels }).panels = panels;
  const input = new WorldMapInput(ctx);
  return { ctx, panels, input, centerAt, renderMap, refreshTerritories, doAbandonFromList };
}

describe('WorldMapPanels.openTerritoryPanel', () => {
  it('opens the panel on the Overview tab when the player has joined', () => {
    const { ctx, panels } = buildHarness();
    panels.openTerritoryPanel();
    expect(ctx.territoryPanelOpen).toBe(true);
    expect(ctx.territoryTab).toBe('overview');
    expect(ctx.modalDimRect).not.toBeNull();
  });

  it('shows a toast instead of opening when the player has not joined yet', () => {
    const { ctx, panels } = buildHarness({ joined: false });
    panels.openTerritoryPanel();
    expect(ctx.territoryPanelOpen).toBe(false);
    expect(ctx.toastTimer).toBeGreaterThan(0);
  });
});

describe('WorldMapPanels.renderTerritoryPanel — Overview tab', () => {
  it('renders without a scrollable list (pure stat display)', () => {
    const { ctx, panels } = buildHarness({ territoryTab: 'overview' });
    panels.renderTerritoryPanel();
    expect(ctx.modalDimRect).not.toBeNull();
    expect(ctx.infoScrollRect).toBeNull();
  });

  it('switching to the Territory tab (list) triggers a fresh fetch', () => {
    const { ctx, panels, refreshTerritories } = buildHarness({ territoryTab: 'overview' });
    panels.renderTerritoryPanel();
    const listTabAction = ctx.modalBtnRects[1]?.action;
    expect(listTabAction).toBeTruthy();
    listTabAction!();
    expect(ctx.territoryTab).toBe('list');
    expect(refreshTerritories).toHaveBeenCalledTimes(1);
  });
});

describe('WorldMapPanels.renderTerritoryPanel — Territory (list) tab', () => {
  it('renders one Jump + one Abandon button per visible row, plus tab/checkbox/close buttons', () => {
    const { ctx, panels } = buildHarness({ territoryTab: 'list', territories: makeTerritories() });
    panels.renderTerritoryPanel();
    // 2 tabs + 2 level checkboxes (levels 1,2) + 3 rows × 2 buttons + 1 close = 11
    expect(ctx.modalBtnRects).toHaveLength(11);
  });

  it('an empty territory list shows the empty-state text instead of any row buttons', () => {
    const { ctx, panels } = buildHarness({ territoryTab: 'list', territories: [] });
    panels.renderTerritoryPanel();
    // 2 tabs + 0 checkboxes (no levels present) + 0 rows + 1 close
    expect(ctx.modalBtnRects).toHaveLength(3);
  });

  it('unchecking a level filters its rows out of the list (button count drops accordingly)', () => {
    const { ctx, panels } = buildHarness({ territoryTab: 'list', territories: makeTerritories() });
    panels.renderTerritoryPanel();
    expect(ctx.modalBtnRects).toHaveLength(11);

    // Checkbox buttons are pushed right after the 2 tab buttons: index 2 = Lv.1, index 3 = Lv.2.
    const lvl1Checkbox = ctx.modalBtnRects[2]?.action;
    expect(lvl1Checkbox).toBeTruthy();
    lvl1Checkbox!();

    expect(ctx.territoryHiddenLevels.has(1)).toBe(true);
    // Re-rendered internally: 2 tabs + 2 checkboxes + 1 remaining row (level 2) × 2 + 1 close = 7.
    expect(ctx.modalBtnRects).toHaveLength(7);
  });

  it('re-checking a hidden level brings its rows back', () => {
    const { ctx, panels } = buildHarness({ territoryTab: 'list', territories: makeTerritories() });
    panels.renderTerritoryPanel();
    ctx.modalBtnRects[2]!.action(); // hide level 1
    expect(ctx.modalBtnRects).toHaveLength(7);
    ctx.modalBtnRects[2]!.action(); // toggle level 1 again (still at index 2 post re-render)
    expect(ctx.territoryHiddenLevels.has(1)).toBe(false);
    expect(ctx.modalBtnRects).toHaveLength(11);
  });

  it('Jump centers the map on that tile and closes the modal', () => {
    const single = [{ x: 9, y: 4, type: 'territory' as const, level: 1, garrison: 3 }];
    const { ctx, panels, centerAt, renderMap } = buildHarness({ territoryTab: 'list', territories: single });
    panels.renderTerritoryPanel();
    // 2 tabs + 1 checkbox (single level) + 1 row (jump, abandon) + 1 close = index 3 is Jump.
    const jumpAction = ctx.modalBtnRects[3]?.action;
    expect(jumpAction).toBeTruthy();
    jumpAction!();
    expect(centerAt).toHaveBeenCalledWith(9, 4);
    expect(renderMap).toHaveBeenCalled();
    expect(ctx.modalDimRect).toBeNull();
    expect(ctx.territoryPanelOpen).toBe(false);
  });

  it('Abandon delegates to net.doAbandonFromList without closing the modal itself', () => {
    const single = [{ x: 9, y: 4, type: 'territory' as const, level: 1, garrison: 3 }];
    const { ctx, panels, doAbandonFromList } = buildHarness({ territoryTab: 'list', territories: single });
    panels.renderTerritoryPanel();
    // index 4 is Abandon (right after Jump at index 3).
    const abandonAction = ctx.modalBtnRects[4]?.action;
    expect(abandonAction).toBeTruthy();
    abandonAction!();
    expect(doAbandonFromList).toHaveBeenCalledWith(9, 4);
  });
});

describe('WorldMapInput — header resource cluster opens the Territory Overview panel', () => {
  it('a tap inside resClusterRect calls openTerritoryPanel', () => {
    const { ctx, input } = buildHarness();
    ctx.resClusterRect = { x: 100, y: 10, w: 200, h: 40 };
    const spy = vi.spyOn(ctx.panels, 'openTerritoryPanel');
    input.handleDown(150, 20);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a tap outside resClusterRect does not open the panel', () => {
    const { ctx, input } = buildHarness();
    ctx.resClusterRect = { x: 100, y: 10, w: 200, h: 40 };
    const spy = vi.spyOn(ctx.panels, 'openTerritoryPanel');
    input.handleDown(5, 5);
    expect(spy).not.toHaveBeenCalled();
  });
});
