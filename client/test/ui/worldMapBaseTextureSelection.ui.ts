// Regression coverage for the 2026-08-12 fix (see SLG_DESIGN_LOG.md §2026-08-12 and the sibling
// worldMapCityLabel.ui.ts, which only covers the text label): WorldMapRenderer/city.ts's
// refreshCityLayer() used to pick the base SPRITE's texture with
// `tile.mine ? getPlayerBaseTextureForLevel(tile.deskLevel ?? 1) : null`, so only the requester's
// own base used the real desk-building level (playerbase_atlas); every OTHER player's base fell
// back to `getCityTextureForLevel(tile.level)` — tile.level is a terrain-generation value frozen
// once at spawn (server/worldsvc/src/core/spawn.ts) and never updated by desk upgrades. A
// brand-new Lv.1 account could spawn on a high terrain-level tile purely by map-seed chance and
// render as a max-tier fortress to everyone else (user report, account "tao").
//
// Unlike worldMapCityLabel.ui.ts (which only asserts the text string), this file asserts the
// actual `getPlayerBaseTextureForLevel`/`getCityTextureForLevel` call arguments and the resulting
// sprite.texture identity — the two atlases are mocked to return distinguishable stub textures so
// "which atlas supplied the sprite" and "which level it was keyed on" are both directly observable.
//
// Same real-scene wiring as worldMapZoom3CityAnchor.ui.ts / worldMapCityLabel.ui.ts (WorldMapContext
// + Renderer + Panels + Input, minus WorldMapNet), under the headless PIXI adapter.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import type { ILayout } from '../../src/layout/ILayout';
import type { WorldTileView } from '../../src/net/WorldApiClient';
import { createFakeTextInput } from '../harness/fakeTextInput';

// vi.mock factories run the first time the mocked module is imported (transitively, via
// WorldMapContext -> ... -> city.ts below) — which happens before this file's own top-level
// `const`s would otherwise initialize. vi.hoisted() guarantees these are ready in time; see
// https://vitest.dev/api/vi.html#vi-hoisted.
const { playerBaseCalls, cityCalls, playerBaseReady } = vi.hoisted(() => ({
  playerBaseCalls: [] as number[],
  cityCalls: [] as number[],
  playerBaseReady: { value: true }, // toggled by the "atlas still decoding" test below
}));

vi.mock('../../src/render/atlas/cityAtlasLoader', () => ({
  isCityAtlasReady: () => true,
  getCityTextureForLevel: (level: number) => { cityCalls.push(level); return PIXI.Texture.WHITE; },
  getCityContentTopFracForLevel: () => 0,
  loadCityAtlas: async () => {},
}));

vi.mock('../../src/render/atlas/playerBaseAtlasLoader', () => ({
  isPlayerBaseAtlasReady: () => true,
  getPlayerBaseTextureForLevel: (level: number) => {
    playerBaseCalls.push(level);
    return playerBaseReady.value ? PIXI.Texture.EMPTY : null;
  },
  getPlayerBaseContentTopFracForLevel: () => 0,
  loadPlayerBaseAtlas: async () => {},
}));

// The two stub textures the mocks above hand out — distinct PIXI statics, so `sprite.texture`
// identity alone tells us which atlas actually supplied the frame.
const CITY_TEX = PIXI.Texture.WHITE;
const PLAYER_TEX = PIXI.Texture.EMPTY;

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
  openTextInput: createFakeTextInput().openTextInput,
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

/** Render a base and return its live sprite. */
function renderSprite(ctx: WorldMapContext, cx: number, cy: number): PIXI.Sprite {
  ctx.view.centerAt(cx, cy);
  ctx.view.invalidatePool();
  const cityC = ctx.citySprites.get(`${cx}:${cy}`);
  expect(cityC, 'a base city sprite should have been created').toBeTruthy();
  return cityC!.getChildByName('img') as PIXI.Sprite;
}

beforeEach(() => {
  playerBaseCalls.length = 0;
  cityCalls.length = 0;
  playerBaseReady.value = true;
});

describe('WorldMap base sprite texture selection (2026-08-12 regression)', () => {
  it('own base renders from playerbase_atlas keyed by deskLevel, ignoring the decoy terrain `level`', () => {
    const ctx = buildScene();
    // `level: 9` is a decoy: the terrain-generation level must never drive the sprite.
    placeBase(ctx, 100, 100, { mine: true, level: 9, deskLevel: 3 });
    const sprite = renderSprite(ctx, 100, 100);

    expect(sprite.texture).toBe(PLAYER_TEX);
    expect(playerBaseCalls).toEqual([3]);
    expect(cityCalls).toEqual([]); // city_atlas never even consulted when playerbase resolves
  });

  it('own base with no deskLevel yet (fresh, no desk upgrade) defaults to level 1, not the terrain level', () => {
    const ctx = buildScene();
    placeBase(ctx, 105, 105, { mine: true, level: 7 }); // deskLevel absent
    const sprite = renderSprite(ctx, 105, 105);

    expect(sprite.texture).toBe(PLAYER_TEX);
    expect(playerBaseCalls).toEqual([1]);
  });

  it("regression: another player's base renders from playerbase_atlas keyed by THEIR deskLevel, " +
     'not the decoy terrain `level` (used to fall back to city_atlas keyed off `level` for anyone else)', () => {
    const ctx = buildScene();
    placeBase(ctx, 110, 110, { mine: false, occupied: true, level: 9, deskLevel: 3, ownerName: 'Bob' });
    const sprite = renderSprite(ctx, 110, 110);

    expect(sprite.texture).toBe(PLAYER_TEX);
    expect(playerBaseCalls).toEqual([3]);
    expect(cityCalls).toEqual([]);
  });

  it('regression (reported bug, account "tao"): a low-level account with no deskLevel yet renders ' +
     'as a level-1 player base even when its spawn tile landed on a high terrain-level cell, never ' +
     'as a high-tier city_atlas fortress', () => {
    const ctx = buildScene();
    // Mirrors the reported case: brand-new account, desk never upgraded (no deskLevel field), but
    // the spawn tile's map-seed terrain `level` happens to be high (here 10, worst case).
    placeBase(ctx, 111, 111, { mine: false, occupied: true, level: 10, ownerName: 'tao' });
    const sprite = renderSprite(ctx, 111, 111);

    expect(sprite.texture).toBe(PLAYER_TEX); // NOT the city_atlas fortress texture
    expect(sprite.texture).not.toBe(CITY_TEX);
    expect(playerBaseCalls).toEqual([1]); // level-1 playerbase frame, not level-10
    expect(cityCalls).toEqual([]);
  });

  it('falls back to city_atlas (keyed by the terrain `level`) only while the playerbase atlas has ' +
     'not finished decoding yet — for own base and other players\' bases alike', () => {
    playerBaseReady.value = false; // simulates getPlayerBaseTextureForLevel returning null pre-decode

    const mine = buildScene();
    placeBase(mine, 120, 120, { mine: true, level: 4, deskLevel: 6 });
    expect(renderSprite(mine, 120, 120).texture).toBe(CITY_TEX);
    expect(cityCalls).toEqual([4]); // falls back on tile.level, deskLevel is moot once the atlas can't serve it

    const other = buildScene();
    placeBase(other, 121, 121, { mine: false, occupied: true, level: 5, deskLevel: 2, ownerName: 'Bob' });
    expect(renderSprite(other, 121, 121).texture).toBe(CITY_TEX);
    expect(cityCalls).toEqual([4, 5]);
  });
});
