// Regression coverage for the 2026-08-19 fix: the world map's NPC city sprite layer drew
// `allCityNodes(ctx.cb.worldId)` — a purely seed-derived list — while the GROUND those cities stand
// on comes from the world's map-template baseline, which a designer can edit in tools/map-editor. A
// published (dragged) city therefore moved its plot but left its castle at the original procedural
// spot; the vacated N×N footprint rendered as bare city ground, and each of its tiles stamped its own
// `building_keep` gatehouse. `POST /world/enter` now ships the world's real node list
// (WorldMapContext.cityNodes) and WorldMapRenderer/core.ts prefers it, falling back to
// allCityNodes() only when nothing has arrived.
//
// Builds a REAL WorldMapContext + WorldMapRenderer (same wiring as WorldMapScene, minus
// WorldMapNet), so the city layer runs exactly as in production. See worldMapZoom3CityAnchor.ui.ts
// for the shared harness notes (headless PIXI adapter, stubbed city atlas).

import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { allCityNodes, type MapEditorCityNode } from '@nw/shared';
import { createFakeTextInput } from '../harness/fakeTextInput';
import { initI18n } from '../../src/i18n';
import { WorldMapContext, type WorldMapCallbacks } from '../../src/scenes/worldmap/WorldMapContext';
import { WorldMapRenderer } from '../../src/scenes/worldmap/WorldMapRenderer';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { WorldMapInput } from '../../src/scenes/worldmap/WorldMapInput';
import { tileToScreen } from '../../src/render/isoGrid';
import type { ILayout } from '../../src/layout/ILayout';

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
const WORLD_ID = 'w1';

const { openTextInput } = createFakeTextInput();
const CB: WorldMapCallbacks = {
  onBack() {}, onOpenChat() {}, onOpenAuction() {}, onReplaySiege() {}, onOpenCity() {},
  onOpenDefense() {}, worldApi: {} as WorldMapCallbacks['worldApi'], openTextInput,
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

/** Screen X the city layer must place a node sprite at (see city.ts: panX + tileToScreen). Under the
 *  2:1 iso projection screen X is (tx - ty), so a fixture that moves a city must shift x and y by
 *  DIFFERENT amounts or the X coordinate stays put and the assertion proves nothing. */
function expectedSpriteX(ctx: WorldMapContext, node: { x: number; y: number }): number {
  return ctx.panX + tileToScreen(node.x, node.y, ctx.tp).x;
}

/** The seed-derived garrison node this suite drags around. */
const SEED_NODE: MapEditorCityNode = allCityNodes(WORLD_ID).find((n) => n.kind === 'garrison')!;

describe('WorldMap published city nodes (2026-08-19 regression)', () => {
  it('falls back to the seed-derived list before the entry fetch lands', () => {
    const ctx = buildScene();
    expect(ctx.cityNodes).toBeNull(); // nothing served yet
    ctx.view.centerAt(SEED_NODE.x, SEED_NODE.y);
    ctx.view.invalidatePool();

    const sprite = ctx.citySprites.get(`node:${SEED_NODE.id}`);
    expect(sprite).toBeTruthy();
    expect(sprite!.x).toBeCloseTo(expectedSpriteX(ctx, SEED_NODE));
  });

  it('draws a published city at its PUBLISHED position, not its procedural one', () => {
    const ctx = buildScene();
    // What a designer publishing a drag produces: same node id, new coordinates.
    const moved = { ...SEED_NODE, x: SEED_NODE.x - 25, y: SEED_NODE.y - 11 };
    ctx.cityNodes = allCityNodes(WORLD_ID).map((n) => (n.id === SEED_NODE.id ? moved : n));

    ctx.view.centerAt(moved.x, moved.y);
    ctx.view.invalidatePool();

    const sprite = ctx.citySprites.get(`node:${SEED_NODE.id}`);
    expect(sprite).toBeTruthy();
    expect(sprite!.x).toBeCloseTo(expectedSpriteX(ctx, moved));
    // The whole point: this is NOT where allCityNodes() said the city was.
    expect(expectedSpriteX(ctx, moved)).not.toBeCloseTo(expectedSpriteX(ctx, SEED_NODE));
  });

  it('honours a served level/footprint change, not just a move', () => {
    const ctx = buildScene();
    const bigger = { ...SEED_NODE, level: 10, footprint: 9 };
    ctx.cityNodes = [bigger];
    ctx.view.centerAt(bigger.x, bigger.y);
    ctx.view.invalidatePool();

    const sprite = ctx.citySprites.get(`node:${SEED_NODE.id}`)!;
    const img = sprite.getChildByName('img') as PIXI.Sprite;
    const wideWidth = img.width;

    // Same node at its original (smaller) tier must draw a narrower sprite — footprint drives size.
    const ctx2 = buildScene();
    ctx2.cityNodes = [SEED_NODE];
    ctx2.view.centerAt(SEED_NODE.x, SEED_NODE.y);
    ctx2.view.invalidatePool();
    const img2 = ctx2.citySprites.get(`node:${SEED_NODE.id}`)!.getChildByName('img') as PIXI.Sprite;

    expect(SEED_NODE.footprint).toBeLessThan(9); // guard: the fixture must actually differ
    expect(wideWidth).toBeGreaterThan(img2.width);
  });

  it('a served list with a city removed stops drawing it', () => {
    const ctx = buildScene();
    ctx.cityNodes = allCityNodes(WORLD_ID).filter((n) => n.id !== SEED_NODE.id);
    ctx.view.centerAt(SEED_NODE.x, SEED_NODE.y);
    ctx.view.invalidatePool();
    expect(ctx.citySprites.get(`node:${SEED_NODE.id}`)).toBeUndefined();
  });
});
