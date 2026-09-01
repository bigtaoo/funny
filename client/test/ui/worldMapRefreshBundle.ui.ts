// Behavioral regression coverage for the 2026-08-12 WorldMapRenderer composition conversion's
// hoisted "refresh everything" bundle — the NEW indirection that conversion introduced.
//
// Before the conversion, `pool.ts`'s invalidatePool()/refreshPool() called `this.refreshCityLayer()`
// (city.ts) and `this.renderOverlay()` (fog.ts) directly through the mixin chain's shared `this`, so
// every caller of pool.invalidatePool() — build(), setZoom(), bootstrap(), and a dozen external
// `ctx.view.renderMap()` sites — got the whole pool+city+fog pass for free. The conversion moved that
// orchestration OUT of pool.ts and UP to the WorldMapRenderer assembly (which now explicitly sequences
// `pool.*` + `city.refreshCityLayer()` + `fog.renderOverlay()`), and injected it into build.ts /
// viewport.ts / lifecycle.ts as a `refreshMap: () => void` closure over the assembly.
//
// That means each of those three call sites is now a separate, silently-droppable wire. If build.ts
// called `this.pool.invalidatePool()` instead of `this.refreshMap()` (the pre-conversion name is
// still a real method on the pool sibling!), or if a line went missing from the assembly's own
// invalidatePool()/refreshPool(), the tile pool would still update perfectly while city sprites froze
// in place and the interactive overlay went stale — exactly the class of bug the pre-conversion
// pool↔city cycle existed to prevent, and exactly what test/ui/composition-wiring.ui.ts's IDENTITY
// checks cannot see (they only prove `viewport.pool === view.pool`, never that the refreshMap closure
// gets INVOKED).
//
// So every test here drives a REAL public entry point (build / setZoom / renderMap / refreshPool /
// bootstrap) and then asserts all three domains actually did work, using real observable state rather
// than spies:
//   • pool  — ctx.pool slot tx/ty reassigned away from a sentinel value
//   • city  — ctx.citySprites container's screen x/y tracking the live pan/zoom
//   • fog   — ctx.fogGfx's PIXI geometry non-empty (renderFog() is only ever reached via
//             fog.renderOverlay(), so a drawn fogGfx is proof that half of the bundle ran)
//
// Same real-scene wiring as test/ui/worldMapZoom3CityAnchor.ui.ts (WorldMapContext + Renderer +
// Panels + Input, minus WorldMapNet), under the headless PIXI adapter.

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createFakeTextInput } from '../harness/fakeTextInput';
import { initI18n } from '../../src/i18n';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { ILayout } from '../../src/layout/ILayout';
import type { WorldTileView } from '../../src/net/WorldApiClient';

// Same reason as worldMapZoom3CityAnchor.ui.ts: the real loadCityAtlas() awaits an Image `onload`
// the headless adapter never fires, and refreshCityLayer() early-returns unless the atlas reports
// ready — without this stub no city sprite would ever be created and the city half of every
// assertion below would be vacuous.
vi.mock('../../src/render/atlas/cityAtlasLoader', () => ({
  isCityAtlasReady: () => true,
  getCityTextureForLevel: () => PIXI.Texture.WHITE,
  getCityContentTopFracForLevel: () => 0,
  // lifecycle.bootstrap() calls this one too (the atlas-load batch behind the loading cover).
  loadCityAtlas: async () => {},
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

const { openTextInput } = createFakeTextInput();
const CB: WorldMapCallbacks = {
  onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
  onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'], openTextInput,
  worldId: 'w1', playerName: 'dbg', accountId: 'acc_dbg', storage: memStore,
};

/**
 * WorldMapScene's own wiring, minus WorldMapNet — but deliberately WITHOUT calling
 * `ctx.view.build()`, because build() is itself one of the call sites under test.
 */
function newScene(): WorldMapContext {
  const ctx = new WorldMapContext(LAYOUT, CB);
  ctx.view = new WorldMapRenderer(ctx);
  ctx.panels = new WorldMapPanels(ctx);
  ctx.input = new WorldMapInput(ctx);
  ctx.net = { loadMapViewport: async () => {} } as WorldMapContext['net'];
  return ctx;
}

/** 3×3 same-owner base footprint (ADR-025) centered on (cx,cy) so isBaseAnchor(cx,cy) holds and
 *  refreshCityLayer() draws exactly one city sprite keyed `${cx}:${cy}`. */
function placeBase(ctx: WorldMapContext, cx: number, cy: number): void {
  const tile = (x: number, y: number): WorldTileView =>
    ({ x, y, type: 'base', level: 1, mine: true, occupied: true } as WorldTileView);
  for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    ctx.tileCache.set(`${cx + dx}:${cy + dy}`, tile(cx + dx, cy + dy));
  }
}

/** Did fog.renderOverlay() run? renderOverlay()'s first act is renderFog(), which is the ONLY
 *  writer of ctx.fogGfx — so a non-empty fogGfx geometry is a spy-free witness for the fog half
 *  of the bundle. (PIXI Graphics builds its geometry on the CPU, no renderer needed.) */
function fogDrawn(ctx: WorldMapContext): boolean {
  return (ctx.fogGfx.geometry as unknown as { graphicsData: unknown[] }).graphicsData.length > 0;
}

const POOL_SENTINEL = -424242;

/** Stamp a recognizable value on every pool slot so a later "was the pool refreshed?" check can
 *  tell a real reposition from a stale leftover. */
function markPool(ctx: WorldMapContext): void {
  for (const s of ctx.pool) { s.tx = POOL_SENTINEL; s.ty = POOL_SENTINEL; }
}

function poolRefreshed(ctx: WorldMapContext): boolean {
  return ctx.pool.length > 0 && ctx.pool.some((s) => s.tx !== POOL_SENTINEL);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WorldMapRenderer pool+city+fog refresh bundle (2026-08-12 composition conversion)', () => {
  it('build() finishes by running the WHOLE bundle, not just pool.buildPool()', () => {
    const ctx = newScene();
    placeBase(ctx, 100, 100);
    ctx.selectedTile = { x: 100, y: 100 };
    ctx.view.centerAt(100, 100);

    // Nothing has drawn yet — build() creates every layer AND is expected to end with refreshMap().
    ctx.view.build();

    // pool half
    expect(ctx.pool.length).toBeGreaterThan(0);
    expect(ctx.pool.some((s) => s.tx > 0)).toBe(true);
    // city half — refreshCityLayer() is the only thing that ever populates ctx.citySprites, so an
    // empty map here means build.ts's `this.refreshMap()` never reached city.ts.
    expect(ctx.citySprites.get('100:100')).toBeTruthy();
    // fog half
    expect(fogDrawn(ctx)).toBe(true);
  });

  it('setZoom() re-runs the whole bundle, so city sprites and the overlay follow the new tile size', () => {
    const ctx = newScene();
    placeBase(ctx, 100, 100);
    ctx.selectedTile = { x: 100, y: 100 };
    ctx.view.centerAt(100, 100);
    ctx.view.build();

    const cityC = ctx.citySprites.get('100:100')!;
    const spriteW0 = (cityC.getChildByName('img') as PIXI.Sprite).width;
    const tp0 = ctx.tp;

    // Reset both witnesses so only setZoom()'s own work counts.
    ctx.fogGfx.clear();
    markPool(ctx);

    ctx.view.setZoom(2);

    expect(ctx.tp).not.toBe(tp0); // sanity: zoom 2 really is a different tile size
    // pool half (setZoom calls pool.buildPool() itself, then refreshMap() repositions the fresh slots)
    expect(poolRefreshed(ctx)).toBe(true);
    // city half — the sprite is scaled from ctx.tp inside refreshCityLayer(); if setZoom() had
    // called pool.invalidatePool() directly instead of the injected refreshMap closure, the tile
    // pool would have re-rendered at zoom 2 while this sprite stayed frozen at the zoom-1 size.
    const cityC2 = ctx.citySprites.get('100:100')!;
    expect((cityC2.getChildByName('img') as PIXI.Sprite).width).not.toBe(spriteW0);
    // fog half
    expect(fogDrawn(ctx)).toBe(true);
  });

  it('renderMap() (the external "data changed" entry point) sequences pool → city → fog', () => {
    const ctx = newScene();
    placeBase(ctx, 100, 100);
    ctx.view.centerAt(100, 100);
    ctx.view.build();

    const x0 = ctx.citySprites.get('100:100')!.x;
    ctx.fogGfx.clear();
    markPool(ctx);
    // Camera moved by some other path (march-focus jump), then new tile data arrives.
    ctx.panX += 40;

    ctx.view.renderMap();

    expect(poolRefreshed(ctx)).toBe(true);
    expect(ctx.citySprites.get('100:100')!.x - x0).toBeCloseTo(40);
    expect(fogDrawn(ctx)).toBe(true);
  });

  it('refreshPool() (the drag-to-pan entry point) still repositions city sprites alongside the pool', () => {
    const ctx = newScene();
    placeBase(ctx, 100, 100);
    ctx.view.centerAt(100, 100);
    ctx.view.build();

    const x0 = ctx.citySprites.get('100:100')!.x;
    markPool(ctx);
    ctx.panX += 25;

    ctx.view.refreshPool();

    expect(poolRefreshed(ctx)).toBe(true);
    // The pre-conversion pool.refreshPool() opened with `this.refreshCityLayer()`; the assembly's
    // refreshPool() has to keep doing that or a drag-pan visibly detaches cities from the map
    // (the 2026-07-16 "主城脱离地图" bug — see worldMapZoom3CityAnchor.ui.ts).
    expect(ctx.citySprites.get('100:100')!.x - x0).toBeCloseTo(25);
  });

  it("lifecycle.bootstrap()'s reveal path runs the same bundle before hiding the loading cover", () => {
    const ctx = newScene();
    placeBase(ctx, 100, 100);
    ctx.view.centerAt(100, 100);
    ctx.view.build();
    expect(ctx.loadingLayer).toBeTruthy();

    const x0 = ctx.citySprites.get('100:100')!.x;
    ctx.fogGfx.clear();
    markPool(ctx);
    ctx.panX += 33;

    // The atlas Promise.allSettled path can't resolve headlessly (the stub Image never fires
    // onload), so exercise bootstrap()'s own 8s safety-net reveal — it runs the identical
    // `this.refreshMap(); this.build.hideLoading();` pair.
    vi.useFakeTimers();
    ctx.view.bootstrap();
    vi.advanceTimersByTime(8000);

    expect(poolRefreshed(ctx)).toBe(true);
    expect(ctx.citySprites.get('100:100')!.x - x0).toBeCloseTo(33);
    expect(fogDrawn(ctx)).toBe(true);
    expect(ctx.loadingLayer).toBeNull();
  });
});
