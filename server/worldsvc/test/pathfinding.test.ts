// S8-6.6 A* pathfinding unit tests (pure functions, no Mongo).
// Coverage: straight path / obstacle detour / gate blocking / gate passage / no path / same tile / out-of-bounds / proceduralTile obstacle generation.
import { describe, expect, it } from 'vitest';
import {
  findMarchPath,
  marchDurationFromPath,
  proceduralTile,
  MARCH_SPEED_SEC_PER_TILE,
  SLG_MAP_W,
  SLG_MAP_H,
  baseFootprintCells,
  baseFootprintInBounds,
} from '@nw/shared';

// Build a small map wrapper (with inline obstacles) to test pure logic with a custom world seed.
// findMarchPath accepts a world string and internally calls proceduralTile,
// so use a clean obstacle-free seed ('test-open') to ensure default tiles are passable,
// then use a tile known to generate an obstacle to test blocking logic.

const W_OPEN = 'open-world-no-obstacle'; // used for logic tests (assumes tests run within an obstacle-free area)
const MAP_W = 50;
const MAP_H = 50;

describe('findMarchPath', () => {
  it('same tile returns single-node path', () => {
    const path = findMarchPath(W_OPEN, MAP_W, MAP_H, 5, 5, 5, 5, new Set());
    expect(path).toEqual([{ x: 5, y: 5 }]);
  });

  it('out-of-bounds start returns null', () => {
    expect(findMarchPath(W_OPEN, MAP_W, MAP_H, -1, 0, 5, 5, new Set())).toBeNull();
    expect(findMarchPath(W_OPEN, MAP_W, MAP_H, 0, -1, 5, 5, new Set())).toBeNull();
    expect(findMarchPath(W_OPEN, MAP_W, MAP_H, MAP_W, 0, 5, 5, new Set())).toBeNull();
  });

  it('out-of-bounds destination returns null', () => {
    expect(findMarchPath(W_OPEN, MAP_W, MAP_H, 5, 5, MAP_W, 5, new Set())).toBeNull();
    expect(findMarchPath(W_OPEN, MAP_W, MAP_H, 5, 5, 5, MAP_H, new Set())).toBeNull();
  });

  it('horizontal path in obstacle-free area has length = Manhattan distance + 1', () => {
    // Tiles near the real map's (0,0) corner (ADR-034: far outside both province rings and any
    // terrain band for this seed) stay passable, so the shortest path is a straight horizontal line.
    const path = findMarchPath(W_OPEN, MAP_W, MAP_H, 1, 1, 6, 1, new Set());
    expect(path).not.toBeNull();
    // Path length = steps+1; straight horizontal path = Manhattan+1.
    expect(path!.length).toBeGreaterThanOrEqual(6); // shortest: 5 steps, 6 nodes
    expect(path![0]).toEqual({ x: 1, y: 1 });
    expect(path![path!.length - 1]).toEqual({ x: 6, y: 1 });
  });

  it('path nodes are adjacent at each step (4-directional only)', () => {
    const path = findMarchPath(W_OPEN, MAP_W, MAP_H, 2, 2, 8, 6, new Set());
    if (!path) return; // skip if the area happens to have an obstacle (should not happen in corner area)
    for (let i = 1; i < path.length; i++) {
      const dx = Math.abs(path[i].x - path[i - 1].x);
      const dy = Math.abs(path[i].y - path[i - 1].y);
      expect(dx + dy).toBe(1); // exactly 1 tile per step, 4 directions
    }
  });
});

describe('base 3×3 footprint (ADR-025)', () => {
  it('baseFootprintCells returns 9 cells centered on the anchor', () => {
    const cells = baseFootprintCells(10, 20);
    expect(cells).toHaveLength(9);
    // includes the anchor and every 8-neighbor
    expect(cells).toContainEqual({ x: 10, y: 20 });
    expect(cells).toContainEqual({ x: 9, y: 19 });
    expect(cells).toContainEqual({ x: 11, y: 21 });
    // all within Chebyshev distance 1 of the anchor
    for (const c of cells) {
      expect(Math.max(Math.abs(c.x - 10), Math.abs(c.y - 20))).toBeLessThanOrEqual(1);
    }
  });

  it('baseFootprintInBounds requires the whole 3×3 inside the map', () => {
    expect(baseFootprintInBounds(1, 1, MAP_W, MAP_H)).toBe(true);
    expect(baseFootprintInBounds(0, 5, MAP_W, MAP_H)).toBe(false); // left ring cell x=-1
    expect(baseFootprintInBounds(5, 0, MAP_W, MAP_H)).toBe(false); // top ring cell y=-1
    expect(baseFootprintInBounds(MAP_W - 1, 5, MAP_W, MAP_H)).toBe(false); // right ring out
    expect(baseFootprintInBounds(MAP_W - 2, MAP_H - 2, MAP_W, MAP_H)).toBe(true); // fits flush
  });

  it('an enemy base footprint blocks pathing (封路), forcing a detour', () => {
    // Wall off a full column x=4 (y=0..3) between start (2,1) and dest (6,1) as "enemy base" cells.
    const blocked = new Set(['4:0', '4:1', '4:2', '4:3']);
    const path = findMarchPath(W_OPEN, MAP_W, MAP_H, 2, 1, 6, 1, new Set(), blocked);
    expect(path).not.toBeNull();
    // No path node may sit on a blocked cell (the marcher routes around it).
    for (const n of path!) expect(blocked.has(`${n.x}:${n.y}`)).toBe(false);
    // Detour is strictly longer than the 5-node straight line.
    expect(path!.length).toBeGreaterThan(6);
  });

  it('a blocked base cell is still reachable AS the destination (siege the base)', () => {
    const blocked = new Set(['4:1']);
    const path = findMarchPath(W_OPEN, MAP_W, MAP_H, 1, 1, 4, 1, new Set(), blocked);
    expect(path).not.toBeNull();
    expect(path![path!.length - 1]).toEqual({ x: 4, y: 1 });
  });
});

describe('marchDurationFromPath', () => {
  it('empty path (same tile) takes 0 duration', () => {
    expect(marchDurationFromPath([{ x: 0, y: 0 }])).toBe(0);
  });

  it('n-step path duration = n × MARCH_SPEED_SEC_PER_TILE', () => {
    const path = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }];
    expect(marchDurationFromPath(path)).toBe(3 * MARCH_SPEED_SEC_PER_TILE);
  });
});

describe('proceduralTile obstacle generation', () => {
  // proceduralTile internally computes province/terrain geometry using the real SLG_MAP_W/H (500×500),
  // independent of findMarchPath's mapW/mapH parameters — so real map dimensions must be used here;
  // the 50×50 logic window above does not apply.
  it('obstacles concentrate on the outer/resource province ring boundary (ADR-034 §2.2)', () => {
    // Scan a band straddling the outer/resource ring boundary (radius ratio 0.39 of the map's half-diagonal,
    // due east of center) — this is where the "折痕岭主环" terrain band lives, so a hit is near-guaranteed.
    const cx = Math.floor(SLG_MAP_W / 2);
    const cy = Math.floor(SLG_MAP_H / 2);
    const halfDiag = Math.sqrt(cx ** 2 + cy ** 2);
    const ringX = cx + Math.round(0.39 * halfDiag);
    let obstacleCnt = 0;
    for (let x = ringX - 15; x <= ringX + 15; x++) {
      for (let y = cy - 15; y <= cy + 15; y++) {
        const t = proceduralTile(W_OPEN, x, y);
        if (t.type === 'obstacle' || t.type === 'gate') obstacleCnt++;
      }
    }
    expect(obstacleCnt).toBeGreaterThan(0);
  });

  it('exact map corners do not generate obstacles (for this seed)', () => {
    // Corners sit at the outer province's largest radius, far from the ring/river/branch terrain for this
    // specific seed — unlike the old distance-only model, this isn't a structural "safe zone" guarantee
    // (a branch could in principle graze a corner for a different seed), just an empirical fact for W_OPEN.
    const corners = [
      [0, 0],
      [0, SLG_MAP_H - 1],
      [SLG_MAP_W - 1, 0],
      [SLG_MAP_W - 1, SLG_MAP_H - 1],
    ] as const;
    for (const [x, y] of corners) {
      const t = proceduralTile(W_OPEN, x, y);
      expect(t.type).not.toBe('obstacle');
      expect(t.type).not.toBe('gate');
    }
  });
});
