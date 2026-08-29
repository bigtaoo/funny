// Unit coverage for logic/attackConnectivity.ts — the ADR-039 "连地" pre-check shared by the neutral-tile
// Occupy button (WorldMapInput.occupyConnected) and the attack/siege path (WorldMapNet.showTeamPicker,
// see worldMapAttackConnectivity.ui.ts for the picker-level integration tests). Pure functions, no PIXI —
// lives outside test/ui/ per ADR-071 4b (a pure module deserves a pure test in the measured suite; see
// worldMapOccupyFrontier.test.ts's header comment for the same reasoning).
import { describe, it, expect } from 'vitest';
import { territoryConnected, attackFootprintCells } from '../src/scenes/worldmap/logic/attackConnectivity';
import type { WorldMapContext } from '../src/scenes/worldmap/WorldMapContext';
import type { WorldTileView, PlayerWorldView, WorldCityNodeView } from '../src/net/WorldApiClient';

const WORLD_ID = 'world:1:0';
const ANCHOR = { x: 20, y: 20 }; // capital footprint = x19..21, y19..21

/** Minimal WorldMapContext stub — only the fields territoryConnected/attackFootprintCells actually read. */
function makeCtx(opts: {
  me?: Partial<PlayerWorldView>;
  tiles?: [string, WorldTileView][];
  cityNodes?: WorldCityNodeView[] | null;
  mapW?: number;
  mapH?: number;
} = {}): WorldMapContext {
  return {
    mapW: opts.mapW ?? 500,
    mapH: opts.mapH ?? 500,
    tileCache: new Map<string, WorldTileView>(opts.tiles ?? []),
    cityNodes: opts.cityNodes ?? null,
    me: { joined: true, mainBaseTile: `${WORLD_ID}:${ANCHOR.x}:${ANCHOR.y}`, ...opts.me } as PlayerWorldView,
    parseTileId(tileId: string): [number, number] {
      const parts = tileId.split(':');
      return [Number(parts[parts.length - 2]), Number(parts[parts.length - 1])];
    },
  } as unknown as WorldMapContext;
}

describe('territoryConnected (ADR-039 连地)', () => {
  it('a single cell 4-adjacent to the own capital footprint is connected', () => {
    const ctx = makeCtx();
    expect(territoryConnected(ctx, [{ x: ANCHOR.x, y: ANCHOR.y + 2 }])).toBe(true); // borders footprint ring (20,21)
  });

  it('a cell only diagonal-adjacent to the footprint (corner touch) is NOT connected (4-neighbour rule, not 8)', () => {
    const ctx = makeCtx();
    expect(territoryConnected(ctx, [{ x: ANCHOR.x + 2, y: ANCHOR.y + 2 }])).toBe(false); // touches (21,21) only at a corner
  });

  it('a cell 2 rows past the footprint (visually close under isometric projection) is NOT connected', () => {
    const ctx = makeCtx();
    expect(territoryConnected(ctx, [{ x: ANCHOR.x, y: ANCHOR.y + 3 }])).toBe(false);
  });

  it('a cell bordering an owned (non-base) captured tile is connected', () => {
    const ctx = makeCtx({ tiles: [[`${ANCHOR.x + 10}:${ANCHOR.y + 10}`, { occupied: true, mine: true } as WorldTileView]] });
    expect(territoryConnected(ctx, [{ x: ANCHOR.x + 11, y: ANCHOR.y + 10 }])).toBe(true);
  });

  it('a multi-cell footprint counts as connected if ANY cell borders own territory, not just the first', () => {
    const ctx = makeCtx();
    // A 3-cell horizontal footprint far from the base on two ends, but its middle cell borders a captured tile.
    const far = { x: 300, y: 300 };
    const ctx2 = makeCtx({ tiles: [[`${far.x + 1}:${far.y - 1}`, { occupied: true, mine: true } as WorldTileView]] });
    const cells = [{ x: far.x, y: far.y }, { x: far.x + 1, y: far.y }, { x: far.x + 2, y: far.y }];
    expect(territoryConnected(ctx2, cells)).toBe(true); // (far.x+1,far.y) borders (far.x+1,far.y-1)
    expect(territoryConnected(ctx, cells)).toBe(false); // same shape, no owned tile nearby
  });

  it("a footprint's own cells never count as their own neighbor (no false-positive self-adjacency)", () => {
    const ctx = makeCtx();
    // A 2×1 footprint far from any territory — each cell's only "owned-looking" neighbor is the other cell
    // of the SAME footprint, which must be excluded, not counted as bordering owned land.
    const cells = [{ x: 300, y: 300 }, { x: 301, y: 300 }];
    expect(territoryConnected(ctx, cells)).toBe(false);
  });

  it('never blocks a family member — sibling-sect territory is invisible client-side, so it defers to true', () => {
    const ctx = makeCtx({ me: { familyId: 'fam-1' } });
    expect(territoryConnected(ctx, [{ x: 300, y: 300 }])).toBe(true);
  });

  it('a neighbor cell off the map edge is skipped, not treated as a crash or a false match', () => {
    const ctx = makeCtx({ mapW: 10, mapH: 10 });
    expect(() => territoryConnected(ctx, [{ x: 0, y: 0 }])).not.toThrow();
    expect(territoryConnected(ctx, [{ x: 0, y: 0 }])).toBe(false); // off-map neighbors (-1,0)/(0,-1) skipped; (1,0)/(0,1) uncached
  });
});

describe('attackFootprintCells (ADR-039 连地 — attack/siege target footprint)', () => {
  it('a plain territory/stronghold tile resolves to just the tapped cell', () => {
    const ctx = makeCtx({ tiles: [[`50:50`, { type: 'territory', occupied: true } as WorldTileView]] });
    expect(attackFootprintCells(ctx, 50, 50)).toEqual([{ x: 50, y: 50 }]);
  });

  it('an uncached tile (outside vision) also falls back to the tapped cell', () => {
    const ctx = makeCtx();
    expect(attackFootprintCells(ctx, 77, 88)).toEqual([{ x: 77, y: 88 }]);
  });

  it("an enemy base resolves the WHOLE 3×3 footprint even when the tapped cell is a ring cell, not the anchor", () => {
    const tiles: [string, WorldTileView][] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) tiles.push([`${100 + dx}:${100 + dy}`, { type: 'base', occupied: true } as WorldTileView]);
    const ctx = makeCtx({ tiles });
    const expected = new Set(['99:99', '100:99', '101:99', '99:100', '100:100', '101:100', '99:101', '100:101', '101:101']);
    for (const [tx, ty] of [[100, 99], [99, 100], [101, 101], [100, 100]]) { // ring cells + the anchor itself
      const got = new Set(attackFootprintCells(ctx, tx, ty).map((c) => `${c.x}:${c.y}`));
      expect(got).toEqual(expected);
    }
  });

  it('an enemy base whose anchor is not resolvable (partial cache — edge of vision) falls back to the tapped cell rather than guessing', () => {
    // Only the tapped cell itself is cached as type 'base' — none of its neighbors are, so no 3×3 anchor
    // candidate can be confirmed anywhere in the scan window.
    const ctx = makeCtx({ tiles: [[`100:100`, { type: 'base', occupied: true } as WorldTileView]] });
    expect(attackFootprintCells(ctx, 100, 100)).toEqual([{ x: 100, y: 100 }]);
  });

  it('a neutral (wild) city resolves its whole plot via cityNodes, not just the tapped cell', () => {
    const tiles: [string, WorldTileView][] = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) tiles.push([`${200 + dx}:${200 + dy}`, { type: 'familyKeep' } as WorldTileView]);
    const ctx = makeCtx({ tiles, cityNodes: [{ id: 'garrison-1', kind: 'garrison', x: 200, y: 200, level: 3, footprint: 5 } as WorldCityNodeView] });
    const cells = attackFootprintCells(ctx, 202, 198); // a plot-edge cell, not the center
    expect(cells).toHaveLength(25); // 5×5
    expect(cells).toEqual(expect.arrayContaining([{ x: 198, y: 198 }, { x: 202, y: 202 }, { x: 200, y: 200 }]));
  });

  it('a familyKeep tile with no matching cityNodes entry falls back to the tapped cell', () => {
    const ctx = makeCtx({ tiles: [[`200:200`, { type: 'familyKeep' } as WorldTileView]], cityNodes: [] });
    expect(attackFootprintCells(ctx, 200, 200)).toEqual([{ x: 200, y: 200 }]);
  });
});
