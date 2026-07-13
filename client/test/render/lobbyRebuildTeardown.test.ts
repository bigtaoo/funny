/**
 * lobbyRebuildTeardown.test.ts — regression test for the LobbyScene freeze fixed
 * 2026-07-13.
 *
 * Background: LobbyScene.rebuild() (badges.ts) tears down the container's
 * children (tearDownChildren → destroy({children:true})) to redraw the scene,
 * but only nulled `this.titleBoil` without destroying it, and left
 * `this.heroFigure` untouched entirely. Both are Ticker-driven: titleBoil hooks
 * PIXI.Ticker.shared directly, and heroFigure is advanced every frame from
 * update(). Once their sprites were destroyed out from under them, the next
 * tick set a property (e.g. `sprite.x`) on an object whose `transform` PIXI
 * had nulled on destroy() — a TypeError that froze the whole ticker (PIXI 7
 * aborts the update loop on any listener throw), matching the "scene update
 * threw (contained)" freeze report.
 *
 * Run with: npm run test:render
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
    WRAP_MODES: { CLAMP: 0 },
  };
});

// ── webpack-served asset used by coinIconAtlas.ts (imported transitively via base.ts) ──
vi.mock('../../src/assets/shop/coins.png',  () => ({ default: 'coins.png' }));
vi.mock('../../src/assets/shop/coins.json', () => ({ default: { frames: {}, meta: {} } }));

// ── jszip stub (StickmanRuntime, imported transitively via base.ts) ────────────
vi.mock('jszip', () => ({ default: { loadAsync: () => Promise.reject(new Error('unused in this test')) } }));

// ── Imports (after all vi.mock declarations) ───────────────────────────────────
import { BadgesMixin } from '../../src/scenes/LobbyScene/badges';
import type { LobbySceneBaseCtor } from '../../src/scenes/LobbyScene/base';
import { tearDownChildren } from '../../src/render/sketchUi';

/** Bare-bones stand-in for LobbySceneBase — only the fields rebuild() touches. */
class FakeLobbySceneBase {
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
  build = vi.fn();
}

/** Public view of the fields under test — bypasses the real LobbySceneBase's `protected` modifiers, which don't apply to our FakeLobbySceneBase stand-in at runtime. */
interface TestScene {
  titleBoil: { destroy(): void } | null;
  heroFigure: { destroy(): void } | null;
  heroFigureClips: string[];
  heroFigureSwapTimer: number;
  build: ReturnType<typeof vi.fn>;
  rebuild(): void;
}

const LobbyWithBadges = BadgesMixin(FakeLobbySceneBase as unknown as LobbySceneBaseCtor);

describe('LobbyScene rebuild() — titleBoil/heroFigure teardown (freeze regression)', () => {
  it('destroys titleBoil and heroFigure before rebuilding, instead of leaving stale references', () => {
    const scene = new LobbyWithBadges() as unknown as TestScene;
    const titleBoilDestroy = vi.fn();
    const heroFigureDestroy = vi.fn();
    scene.titleBoil = { destroy: titleBoilDestroy };
    scene.heroFigure = { destroy: heroFigureDestroy };
    scene.heroFigureClips = ['idle', 'attack'];
    scene.heroFigureSwapTimer = 2.4;

    scene.rebuild();

    // Regression: the old code only did `this.titleBoil = null` (no destroy call)
    // and never touched heroFigure at all — this would fail against that code.
    expect(titleBoilDestroy).toHaveBeenCalledTimes(1);
    expect(heroFigureDestroy).toHaveBeenCalledTimes(1);
    expect(scene.titleBoil).toBeNull();
    expect(scene.heroFigure).toBeNull();
    expect(scene.heroFigureClips).toEqual([]);
    expect(scene.heroFigureSwapTimer).toBe(0);
    expect(scene.build).toHaveBeenCalledTimes(1);
  });

  it('is a no-op destroy call when titleBoil/heroFigure were never set (first build)', () => {
    const scene = new LobbyWithBadges() as unknown as TestScene;
    expect(() => scene.rebuild()).not.toThrow();
    expect(scene.titleBoil).toBeNull();
    expect(scene.heroFigure).toBeNull();
  });

  it('sanity: tearDownChildren really does destroy a container\'s children (the hazard rebuild() must race against)', () => {
    const child = { destroy: vi.fn() };
    const container = { removeChildren: (): unknown[] => [child] };
    tearDownChildren(container as unknown as Parameters<typeof tearDownChildren>[0]);
    expect(child.destroy).toHaveBeenCalledWith({ children: true });
  });
});
