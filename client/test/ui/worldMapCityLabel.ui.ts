// Coverage for the 2026-08-01 city-label change (WorldMapRenderer/city.ts refreshCityLayer): the old
// filled/hollow "level-within-tier" dot cluster below each base sprite was replaced with a plain text
// label floating above the building — "{ownerName} Lv.{n}" for every base, own included (own base uses
// WorldMapCallbacks.playerName since WorldTileView.ownerName is only populated for OTHER players'
// territory — see worldsvc/src/worldTypes.ts). Ownership itself stays conveyed by the tile's own color
// wash (ownerTint); the label's ink color just echoes the same mapping, it doesn't introduce a new one.
//
// Builds a REAL WorldMapContext + renderer under the headless PIXI adapter (same wiring as
// worldMapBaseHpBar.ui.ts / worldMapZoom3CityAnchor.ui.ts), so refreshCityLayer runs exactly as in
// production and the label child is a real PIXI.Text we can read `.text`/`.style`/`.position` off of.

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

const CB: WorldMapCallbacks = {
  onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
  onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'],
  worldId: 'w1', playerName: 'Tao', accountId: 'acc_dbg', storage: memStore,
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

/** Render a base and return its live `label` PIXI.Text child. */
function renderLabel(ctx: WorldMapContext, cx: number, cy: number): PIXI.Text {
  ctx.view.centerAt(cx, cy);
  ctx.view.invalidatePool();
  const cityC = ctx.citySprites.get(`${cx}:${cy}`);
  expect(cityC, 'a base city sprite should have been created').toBeTruthy();
  const label = cityC!.getChildByName('label') as PIXI.Text;
  expect(label, 'the city container should own a label child').toBeTruthy();
  return label;
}

describe('WorldMap city name/level label (2026-08-01)', () => {
  it('own base shows the player\'s own name + level (unified rule, own included)', () => {
    const ctx = buildScene();
    placeBase(ctx, 100, 100, { mine: true, level: 3 });
    const label = renderLabel(ctx, 100, 100);
    expect(label.text).toBe('Tao Lv.3');
  });

  it('another player\'s base shows their ownerName + level', () => {
    const ctx = buildScene();
    placeBase(ctx, 110, 110, { mine: false, occupied: true, level: 5, ownerName: 'Bob' });
    const label = renderLabel(ctx, 110, 110);
    expect(label.text).toBe('Bob Lv.5');
  });

  it('an enemy base with no resolved ownerName falls back to just the level (no stray leading space)', () => {
    const ctx = buildScene();
    placeBase(ctx, 120, 120, { mine: false, occupied: true, level: 2 }); // ownerName absent (meta unavailable)
    const label = renderLabel(ctx, 120, 120);
    expect(label.text).toBe('Lv.2');
  });

  it('ink color follows ownership: mine=red, ally=green, occupied=blue, neutral=gray', () => {
    // PIXI's TextStyle normalizes a numeric `fill` to a CSS hex string on readback.
    const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
    const colorFor = (extra: Partial<WorldTileView>, cx: number): string => {
      const ctx = buildScene();
      placeBase(ctx, cx, 130, extra);
      return String(renderLabel(ctx, cx, 130).style.fill);
    };
    expect(colorFor({ mine: true }, 140)).toBe(hex(0xcc2222));
    expect(colorFor({ mine: false, ally: true }, 150)).toBe(hex(0x2e8b40));
    expect(colorFor({ mine: false, ally: false, occupied: true }, 160)).toBe(hex(0x2266cc));
    expect(colorFor({ mine: false, ally: false, occupied: false }, 170)).toBe(hex(0x888888));
  });

  it('no longer draws the old dot cluster', () => {
    const ctx = buildScene();
    placeBase(ctx, 180, 180, { mine: true, level: 7 });
    ctx.view.centerAt(180, 180);
    ctx.view.invalidatePool();
    const cityC = ctx.citySprites.get('180:180');
    expect(cityC!.getChildByName('dots')).toBeNull();
  });

  it('label position is stable regardless of the (unrelated) HP-bar visibility, so it never jumps on siege start/end', () => {
    const damagedCtx = buildScene();
    placeBase(damagedCtx, 200, 200, { mine: false, level: 4, hp: 10, maxHp: 100 }); // under siege
    const damagedY = renderLabel(damagedCtx, 200, 200).position.y;

    const healthyCtx = buildScene();
    placeBase(healthyCtx, 200, 200, { mine: false, level: 4 }); // hp absent = full HP, no bar
    const healthyY = renderLabel(healthyCtx, 200, 200).position.y;

    expect(damagedY).toBe(healthyY);
    expect(damagedY).toBeLessThan(0); // sits above the sprite's bottom-anchor foot
  });
});
