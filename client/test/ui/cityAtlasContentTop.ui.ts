// Coverage for the 2026-07-22 HP-bar-floats-above-short-buildings fix (see worldMapBaseHpBar.ui.ts
// for the city.ts wiring test). This file tests the data layer directly: cityAtlasLoader's and
// playerBaseAtlasLoader's getContentTopFracForLevel getters, against the REAL atlas JSON bundled
// with the client (not mocked — both loaders now read the shared, merged world_atlas.json, see
// worldAtlas.ts) — so it fails the moment a future re-pack of either atlas drops the
// `contentTop` field, or the getters' frame-name resolution (per-level vs tier fallback) drifts out
// of sync with getCityTextureForLevel's own resolution.
//
// No PIXI scene needed, but these loaders `import atlasUrl from '.../*.png'`, which only the .ui.ts
// harness's stubBinaryAssets plugin can resolve — hence living here rather than a plain .test.ts.
// The getters intentionally don't gate on the atlas's decode state (see the loaders' own doc
// comments), so this needs neither loadCityAtlas() nor loadPlayerBaseAtlas().

import { describe, it, expect } from 'vitest';
import { cityTier, BASE_FOOTPRINT } from '@nw/shared';
import { getCityContentTopFracForLevel } from '../../src/render/atlas/cityAtlasLoader';
import { getPlayerBaseContentTopFracForLevel } from '../../src/render/atlas/playerBaseAtlasLoader';
import { ISO_RATIO } from '../../src/render/isoGrid';
import { BASE_SPRITE_TILES } from '../../src/scenes/worldmap/constants';
import worldAtlasData from '../../src/assets/slg/world_atlas.json';

type FrameMap = Record<string, { contentTop?: number }>;
const worldFrames = (worldAtlasData as { frames: FrameMap }).frames;
// world_atlas.json is shared by 6 merged atlases (worldAtlas.ts) — scope down to each
// loader's own frames (disjoint `city_*` / `playerbase_*` prefixes) so this doesn't
// assert contentTop against unrelated frame families (e.g. terrain_*) that never had it.
const cityFrames = Object.fromEntries(Object.entries(worldFrames).filter(([k]) => k.startsWith('city_')));
const playerBaseFrames = Object.fromEntries(Object.entries(worldFrames).filter(([k]) => k.startsWith('playerbase_')));

describe('cityAtlasLoader.getCityContentTopFracForLevel (real atlas data)', () => {
  it('every baked frame has a contentTop in [0,1) — the fix depends on this being present', () => {
    // (1 itself would mean "zero visible pixels", which pack_*_atlas.js can never produce for a
    // non-empty source image, so content strictly less than the full cell.)
    for (const [name, frame] of Object.entries(cityFrames)) {
      expect(frame.contentTop, `${name} missing contentTop`).toBeDefined();
      expect(frame.contentTop as number, name).toBeGreaterThanOrEqual(0);
      expect(frame.contentTop as number, name).toBeLessThan(1);
    }
  });

  it('per-level frames (city_l2/4/5/7/8/10) return that frame\'s own contentTop, not the tier fallback', () => {
    for (const lv of [2, 4, 5, 7, 8, 10]) {
      expect(getCityContentTopFracForLevel(lv)).toBe(cityFrames[`city_l${lv}`].contentTop);
    }
  });

  it('levels without a per-level frame (1/3/6/9) fall back to their TIER frame\'s contentTop', () => {
    for (const lv of [1, 3, 6, 9]) {
      const tierFrame = cityFrames[`city_lv${cityTier(lv)}`];
      expect(getCityContentTopFracForLevel(lv)).toBe(tierFrame.contentTop);
    }
  });

  it('clamps out-of-range levels into [1,10] the same way getCityTextureForLevel does', () => {
    expect(getCityContentTopFracForLevel(0)).toBe(getCityContentTopFracForLevel(1));
    expect(getCityContentTopFracForLevel(-5)).toBe(getCityContentTopFracForLevel(1));
    expect(getCityContentTopFracForLevel(11)).toBe(getCityContentTopFracForLevel(10));
    expect(getCityContentTopFracForLevel(999)).toBe(getCityContentTopFracForLevel(10));
  });

  it('a low-tier camp (lv1) has a much larger contentTop than a top-tier citadel (lv10) — this gap is the bug', () => {
    // Direct assertion of the reported bug's shape: a lv1 camp's art fills far less of the cell
    // than a lv10 citadel's, which is exactly why a flat "90% of full cell height" offset floated
    // the bar over empty padding for low-level bases.
    expect(getCityContentTopFracForLevel(1)).toBeGreaterThan(0.3);
    expect(getCityContentTopFracForLevel(10)).toBeLessThan(0.1);
  });
});

describe('playerBaseAtlasLoader.getPlayerBaseContentTopFracForLevel (real atlas data)', () => {
  it('every level 1-10 has its own frame with a contentTop in [0,1) — no tier fallback for this atlas', () => {
    for (let lv = 1; lv <= 10; lv++) {
      const frame = playerBaseFrames[`playerbase_l${lv}`];
      expect(frame, `playerbase_l${lv}`).toBeDefined();
      expect(frame.contentTop, `playerbase_l${lv}`).toBeDefined();
      expect(getPlayerBaseContentTopFracForLevel(lv)).toBe(frame.contentTop);
    }
  });

  it('clamps out-of-range levels into [1,10]', () => {
    expect(getPlayerBaseContentTopFracForLevel(0)).toBe(getPlayerBaseContentTopFracForLevel(1));
    expect(getPlayerBaseContentTopFracForLevel(23)).toBe(getPlayerBaseContentTopFracForLevel(10));
  });

  it('no frame is taller than the 3×3 plot\'s own screen height plus a spire allowance (2026-08-02)', () => {
    // The art is bottom-aligned in its cell, so contentTop doubles as a height readout: the drawn
    // building is (1 - contentTop) of the cell, and the renderer draws that cell as a
    // BASE_SPRITE_TILES-wide SQUARE (WorldMapRenderer/city.ts) — so the on-map height in tiles is
    // (1 - contentTop) * BASE_SPRITE_TILES. The 3×3 plot is only BASE_FOOTPRINT * ISO_RATIO = 1.5
    // tiles tall on screen (2:1 isometric), and this art has no ground plate, so a square fit made
    // every base ~2.5 tiles tall — overhanging its own plot by a full tile and covering ~2 rows of
    // tiles behind it. pack_playerbase_atlas.js now budgets height separately (HEIGHT_BUDGET_K);
    // this locks that in, so a repack that goes back to a square scale fails here instead of
    // silently shipping oversized bases again.
    const HEIGHT_BUDGET_K = 1.2;
    const maxTiles = BASE_FOOTPRINT * ISO_RATIO * HEIGHT_BUDGET_K;
    for (let lv = 1; lv <= 10; lv++) {
      const drawnTiles = (1 - getPlayerBaseContentTopFracForLevel(lv)) * BASE_SPRITE_TILES;
      expect(drawnTiles, `playerbase_l${lv} drawn height in tiles`).toBeLessThanOrEqual(maxTiles + 0.02);
    }
  });

  it('but is not shrunk to nothing either — a repack that lost the art is also a bug', () => {
    // Only a loose floor, deliberately: the packer budgets width and height independently and
    // `fit:'inside'` honours whichever binds first, so a frame WIDER than the ~10:7 target aspect
    // (a sparse low camp like l1) is width-bound and legitimately ends up shorter than the plot's
    // own 1.5-tile screen height. Asserting "at least as tall as the plot" would therefore fail on
    // exactly the wide-and-low art the composition rules ask for
    // (design/product/player-base-image-prompts.md § 构图硬规). Half the plot height is well below
    // anything a real frame produces and still catches an empty/failed cut.
    for (let lv = 1; lv <= 10; lv++) {
      const drawnTiles = (1 - getPlayerBaseContentTopFracForLevel(lv)) * BASE_SPRITE_TILES;
      expect(drawnTiles, `playerbase_l${lv} drawn height in tiles`).toBeGreaterThan(BASE_FOOTPRINT * ISO_RATIO * 0.5);
    }
  });
});
