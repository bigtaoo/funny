// Unit tests for slg/core.ts's pure helpers that aren't already exercised elsewhere: the SlgError
// wrapper, deterministic ID derivation (worldId/tileId/.../siegeId), the main-base 3×3 footprint
// geometry, city-sprite placement geometry, and the emblem key/color validators. cityFootprint
// itself, orgNameWidth/truncateOrgName, and the province/proceduralTile machinery already have
// dedicated coverage (city-buildings.test.ts / orgName.test.ts / slg.test.ts) and are not repeated here.
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../src/api';
import {
  SlgError,
  worldId,
  tileId,
  playerWorldId,
  familyMemberId,
  familyId,
  sectId,
  auctionId,
  marchId,
  siegeId,
  baseFootprintCells,
  baseFootprintInBounds,
  BASE_FOOTPRINT,
  BASE_FOOTPRINT_R,
  citySpriteTiles,
  cityGroundFwdPx,
  cityPlotMaskPoints,
  isCityGroundTile,
  tileFeatureBuilding,
  resMotifJitter,
  resMotifPlacement,
  resLevelLabelFontPx,
  RES_LEVEL_LABEL_TP_FRAC,
  RES_LEVEL_LABEL_MIN_PX,
  RES_LEVEL_LABEL_MAX_PX,
  RES_LEVEL_LABEL_MIN_TP,
  RES_MOTIF_SIZE_FRAC,
  RES_MOTIF_FOG_ALPHA,
  type TileType,
  EMBLEM_KEYS,
  isEmblemKey,
  EMBLEM_COLORS,
  isEmblemColor,
} from '../src/slg/core';

describe('SlgError', () => {
  it('carries the ErrorCode value and defaults its message to the code name', () => {
    const e = new SlgError('TILE_OCCUPIED');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('SlgError');
    expect(e.code).toBe(ErrorCode.TILE_OCCUPIED);
    expect(e.message).toBe('TILE_OCCUPIED');
  });

  it('accepts a custom message, keeping the code separate', () => {
    const e = new SlgError('WORLD_FULL', 'this world has no room left');
    expect(e.code).toBe(ErrorCode.WORLD_FULL);
    expect(e.message).toBe('this world has no room left');
  });
});

// ── Deterministic ID derivation (§14.7) ───────────────────────────────────────────────────────

describe('deterministic ID derivation', () => {
  it('worldId formats as s{season}-{shard}', () => {
    expect(worldId(8, 2)).toBe('s8-2');
  });

  it('tileId formats as {world}:{x}:{y}', () => {
    expect(tileId('s8-2', 12, 34)).toBe('s8-2:12:34');
  });

  it('playerWorldId and familyMemberId share the same {world}:{accountId} shape', () => {
    expect(playerWorldId('s8-2', 'acc-1')).toBe('s8-2:acc-1');
    expect(familyMemberId('s8-2', 'acc-1')).toBe('s8-2:acc-1');
  });

  it('familyId uppercases the tag and prefixes f:', () => {
    expect(familyId('s8-2', 'abcd')).toBe('f:s8-2:ABCD');
    expect(familyId('s8-2', 'AbCd')).toBe('f:s8-2:ABCD');
  });

  it('sectId uppercases the tag and prefixes s:', () => {
    expect(sectId('s8-2', 'wu')).toBe('s:s8-2:WU');
  });

  it('auctionId embeds worldId, sellerId, ts, and seq', () => {
    expect(auctionId('s8-2', 'acc-1', 1000, 3)).toBe('a:s8-2:acc-1:1000:3');
  });

  it('marchId embeds worldId, ownerId, departAt, and seq', () => {
    expect(marchId('s8-2', 'acc-1', 5000, 1)).toBe('m:s8-2:acc-1:5000:1');
  });

  it('siegeId embeds worldId, attackerId, ts, and seq', () => {
    expect(siegeId('s8-2', 'acc-1', 5000, 2)).toBe('g:s8-2:acc-1:5000:2');
  });

  it('two distinct calls within the same millisecond only differ by seq (no key collision)', () => {
    expect(marchId('s8-2', 'acc-1', 5000, 1)).not.toBe(marchId('s8-2', 'acc-1', 5000, 2));
  });
});

// ── Main-base 3×3 footprint (ADR-025) ────────────────────────────────────────────────────────

describe('baseFootprintCells', () => {
  it('returns BASE_FOOTPRINT² cells centered on the anchor', () => {
    const cells = baseFootprintCells(10, 10);
    expect(cells.length).toBe(BASE_FOOTPRINT * BASE_FOOTPRINT);
    expect(cells).toEqual(
      expect.arrayContaining([
        { x: 9, y: 9 }, { x: 10, y: 9 }, { x: 11, y: 9 },
        { x: 9, y: 10 }, { x: 10, y: 10 }, { x: 11, y: 10 },
        { x: 9, y: 11 }, { x: 10, y: 11 }, { x: 11, y: 11 },
      ]),
    );
  });

  it('the anchor itself is always included', () => {
    const cells = baseFootprintCells(0, 0);
    expect(cells.some((c) => c.x === 0 && c.y === 0)).toBe(true);
  });
});

describe('baseFootprintInBounds', () => {
  it('true when the whole 3×3 block fits inside the map', () => {
    expect(baseFootprintInBounds(10, 10, 100, 100)).toBe(true);
    expect(baseFootprintInBounds(BASE_FOOTPRINT_R, BASE_FOOTPRINT_R, 100, 100)).toBe(true); // exact left/top edge fit
  });

  it('false when any part of the footprint would spill outside the map', () => {
    expect(baseFootprintInBounds(0, 10, 100, 100)).toBe(false); // spills past x=0
    expect(baseFootprintInBounds(10, 0, 100, 100)).toBe(false); // spills past y=0
    expect(baseFootprintInBounds(99, 10, 100, 100)).toBe(false); // spills past mapW
    expect(baseFootprintInBounds(10, 99, 100, 100)).toBe(false); // spills past mapH
  });
});

// ── City sprite placement geometry ───────────────────────────────────────────────────────────

describe('citySpriteTiles', () => {
  it('scales linearly with footprint, matching baseSpriteTiles at footprint===BASE_FOOTPRINT', () => {
    expect(citySpriteTiles(BASE_FOOTPRINT, 4)).toBe(4);
    expect(citySpriteTiles(BASE_FOOTPRINT * 2, 4)).toBe(8);
  });
});

describe('cityGroundFwdPx', () => {
  it('computes the forward offset to the plot\'s front vertex', () => {
    expect(cityGroundFwdPx(3, 64, 0.5)).toBeCloseTo((3 * 64 * 0.5) / 2);
  });

  it('scales with footprint (bigger plots push the anchor further forward)', () => {
    expect(cityGroundFwdPx(9, 64, 0.5)).toBeGreaterThan(cityGroundFwdPx(3, 64, 0.5));
  });
});

describe('cityPlotMaskPoints', () => {
  it('returns a 5-point (10-number) polygon starting at the sprite origin', () => {
    const pts = cityPlotMaskPoints(3, 64, 0.5, 200);
    expect(pts).toHaveLength(10);
    expect(pts[0]).toBe(0);
    expect(pts[1]).toBe(0);
  });

  it('the polygon half-width matches half the plot\'s tile-width', () => {
    const half = (3 * 64) / 2;
    const pts = cityPlotMaskPoints(3, 64, 0.5, 200);
    expect(pts[2]).toBe(half);
    expect(pts[8]).toBe(-half);
  });
});

// ── Family / sect emblem picker (2026-08-14) ────────────────────────────────────────────────

describe('isEmblemKey', () => {
  it('accepts every key in EMBLEM_KEYS', () => {
    for (const k of EMBLEM_KEYS) expect(isEmblemKey(k)).toBe(true);
  });

  it('rejects unknown strings', () => {
    expect(isEmblemKey('emblem_not_real')).toBe(false);
    expect(isEmblemKey('')).toBe(false);
  });
});

describe('isEmblemColor', () => {
  it('accepts every value in EMBLEM_COLORS', () => {
    for (const c of EMBLEM_COLORS) expect(isEmblemColor(c)).toBe(true);
  });

  it('rejects a color not in the preset palette', () => {
    expect(isEmblemColor(0x123456)).toBe(false);
  });
});

// ── Per-tile feature art (2026-08-19) ────────────────────────────────────────────────────────
// These two exist ONLY so the game client's drawTileL1 and the map editor's drawEditorTile cannot
// disagree (design/tools/map-editor/DESIGN.md §6.3 render parity). Both renderers draw through PIXI,
// so neither package can cheaply test the mapping itself — the editor's vitest deliberately excludes
// every PIXI-touching module. Pinning it here is what makes the parity rule enforceable at all.
const ALL_TILE_TYPES: readonly TileType[] = [
  'neutral', 'resource', 'territory', 'familyKeep', 'center', 'base', 'obstacle', 'bridge', 'plankway', 'stronghold',
];

describe('isCityGroundTile', () => {
  it('is true for exactly the two city-ground types', () => {
    expect(ALL_TILE_TYPES.filter(isCityGroundTile)).toEqual(['familyKeep', 'center']);
  });

  it('is false for undefined (a viewport cell with no tile and no procedural guess yet)', () => {
    expect(isCityGroundTile(undefined)).toBe(false);
  });
});

describe('tileFeatureBuilding', () => {
  it('maps exactly the three one-per-region landmarks, and nothing else', () => {
    const mapped = ALL_TILE_TYPES
      .map((t) => [t, tileFeatureBuilding(t)] as const)
      .filter(([, b]) => b !== null);
    expect(Object.fromEntries(mapped)).toEqual({
      stronghold: 'building_stronghold',
      bridge: 'building_bridge',
      plankway: 'building_plankway',
    });
  });

  it('returns null for CITY GROUND — the 2026-08-19 regression this function exists to prevent', () => {
    // `familyKeep` used to stamp `building_keep` on every tile of its type. That is invisible on a
    // procedural city (proceduralTile classifies only the single anchor tile) but paints a wall of
    // overlapping gatehouses across a PUBLISHED city's whole N×N footprint, under its own sprite.
    expect(tileFeatureBuilding('familyKeep')).toBeNull();
    expect(tileFeatureBuilding('center')).toBeNull();
  });

  it('returns null for undefined and for every ordinary tile type', () => {
    expect(tileFeatureBuilding(undefined)).toBeNull();
    for (const t of ['neutral', 'resource', 'territory', 'base', 'obstacle'] as const) {
      expect(tileFeatureBuilding(t)).toBeNull();
    }
  });

  it('never claims a city-ground tile has feature art (the two functions cannot both be true)', () => {
    for (const t of ALL_TILE_TYPES) {
      if (isCityGroundTile(t)) expect(tileFeatureBuilding(t)).toBeNull();
    }
  });
});

// ── Resource-motif placement (slg-resource-art.md §6) ─────────────────────────────────────────────
// Pinned here because the game client and the map editor now BOTH call these instead of each keeping
// a hand-written copy; two copies had nowhere their agreement could be asserted. The routing half
// ("the renderer actually calls this") is pinned per package:
// client/test/ui/worldMapResMotifLevelRead.ui.ts and tools/map-editor/test/resMotifCallSite.test.ts.

describe('resMotifJitter', () => {
  it('is deterministic: the same (tx, ty) always produces the same jitter (no shimmer on redraw/pan)', () => {
    expect(resMotifJitter(37, -12)).toEqual(resMotifJitter(37, -12));
  });

  it('different tiles get different jitter (not a constant fallback)', () => {
    expect(resMotifJitter(1, 0)).not.toEqual(resMotifJitter(0, 0));
  });

  it('scale variance is imperceptible — size belongs to the level curve, not to the jitter', () => {
    // The 2026-08-19 rebuild narrowed this from [0.85, 1.15]. At the old range two NEIGHBOURING tiles
    // of the same level could differ by 1.15/0.88 = 1.31x, which is what the player was looking at
    // when they reported three level-4 ink tiles as "obviously not the same kind of tile" (§6.1).
    let lo = Infinity, hi = -Infinity;
    for (let tx = -20; tx <= 20; tx++) {
      for (let ty = -20; ty <= 20; ty++) {
        const s = resMotifJitter(tx, ty).scale;
        lo = Math.min(lo, s); hi = Math.max(hi, s);
      }
    }
    expect(lo).toBeGreaterThanOrEqual(0.96);
    expect(hi).toBeLessThanOrEqual(1.04);
    expect(hi / lo).toBeLessThan(1.09);
  });

  it('offset and rotation stay within their documented bounds', () => {
    for (let tx = -20; tx <= 20; tx++) {
      for (let ty = -20; ty <= 20; ty++) {
        const j = resMotifJitter(tx, ty);
        expect(Math.abs(j.dx)).toBeLessThanOrEqual(0.13);
        expect(Math.abs(j.dy)).toBeLessThanOrEqual(0.09);
        expect(Math.abs(j.rot)).toBeLessThanOrEqual(0.35);
      }
    }
  });
});

describe('resMotifPlacement', () => {
  const TP = 76; // L1 tile pitch
  const read = { sizeMul: 0.0089, alphaMul: 0.9 };

  it("takes size from the frame's baked sizeMul, NOT from the texture's own dimensions", () => {
    // This is the whole point of the rebuild: the retired contract divided by tex.width, so a wide
    // "more of it" drawing rendered SMALLER. sizeMul already folds the frame's equivalent edge in.
    const wide = resMotifPlacement({ tp: TP, tx: 3, ty: 4, read, texW: 200, texH: 60 });
    const tall = resMotifPlacement({ tp: TP, tx: 3, ty: 4, read, texW: 60, texH: 200 });
    expect(wide.scale).toBe(tall.scale);
    expect(wide.scale).toBeCloseTo(TP * RES_MOTIF_SIZE_FRAC * read.sizeMul * resMotifJitter(3, 4).scale, 12);
  });

  it("takes alpha from the frame's baked alphaMul, with no level term of its own", () => {
    expect(resMotifPlacement({ tp: TP, tx: 0, ty: 0, read, texW: 128, texH: 128 }).alpha).toBe(0.9);
  });

  it('fog overrides alpha to the type-only dim, whatever the frame says', () => {
    const p = resMotifPlacement({ tp: TP, tx: 0, ty: 0, read, texW: 128, texH: 128, fogged: true });
    expect(p.alpha).toBe(RES_MOTIF_FOG_ALPHA);
  });

  it('a frame with no baked read stays bounded by max(w, h) at full alpha — visible, but claiming no level', () => {
    const p = resMotifPlacement({ tp: TP, tx: 0, ty: 0, read: null, texW: 200, texH: 60 });
    expect(p.scale).toBeCloseTo(TP * RES_MOTIF_SIZE_FRAC / 200 * resMotifJitter(0, 0).scale, 12);
    expect(p.alpha).toBe(1);
  });

  it('scales linearly with tile pitch, so zooming never changes the relative read', () => {
    const a = resMotifPlacement({ tp: 40, tx: 7, ty: 9, read, texW: 128, texH: 128 });
    const b = resMotifPlacement({ tp: 80, tx: 7, ty: 9, read, texW: 128, texH: 128 });
    expect(b.scale / a.scale).toBeCloseTo(2, 12);
    expect(b.x / a.x).toBeCloseTo(2, 12);
  });

  it('offsets stay inside the tile: never more than a fifth of the pitch from its centre', () => {
    for (let tx = -20; tx <= 20; tx++) {
      for (let ty = -20; ty <= 20; ty++) {
        const p = resMotifPlacement({ tp: TP, tx, ty, read, texW: 128, texH: 128 });
        expect(Math.abs(p.x)).toBeLessThan(TP * 0.2);
        expect(Math.abs(p.y)).toBeLessThan(TP * 0.2);
      }
    }
  });
});

describe('resLevelLabelFontPx', () => {
  it('grows with the tile pitch until the cap, then stops', () => {
    expect(resLevelLabelFontPx(98)).toBe(Math.round(98 * RES_LEVEL_LABEL_TP_FRAC));
    expect(resLevelLabelFontPx(174)).toBe(RES_LEVEL_LABEL_MAX_PX);
    expect(resLevelLabelFontPx(4000)).toBe(RES_LEVEL_LABEL_MAX_PX);
  });

  it('never drops below the size at which the glyphs read as map dirt', () => {
    expect(resLevelLabelFontPx(1)).toBe(RES_LEVEL_LABEL_MIN_PX);
    expect(resLevelLabelFontPx(RES_LEVEL_LABEL_MIN_TP)).toBeGreaterThanOrEqual(RES_LEVEL_LABEL_MIN_PX);
  });

  it('is monotone in the pitch — zooming in never shrinks the label', () => {
    for (let tp = RES_LEVEL_LABEL_MIN_TP; tp < 400; tp++) {
      expect(resLevelLabelFontPx(tp + 1)).toBeGreaterThanOrEqual(resLevelLabelFontPx(tp));
    }
  });
});
