// Coverage for the 2026-08-12 loading-cover eraser-wipe reveal (WorldMapRenderer/loadingReveal.ts):
// hideLoading() used to `layer.destroy()` the first-paint paper sheet outright the instant the map
// atlases settled — this replaced that hard cut with an animated wipe. Drives the module's public
// functions directly (beginLoadingErase/updateLoadingErase/cancelLoadingErase) against a bare
// WorldMapContext, rather than through the full renderer/atlas machinery — none of this module's
// behavior touches the tile pool, city sprites, or fog, so the lighter setup keeps the intent clear
// per test.
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createFakeTextInput } from '../harness/fakeTextInput';
import { initI18n } from '../../src/i18n';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import { beginLoadingErase, updateLoadingErase, cancelLoadingErase, MAX_CRUMBS } from '../../src/scenes/worldmap/WorldMapRenderer/loadingReveal';

// lifecycle.bootstrap()'s atlas-load batch (behind the loading cover) touches this one — same
// reason as worldMapRefreshBundle.ui.ts: the headless adapter never fires a real Image onload.
vi.mock('../../src/render/atlas/cityAtlasLoader', () => ({
  isCityAtlasReady: () => true,
  getCityTextureForLevel: () => PIXI.Texture.WHITE,
  getCityContentTopFracForLevel: () => 0,
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

const LAYOUT = { designWidth: 1280, designHeight: 800 } as import('../../src/layout/ILayout').ILayout;

const { openTextInput } = createFakeTextInput();
const CB: WorldMapCallbacks = {
  onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
  onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'], openTextInput,
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

/** Same wiring `WorldMapScene` uses, minus WorldMapNet (unneeded here) — see
 *  worldMapRefreshBundle.ui.ts's `newScene()`, which this mirrors. */
function newScene(): WorldMapContext {
  const ctx = new WorldMapContext(LAYOUT, CB);
  ctx.view = new WorldMapRenderer(ctx);
  ctx.panels = new WorldMapPanels(ctx);
  ctx.input = new WorldMapInput(ctx);
  ctx.net = { loadMapViewport: async () => {} } as WorldMapContext['net'];
  return ctx;
}

afterEach(() => {
  vi.useRealTimers();
});

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

  it('the mask never un-erases: its visible (still-covered) area is non-increasing across the whole stroke', () => {
    const ctx = newCtxWithCover();
    beginLoadingErase(ctx);

    let prevArea = maskArea(ctx);
    // Small steps so the per-row stagger/wobble (which can locally shift an individual row's
    // front) doesn't get to hide a regression behind one big jump — this is the property the
    // eraser-stroke feel actually depends on: the map must never flicker back under paper once
    // it's been revealed.
    for (let i = 0; i < 20; i++) {
      updateLoadingErase(ctx, 0.04);
      if (!ctx.loadingEraseMask) break; // stroke finished early on the last iteration
      const area = maskArea(ctx);
      expect(area).toBeLessThanOrEqual(prevArea + 1e-6);
      prevArea = area;
    }
  });

  it('caps live eraser-crumb particles at MAX_CRUMBS instead of growing unbounded', () => {
    const ctx = newCtxWithCover();
    beginLoadingErase(ctx);
    updateLoadingErase(ctx, 0.3); // mid-stroke, well inside the crumb-spawn window

    // A real stroke's spawn window is short enough (~0.6s at the module's own spawn rate) that it
    // never naturally fills MAX_CRUMBS in one pass — so exercise the cap directly: pre-seed up to
    // the limit with long-lived crumbs (so none age out mid-assertion) and confirm one more spawn
    // tick still can't push past it.
    ctx.loadingEraseCrumbData.length = 0;
    for (let i = 0; i < MAX_CRUMBS; i++) {
      ctx.loadingEraseCrumbData.push({ x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 999, size: 3 });
    }
    updateLoadingErase(ctx, 0.1); // plenty of accumulator to want to spawn several more
    expect(ctx.loadingEraseCrumbData.length).toBe(MAX_CRUMBS);
  });

  it('a second beginLoadingErase() call mid-wipe (e.g. hideLoading() invoked twice) does not restart the stroke', () => {
    const ctx = newCtxWithCover();
    beginLoadingErase(ctx);
    updateLoadingErase(ctx, 0.3);
    const tBefore = ctx.loadingEraseT;
    const layerBefore = ctx.loadingEraseLayer;
    expect(tBefore).toBeGreaterThan(0);

    // ctx.loadingLayer is already null at this point (handed off by the first call) — the second
    // call must see that and no-op, not reset ctx.loadingEraseT back to 0.
    beginLoadingErase(ctx);

    expect(ctx.loadingEraseT).toBe(tBefore);
    expect(ctx.loadingEraseLayer).toBe(layerBefore);
  });

  describe('wired into the real WorldMapRenderer (not just the leaf loadingReveal functions)', () => {
    it('ctx.view.update(dt) — the scene\'s real per-frame tick — advances the wipe on its own', () => {
      const ctx = newScene();
      ctx.view.build(); // build.ts's build() creates ctx.loadingLayer via buildLoadingOverlay()
      expect(ctx.loadingLayer).toBeTruthy();

      // Drive hideLoading() through its real caller: bootstrap()'s 8s safety-net reveal, same
      // trigger worldMapRefreshBundle.ui.ts uses (the atlas Promise.allSettled path never
      // resolves headlessly).
      vi.useFakeTimers();
      ctx.view.bootstrap();
      vi.advanceTimersByTime(8000);

      expect(ctx.loadingLayer).toBeNull(); // hideLoading()'s contract still holds
      expect(ctx.loadingEraseLayer).toBeTruthy(); // ...but the sheet lives on, mid-handoff
      expect(ctx.loadingEraseT).toBe(0);

      ctx.view.update(0.3); // real per-frame entry point, not updateLoadingErase() directly
      expect(ctx.loadingEraseT).toBeGreaterThan(0);
      expect(ctx.loadingEraseT).toBeLessThan(1);

      ctx.view.update(5); // finish it
      expect(ctx.loadingEraseT).toBe(1);
      expect(ctx.loadingEraseLayer).toBeNull();
    });

    it('ctx.view.destroy() cancels an in-flight wipe instead of leaking the layer/mask/crumbs', () => {
      const ctx = newScene();
      ctx.view.build();

      vi.useFakeTimers();
      ctx.view.bootstrap();
      vi.advanceTimersByTime(8000);
      ctx.view.update(0.2); // mid-wipe, nowhere near done

      expect(ctx.loadingEraseLayer).not.toBeNull();
      expect(() => ctx.view.destroy()).not.toThrow();

      expect(ctx.loadingEraseLayer).toBeNull();
      expect(ctx.loadingEraseMask).toBeNull();
      expect(ctx.loadingEraseCrumbs).toBeNull();
      expect(ctx.loadingEraseCrumbData.length).toBe(0);
    });
  });
});
