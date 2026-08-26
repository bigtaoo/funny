// Regression coverage (2026-08-12, same fix as BattlePassScene/LeaderboardScene/ChatScene/
// CardCodexScene/DeckBuilderScene): CityScene/render.ts's renderBuildingGrid() used to build
// every grid tile's panel+2 accent-bars+icon+2 Text(+badge) unconditionally, regardless of scroll
// position — only the tile's *hit rect* (computed right after) was viewport-filtered. Bounded to
// GRID_BUILDING_KEYS.length+1 (~12) tiles today, never a crash risk in practice (see
// cityScene.ui.ts's "all 12 tiles fit on one screen, nothing scrolls off" — this dataset never
// actually overflows at any real screen size, so the cull's effect can't be observed by just
// building a scene normally), but the same missing-cull shape as the bug that reloaded the
// Battle Pass page on mobile. Fix: the tile-build loop now skips any tile whose row falls outside
// the scroll viewport ± a half-viewport buffer — core has no reposition-only drag fast path
// (`scrollDirty` triggers a full render() per drag frame), so no cross-render object cache is
// needed, same reasoning as ChatScene/DeckBuilderScene.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).

import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';
import { CityScene, type CitySceneCallbacks } from '../../src/scenes/CityScene';
import type { WorldApiClient, PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function countTexts(container: PIXI.Container): number {
  let n = 0;
  const walk = (node: PIXI.Container): void => {
    if (node instanceof PIXI.Text) n++;
    for (const c of node.children) walk(c as PIXI.Container);
  };
  walk(container);
  return n;
}

function stubWorldApi(): WorldApiClient {
  return {
    getMe: () => new Promise<PlayerWorldView>(() => {}),
    getTeams: () => Promise.resolve([]),
    getMarches: () => Promise.resolve([]),
    getOccupations: () => Promise.resolve([]),
    getStationed: () => Promise.resolve([]),
    upgradeBuilding: () => new Promise<PlayerWorldView>(() => {}),
    speedupBuild: () => new Promise<PlayerWorldView>(() => {}),
  } as unknown as WorldApiClient;
}

type CoreInternals = { scrollY: number; scrollMax: number; render(): void; container: PIXI.Container };

function buildScene(): { scene: CityScene; core: CoreInternals } {
  const cb: CitySceneCallbacks = { onBack() {}, worldApi: stubWorldApi(), worldId: 'world:1:0' };
  const scene = new CityScene(createLayout(800, 1280), new InputManager(), cb);
  return { scene, core: (scene as unknown as { core: CoreInternals }).core };
}

describe('CityScene — building-grid viewport culling', () => {
  it('the grid build loop actually reads scroll position — tiles scrolled far out of the buffered band stop being built', () => {
    // GRID_BUILDING_KEYS is small enough today that it never overflows a real screen at all
    // (cityScene.ui.ts's own comment: "none scroll off-screen ... all 12 register a hit"), and
    // renderBuildingGrid() itself unconditionally re-clamps `core.scrollY` down to `scrollMax`
    // (0, since content fits) on every call — so this dataset's cull genuinely cannot be
    // exercised through a normal render() at any screen size; it's dead code today, exactly as
    // expected for a "same shape, still-small dataset" defensive fix. To prove the cull check
    // itself (`cullY = viewY - this.core.scrollY + cy`) isn't silently broken/inverted, override
    // `scrollY` as a getter that reports a huge value regardless of what the clamp writes back —
    // this is the same value renderBuildingGrid's cull line actually reads, just no longer
    // overwritable by the clamp that runs two lines above it.
    const { scene, core } = buildScene();
    const restCount = countTexts(core.container);

    Object.defineProperty(core, 'scrollY', { get: () => 1_000_000, set: () => {}, configurable: true });
    core.render();
    const farCount = countTexts(core.container);

    expect(farCount).toBeLessThan(restCount);
    scene.destroy();
  });

  it('does not throw when scrolled to an out-of-range position (no crash from a partially-culled grid)', () => {
    const { scene, core } = buildScene();
    Object.defineProperty(core, 'scrollY', { get: () => 1_000_000, set: () => {}, configurable: true });
    expect(() => core.render()).not.toThrow();
    scene.destroy();
  });
});
