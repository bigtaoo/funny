// Coverage for the 2026-07-22 HP-bar-floats-above-short-buildings fix (see worldMapBaseHpBar.ui.ts
// for the city.ts wiring test). This file tests the data layer directly: cityAtlasLoader's and
// playerBaseAtlasLoader's getContentTopFracForLevel getters, against the REAL atlas JSON bundled
// with the client (not mocked) — so it fails the moment a future re-pack of either atlas drops the
// `contentTop` field, or the getters' frame-name resolution (per-level vs tier fallback) drifts out
// of sync with getCityTextureForLevel's own resolution.
//
// No PIXI scene needed, but these loaders `import atlasUrl from '.../*.png'`, which only the .ui.ts
// harness's stubBinaryAssets plugin can resolve — hence living here rather than a plain .test.ts.
// The getters intentionally don't gate on the atlas's decode state (see the loaders' own doc
// comments), so this needs neither loadCityAtlas() nor loadPlayerBaseAtlas().

import { describe, it, expect } from 'vitest';
import { cityTier } from '@nw/shared';
import { getCityContentTopFracForLevel } from '../../src/render/cityAtlasLoader';
import { getPlayerBaseContentTopFracForLevel } from '../../src/render/playerBaseAtlasLoader';
import cityAtlasData from '../../src/assets/slg/city_atlas.json';
import playerBaseAtlasData from '../../src/assets/slg/playerbase_atlas.json';

type FrameMap = Record<string, { contentTop?: number }>;
const cityFrames = (cityAtlasData as { frames: FrameMap }).frames;
const playerBaseFrames = (playerBaseAtlasData as { frames: FrameMap }).frames;

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
});
