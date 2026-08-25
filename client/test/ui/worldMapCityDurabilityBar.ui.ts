// Regression coverage for the ADR-074 P1 wild-city durability bar — specifically for the way it shipped
// broken and 15 passing UI tests did not notice.
//
// The bar was anchored at `-sprite.height`, i.e. the top of the sprite's CELL. But `citySpriteTiles` sizes
// a city sprite from its plot footprint and every atlas frame carries transparent padding above its
// silhouette, so on a 7x7 (Lv.6) city the bar rendered hundreds of pixels above the roof — outside the
// viewport, indistinguishable from "not implemented". It was found by looking at a screenshot, not by any
// test: worldMapCityClick.ui.ts asserts the PANEL's lines and buttons, which are content, not position.
// `getCityContentTopFracForLevel` exists for exactly this (its own doc comment names
// WorldMapRenderer/city.ts as the caller) and the player-base bar right above already used it, after the
// same symptom was reported for short buildings on 2026-07-22.
//
// So the assertions here are deliberately about GEOMETRY: the bar has to sit a small, constant gap above
// the ART, and that gap must not scale with the sprite's cell. A contentTop of 0.5 is what makes the two
// formulas measurably different (half a sprite height apart) — with the atlas's real 0 for a full-bleed
// frame, the broken and fixed code agree and the case would prove nothing.
//
// Same harness as worldMapPublishedCityNodes.ui.ts / worldMapZoom3CityAnchor.ui.ts (headless PIXI adapter,
// stubbed city atlas, a real WorldMapContext + WorldMapRenderer so the city layer runs as in production).

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { allCityNodes, cityDurabilityMax, type MapEditorCityNode } from '@nw/shared';
import { initI18n } from '../../src/i18n';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { WorldCityNodeView } from '../../src/net/WorldApiClient';
import type { ILayout } from '../../src/layout/ILayout';

/** The fraction of a city frame's cell that is transparent padding above the art. Non-zero on purpose. */
const CONTENT_TOP = 0.5;

vi.mock('../../src/render/atlas/cityAtlasLoader', () => ({
  isCityAtlasReady: () => true,
  getCityTextureForLevel: () => PIXI.Texture.WHITE,
  getCityContentTopFracForLevel: () => 0.5,
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
const WORLD_ID = 'w1';

const CB: WorldMapCallbacks = {
  onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
  onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'],
  worldId: WORLD_ID, playerName: 'dbg', accountId: 'acc_dbg', storage: memStore,
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

/** A big graded city — the tier the bug was visible on (a 3x3 city's padding is too small to notice). */
const NODE: MapEditorCityNode = allCityNodes(WORLD_ID).find((n) => n.kind === 'garrison' && n.footprint >= 7)
  ?? allCityNodes(WORLD_ID).find((n) => n.kind === 'garrison')!;

function served(over: Partial<WorldCityNodeView> = {}): WorldCityNodeView {
  const max = cityDurabilityMax(NODE.level, 'garrison');
  return { ...NODE, durability: max, durabilityMax: max, regenPerHour: 1000, ...over } as WorldCityNodeView;
}

function renderCity(node: WorldCityNodeView): { ctx: WorldMapContext; sprite: PIXI.Sprite; bar: PIXI.Graphics } {
  const ctx = buildScene();
  ctx.cityNodes = [node];
  ctx.view.centerAt(node.x, node.y);
  ctx.view.invalidatePool();
  const container = ctx.citySprites.get(`node:${node.id}`);
  if (!container) throw new Error('city sprite container was not created');
  return {
    ctx,
    sprite: container.getChildByName('img') as PIXI.Sprite,
    bar: container.getChildByName('hpbar') as PIXI.Graphics,
  };
}

/** Every rectangle the bar drew, in the container's local space, in draw order (track first, then fill). */
function barRects(bar: PIXI.Graphics): { x: number; y: number; width: number; height: number }[] {
  return bar.geometry.graphicsData.map((d) => {
    const r = d.shape as PIXI.Rectangle;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

describe('WorldMap wild-city durability bar (ADR-074 P1)', () => {
  it('draws nothing at full durability — 64 permanently-full bars would be pure clutter', () => {
    const { bar } = renderCity(served());
    expect(barRects(bar)).toHaveLength(0);
  });

  it('draws nothing when the server sent no siege state at all (pre-P1 world, or the seed fallback)', () => {
    // `cityNodes()` falls back to `allCityNodes()`, whose entries carry geometry only. A bar drawn from
    // `undefined` would either throw or render a full/empty bar the client cannot actually know.
    const { bar } = renderCity(NODE as WorldCityNodeView);
    expect(barRects(bar)).toHaveLength(0);
  });

  it('draws a track + fill once damaged', () => {
    const max = cityDurabilityMax(NODE.level, 'garrison');
    const { bar } = renderCity(served({ durability: Math.round(max * 0.4) }));
    const rects = barRects(bar);
    expect(rects).toHaveLength(2);
    const [track, fill] = rects;
    expect(fill!.width / track!.width).toBeCloseTo(0.4, 1);
    expect(fill!.y).toBe(track!.y);
    expect(fill!.height).toBe(track!.height);
  });

  it('sits a small CONSTANT gap above the ART, not above the sprite cell', () => {
    // THE regression. Buggy: y = -spriteHeight - barH - gap. Fixed: y = -spriteHeight*(1-contentTop) - barH - gap.
    // With contentTop = 0.5 the two differ by half a sprite height — hundreds of px at zoom 1, which is how
    // the bar ended up off-screen and looked unimplemented.
    const max = cityDurabilityMax(NODE.level, 'garrison');
    const { sprite, bar } = renderCity(served({ durability: Math.round(max * 0.4) }));
    const [track] = barRects(bar);
    const artTop = -sprite.height * (1 - CONTENT_TOP); // sprite is bottom-anchored at the container origin
    const cellTop = -sprite.height;

    // Directly above the art, by no more than the bar itself plus a few px of gap.
    const gapAboveArt = artTop - (track!.y + track!.height);
    expect(gapAboveArt).toBeGreaterThanOrEqual(0);
    expect(gapAboveArt).toBeLessThan(track!.height + 8);

    // And decisively NOT anchored to the cell: the cell top is half a sprite away.
    expect(Math.abs(track!.y - cellTop)).toBeGreaterThan(sprite.height * 0.4);
  });

  it('the gap above the art does not grow with the city footprint', () => {
    // The property that makes the fix a fix rather than a tuned constant: a bigger city has a bigger cell
    // and more padding, so a cell-anchored bar drifts further and further off. An art-anchored one does not.
    const max = cityDurabilityMax(10, 'garrison');
    const small = renderCity(served({ ...NODE, footprint: 3, level: 2, durability: Math.round(max * 0.4), durabilityMax: max }));
    const large = renderCity(served({ ...NODE, footprint: 9, level: 10, durability: Math.round(max * 0.4), durabilityMax: max }));

    const gapOf = (r: { sprite: PIXI.Sprite; bar: PIXI.Graphics }) => {
      const [track] = barRects(r.bar);
      return -r.sprite.height * (1 - CONTENT_TOP) - (track!.y + track!.height);
    };
    expect(large.sprite.height).toBeGreaterThan(small.sprite.height * 2); // guard: the fixture must differ
    // Both gaps are the same handful of pixels — they scale with tile size, never with sprite height.
    expect(Math.abs(gapOf(large) - gapOf(small))).toBeLessThan(4);
  });

  it('is not clipped by the plot mask that crops the building art', () => {
    // The bar hovers ABOVE the plot diamond, so masking it would erase it. `sprite.mask = plotMask` must
    // stay scoped to the sprite; a container-level mask would take the bar with it.
    const max = cityDurabilityMax(NODE.level, 'garrison');
    const { ctx, bar, sprite } = renderCity(served({ durability: Math.round(max * 0.4) }));
    const container = ctx.citySprites.get(`node:${NODE.id}`)!;
    expect(container.mask).toBeFalsy();
    expect(bar.mask).toBeFalsy();
    expect(sprite.mask).toBeTruthy();
  });
});
