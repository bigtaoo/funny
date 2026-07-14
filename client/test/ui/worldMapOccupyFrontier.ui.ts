// Unit coverage for occupyFrontierCells — the ADR-039 "连地" frontier the world map outlines (三战-style).
// Pins the rule that matters: a target counts only if it shares an EDGE (4-directional) with owned land —
// a corner-touching diagonal tile is NOT a frontier target, even though the isometric projection makes it
// look adjacent. Also: own capital footprint bootstraps the frontier; occupied/fogged/mid-hold/blocking
// tiles are excluded; a captured (mine) or family (ally) tile extends the frontier.
import { describe, it, expect } from 'vitest';
import { proceduralTile } from '@nw/shared';
import { occupyFrontierCells, type FrontierTile } from '../../src/scenes/worldmap/occupyFrontier';

const W = 's1-frontier';
const MAP = 500;

const NON_BLOCKING = (x: number, y: number): boolean => {
  const tp = proceduralTile(W, x, y).type;
  return tp !== 'obstacle' && tp !== 'center' && tp !== 'stronghold' && tp !== 'bridge' && tp !== 'plankway';
};

/** Find a center whose (2r+1)² block is entirely non-blocking terrain, so terrain doesn't perturb assertions. */
function findClearCenter(r: number): { x: number; y: number } {
  for (let cy = 100; cy < 200; cy++) {
    for (let cx = 100; cx < 200; cx++) {
      let clear = true;
      for (let dy = -r; dy <= r && clear; dy++) for (let dx = -r; dx <= r; dx++) {
        if (!NON_BLOCKING(cx + dx, cy + dy)) { clear = false; break; }
      }
      if (clear) return { x: cx, y: cy };
    }
  }
  throw new Error('no clear block found');
}

const parseAnchor = (id: string): [number, number] | null => {
  const p = id.split(':');
  return [Number(p[p.length - 2]), Number(p[p.length - 1])];
};

const keyset = (cells: { x: number; y: number }[]) => new Set(cells.map((c) => `${c.x}:${c.y}`));

describe('occupyFrontierCells (ADR-039 连地 frontier)', () => {
  it('a fresh 3×3 capital yields exactly its 12 shared-edge perimeter tiles (not the 4 diagonal corners)', () => {
    const c = findClearCenter(2);
    const cells = occupyFrontierCells({
      worldId: W, mapW: MAP, mapH: MAP,
      bounds: { minTx: c.x - 3, maxTx: c.x + 3, minTy: c.y - 3, maxTy: c.y + 3 },
      mainBaseTile: `${W}:${c.x}:${c.y}`,
      tileCache: new Map<string, FrontierTile>(),
      parseAnchor,
    });
    const got = keyset(cells);

    const expected = new Set<string>();
    for (const x of [c.x - 1, c.x, c.x + 1]) { expected.add(`${x}:${c.y - 2}`); expected.add(`${x}:${c.y + 2}`); }
    for (const y of [c.y - 1, c.y, c.y + 1]) { expected.add(`${c.x - 2}:${y}`); expected.add(`${c.x + 2}:${y}`); }

    expect(cells.length).toBe(12);
    expect(got).toEqual(expected);
    // The 4 footprint-corner diagonals only touch at a point → must NOT be frontier.
    for (const [dx, dy] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) {
      expect(got.has(`${c.x + dx}:${c.y + dy}`)).toBe(false);
    }
  });

  it('a captured (mine) tile extends the frontier to its 4 edge-neighbours, not its diagonals', () => {
    const c = findClearCenter(2);
    const tiles = new Map<string, FrontierTile>([[`${c.x}:${c.y}`, { occupied: true, mine: true }]]);
    const cells = occupyFrontierCells({
      worldId: W, mapW: MAP, mapH: MAP,
      bounds: { minTx: c.x - 2, maxTx: c.x + 2, minTy: c.y - 2, maxTy: c.y + 2 },
      mainBaseTile: null, tileCache: tiles, parseAnchor,
    });
    const got = keyset(cells);
    expect(got).toEqual(new Set([`${c.x - 1}:${c.y}`, `${c.x + 1}:${c.y}`, `${c.x}:${c.y - 1}`, `${c.x}:${c.y + 1}`]));
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      expect(got.has(`${c.x + dx}:${c.y + dy}`)).toBe(false); // diagonals excluded
    }
  });

  it('a family (ally) tile also seeds the frontier', () => {
    const c = findClearCenter(2);
    const tiles = new Map<string, FrontierTile>([[`${c.x}:${c.y}`, { occupied: true, ally: true }]]);
    const cells = occupyFrontierCells({
      worldId: W, mapW: MAP, mapH: MAP,
      bounds: { minTx: c.x - 1, maxTx: c.x + 1, minTy: c.y - 1, maxTy: c.y + 1 },
      mainBaseTile: null, tileCache: tiles, parseAnchor,
    });
    expect(cells.length).toBe(4);
  });

  it('excludes occupied, fogged, and mid-occupation-hold neighbours', () => {
    const c = findClearCenter(2);
    const tiles = new Map<string, FrontierTile>([
      [`${c.x}:${c.y}`, { occupied: true, mine: true }],
      [`${c.x - 1}:${c.y}`, { occupied: true }],            // someone else's / already taken
      [`${c.x + 1}:${c.y}`, { visible: false }],             // fogged
      [`${c.x}:${c.y - 1}`, { contestedUntil: 9_999_999 }],  // mid-hold
    ]);
    const cells = occupyFrontierCells({
      worldId: W, mapW: MAP, mapH: MAP,
      bounds: { minTx: c.x - 2, maxTx: c.x + 2, minTy: c.y - 2, maxTy: c.y + 2 },
      mainBaseTile: null, tileCache: tiles, parseAnchor,
    });
    // Only the south neighbour (c.y+1) survives the exclusions.
    expect(keyset(cells)).toEqual(new Set([`${c.x}:${c.y + 1}`]));
  });

  it('returns nothing when no territory is known (no base, empty cache)', () => {
    const c = findClearCenter(1);
    const cells = occupyFrontierCells({
      worldId: W, mapW: MAP, mapH: MAP,
      bounds: { minTx: c.x - 2, maxTx: c.x + 2, minTy: c.y - 2, maxTy: c.y + 2 },
      mainBaseTile: null, tileCache: new Map(), parseAnchor,
    });
    expect(cells).toEqual([]);
  });
});
