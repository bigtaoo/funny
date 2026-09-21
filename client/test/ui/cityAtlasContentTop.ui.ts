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
import { BASE_FOOTPRINT, cityFootprint, citySpriteTiles } from '@nw/shared';
import { getCityContentTopFracForLevel } from '../../src/render/atlas/cityAtlasLoader';
import { getPlayerBaseContentTopFracForLevel, getPlayerBaseContentWidthFracForLevel } from '../../src/render/atlas/playerBaseAtlasLoader';
import { ISO_RATIO } from '../../src/render/isoGrid';
import { BASE_SPRITE_TILES } from '../../src/scenes/worldmap/logic/constants';
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

  it('every level 1-10 has its own dedicated frame (city_l{level}) and returns that frame\'s own contentTop — no tier fallback since the 2026-08-14 naming unification', () => {
    for (let lv = 1; lv <= 10; lv++) {
      expect(cityFrames[`city_l${lv}`], `city_l${lv}`).toBeDefined();
      expect(getCityContentTopFracForLevel(lv)).toBe(cityFrames[`city_l${lv}`].contentTop);
    }
  });

  it('clamps out-of-range levels into [1,10] the same way getCityTextureForLevel does', () => {
    expect(getCityContentTopFracForLevel(0)).toBe(getCityContentTopFracForLevel(1));
    expect(getCityContentTopFracForLevel(-5)).toBe(getCityContentTopFracForLevel(1));
    expect(getCityContentTopFracForLevel(11)).toBe(getCityContentTopFracForLevel(10));
    expect(getCityContentTopFracForLevel(999)).toBe(getCityContentTopFracForLevel(10));
  });

  it('contentTop varies widely across levels — this spread is the bug a flat offset cannot absorb', () => {
    // Direct assertion of the reported bug's shape: levels fill very different fractions of their
    // fixed cell, which is exactly why a flat "90% of full cell height" offset floated the bar over
    // empty padding on the frames whose art is short.
    //
    // This used to be pinned as "lv1 > 0.3 AND lv10 < 0.1", i.e. "a top-tier citadel nearly fills
    // its cell". That direction was an artefact of the 2026-09-21 height defect, not a contract: a
    // frame only fills its square cell vertically by being drawn as tall as its plot is wide. Now
    // that l3/l5/l7/l8/l9/l10 are wide-and-low, every frame legitimately leaves 26-50% of its cell
    // empty and no level is the designated "full" one. The spread is what the fix depends on.
    const tops = Array.from({ length: 10 }, (_, i) => getCityContentTopFracForLevel(i + 1));
    expect(Math.max(...tops) - Math.min(...tops)).toBeGreaterThan(0.15);
  });

  it('no frame is drawn taller than its own plot plus a spire allowance (2026-09-21)', () => {
    // The city sprite is scaled to a SQUARE citySpriteTiles(footprint, BASE_SPRITE_TILES) tiles on a
    // side (WorldMapRenderer/city.ts), so on-map drawn height in tiles is
    // (1 - contentTop) * footprint/BASE_FOOTPRINT * BASE_SPRITE_TILES — i.e. purely a property of the
    // source art's aspect ratio, with no code-side knob. An N×N plot is only N * ISO_RATIO tiles tall
    // on screen, so art drawn near-square (aspect ≈ 1.0) renders a castle taller than its own plot is
    // wide. That is what shipped until 2026-09-21, when the 9×9 world centre measured 1.05× its plot
    // width; the 2026-08-13 audit had missed it because its criterion (cw/ch >= 0.9375) only checks
    // plot-WIDTH fill and has no height ceiling. Mirrors the playerbase height-budget test above.
    //
    // K is as tight as the current art allows: `city_l2` (1.40) is the last frame still on
    // pre-2026-09-21 art, and nothing else exceeds 1.22. Every frame the 2026-09-21 batch
    // replaced sat at 2.03-2.13, so this still separates fixed from broken by a wide margin.
    // Tighten to the playerbase's own 1.2 if l2 is ever redrawn — it is a 3×3 starter camp
    // nobody has complained about, so that is a nice-to-have, not a queued fix
    // (design/product/city-image-prompts.md § 高度审计 2026-09-21).
    const HEIGHT_BUDGET_K = 1.45;
    for (let lv = 1; lv <= 10; lv++) {
      const footprint = cityFootprint(lv);
      const drawnTiles = (1 - getCityContentTopFracForLevel(lv)) * citySpriteTiles(footprint, BASE_SPRITE_TILES);
      const plotScreenTiles = footprint * ISO_RATIO;
      expect(drawnTiles, `city_l${lv} drawn height in tiles`).toBeLessThanOrEqual(plotScreenTiles * HEIGHT_BUDGET_K + 0.02);
    }
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

  // 2026-08-08: CONTENT_W_FRAC in pack_playerbase_atlas.js was left at 0.8 — a comfort margin from the
  // 2026-08-02 pre-ground-plate art — through the 2026-08-03 art redraw, so even the new wide-and-low
  // art was still being clipped to 80% of its cell width instead of reaching the plot's own width. The
  // height tests above never caught this: contentTop only reads off the vertical axis, and this bug
  // didn't touch it at all. contentWidthFrac (mirrors contentTop, but for width) is what makes it
  // testable — see pack_playerbase_atlas.js's makeCell() for how it's measured.
  describe('getPlayerBaseContentWidthFracForLevel (2026-08-08 width-underfill regression)', () => {
    it('every level has a contentWidthFrac in (0,1] — falls back to 1 only on a pre-2026-08-08 atlas', () => {
      for (let lv = 1; lv <= 10; lv++) {
        const frac = getPlayerBaseContentWidthFracForLevel(lv);
        expect(frac, `playerbase_l${lv}`).toBeGreaterThan(0);
        expect(frac, `playerbase_l${lv}`).toBeLessThanOrEqual(1);
      }
    });

    it('at least one level\'s ground plate reaches the plot\'s own full width', () => {
      // `fit:'inside'` in the packer binds on whichever of CONTENT_W_FRAC/CONTENT_H_FRAC hits its
      // budget first — only frames wider than the ~10:7 target aspect are WIDTH-bound and so actually
      // reach CONTENT_W_FRAC's target; the rest are height-bound and legitimately fall short (known,
      // left for a future art pass — see design/product/player-base-image-prompts.md § 2026-08-08).
      // Which specific level is width-bound depends on the current art batch's aspect ratios, so this
      // doesn't hardcode a level — it just asserts SOME level gets there. At the old CONTENT_W_FRAC=0.8
      // every level was capped at exactly 0.8, so the max across all ten would sit at 0.8 too and this
      // assertion is exactly what would have failed then.
      const target = BASE_FOOTPRINT / BASE_SPRITE_TILES; // ≈0.9375 — the plot's own width as a
      // fraction of the BASE_SPRITE_TILES-wide sprite cell (the same "fill the cell, let
      // cityPlotMaskPoints trim the ~7% overhang" contract city_atlas already uses).
      const widest = Math.max(...Array.from({ length: 10 }, (_, i) => getPlayerBaseContentWidthFracForLevel(i + 1)));
      expect(widest).toBeGreaterThanOrEqual(target - 0.02);
    });

    it('no level\'s content width is shrunk to near-nothing — a failed cut is also a bug', () => {
      for (let lv = 1; lv <= 10; lv++) {
        expect(getPlayerBaseContentWidthFracForLevel(lv), `playerbase_l${lv}`).toBeGreaterThan(0.5);
      }
    });
  });
});
