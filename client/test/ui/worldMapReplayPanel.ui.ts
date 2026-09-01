// Regression coverage for the "battle replays" browser (WorldMapPanels.renderReplayPanel): the
// (x,y) coordinate on each row is its own clickable label that jumps the camera to that tile
// and closes the modal — same jump pattern as the Territory Overview list's territoryJump button
// and the marches list (WorldMapInput.ts). Added alongside that feature.
//
// Mirrors the "hand-rolled minimal WorldMapContext" harness pattern used by worldMapTerritoryPanel.ui.ts.
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles).

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { SiegeSummaryView } from '../../src/net/WorldApiClient';

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

function makeSieges(): SiegeSummaryView[] {
  return [
    { siegeId: 's1', tile: 'w1:34:293', tileLevel: 2, outcome: 'attacker_win', role: 'attacker', ts: 1000, hasReplay: true },
    { siegeId: 's2', tile: 'w1:34:292', tileLevel: 2, outcome: 'defender_win', role: 'attacker', ts: 900, hasReplay: false },
  ];
}

function buildHarness(sieges: SiegeSummaryView[] = makeSieges()) {
  const centerAt = vi.fn();
  const renderMap = vi.fn();
  const onReplaySiege = vi.fn();

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
    replayPanelOpen: false,
    sieges,
    selectedTile: null,
    toastTimer: 0,
    me: { joined: true },
    cb: { accountId: 'me', getCoins: () => 999, onReplaySiege, worldApi: { listSieges: vi.fn(async () => sieges) }, worldId: 'w1' },
    view: { renderMap, centerAt },
    topInset: 0,
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  (ctx as unknown as { panels: WorldMapPanels }).panels = panels;
  return { ctx, panels, centerAt, renderMap, onReplaySiege };
}

describe('WorldMapPanels.renderReplayPanel — coordinate jump', () => {
  it('registers a clickable rect over each row\'s (x,y) coordinate that jumps the camera and closes the modal', () => {
    const { ctx, centerAt, renderMap } = buildHarness();
    ctx.panels.renderReplayPanel();

    // Two rows, each contributing a coordinate-jump rect ahead of any replay-button rect.
    expect(ctx.modalBtnRects.length).toBeGreaterThanOrEqual(2);

    const firstRowAction = ctx.modalBtnRects[0]!.fn;
    firstRowAction();

    expect(centerAt).toHaveBeenCalledWith(34, 293);
    expect(renderMap).toHaveBeenCalled();
    expect(ctx.modalDimRect).toBeNull(); // closeModal() ran
    expect(ctx.replayPanelOpen).toBe(false);
  });

  it('jumps to the second row\'s own coordinate, independent of the first', () => {
    const { ctx, centerAt } = buildHarness();
    ctx.panels.renderReplayPanel();

    // Row 1 (hasReplay: true) registers coord-jump + replay-button rects; row 2 (hasReplay: false)
    // registers only its coord-jump rect; the panel's own Close button is last — so row 2's jump is
    // the third rect overall.
    expect(ctx.modalBtnRects.length).toBe(4);
    const secondRowAction = ctx.modalBtnRects[2]!.fn;
    secondRowAction();

    expect(centerAt).toHaveBeenCalledWith(34, 292);
  });
});
