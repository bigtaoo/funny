/**
 * lobbyRebuildTeardown.test.ts — regression test for the LobbyScene freeze fixed
 * 2026-07-13.
 *
 * Background: LobbyScene's rebuild() tears down the container's children
 * (tearDownChildren → destroy({children:true})) to redraw the scene, but only
 * nulled `this.titleBoil` without destroying it, and left `this.heroFigure`
 * untouched entirely. Both are Ticker-driven: titleBoil hooks PIXI.Ticker.shared
 * directly, and heroFigure is advanced every frame from update(). Once their
 * sprites were destroyed out from under them, the next tick set a property
 * (e.g. `sprite.x`) on an object whose `transform` PIXI had nulled on destroy()
 * — a TypeError that froze the whole ticker (PIXI 7 aborts the update loop on
 * any listener throw), matching the "scene update threw (contained)" freeze
 * report.
 *
 * 2026-08-12: rebuild() moved from badges.ts (BadgesMixin) to LobbySceneCore
 * itself during the mixin→composition conversion (see claudedocs/client-modules.md
 * and ../../src/scenes/LobbyScene/core.ts's file-header comment) — it's a
 * whole-scene concern (teardown + re-invoke the full layout build), not
 * badges-specific; badges.ts's applyEventsAvailable() now just calls
 * `core.rebuild()` like any other caller. This test targets LobbySceneCore
 * directly instead of the old BadgesMixin.
 *
 * Run with: npm test — the default suite's include covers every *.test.ts under test/.
 */

import { describe, it, expect, vi } from 'vitest';

// ── Minimal PIXI stub — only what tearDownChildren()/rebuild() touch ──────────
vi.mock('pixi.js-legacy', () => {
  class FakeContainer {
    children: unknown[] = [];
    addChild(c: unknown): unknown { this.children.push(c); return c; }
    removeChildren(): unknown[] { const kids = this.children; this.children = []; return kids; }
    destroy(_opts?: unknown): void { /* no-op */ }
  }
  class FakeSprite extends FakeContainer {}
  class FakeGraphics extends FakeContainer {
    lineStyle(): this { return this; }
    beginFill(): this { return this; }
    endFill(): this { return this; }
    drawEllipse(): this { return this; }
    drawCircle(): this { return this; }
    drawRect(): this { return this; }
    moveTo(): this { return this; }
    lineTo(): this { return this; }
    arc(): this { return this; }
    closePath(): this { return this; }
    clear(): this { return this; }
  }
  class FakeText extends FakeContainer {}
  class FakeTicker {
    static shared = new FakeTicker();
    add(_cb: unknown): void {}
    remove(_cb: unknown): void {}
  }
  class FakeBaseTexture {
    on(): this { return this; }
    once(): this { return this; }
    off(): this { return this; }
  }
  class FakeTexture {
    static from(): FakeTexture { return new FakeTexture(); }
  }
  class FakeSpritesheet {
    textures: Record<string, unknown> = {};
    async parse(): Promise<void> {}
  }
  class FakeRectangle {
    constructor(_x = 0, _y = 0, _w = 0, _h = 0) {}
  }
  return {
    Container: FakeContainer,
    Sprite: FakeSprite,
    Graphics: FakeGraphics,
    Text: FakeText,
    Ticker: FakeTicker,
    BaseTexture: FakeBaseTexture,
    Texture: FakeTexture,
    Spritesheet: FakeSpritesheet,
    Rectangle: FakeRectangle,
    settings: { ADAPTER: {} },
    LINE_CAP: { ROUND: 'round', SQUARE: 'square', BUTT: 'butt' },
    LINE_JOIN: { ROUND: 'round', MITER: 'miter', BEVEL: 'bevel' },
    SCALE_MODES: { NEAREST: 0, LINEAR: 1 },
    // icons.ts (imported transitively via core.ts's HubTabs icons) now pulls in
    // cardArt.ts -> preloadTextures.ts for the raster tab-icon art (batch 2/3), which
    // reads this at module scope for ART_TEX_OPTIONS.
    MIPMAP_MODES: { OFF: 0, POW2: 1, ON: 2, ON_MANUAL: 3 },
    WRAP_MODES: { CLAMP: 0 },
  };
});

// ── jszip stub (StickmanRuntime, imported transitively via core.ts) ────────────
vi.mock('jszip', () => ({ default: { loadAsync: () => Promise.reject(new Error('unused in this test')) } }));

// ── Imports (after all vi.mock declarations) ───────────────────────────────────
import { LobbySceneCore } from '../../src/scenes/LobbyScene/core';
import { tearDownChildren } from '../../src/render/sketchUi';

/**
 * Bare-bones stand-in for LobbySceneCore — only the fields rebuild() touches, but borrows the REAL
 * `rebuild()` implementation via `Function.prototype.call` so this regression test exercises actual
 * production code rather than a hand-copied duplicate (LobbySceneCore's own constructor pulls in
 * `ILayout`/`LobbySceneCallbacks`/ the ctor's onSaveChanged+preloadTabIconTextures wiring, which
 * this test doesn't need — only `rebuild()`'s teardown-then-buildHook() sequence).
 */
class FakeLobbySceneCore {
  container = { removeChildren: (): unknown[] => [] as unknown[] };
  toastLayer: unknown = null;
  settlementLayer: unknown = null;
  achievementBadgeLayer: unknown = null;
  shopBadgeLayer: unknown = null;
  socialBadgeLayer: unknown = null;
  sideStripBadgeLayer: unknown = null;
  titleBoil: { destroy(): void } | null = null;
  heroFigure: { destroy(): void } | null = null;
  heroFigureClips: string[] = [];
  heroFigureSwapTimer = 0;
  destroyed = false;
  buildHook = vi.fn();

  rebuild(): void {
    LobbySceneCore.prototype.rebuild.call(this as unknown as LobbySceneCore);
  }
}

describe('LobbyScene rebuild() — titleBoil/heroFigure teardown (freeze regression)', () => {
  it('destroys titleBoil and heroFigure before rebuilding, instead of leaving stale references', () => {
    const core = new FakeLobbySceneCore();
    const titleBoilDestroy = vi.fn();
    const heroFigureDestroy = vi.fn();
    core.titleBoil = { destroy: titleBoilDestroy };
    core.heroFigure = { destroy: heroFigureDestroy };
    core.heroFigureClips = ['idle', 'attack'];
    core.heroFigureSwapTimer = 2.4;

    core.rebuild();

    // Regression: the old code only did `this.titleBoil = null` (no destroy call)
    // and never touched heroFigure at all — this would fail against that code.
    expect(titleBoilDestroy).toHaveBeenCalledTimes(1);
    expect(heroFigureDestroy).toHaveBeenCalledTimes(1);
    expect(core.titleBoil).toBeNull();
    expect(core.heroFigure).toBeNull();
    expect(core.heroFigureClips).toEqual([]);
    expect(core.heroFigureSwapTimer).toBe(0);
    expect(core.buildHook).toHaveBeenCalledTimes(1);
  });

  it('is a no-op destroy call when titleBoil/heroFigure were never set (first build)', () => {
    const core = new FakeLobbySceneCore();
    expect(() => core.rebuild()).not.toThrow();
    expect(core.titleBoil).toBeNull();
    expect(core.heroFigure).toBeNull();
  });

  it('sanity: tearDownChildren really does destroy a container\'s children (the hazard rebuild() must race against)', () => {
    const child = { destroy: vi.fn() };
    const container = { removeChildren: (): unknown[] => [child] };
    tearDownChildren(container as unknown as Parameters<typeof tearDownChildren>[0]);
    expect(child.destroy).toHaveBeenCalledWith({ children: true });
  });
});
