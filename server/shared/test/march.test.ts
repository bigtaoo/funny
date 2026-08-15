import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  MARCH_MORALE_MAX,
  MARCH_MORALE_COMBAT_FLOOR,
  MARCH_MORALE_FLOOR_TILES,
  marchMoraleFromPath,
  moraleCombatMultiplier,
  type PathCell,
} from '../src/slg';
import { MARCH_SPEED_SEC_PER_TILE, RESOURCE_YIELD_BASE } from '../src/slg/core';

// ── Controlled tile fixture for findMarchPath (2026-08-15 coverage pass) ────────────────────────
// findMarchPath calls proceduralTile(world, x, y) internally (real procedural generation is
// deterministic-but-opaque at arbitrary coordinates), so we mock the mapgen module to get exact,
// hand-picked tile layouts for pathfinding scenarios instead of hunting for real obstacle tiles on
// the live 1500×1500 map. Only this test file's module graph is affected (vitest isolates per file).
const tileOverrides = vi.hoisted(() => new Map<string, { type: string; obstacleKind?: string }>());
vi.mock('../src/slg/mapgen', () => ({
  proceduralTile: (_world: string, x: number, y: number) =>
    tileOverrides.get(`${x}:${y}`) ?? { type: 'neutral', level: 1 },
}));
// Imported after the mock so march.ts picks up the mocked proceduralTile.
// eslint-disable-next-line import/first
import {
  tileYield,
  marchDurationSec,
  findMarchPath,
  marchDurationFromPath,
  marchStepArriveAt,
} from '../src/slg/march';

function setTile(x: number, y: number, type: string, obstacleKind?: string): void {
  tileOverrides.set(`${x}:${y}`, obstacleKind ? { type, obstacleKind } : { type });
}

function pathOfLength(n: number): PathCell[] {
  // Content doesn't matter to marchMoraleFromPath, only path.length (tiles moved = length - 1).
  return Array.from({ length: n }, (_, i) => ({ x: i, y: 0 }));
}

// ADR-053: cost per tile is MARCH_MORALE_MAX / MARCH_MORALE_FLOOR_TILES (a ratio of the map's half-diagonal),
// not a flat 1 point/tile — so the expected values below are derived from the live constant, not hardcoded,
// and stay correct across future SLG_MAP_W/H changes.
const COST_PER_TILE = MARCH_MORALE_MAX / MARCH_MORALE_FLOOR_TILES;

describe('marchMoraleFromPath', () => {
  it('same-tile path (length 1, 0 tiles moved) costs no morale', () => {
    expect(marchMoraleFromPath(pathOfLength(1))).toBe(MARCH_MORALE_MAX);
  });

  it('costs COST_PER_TILE morale per tile moved', () => {
    expect(marchMoraleFromPath(pathOfLength(2))).toBeCloseTo(MARCH_MORALE_MAX - COST_PER_TILE, 8); // 1 tile moved
    expect(marchMoraleFromPath(pathOfLength(51))).toBeCloseTo(MARCH_MORALE_MAX - 50 * COST_PER_TILE, 8); // 50 tiles moved
  });

  it('floors at 0 for paths longer than MARCH_MORALE_FLOOR_TILES — never goes negative', () => {
    expect(marchMoraleFromPath(pathOfLength(Math.ceil(MARCH_MORALE_FLOOR_TILES) + 1))).toBe(0);
    expect(marchMoraleFromPath(pathOfLength(Math.ceil(MARCH_MORALE_FLOOR_TILES) + 500))).toBe(0); // far beyond the cap
  });

  it('an empty path (defensive edge case) does not go negative', () => {
    expect(marchMoraleFromPath([])).toBe(MARCH_MORALE_MAX);
  });
});

describe('moraleCombatMultiplier', () => {
  it('full morale → full combat power (1.0)', () => {
    expect(moraleCombatMultiplier(MARCH_MORALE_MAX)).toBe(1);
  });

  it('zero morale → the combat-power floor (0.7), never worse', () => {
    expect(moraleCombatMultiplier(0)).toBe(MARCH_MORALE_COMBAT_FLOOR);
  });

  it('scales linearly between the floor and full strength', () => {
    expect(moraleCombatMultiplier(50)).toBeCloseTo(0.85, 10); // 0.7 + 0.3 * 0.5
    expect(moraleCombatMultiplier(80)).toBeCloseTo(0.94, 10); // 0.7 + 0.3 * 0.8
  });

  it('clamps out-of-range input instead of extrapolating past the floor/ceiling', () => {
    expect(moraleCombatMultiplier(-20)).toBe(MARCH_MORALE_COMBAT_FLOOR); // negative morale clamps to 0
    expect(moraleCombatMultiplier(MARCH_MORALE_MAX + 50)).toBe(1); // over-cap morale clamps to MARCH_MORALE_MAX
  });

  it('composes with marchMoraleFromPath end-to-end', () => {
    const morale = marchMoraleFromPath(pathOfLength(51)); // 50 tiles moved
    const expectedMorale = MARCH_MORALE_MAX - 50 * COST_PER_TILE;
    const expectedMult = MARCH_MORALE_COMBAT_FLOOR + (1 - MARCH_MORALE_COMBAT_FLOOR) * (expectedMorale / MARCH_MORALE_MAX);
    expect(moraleCombatMultiplier(morale)).toBeCloseTo(expectedMult, 10);
  });
});

// ── tileYield (S8-1 §14.3) ───────────────────────────────────────────────────────────────────

describe('tileYield', () => {
  it('base (home city) always yields a starting ink trickle, regardless of level/resType', () => {
    expect(tileYield('base', 1)).toEqual({ ink: RESOURCE_YIELD_BASE });
    expect(tileYield('base', 5, 'paper')).toEqual({ ink: RESOURCE_YIELD_BASE }); // resType ignored for base
  });

  it('a tile with a resType yields RESOURCE_YIELD_BASE × level of that resource', () => {
    expect(tileYield('resource', 3, 'metal')).toEqual({ metal: RESOURCE_YIELD_BASE * 3 });
    expect(tileYield('familyKeep', 1, 'sticker')).toEqual({ sticker: RESOURCE_YIELD_BASE });
  });

  it('level is floored at 1 (never a 0 or negative multiplier)', () => {
    expect(tileYield('resource', 0, 'ink')).toEqual({ ink: RESOURCE_YIELD_BASE });
    expect(tileYield('resource', -5, 'ink')).toEqual({ ink: RESOURCE_YIELD_BASE });
  });

  it('no resType and not base → no yield', () => {
    expect(tileYield('neutral', 3)).toEqual({});
    expect(tileYield('obstacle', 1)).toEqual({});
  });
});

// ── marchDurationSec (S8-2 §14.4) ────────────────────────────────────────────────────────────

describe('marchDurationSec', () => {
  it('same-tile (distance 0) costs exactly 1 tile of travel time', () => {
    expect(marchDurationSec(5, 5, 5, 5)).toBe(1 * MARCH_SPEED_SEC_PER_TILE);
  });

  it('scales with Euclidean distance, ceiling to a whole tile', () => {
    expect(marchDurationSec(0, 0, 3, 0)).toBe(3 * MARCH_SPEED_SEC_PER_TILE); // exact straight distance
    expect(marchDurationSec(0, 0, 3, 4)).toBe(5 * MARCH_SPEED_SEC_PER_TILE); // 3-4-5 triangle, exact
    expect(marchDurationSec(0, 0, 1, 1)).toBe(Math.ceil(Math.sqrt(2)) * MARCH_SPEED_SEC_PER_TILE); // ceil(1.41..) = 2
  });

  it('is symmetric and independent of direction', () => {
    expect(marchDurationSec(10, 10, 2, 6)).toBe(marchDurationSec(2, 6, 10, 10));
  });

  it('never returns less than 1 tile of travel time even for a sub-1-tile distance', () => {
    expect(marchDurationSec(0, 0, 0.5, 0)).toBe(1 * MARCH_SPEED_SEC_PER_TILE);
  });
});

// ── findMarchPath (S8-6.6 §4, A* with obstacle/crossing/blocked-base semantics) ───────────────

describe('findMarchPath', () => {
  beforeEach(() => {
    tileOverrides.clear();
  });

  it('same-tile march returns a single-node path without touching bounds/tiles at all', () => {
    // Out-of-range fx/fy/tx/ty would normally fail the bounds check, but the same-tile shortcut
    // returns before that check ever runs.
    const path = findMarchPath('w', 10, 10, -999, -999, -999, -999, new Set());
    expect(path).toEqual([{ x: -999, y: -999 }]);
  });

  it('returns null when the origin or destination is out of the map bounds', () => {
    expect(findMarchPath('w', 10, 10, -1, 0, 5, 5, new Set())).toBeNull(); // origin OOB
    expect(findMarchPath('w', 10, 10, 0, 0, 10, 5, new Set())).toBeNull(); // dest x === mapW (OOB)
    expect(findMarchPath('w', 10, 10, 0, 0, 5, 10, new Set())).toBeNull(); // dest y === mapH (OOB)
  });

  it('returns null immediately when the destination tile itself is an obstacle', () => {
    setTile(5, 5, 'obstacle', 'mountain');
    expect(findMarchPath('w', 20, 20, 0, 0, 5, 5, new Set())).toBeNull();
  });

  it('finds a straight-line path across open terrain (start and end inclusive)', () => {
    const path = findMarchPath('w', 20, 20, 0, 0, 3, 0, new Set());
    expect(path).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
  });

  it('routes around a single obstacle tile blocking the direct route', () => {
    setTile(1, 0, 'obstacle', 'mountain');
    const path = findMarchPath('w', 20, 20, 0, 0, 2, 0, new Set());
    expect(path).not.toBeNull();
    expect(path![0]).toEqual({ x: 0, y: 0 });
    expect(path![path!.length - 1]).toEqual({ x: 2, y: 0 });
    expect(path!.some((c) => c.x === 1 && c.y === 0)).toBe(false); // never steps on the obstacle
  });

  it('returns null when every route to the destination is fully walled off by obstacles (A* exhausts the open set)', () => {
    // Enclose (5,5) on all 4 sides with obstacles inside a small bounded map — no detour is possible.
    setTile(4, 5, 'obstacle', 'mountain');
    setTile(6, 5, 'obstacle', 'mountain');
    setTile(5, 4, 'obstacle', 'mountain');
    setTile(5, 6, 'obstacle', 'mountain');
    expect(findMarchPath('w', 11, 11, 0, 0, 5, 5, new Set())).toBeNull();
  });

  it('an unoccupied bridge/plankway blocks passage like an obstacle unless it is the destination', () => {
    // A single-row "corridor" map (mapH=1) so there is no way to detour around x=2.
    setTile(2, 0, 'bridge', 'river');
    expect(findMarchPath('w', 5, 1, 0, 0, 4, 0, new Set())).toBeNull(); // no gate rights, not the dest → blocked
  });

  it('a bridge/plankway is passable when the caller supplies passage rights via passableGateKeys', () => {
    setTile(2, 0, 'bridge', 'river');
    const path = findMarchPath('w', 5, 1, 0, 0, 4, 0, new Set(['2:0']));
    expect(path).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }]);
  });

  it('a bridge/plankway is always reachable as the destination itself, regardless of gate rights (siege target)', () => {
    setTile(2, 0, 'plankway', 'mountain');
    const path = findMarchPath('w', 5, 1, 0, 0, 2, 0, new Set());
    expect(path).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]);
  });

  it('blockedBaseKeys (ADR-025) blocks pathing through an enemy main-base tile, except when it is the destination', () => {
    setTile(1, 0, 'neutral'); // not an obstacle — only blocked via blockedBaseKeys
    expect(findMarchPath('w', 3, 1, 0, 0, 2, 0, new Set(), new Set(['1:0']))).toBeNull(); // no detour in a 1-row map
    // The same tile, as the destination itself, is exempt (an attacker can march onto/besiege it).
    const path = findMarchPath('w', 3, 1, 0, 0, 1, 0, new Set(), new Set(['1:0']));
    expect(path).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }]);
  });

  it('defaults blockedBaseKeys to an empty set when omitted', () => {
    const path = findMarchPath('w', 10, 10, 0, 0, 2, 2, new Set());
    expect(path).not.toBeNull();
    expect(path![0]).toEqual({ x: 0, y: 0 });
    expect(path![path!.length - 1]).toEqual({ x: 2, y: 2 });
  });
});

// ── marchDurationFromPath (ADR-051) ──────────────────────────────────────────────────────────

describe('marchDurationFromPath', () => {
  it('duration is (steps) × MARCH_SPEED_SEC_PER_TILE, where steps = path.length - 1', () => {
    expect(marchDurationFromPath([{ x: 0, y: 0 }])).toBe(0); // same-tile path, 0 steps
    expect(marchDurationFromPath([{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe(1 * MARCH_SPEED_SEC_PER_TILE);
    expect(marchDurationFromPath([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }])).toBe(3 * MARCH_SPEED_SEC_PER_TILE);
  });

  it('never goes negative for a defensively-empty path', () => {
    expect(marchDurationFromPath([])).toBe(0);
  });
});

// ── marchStepArriveAt (ADR-051 P1) ───────────────────────────────────────────────────────────

describe('marchStepArriveAt', () => {
  it('step 0 arrives exactly at departAt', () => {
    expect(marchStepArriveAt(1_000_000, 0)).toBe(1_000_000);
  });

  it('each subsequent step adds MARCH_SPEED_SEC_PER_TILE seconds', () => {
    expect(marchStepArriveAt(0, 1)).toBe(MARCH_SPEED_SEC_PER_TILE * 1000);
    expect(marchStepArriveAt(0, 5)).toBe(5 * MARCH_SPEED_SEC_PER_TILE * 1000);
  });

  it('clamps a negative stepIndex to 0 (never arrives before departAt)', () => {
    expect(marchStepArriveAt(500, -3)).toBe(500);
  });
});
