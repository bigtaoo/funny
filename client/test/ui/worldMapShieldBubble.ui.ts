// Coverage for the S8-8 UI fix (2026-08-08): the capital-protection shield (slg_shield_8h/24h,
// TileDoc.protectedUntil) took effect server-side but had no visual — a shielded base looked
// identical to an unshielded one. refreshCityLayer (WorldMapRenderer/city.ts) now draws a
// translucent breathing-pulse ellipse ('shieldFx' child Graphics) over any base tile — own or
// another player's — whose protectedUntil is still in the future.
//
// Same wiring/pattern as worldMapBaseHpBar.ui.ts: builds a REAL WorldMapContext + renderer under
// the headless PIXI adapter, so refreshCityLayer runs exactly as in production and shieldFx is a
// real PIXI.Graphics whose draw calls we can spy on.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createFakeTextInput } from '../harness/fakeTextInput';
import { initI18n } from '../../src/i18n';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import { SHIELD_BREAK_LIFE } from '../../src/scenes/worldmap/WorldMapRenderer/shieldFx';
import { setDecorationsQuiet } from '../../src/render/idleQuiet';
import type { ILayout } from '../../src/layout/ILayout';
import type { WorldTileView } from '../../src/net/WorldApiClient';

// See worldMapZoom3CityAnchor.ui.ts: the real loadCityAtlas() would hang on the headless stub
// Image's never-firing onload. Stub the atlas as ready with a throwaway texture.
vi.mock('../../src/render/atlas/cityAtlasLoader', () => ({
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

const { openTextInput } = createFakeTextInput();
const CB: WorldMapCallbacks = {
  onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
  onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'], openTextInput,
  worldId: 'w1', playerName: 'dbg', accountId: 'acc_dbg', storage: memStore,
};

function buildScene(): WorldMapContext {
  const ctx = new WorldMapContext(LAYOUT, CB);
  ctx.view = new WorldMapRenderer(ctx);
  ctx.panels = new WorldMapPanels(ctx);
  ctx.input = new WorldMapInput(ctx);
  ctx.net = { loadMapViewport: async () => {} } as WorldMapContext['net'];
  ctx.view.build();
  return ctx;
}

/** Marks a 3×3 same-owner base anchored at (cx,cy) so isBaseAnchor(cx,cy) holds and
 *  refreshCityLayer draws exactly one city sprite keyed `${cx}:${cy}`. */
function placeBase(
  ctx: WorldMapContext, cx: number, cy: number,
  extra: Partial<WorldTileView> = {},
): void {
  const tile = (x: number, y: number): WorldTileView =>
    ({ x, y, type: 'base', level: 1, occupied: true, ...extra } as WorldTileView);
  for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
    ctx.tileCache.set(`${cx + dx}:${cy + dy}`, tile(cx + dx, cy + dy));
  }
}

/** Render a base, then return its live shieldFx Graphics with drawEllipse/beginFill spied.
 *  The container (and shieldFx child) is created on the first refresh; we spy afterward and
 *  trigger a second refresh so the spies capture the draw for the given tile state. */
function renderAndSpyShield(ctx: WorldMapContext, cx: number, cy: number): {
  ellipses: { x: number; y: number; rx: number; ry: number }[];
} {
  ctx.view.centerAt(cx, cy);
  ctx.view.invalidatePool();
  const cityC = ctx.citySprites.get(`${cx}:${cy}`);
  expect(cityC, 'a base city sprite should have been created').toBeTruthy();
  const shieldFx = cityC!.getChildByName('shieldFx') as PIXI.Graphics;
  expect(shieldFx, 'the city container should own a shieldFx child').toBeTruthy();

  const ellipses: { x: number; y: number; rx: number; ry: number }[] = [];
  vi.spyOn(shieldFx, 'drawEllipse').mockImplementation(function (this: PIXI.Graphics, x, y, rx, ry) {
    ellipses.push({ x, y, rx, ry });
    return this;
  });

  ctx.view.invalidatePool(); // re-runs refreshCityLayer → redraws shieldFx with the spy attached
  return { ellipses };
}

describe('WorldMap capital-protection shield bubble (S8-8 UI fix, 2026-08-08)', () => {
  it('a base with protectedUntil in the future draws a shield ellipse over the building', () => {
    const ctx = buildScene();
    placeBase(ctx, 400, 400, { mine: false, protectedUntil: Date.now() + 3_600_000 });
    const { ellipses } = renderAndSpyShield(ctx, 400, 400);
    expect(ellipses).toHaveLength(1);
    // Centered horizontally over the building, hovering above the ground (negative local y).
    expect(ellipses[0].x).toBe(0);
    expect(ellipses[0].y).toBeLessThan(0);
    expect(ellipses[0].rx).toBeGreaterThan(0);
    expect(ellipses[0].ry).toBeGreaterThan(0);
  });

  it('a base with no protectedUntil draws no shield (uncluttered map)', () => {
    const ctx = buildScene();
    placeBase(ctx, 410, 410, { mine: false });
    const { ellipses } = renderAndSpyShield(ctx, 410, 410);
    expect(ellipses).toHaveLength(0);
  });

  it('a base whose protectedUntil has already passed draws no shield', () => {
    const ctx = buildScene();
    placeBase(ctx, 420, 420, { mine: false, protectedUntil: Date.now() - 1000 });
    const { ellipses } = renderAndSpyShield(ctx, 420, 420);
    expect(ellipses).toHaveLength(0);
  });

  it('own protected base shows the bubble too (not just enemy bases)', () => {
    const ctx = buildScene();
    placeBase(ctx, 430, 430, { mine: true, protectedUntil: Date.now() + 3_600_000 });
    const { ellipses } = renderAndSpyShield(ctx, 430, 430);
    expect(ellipses).toHaveLength(1);
  });
});

/** The glow layer is a subtree, not one Graphics (2026-09-22): a Container carrying the ellipse
 *  squash, a dashed `ring` Graphics carrying the spin, and a `sparks` Container of one Graphics per
 *  sparkle so each can twinkle on its own alpha/scale. See shieldFx.ts on why the spin has to be a
 *  rotation applied BEFORE the squash. */
function glowParts(ctx: WorldMapContext, key: string): {
  root: PIXI.Container; ring: PIXI.Graphics; sparks: PIXI.Container;
} {
  const cityC = ctx.citySprites.get(key);
  const root = cityC!.getChildByName('shieldGlowFx') as PIXI.Container;
  expect(root, 'the city container should own a shieldGlowFx child').toBeTruthy();
  return {
    root,
    ring: root.getChildByName('ring') as PIXI.Graphics,
    sparks: root.getChildByName('sparks') as PIXI.Container,
  };
}

describe('WorldMap shield glow layer + break-flash pop (2026-08-08 follow-up, borrowed from daydayup\'s EnergyShieldFilter/flash)', () => {
  it('an active shield draws its rotating ring/sparkles on a separate additive-blend shieldGlowFx subtree', () => {
    const ctx = buildScene();
    placeBase(ctx, 500, 500, { mine: false, protectedUntil: Date.now() + 3_600_000 });
    ctx.view.centerAt(500, 500);
    ctx.view.invalidatePool();
    const { ring, sparks } = glowParts(ctx, '500:500');
    expect(ring.blendMode).toBe(PIXI.BLEND_MODES.ADD);
    expect(sparks.children).toHaveLength(4);
    for (const spark of sparks.children) {
      expect((spark as PIXI.Graphics).blendMode).toBe(PIXI.BLEND_MODES.ADD);
    }

    const sparkles: { x: number; y: number }[] = [];
    for (const spark of sparks.children) {
      vi.spyOn(spark as PIXI.Graphics, 'drawCircle').mockImplementation(function (this: PIXI.Graphics, x, y) {
        sparkles.push({ x, y });
        return this;
      });
    }
    ctx.view.invalidatePool(); // re-runs refreshCityLayer → redraws the glow with the spies attached
    expect(sparkles).toHaveLength(4); // the four sparkle ticks drawn each redraw by drawShieldGlow
  });

  it('the glow subtree carries the ellipse squash so its children can spin as a circle', () => {
    const ctx = buildScene();
    placeBase(ctx, 505, 505, { mine: false, protectedUntil: Date.now() + 3_600_000 });
    const { ellipses } = renderAndSpyShield(ctx, 505, 505);
    const { root } = glowParts(ctx, '505:505');
    // x untouched, y squashed by exactly the dome's own ry/rx — rotating a child and only then
    // applying this is what turns a circle into a turning ellipse rather than a wobbling one.
    expect(root.scale.x).toBe(1);
    expect(root.scale.y).toBeCloseTo(ellipses[0].ry / ellipses[0].rx, 6);
  });

  it('a base with no active shield draws nothing on the glow subtree either', () => {
    const ctx = buildScene();
    placeBase(ctx, 510, 510, { mine: false });
    ctx.view.centerAt(510, 510);
    ctx.view.invalidatePool();
    const { sparks } = glowParts(ctx, '510:510');
    const sparkles: unknown[] = [];
    for (const spark of sparks.children) {
      vi.spyOn(spark as PIXI.Graphics, 'drawCircle').mockImplementation(function (this: PIXI.Graphics) {
        sparkles.push(1);
        return this;
      });
    }
    ctx.view.invalidatePool();
    expect(sparkles).toHaveLength(0);
  });

  it('protection lapsing between two redraws pops a one-shot break flash', () => {
    const ctx = buildScene();
    const key = '520:520';
    placeBase(ctx, 520, 520, { mine: false, protectedUntil: Date.now() + 3_600_000 });
    ctx.view.centerAt(520, 520);
    ctx.view.invalidatePool();
    expect(ctx.shieldGeom.has(key)).toBe(true);
    expect(ctx.shieldBreakFx.has(key)).toBe(false);

    // Simulate real time passing past protectedUntil — flip just the anchor tile's field and
    // redraw, same as a live tile_update push/poll refresh would deliver.
    const tile = ctx.tileCache.get(key)!;
    ctx.tileCache.set(key, { ...tile, protectedUntil: Date.now() - 1000 });
    ctx.view.invalidatePool();

    expect(ctx.shieldGeom.has(key)).toBe(false);
    expect(ctx.shieldBreakFx.has(key)).toBe(true);
    expect(ctx.shieldBreakFx.get(key)!.age).toBe(0);

    const cityC = ctx.citySprites.get(key);
    const shieldBreakFx = cityC!.getChildByName('shieldBreakFx') as PIXI.Graphics;
    expect(shieldBreakFx, 'the city container should own a shieldBreakFx child').toBeTruthy();
    expect(shieldBreakFx.blendMode).toBe(PIXI.BLEND_MODES.ADD);
  });

  it('a base that was never protected does not pop a break flash on redraw', () => {
    const ctx = buildScene();
    const key = '530:530';
    placeBase(ctx, 530, 530, { mine: false });
    ctx.view.centerAt(530, 530);
    ctx.view.invalidatePool();
    ctx.view.invalidatePool();
    expect(ctx.shieldBreakFx.has(key)).toBe(false);
  });

  it('the break-flash pop self-clears after its lifetime elapses', () => {
    const ctx = buildScene();
    const key = '540:540';
    placeBase(ctx, 540, 540, { mine: false, protectedUntil: Date.now() + 3_600_000 });
    ctx.view.centerAt(540, 540);
    ctx.view.invalidatePool();
    const tile = ctx.tileCache.get(key)!;
    ctx.tileCache.set(key, { ...tile, protectedUntil: Date.now() - 1000 });
    ctx.view.invalidatePool();
    expect(ctx.shieldBreakFx.has(key)).toBe(true);

    ctx.view.update(SHIELD_BREAK_LIFE + 0.1);
    expect(ctx.shieldBreakFx.has(key)).toBe(false);
  });
});

// Smoothness pass (2026-09-22). The bubble animated by rebuilding both Graphics from scratch, which
// is why it was capped at 10 fps — and at 10 fps the ring, the biggest moving thing on the map,
// visibly strobed ("这个护盾的动画，看起来不连贯啊"). Two things changed: a step is now transform + alpha
// only (so the rate is a paint-budget call, not a rebuild-cost one), and the clock is held while
// decorations are quiet instead of drifting behind a frozen picture.
describe('WorldMap shield bubble animates by transform, not by redraw (2026-09-22)', () => {
  const STEP = 1 / 30; // SHIELD_ANIM_FPS

  function shieldedAt(key: string): WorldMapContext {
    const [x, y] = key.split(':').map(Number);
    const ctx = buildScene();
    placeBase(ctx, x, y, { mine: true, protectedUntil: Date.now() + 3_600_000 });
    ctx.view.centerAt(x, y);
    ctx.view.invalidatePool();
    return ctx;
  }

  it('an animation step spins the ring and breathes the dome without touching any geometry', () => {
    const ctx = shieldedAt('600:600');
    const cityC = ctx.citySprites.get('600:600')!;
    const dome = cityC.getChildByName('shieldFx') as PIXI.Graphics;
    const { ring, sparks } = glowParts(ctx, '600:600');
    const before = { rot: ring.rotation, spin: sparks.rotation, alpha: dome.alpha };

    // Any redraw would have to clear() first — that is the call this rewrite exists to remove from
    // the per-step path (it re-tessellates the whole ring every time it lands).
    const cleared = vi.spyOn(ring, 'clear');
    ctx.view.update(STEP + 0.001);

    expect(cleared).not.toHaveBeenCalled();
    expect(ring.rotation).not.toBe(before.rot);
    expect(sparks.rotation).not.toBe(before.spin);
    // Counter-rotating, so the two layers never lock into one rigid wheel.
    expect(Math.sign(ring.rotation - before.rot)).toBe(-Math.sign(sparks.rotation - before.spin));
    expect(dome.alpha).not.toBe(before.alpha);
  });

  it('steps at SHIELD_ANIM_FPS, keeping the leftover time rather than dropping it', () => {
    const ctx = shieldedAt('610:610');
    const { ring } = glowParts(ctx, '610:610');
    const start = ring.rotation;

    // Two half-steps must add up to one step: zeroing the accumulator on each step (the old
    // behaviour) quantised the real interval to whole frames and jittered evenly-spaced motion.
    ctx.view.update(STEP * 0.6);
    expect(ring.rotation).toBe(start);
    ctx.view.update(STEP * 0.6);
    expect(ring.rotation).toBeGreaterThan(start);
    expect(ctx.shieldAnimAcc).toBeCloseTo(STEP * 0.2, 6);
  });

  it('holds the clock while decorations are quiet, so resuming does not snap the ring', () => {
    const ctx = shieldedAt('620:620');
    const { ring } = glowParts(ctx, '620:620');
    const held = ring.rotation;
    try {
      setDecorationsQuiet(true);
      for (let i = 0; i < 30; i++) ctx.view.update(1); // 30 s untouched
      expect(ring.rotation).toBe(held);
      expect(ctx.shieldAnimT).toBe(0);
    } finally {
      setDecorationsQuiet(false);
    }
    // ...and picks up exactly where it stopped, rather than jumping to wherever a free-running
    // clock would have drifted to (0.6 rad/s x 30 s = 2.9 revolutions).
    ctx.view.update(STEP + 0.001);
    expect(ring.rotation - held).toBeCloseTo(0.6 * (STEP + 0.001), 6);
  });
});
