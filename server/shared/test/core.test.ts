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
