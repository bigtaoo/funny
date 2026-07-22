// Coverage for the 2026-07-22 fix: a main-city (3×3 base) under siege must show a durability
// bar on the world map. tileGraphics.drawHpBar draws the tile-level bar on the anchor tile in
// the L1/L2 pool layer, but that tile is fully covered by the base's 3×3 city sprite (a separate,
// higher layer) — so a damaged base showed no HP at all. The fix redraws the bar inside the city
// sprite container (WorldMapRenderer/city.ts refreshCityLayer, an `hpbar` child Graphics),
// hovering above the building, and ONLY while damaged (hp < maxHp; absent hp = full HP per the
// WorldTileView contract).
//
// Builds a REAL WorldMapContext + renderer under the headless PIXI adapter (same wiring as
// worldMapZoom3CityAnchor.ui.ts), so refreshCityLayer runs exactly as in production and the
// hpbar child is a real PIXI.Graphics whose draw calls we can spy on.

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { ILayout } from '../../src/layout/ILayout';
import type { WorldTileView } from '../../src/net/WorldApiClient';

// See worldMapZoom3CityAnchor.ui.ts: the real loadCityAtlas() would hang on the headless stub
// Image's never-firing onload. Stub the atlas as ready with a throwaway texture.
vi.mock('../../src/render/cityAtlasLoader', () => ({
  isCityAtlasReady: () => true,
  getCityTextureForLevel: () => PIXI.Texture.WHITE,
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
 *  refreshCityLayer draws exactly one city sprite keyed `${cx}:${cy}`. hp/maxHp optional. */
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

/** Render a base, then return its live hpbar Graphics with drawRect/beginFill spied.
 *  The container (and hpbar child) is created on the first refresh; we spy afterward and
 *  trigger a second refresh so the spies capture the draw for the given tile state. */
function renderAndSpyHpBar(ctx: WorldMapContext, cx: number, cy: number): {
  rects: { x: number; y: number; w: number; h: number }[];
  fillColors: number[];
} {
  ctx.view.centerAt(cx, cy);
  ctx.view.invalidatePool();
  const cityC = ctx.citySprites.get(`${cx}:${cy}`);
  expect(cityC, 'a base city sprite should have been created').toBeTruthy();
  const hpbar = cityC!.getChildByName('hpbar') as PIXI.Graphics;
  expect(hpbar, 'the city container should own an hpbar child').toBeTruthy();

  const rects: { x: number; y: number; w: number; h: number }[] = [];
  const fillColors: number[] = [];
  vi.spyOn(hpbar, 'drawRect').mockImplementation(function (this: PIXI.Graphics, x, y, w, h) {
    rects.push({ x, y, w, h });
    return this;
  });
  vi.spyOn(hpbar, 'beginFill').mockImplementation(function (this: PIXI.Graphics, color) {
    fillColors.push(Number(color ?? 0));
    return this;
  });

  ctx.view.invalidatePool(); // re-runs refreshCityLayer → redraws hpbar with spies attached
  return { rects, fillColors };
}

describe('WorldMap base HP bar (2026-07-22)', () => {
  it('a damaged base draws a track + a proportional fill rect above the building', () => {
    const ctx = buildScene();
    placeBase(ctx, 200, 200, { mine: false, hp: 150, maxHp: 300 }); // 50%
    const { rects } = renderAndSpyHpBar(ctx, 200, 200);

    // Two rects: the full-width track then the ratio-scaled fill (see city.ts).
    expect(rects).toHaveLength(2);
    const [track, fill] = rects;
    expect(track.w).toBeGreaterThan(0);
    expect(fill.w).toBeCloseTo(track.w * 0.5, 3); // 150/300
    // Both sit above the building: the sprite is bottom-anchored at local y=0 and rises to
    // negative y, so the bar's y is negative (above the foot).
    expect(track.y).toBeLessThan(0);
    expect(fill.y).toBe(track.y);
  });

  it('a full-HP base draws no bar (uncluttered map)', () => {
    const ctx = buildScene();
    placeBase(ctx, 210, 210, { mine: false, hp: 300, maxHp: 300 });
    const { rects } = renderAndSpyHpBar(ctx, 210, 210);
    expect(rects).toHaveLength(0);
  });

  it('a base with hp absent (contract: absent = full HP) draws no bar', () => {
    const ctx = buildScene();
    placeBase(ctx, 220, 220, { mine: false, maxHp: 300 }); // hp undefined
    const { rects } = renderAndSpyHpBar(ctx, 220, 220);
    expect(rects).toHaveLength(0);
  });

  it('own damaged base shows the bar too (not just enemy bases)', () => {
    const ctx = buildScene();
    placeBase(ctx, 230, 230, { mine: true, hp: 90, maxHp: 300 });
    const { rects } = renderAndSpyHpBar(ctx, 230, 230);
    expect(rects).toHaveLength(2);
    expect(rects[1].w).toBeCloseTo(rects[0].w * 0.3, 3);
  });

  it('fill colour follows the ratio: green >50%, amber >25%, red otherwise', () => {
    const GREEN = 0x3aa03a, AMBER = 0xd8a520, RED = 0xcc2222;
    // The fill rect's colour is the LAST beginFill (the track fills first, then the bar).
    const fillColorFor = (hp: number): number => {
      const ctx = buildScene();
      const cx = 240 + hp; // distinct anchor per case so caches never collide
      placeBase(ctx, cx, 240, { mine: false, hp, maxHp: 100 });
      const { fillColors } = renderAndSpyHpBar(ctx, cx, 240);
      return fillColors[fillColors.length - 1];
    };
    expect(fillColorFor(80)).toBe(GREEN);
    expect(fillColorFor(40)).toBe(AMBER);
    expect(fillColorFor(10)).toBe(RED);
  });
});
