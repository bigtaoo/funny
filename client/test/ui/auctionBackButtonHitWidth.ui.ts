// Regression coverage for the AuctionScene back-button hit-rect width bug (2026-07-15): render()
// used to rebuild hitRects every call with a hardcoded `w: 80` box, half the shared SceneHeader
// standard (`BACK_HIT_W` = 160, see src/ui/widgets/SceneHeader.ts). Visually the header looked like
// every other scene, but taps landing in the right half of the header's back area (x in [80,160))
// did nothing. Fixed by caching `hdr.backRect` (from drawSceneHeader) on the instance and reusing it
// instead of re-deriving a narrower box in render().
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { drawSceneHeader } from '../../src/ui/widgets/SceneHeader';
import { AuctionScene, type AuctionSceneCallbacks } from '../../src/scenes/AuctionScene';
import type { WorldApiClient } from '../../src/net/WorldApiClient';
import * as PIXI from 'pixi.js-legacy';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const LANDSCAPE: [number, number] = [1920, 1080];

type Rect = { x: number; y: number; w: number; h: number };
type Hit = { rect: Rect; action: () => void };
type SceneInternals = {
  backRect: Rect;
  hitRects: Hit[];
  itemPickerOpen: boolean;
  handleDown(x: number, y: number): void;
  render(): void;
  openItemPicker(): void;
};

function internals(scene: AuctionScene): SceneInternals {
  return scene as unknown as SceneInternals;
}

function stubWorldApi(): WorldApiClient {
  return {
    listAuctions: async () => [],
    getMyListings: async () => [],
    getAuctionRefBand: () => new Promise<never>(() => {}), // never resolves; openCreateForm's fetch is fire-and-forget
  } as unknown as WorldApiClient;
}

function buildScene() {
  const calls = { back: 0 };
  const cb: AuctionSceneCallbacks = { onBack: () => { calls.back++; }, worldApi: stubWorldApi() };
  const scene = new AuctionScene(createLayout(...LANDSCAPE), new InputManager(), cb);
  return { scene, calls };
}

/** The width the shared SceneHeader standard actually hands out — computed live (not hardcoded)
 *  so this test tracks BACK_HIT_W if it's ever retuned, instead of asserting a stale magic number. */
function standardBackHitWidth(): number {
  const hdr = drawSceneHeader(new PIXI.Container(), 1920, 1080, 'Auction');
  return hdr.backRect.w;
}

describe('AuctionScene back-button hit rect matches the shared SceneHeader standard width', () => {
  it('matches on initial render', () => {
    const { scene } = buildScene();
    expect(internals(scene).backRect.w).toBe(standardBackHitWidth());
    scene.destroy();
  });

  it('stays the standard width after a body re-render (render() rebuilds hitRects from scratch)', () => {
    const { scene } = buildScene();
    internals(scene).render();
    internals(scene).render();
    expect(internals(scene).backRect.w).toBe(standardBackHitWidth());
    scene.destroy();
  });

  it('a tap in the right half of the standard back area (x in [80,160)) still calls onBack', () => {
    const { scene, calls } = buildScene();
    const w = standardBackHitWidth();
    expect(w).toBeGreaterThan(80); // sanity: the regression only reproduces if the standard is wider than 80
    internals(scene).handleDown(w - 1, 10);
    expect(calls.back).toBe(1);
    scene.destroy();
  });

  it('while the item picker overlay is open, the same wide back area cancels the picker (not a no-op)', () => {
    const { scene, calls } = buildScene();
    internals(scene).openItemPicker();
    expect(internals(scene).itemPickerOpen).toBe(true);

    const w = standardBackHitWidth();
    internals(scene).handleDown(w - 1, 10);

    expect(internals(scene).itemPickerOpen).toBe(false);
    expect(calls.back).toBe(0); // picker-cancel, not scene onBack
    scene.destroy();
  });
});
