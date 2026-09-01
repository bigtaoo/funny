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

describe('WorldMap shield glow layer + break-flash pop (2026-08-08 follow-up, borrowed from daydayup\'s EnergyShieldFilter/flash)', () => {
  it('an active shield draws its rotating ring/sparkles on a separate additive-blend shieldGlowFx child', () => {
    const ctx = buildScene();
    placeBase(ctx, 500, 500, { mine: false, protectedUntil: Date.now() + 3_600_000 });
    ctx.view.centerAt(500, 500);
    ctx.view.invalidatePool();
    const cityC = ctx.citySprites.get('500:500');
    const shieldGlowFx = cityC!.getChildByName('shieldGlowFx') as PIXI.Graphics;
    expect(shieldGlowFx, 'the city container should own a shieldGlowFx child').toBeTruthy();
    expect(shieldGlowFx.blendMode).toBe(PIXI.BLEND_MODES.ADD);

    const sparkles: { x: number; y: number }[] = [];
    vi.spyOn(shieldGlowFx, 'drawCircle').mockImplementation(function (this: PIXI.Graphics, x, y) {
      sparkles.push({ x, y });
      return this;
    });
    ctx.view.invalidatePool(); // re-runs refreshCityLayer → redraws shieldGlowFx with the spy attached
    expect(sparkles).toHaveLength(4); // the four sparkle ticks drawn each redraw by drawShieldGlow
  });

  it('a base with no active shield draws nothing on shieldGlowFx either', () => {
    const ctx = buildScene();
    placeBase(ctx, 510, 510, { mine: false });
    ctx.view.centerAt(510, 510);
    ctx.view.invalidatePool();
    const cityC = ctx.citySprites.get('510:510');
    const shieldGlowFx = cityC!.getChildByName('shieldGlowFx') as PIXI.Graphics;
    const sparkles: unknown[] = [];
    vi.spyOn(shieldGlowFx, 'drawCircle').mockImplementation(function (this: PIXI.Graphics) {
      sparkles.push(1);
      return this;
    });
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
