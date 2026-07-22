// Regression coverage for the 2026-07-16 fix: at zoom level 3 (the map-overview zoom tier),
// the player's main-city sprite used to detach from the map and appear to drift with the
// camera instead of tracking its map tile ("主城脱离地图，随视角移动"). Two independent bugs
// combined to cause this:
//
//  1. WorldMapRenderer/fog.ts's renderMapL3() (the L3 batched background) hardcoded
//     `const tp = 20` instead of reading the live `ctx.tp` (=27 at zoom 3, per zoom.ts's
//     makeZoomCfgs) — a stale constant left over from an earlier tuning pass, out of sync
//     with every other L3 layer (city sprites, overlay, fog), which all read `ctx.tp`.
//  2. WorldMapInput.handleMove (drag-to-pan) and WorldMapRenderer/pool.ts's invalidatePool()
//     both short-circuit the L1/L2 tile-pool refresh at zoom 3 (it's not used — L3 draws a
//     single batched Graphics object instead), but that short-circuit also skipped
//     refreshCityLayer(), which is what repositions the city sprite's screen x/y. So the
//     city sprite's container coordinates stayed frozen at whatever they were last computed
//     at, while the L3 background scrolled underneath via panX/panY — the city visually
//     stuck to the viewport instead of the map.
//
// Builds a REAL WorldMapContext + WorldMapRenderer + WorldMapPanels + WorldMapInput (mirrors
// WorldMapScene's own wiring, minus WorldMapNet — no network calls are exercised), so the
// mixin chain (build/viewport/pool/city/fog/lifecycle) runs exactly as in production. Runs
// under the headless PIXI adapter (vitest.ui.config.ts setupFiles); binary asset imports
// (including the city atlas PNG) are stubbed to a 1×1 data URI so loadCityAtlas() resolves
// without a real renderer.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { ILayout } from '../../src/layout/ILayout';
import type { WorldTileView } from '../../src/net/WorldApiClient';

// cityAtlasLoader's real loadCityAtlas() awaits an Image `onload` event that the headless
// PIXI adapter's stub Image never fires (see test/harness/pixiHeadless.ts) — it would hang
// forever. City-sprite positioning doesn't depend on real pixel content, so stub the atlas
// as already-loaded with a throwaway 1×1 texture, same spirit as the binary-asset stub.
vi.mock('../../src/render/cityAtlasLoader', () => ({
  isCityAtlasReady: () => true,
  getCityTextureForLevel: () => PIXI.Texture.WHITE,
  getCityContentTopFracForLevel: () => 0,
}));

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
  worldId: 'w1', playerName: 'dbg', accountId: 'acc_dbg',
};

/** A real scene wiring (WorldMapScene's own constructor, minus WorldMapNet — no network). */
function buildScene(): WorldMapContext {
  const ctx = new WorldMapContext(LAYOUT, CB);
  ctx.view = new WorldMapRenderer(ctx);
  ctx.panels = new WorldMapPanels(ctx);
  ctx.input = new WorldMapInput(ctx);
  // setZoom() fires off ctx.net.loadMapViewport() — a real WorldMapNet would hit the network,
  // which this test doesn't exercise; stub the one method the zoom path calls.
  ctx.net = { loadMapViewport: async () => {} } as WorldMapContext['net'];
  ctx.view.build();
  return ctx;
}

/** Marks a 3×3 same-owner base footprint (ADR-025) centered on (cx,cy) so isBaseAnchor(cx,cy)
 *  is true and refreshCityLayer() draws exactly one city sprite, keyed `${cx}:${cy}`. */
function placeBase(ctx: WorldMapContext, cx: number, cy: number): void {
  const tile = (x: number, y: number): WorldTileView =>
    ({ x, y, type: 'base', level: 1, mine: true, occupied: true } as WorldTileView);
  for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    ctx.tileCache.set(`${cx + dx}:${cy + dy}`, tile(cx + dx, cy + dy));
  }
}

describe('WorldMap zoom-3 city anchoring (2026-07-16 regression)', () => {
  it('city sprite tracks a drag-pan at zoom level 3 (bug: panning skipped refreshCityLayer)', () => {
    const ctx = buildScene();
    placeBase(ctx, 200, 200);
    ctx.view.setZoom(3);
    ctx.view.centerAt(200, 200);
    ctx.view.invalidatePool();

    const before = ctx.citySprites.get('200:200');
    expect(before).toBeTruthy();
    const x0 = before!.x;
    const y0 = before!.y;

    // Drive the real drag-to-pan input path (not a direct ctx.panX mutation).
    ctx.input.handleDown(500, 400);
    ctx.input.handleMove(800, 550); // drag delta: dx=300, dy=150

    const after = ctx.citySprites.get('200:200')!;
    // Before the fix, the city container's x/y never updated at zoom 3, so this delta was 0.
    expect(after.x - x0).toBeCloseTo(300);
    expect(after.y - y0).toBeCloseTo(150);
  });

  it('a data-refresh (invalidatePool, e.g. after a tile-update push) repositions the city sprite at zoom 3', () => {
    const ctx = buildScene();
    placeBase(ctx, 100, 100);
    ctx.view.setZoom(3);
    ctx.view.centerAt(100, 100);
    ctx.view.invalidatePool();

    const before = ctx.citySprites.get('100:100');
    expect(before).toBeTruthy();
    const x0 = before!.x;
    const y0 = before!.y;

    // Simulate the camera having moved by some other path (e.g. centerAt after a march-focus
    // jump), then a data refresh arriving — invalidatePool() is the shared entry point both
    // "new tile data" and "zoom just switched to 3" go through.
    ctx.panX += 40;
    ctx.panY += 20;
    ctx.view.invalidatePool();

    const after = ctx.citySprites.get('100:100')!;
    expect(after.x - x0).toBeCloseTo(40);
    expect(after.y - y0).toBeCloseTo(20);
  });

  it('renderMapL3 reads the live ctx.tp instead of a stale hardcoded tile size (regression: was `const tp = 20`)', () => {
    const ctx = buildScene();
    ctx.view.setZoom(3);
    expect(ctx.tp).toBe(27); // L3 tile size per zoom.ts's makeZoomCfgs — locks in the value the bug's hardcoded `20` drifted from

    let tpReads = 0;
    const realTp = ctx.tp;
    // Shadow the prototype's `get tp()` on this instance — proves renderMapL3 actually reads
    // ctx.tp at call time rather than closing over a local literal.
    Object.defineProperty(ctx, 'tp', { configurable: true, get: () => { tpReads++; return realTp; } });

    ctx.view.renderMapL3();
    expect(tpReads).toBeGreaterThan(0);
  });
});
