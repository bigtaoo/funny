// Coverage for the 2026-08-12 loading-cover eraser-wipe reveal (WorldMapRenderer/loadingReveal.ts):
// hideLoading() used to `layer.destroy()` the first-paint paper sheet outright the instant the map
// atlases settled — this replaced that hard cut with an animated wipe. Drives the module's public
// functions directly (beginLoadingErase/updateLoadingErase/cancelLoadingErase) against a bare
// WorldMapContext, rather than through the full renderer/atlas machinery — none of this module's
// behavior touches the tile pool, city sprites, or fog, so the lighter setup keeps the intent clear
// per test.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { beginLoadingErase, updateLoadingErase, cancelLoadingErase } from '../../src/scenes/worldmap/WorldMapRenderer/loadingReveal';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const LAYOUT = { designWidth: 1280, designHeight: 800 } as import('../../src/layout/ILayout').ILayout;

const CB: WorldMapCallbacks = {
  onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
  onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'],
  worldId: 'w1', playerName: 'dbg', accountId: 'acc_dbg', storage: memStore,
};

/** Bare context with a stand-in "loading cover" container — enough for loadingReveal.ts, which
 *  only ever touches ctx.container/w/h and its own loadingLayer/loadingSpinner/loadingErase*
 *  fields. */
function newCtxWithCover(): WorldMapContext {
  const ctx = new WorldMapContext(LAYOUT, CB);
  ctx.loadingLayer = new PIXI.Container();
  ctx.loadingSpinner = new PIXI.Graphics();
  ctx.loadingLayer.addChild(ctx.loadingSpinner);
  ctx.container.addChild(ctx.loadingLayer);
  return ctx;
}

function maskArea(ctx: WorldMapContext): number {
  const data = (ctx.loadingEraseMask!.geometry as unknown as { graphicsData: { shape: { width: number; height: number } }[] }).graphicsData;
  return data.reduce((sum, d) => sum + d.shape.width * d.shape.height, 0);
}

describe('worldmap loading-cover eraser-wipe reveal (loadingReveal.ts)', () => {
  it('beginLoadingErase() hands the cover off instead of destroying it: loadingLayer/loadingSpinner go null, but the sheet survives as loadingEraseLayer', () => {
    const ctx = newCtxWithCover();
    const sheet = ctx.loadingLayer!;

    beginLoadingErase(ctx);

    expect(ctx.loadingLayer).toBeNull();
    expect(ctx.loadingSpinner).toBeNull();
    expect(ctx.loadingEraseLayer).toBe(sheet); // same container, not a rebuild
    expect(sheet.destroyed).toBe(false);
    expect(ctx.loadingEraseT).toBe(0);
  });

  it('is idempotent: calling it again (or via a second hideLoading()) while nothing is covering the map is a no-op', () => {
    const ctx = new WorldMapContext(LAYOUT, CB); // no loadingLayer at all
    expect(() => beginLoadingErase(ctx)).not.toThrow();
    expect(ctx.loadingEraseLayer).toBeNull();
  });

  it('updateLoadingErase() progressively masks the sheet away, then tears it down once the stroke completes', () => {
    const ctx = newCtxWithCover();
    beginLoadingErase(ctx);

    // Fresh wipe: nothing erased yet, so the mask should still cover the full sheet area.
    const fullArea = ctx.w * ctx.h;
    expect(maskArea(ctx)).toBeCloseTo(fullArea, -1);

    // Partway through the stroke: some, but not all, of the sheet should now be uncovered.
    updateLoadingErase(ctx, 0.3);
    expect(ctx.loadingEraseT).toBeGreaterThan(0);
    expect(ctx.loadingEraseT).toBeLessThan(1);
    expect(ctx.loadingEraseLayer).not.toBeNull(); // still mid-wipe
    const midArea = maskArea(ctx);
    expect(midArea).toBeLessThan(fullArea);
    expect(midArea).toBeGreaterThan(0);

    // Run well past the stroke's duration — it must finish and clean up on its own, not hang.
    updateLoadingErase(ctx, 5);
    expect(ctx.loadingEraseT).toBe(1);
    expect(ctx.loadingEraseLayer).toBeNull();
    expect(ctx.loadingEraseMask).toBeNull();
    expect(ctx.loadingEraseCrumbs).toBeNull();
    expect(ctx.loadingEraseCrumbData.length).toBe(0);
  });

  it('spawns trailing eraser-crumb specks mid-wipe and ages/removes them as the stroke advances', () => {
    const ctx = newCtxWithCover();
    beginLoadingErase(ctx);

    for (let i = 0; i < 10; i++) updateLoadingErase(ctx, 0.03); // ~0.3s in — well inside the stroke
    expect(ctx.loadingEraseCrumbData.length).toBeGreaterThan(0);
    const crumbsGeom = (ctx.loadingEraseCrumbs!.geometry as unknown as { graphicsData: unknown[] }).graphicsData;
    expect(crumbsGeom.length).toBe(ctx.loadingEraseCrumbData.length);

    updateLoadingErase(ctx, 5); // finish the wipe — crumbs go with it, no leftover particles/graphics
    expect(ctx.loadingEraseCrumbData.length).toBe(0);
    expect(ctx.loadingEraseCrumbs).toBeNull();
  });

  it('cancelLoadingErase() (scene torn down mid-wipe) cleans up without waiting for completion', () => {
    const ctx = newCtxWithCover();
    beginLoadingErase(ctx);
    updateLoadingErase(ctx, 0.2); // mid-wipe, nowhere near done

    expect(ctx.loadingEraseLayer).not.toBeNull();
    cancelLoadingErase(ctx);

    expect(ctx.loadingEraseLayer).toBeNull();
    expect(ctx.loadingEraseMask).toBeNull();
    expect(ctx.loadingEraseCrumbs).toBeNull();
    expect(ctx.loadingEraseCrumbData.length).toBe(0);
  });
});
