// What the portrait camera's closest zoom tier is FOR: the player's own base fills
// `PORTRAIT_L1_BASE_WIDTH_FRAC` (5/6) of the screen width (2026-09-15 user call, see
// design/game/SLG_LOG_2026-08.md that day). `test/worldmapZoom.test.ts` already pins the arithmetic
// in `makeZoomCfgs`, but on its own that pin is circular: it restates the formula in the formula's
// own units and cannot see whether the number survives the trip to the screen.
//
// Three separate things decide the width the player actually perceives, and only the first lives in
// zoom.ts:
//   1. `ctx.tp` — the tile size makeZoomCfgs chose;
//   2. `BASE_SPRITE_TILES` (3.2) — how wide city.ts draws the base sprite, deliberately WIDER than
//      the 3-tile plot to compensate the transparent margin baked into the isometric art;
//   3. `cityPlotMaskPoints` — the diamond city.ts masks that sprite to, `BASE_FOOTPRINT * tp` wide.
// So the visible base is `min(sprite, mask)` = the PLOT, and the framing constant is only honoured
// while (3) keeps clipping (2). Drop the mask, widen the sprite budget, or let city.ts size from a
// captured tile size instead of the live `ctx.tp`, and the unit pin stays green while the base
// visibly overflows or under-fills its 5/6. This file measures the drawn objects instead.
//
// Real wiring (same harness shape as worldMapZoom3CityAnchor.ui.ts): a real WorldMapContext +
// Renderer + Panels + Input, built from a REAL layout out of `createLayout()` rather than a hand-
// written `{designWidth, designHeight}` literal — the portrait/landscape ladder split keys off the
// DESIGN dimensions, so a test that invents them can't tell that a 390x844 phone really does land in
// the portrait branch.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { BASE_FOOTPRINT } from '@nw/shared';
import { createFakeTextInput } from '../harness/fakeTextInput';
import { initI18n } from '../../src/i18n';
import { createLayout } from '../../src/layout/ScalingManager';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import { PORTRAIT_L1_BASE_WIDTH_FRAC } from '../../src/scenes/worldmap/logic/zoom';
import { BASE_SPRITE_TILES } from '../../src/scenes/worldmap/logic/constants';
import type { ILayout } from '../../src/layout/ILayout';
import type { WorldTileView } from '../../src/net/WorldApiClient';

// The headless PIXI adapter's stub Image never fires `onload`, so the real loadCityAtlas() would
// hang — same stub as worldMapZoom3CityAnchor.ui.ts. Geometry is what this file measures; the
// texture's pixels are irrelevant, but its SIZE must not leak into the sprite's, so hand out a 1x1
// white texture and let city.ts's explicit `sprite.width/height` assignment be the only thing
// that sets the size (which is exactly the code path under test).
vi.mock('../../src/render/atlas/cityAtlasLoader', () => ({
  isCityAtlasReady: () => true,
  getCityTextureForLevel: () => PIXI.Texture.WHITE,
  getCityContentTopFracForLevel: () => 0,
}));
vi.mock('../../src/render/atlas/playerBaseAtlasLoader', () => ({
  isPlayerBaseAtlasReady: () => true,
  getPlayerBaseTextureForLevel: () => PIXI.Texture.WHITE,
  getPlayerBaseContentTopFracForLevel: () => 0,
  getPlayerBaseContentWidthFracForLevel: () => 1,
  loadPlayerBaseAtlas: async () => {},
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

const { openTextInput } = createFakeTextInput();
const CB: WorldMapCallbacks = {
  onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
  onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'], openTextInput,
  worldId: 'w1', playerName: 'dbg', accountId: 'acc_dbg', storage: memStore,
};

function buildScene(layout: ILayout): WorldMapContext {
  const ctx = new WorldMapContext(layout, CB);
  ctx.view = new WorldMapRenderer(ctx);
  ctx.panels = new WorldMapPanels(ctx);
  ctx.input = new WorldMapInput(ctx);
  ctx.net = { loadMapViewport: async () => {} } as WorldMapContext['net'];
  ctx.view.build();
  return ctx;
}

/** A complete own 3x3 base (ADR-025) centred on (cx,cy): isBaseAnchor() needs the tile plus its
 *  four orthogonal neighbours to be same-owner base tiles. */
function placeOwnBase(ctx: WorldMapContext, cx: number, cy: number): void {
  const tile = (x: number, y: number): WorldTileView =>
    ({ x, y, type: 'base', level: 10, deskLevel: 10, mine: true, occupied: true } as WorldTileView);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) ctx.tileCache.set(`${cx + dx}:${cy + dy}`, tile(cx + dx, cy + dy));
  }
  ctx.me = { joined: true, mainBaseTile: `w1:${cx}:${cy}` } as WorldMapContext['me'];
}

/** Draw the base at `zoom` and measure the objects city.ts actually produced, in design px. */
function measureBase(layout: ILayout, zoom: 1 | 2 | 3): {
  tp: number; spriteW: number; maskW: number; visibleW: number; frac: number;
} {
  const ctx = buildScene(layout);
  placeOwnBase(ctx, 200, 200);
  ctx.view.setZoom(zoom);
  ctx.view.centerAt(200, 200);
  ctx.view.invalidatePool();

  const cityC = ctx.citySprites.get('200:200');
  if (!cityC) throw new Error('no city sprite was drawn for the seeded base');
  const sprite = cityC.getChildByName('img') as PIXI.Sprite;
  const mask = cityC.getChildByName('plotMask') as PIXI.Graphics;
  // The polygon is centred on the container origin and the sprite is anchored (0.5, 1) there too,
  // so both are centred on the same x and the visible width is simply the narrower of the two.
  const maskW = mask.getLocalBounds().width;
  const visibleW = Math.min(sprite.width, maskW);
  return { tp: ctx.tp, spriteW: sprite.width, maskW, visibleW, frac: visibleW / layout.designWidth };
}

// Real device viewports, not design-space literals — createLayout() maps these onto the design
// space the zoom ladder is actually keyed on (portrait pins width 1080 and grows the height;
// landscape pins height 1080 and grows the width).
const PHONE_PORTRAIT = createLayout(390, 844);   // iPhone 13-ish
const PHONE_LANDSCAPE = createLayout(844, 390);

describe('portrait L1 frames the player base at 5/6 of the screen (2026-09-15)', () => {
  it('draws the base 5/6 of the design width wide, measured off the display objects', () => {
    const m = measureBase(PHONE_PORTRAIT, 1);
    expect(m.frac).toBeCloseTo(PORTRAIT_L1_BASE_WIDTH_FRAC, 2);
    // ...and it is the PLOT that measures 5/6, which is the thing the framing constant is defined
    // against. `tp` is asserted here too so a failure says which of the two halves moved.
    expect(m.tp).toBe(Math.floor((PHONE_PORTRAIT.designWidth * PORTRAIT_L1_BASE_WIDTH_FRAC) / BASE_FOOTPRINT));
    expect(m.maskW).toBeCloseTo(BASE_FOOTPRINT * m.tp, 0);
  });

  it('is the plot mask, not the sprite, that sets the visible width', () => {
    // city.ts draws the sprite BASE_SPRITE_TILES (3.2) wide on purpose and clips it back to the
    // 3-tile plot. If the mask stops being the binding constraint — mask dropped, or the sprite
    // budget shrunk below the plot — the base no longer fills its 3x3 and the 5/6 claim quietly
    // changes meaning even though makeZoomCfgs never moved.
    const m = measureBase(PHONE_PORTRAIT, 1);
    expect(BASE_SPRITE_TILES).toBeGreaterThan(BASE_FOOTPRINT);
    expect(m.spriteW).toBeCloseTo(BASE_SPRITE_TILES * m.tp, 0);
    expect(m.spriteW).toBeGreaterThan(m.maskW);
    expect(m.visibleW).toBe(m.maskW);
  });

  it('keeps the pre-2026-09-15 wide view one tap out, at L2', () => {
    // L2 inherited the old portrait L1 divisor (11), so this is the framing the user was looking at
    // when they reported the camera sitting too high — ~27%. Pinning it keeps "the old view is still
    // reachable" a tested property rather than a claim in a commit message.
    const m = measureBase(PHONE_PORTRAIT, 2);
    expect(m.tp).toBe(Math.floor(PHONE_PORTRAIT.designWidth / 11));
    expect(m.frac).toBeGreaterThan(0.2);
    expect(m.frac).toBeLessThan(0.35);
  });

  it('leaves landscape alone — 5/6 there would be a base filling the long axis', () => {
    // The two ladders are deliberately different (zoom.ts branches on `h <= w`). This is the guard
    // against a future "why are there two ladders" cleanup: on a landscape layout the same closest
    // tier must still be the tile-count-derived one, well under half the width.
    const m = measureBase(PHONE_LANDSCAPE, 1);
    expect(m.tp).toBe(Math.floor(PHONE_LANDSCAPE.designWidth / 11));
    expect(m.frac).toBeLessThan(0.4);
  });

  it('routes a real phone to the ladder its ORIENTATION implies, not its device pixel count', () => {
    // The branch reads design dimensions, which are not the device's: a 390x844 phone becomes
    // 1080x~2337 and a 844x390 one becomes ~2337x1080. Asserting on the real layouts is what makes
    // this meaningful — `h <= w` on the raw viewport would happen to agree here and diverge on any
    // device whose design mapping is not a pure scale.
    expect(PHONE_PORTRAIT.designWidth).toBe(1080);
    expect(PHONE_PORTRAIT.designHeight).toBeGreaterThan(PHONE_PORTRAIT.designWidth);
    expect(PHONE_LANDSCAPE.designHeight).toBe(1080);
    expect(PHONE_LANDSCAPE.designWidth).toBeGreaterThan(PHONE_LANDSCAPE.designHeight);
    // A tablet in portrait (4:3) is the interesting one: much less extreme than a phone, but its
    // design space is still taller than wide, so it takes the portrait ladder too.
    const tablet = createLayout(768, 1024);
    expect(tablet.designHeight).toBeGreaterThan(tablet.designWidth);
    expect(measureBase(tablet, 1).frac).toBeCloseTo(PORTRAIT_L1_BASE_WIDTH_FRAC, 2);
  });
});
