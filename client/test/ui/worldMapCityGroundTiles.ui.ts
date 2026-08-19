// Regression coverage for the 2026-08-19 render decision: a CITY GROUND tile (`familyKeep` =
// province capital / graded city, `center` = world centre) draws NOTHING of its own.
//
// `familyKeep` used to stamp a `building_keep` gatehouse per tile, at `tp*1.3` so neighbours overlap.
// That was invisible on a procedural city — `proceduralTile` classifies only the single anchor tile, so
// the one gatehouse hid under the city sprite — but a PUBLISHED city has its whole N×N footprint
// rasterized as `familyKeep` (shared `rasterizeMapEdits`), and every cell stamped its own gatehouse:
// the same wall of overlapping masonry the scattered-familyKeep tile class had just been deleted for.
//
// Two halves are asserted here, because they pull in opposite directions and it would be easy to
// "fix" one by breaking the other:
//   • no feature-building sprite on city ground (the bug), yet
//   • the resource-motif heap is STILL suppressed there — city ground keeps a biome `resType`
//     (mapgen/tileGen.ts + mapEdit.ts both write one), and a heap under a castle is the same clutter
//     the 2026-08-17 pass removed from watchtower/arrowTower tiles.
//
// The type→art mapping itself lives in @nw/shared (`isCityGroundTile` / `tileFeatureBuilding`) so the
// map editor's drawEditorTile shares it verbatim; server/shared/test/core.test.ts pins the mapping.
// What THIS file adds is that drawTileL1 actually routes through it — a correct mapping nobody calls
// would still render gatehouses.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import type { WorldTileView } from '../../src/net/WorldApiClient';

const TP = 76; // L1 tile pitch

/** A texture of the given packed-frame size; never rendered, so no GL context is needed. */
function fakeTex(w = 256, h = 198): PIXI.Texture {
  return new PIXI.Texture(new PIXI.BaseTexture(undefined, { width: w, height: h }));
}

/**
 * Draw one tile with BOTH atlases reporting ready, and report what got added.
 *
 * Both stubs matter. Without the building atlas ready, `placeBuildingSprite` returns early and every
 * "no gatehouse" assertion below would pass vacuously — the pre-fix code would look fixed. Without the
 * res atlas ready, the motif sprite never appears and the suppression half would be vacuous too.
 */
async function drawn(tile: WorldTileView): Promise<{ sprites: PIXI.Sprite[]; frames: string[] }> {
  vi.resetModules();
  const frames: string[] = [];
  vi.doMock('../../src/render/atlas/buildingAtlasLoader', () => ({
    isBuildingAtlasReady: () => true,
    getBuildingTexture: (name: string) => { frames.push(name); return fakeTex(); },
  }));
  vi.doMock('../../src/render/atlas/resAtlasLoader', () => ({
    isResAtlasReady: () => true,
    getResTexture: () => fakeTex(128, 128),
    getResLevelTexture: () => fakeTex(128, 128),
    getResFrameRead: () => ({ sizeMul: 1 / 128, alphaMul: 1 }),
  }));
  const { drawTileL1 } = await import('../../src/scenes/worldmap/tileGraphics');
  const g = new PIXI.Graphics();
  drawTileL1(g, tile, 0xffffff, null, false, TP, false, 'terrain_grass', null, 5, 5, 'w1');
  return { sprites: g.children.filter((c): c is PIXI.Sprite => c instanceof PIXI.Sprite), frames };
}

/** A tile as the server reports city ground: the city type PLUS the biome resType it always carries. */
function cityGround(type: 'familyKeep' | 'center'): WorldTileView {
  return { x: 5, y: 5, type, level: 9, resType: 'paper' } as WorldTileView;
}

describe('drawTileL1 city ground draws no per-tile art (2026-08-19 regression)', () => {
  it('a familyKeep tile stamps no building sprite — the gatehouse wall bug', async () => {
    const { sprites, frames } = await drawn(cityGround('familyKeep'));
    expect(frames).not.toContain('building_keep');
    expect(sprites).toHaveLength(0);
  });

  it('a center (world-centre) tile stamps no building sprite either', async () => {
    const { sprites } = await drawn(cityGround('center'));
    expect(sprites).toHaveLength(0);
  });

  it('city ground still suppresses the resource heap, despite carrying a resType', async () => {
    // Guard the guard: the same tile WITHOUT the city type does draw a heap, so the empty result
    // above is the city-ground rule and not a broken res-atlas stub.
    const asResource = { x: 5, y: 5, type: 'resource', level: 9, resType: 'paper' } as WorldTileView;
    expect((await drawn(asResource)).sprites.length).toBeGreaterThan(0);
    expect((await drawn(cityGround('familyKeep'))).sprites).toHaveLength(0);
  });

  it('the three real landmarks still stamp their own frames — the fix removed one case, not the feature', async () => {
    for (const [type, frame] of [
      ['stronghold', 'building_stronghold'],
      ['bridge', 'building_bridge'],
      ['plankway', 'building_plankway'],
    ] as const) {
      const { sprites, frames } = await drawn({ x: 5, y: 5, type, level: 9 } as WorldTileView);
      expect(frames, type).toContain(frame);
      expect(sprites.length, type).toBeGreaterThan(0);
    }
  });
});
