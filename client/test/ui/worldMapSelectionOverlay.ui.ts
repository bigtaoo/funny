// What the selected-tile highlight actually DRAWS (2026-08-30 whole-plot selection).
//
// test/worldMapSelectionPlot.test.ts already pins `selectedPlot()`'s arithmetic, but nothing pinned
// the renderer that consumes it — and the interesting failure modes all live on that seam, where the
// pure tests stay green:
//   • `diamondPath(tp)` instead of `diamondPath(tp * plot.size)` — right anchor, one-tile diamond,
//     i.e. exactly the bug this change fixed, silently restored.
//   • `tileToScreen(tx, ty)` instead of `tileToScreen(plot.ax, plot.ay)` — right SIZE, but centred on
//     whichever cell the finger landed on, so tapping a corner draws the plot off by a tile.
//   • the multi-cell fill guard dropped — a 0.15 yellow wash you can barely see over one tile of
//     ground becomes a tint over a whole 9×9 capital, because the overlay draws above `cityLayer`.
//
// Real scene wiring (WorldMapContext + WorldMapRenderer), same harness shape as
// worldMapRefreshBundle.ui.ts. With no nations / marches / stationed in the fixture, the selection
// highlight is the ONLY thing in renderOverlay that reaches `drawPolygon` (the frontier and garrison
// zones stroke through drawDashedPolygon's moveTo/lineTo, capital stars through drawStar), so a
// single spied call is an unambiguous witness.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { BASE_FOOTPRINT } from '@nw/shared';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { tileToScreen } from '../../src/render/isoGrid';
import type { ILayout } from '../../src/layout/ILayout';
import type { WorldCityNodeView, WorldTileView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const LAYOUT = { designWidth: 1280, designHeight: 800 } as ILayout;
const CB: WorldMapCallbacks = {
  onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
  onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'],
  worldId: 'w1', playerName: 'dbg', accountId: 'acc_dbg', storage: memStore,
};

function newScene(): WorldMapContext {
  const ctx = new WorldMapContext(LAYOUT, CB);
  ctx.view = new WorldMapRenderer(ctx);
  ctx.panels = new WorldMapPanels(ctx); // build() ends with renderHud()
  ctx.net = { loadMapViewport: async () => {} } as WorldMapContext['net'];
  ctx.view.build();
  return ctx;
}

function setTile(ctx: WorldMapContext, x: number, y: number, type: WorldTileView['type']): void {
  ctx.tileCache.set(`${x}:${y}`, { x, y, type, level: 1, mine: true, occupied: true } as WorldTileView);
}

/** The full 9-cell base footprint, so the anchor scan has a genuine anchor to find. */
function placeBase(ctx: WorldMapContext, cx: number, cy: number): void {
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) setTile(ctx, cx + dx, cy + dy, 'base');
}

interface Drawn {
  polygons: number[][];
  fills: number[];
  lineWidths: number[];
}

/**
 * Record the overlay's polygon/fill/stroke calls. Spied AFTER build() (which creates overlayGfx)
 * and BEFORE renderOverlay(), so only this pass is captured.
 */
function recordOverlay(ctx: WorldMapContext): Drawn {
  const out: Drawn = { polygons: [], fills: [], lineWidths: [] };
  const g = ctx.overlayGfx;
  vi.spyOn(g, 'drawPolygon').mockImplementation(function (this: PIXI.Graphics, pts: unknown) {
    out.polygons.push((pts as number[]).slice());
    return this;
  });
  vi.spyOn(g, 'beginFill').mockImplementation(function (this: PIXI.Graphics, color?: unknown) {
    out.fills.push(typeof color === 'number' ? color : 0);
    return this;
  });
  vi.spyOn(g, 'lineStyle').mockImplementation(function (this: PIXI.Graphics, w?: unknown) {
    out.lineWidths.push(typeof w === 'number' ? w : 0);
    return this;
  });
  return out;
}

/** Axis extents of a flat [x,y,x,y,...] point list. */
function bounds(pts: number[]): { w: number; h: number; cx: number; cy: number } {
  const xs = pts.filter((_, i) => i % 2 === 0);
  const ys = pts.filter((_, i) => i % 2 === 1);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  return { w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

describe('selection highlight — diamond size follows the PLOT, not the tapped cell', () => {
  it('a plain tile draws one tile-wide diamond', () => {
    const ctx = newScene();
    setTile(ctx, 100, 100, 'territory');
    ctx.selectedTile = { x: 100, y: 100 };
    const drawn = recordOverlay(ctx);
    ctx.view.renderOverlay();

    expect(drawn.polygons).toHaveLength(1);
    expect(bounds(drawn.polygons[0]!).w).toBeCloseTo(ctx.tp, 5);
  });

  it('a base draws a diamond BASE_FOOTPRINT tiles across — a one-tile diamond here is the old bug', () => {
    const ctx = newScene();
    placeBase(ctx, 100, 100);
    ctx.selectedTile = { x: 100, y: 100 };
    const drawn = recordOverlay(ctx);
    ctx.view.renderOverlay();

    expect(drawn.polygons).toHaveLength(1);
    expect(bounds(drawn.polygons[0]!).w).toBeCloseTo(ctx.tp * BASE_FOOTPRINT, 5);
  });

  it("a wild city draws a diamond as wide as its own footprint, not a fixed size", () => {
    const ctx = newScene();
    const city = { x: 200, y: 200, footprint: 9, kind: 'capital' } as WorldCityNodeView;
    ctx.cityNodes = [city];
    setTile(ctx, 203, 202, 'familyKeep');
    ctx.selectedTile = { x: 203, y: 202 };
    const drawn = recordOverlay(ctx);
    ctx.view.renderOverlay();

    expect(drawn.polygons).toHaveLength(1);
    expect(bounds(drawn.polygons[0]!).w).toBeCloseTo(ctx.tp * 9, 5);
  });

  it('tapping a base CORNER still centres the diamond on the anchor, not on the tapped cell', () => {
    // The size-only half of the fix would pass every assertion above while drawing a correctly-sized
    // plot one tile off-centre — this is the assertion that separates the two.
    const ctx = newScene();
    placeBase(ctx, 100, 100);
    ctx.view.centerAt(100, 100);
    ctx.selectedTile = { x: 99, y: 99 };
    const drawn = recordOverlay(ctx);
    ctx.view.renderOverlay();

    const anchor = tileToScreen(100, 100, ctx.tp);
    const b = bounds(drawn.polygons[0]!);
    expect(b.cx).toBeCloseTo(ctx.panX + anchor.x, 5);
    expect(b.cy).toBeCloseTo(ctx.panY + anchor.y, 5);
  });

  it('nothing selected draws no highlight at all', () => {
    const ctx = newScene();
    setTile(ctx, 100, 100, 'territory');
    ctx.selectedTile = null;
    const drawn = recordOverlay(ctx);
    ctx.view.renderOverlay();

    expect(drawn.polygons).toHaveLength(0);
  });
});

describe('selection highlight — fill is single-tile only', () => {
  it('a single tile keeps its translucent fill', () => {
    const ctx = newScene();
    setTile(ctx, 100, 100, 'territory');
    ctx.selectedTile = { x: 100, y: 100 };
    const drawn = recordOverlay(ctx);
    ctx.view.renderOverlay();

    expect(drawn.fills).toContain(0xffff00);
  });

  it('a multi-tile plot is outline-only — a fill here would tint the whole building', () => {
    const ctx = newScene();
    placeBase(ctx, 100, 100);
    ctx.selectedTile = { x: 100, y: 100 };
    const drawn = recordOverlay(ctx);
    ctx.view.renderOverlay();

    expect(drawn.fills).not.toContain(0xffff00);
    // ...and it compensates with a heavier stroke, since the outline is now carrying the whole signal.
    expect(Math.max(...drawn.lineWidths)).toBeGreaterThanOrEqual(3);
  });
});
