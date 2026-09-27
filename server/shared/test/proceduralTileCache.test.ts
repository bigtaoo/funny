// cachedProceduralTile is an optimisation of proceduralTile that must not change a single answer, so the
// test is equivalence against the uncached function over regions that cover chunk edges, the world
// centre, a city footprint and the map border.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cachedProceduralTile,
  clearProceduralTileCache,
  proceduralTile,
  allCityNodes,
  SLG_MAP_W,
  SLG_MAP_H,
} from '../src';

const W = 'equiv-world';

function expectSameRegion(world: string, x0: number, y0: number, x1: number, y1: number): void {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      expect(cachedProceduralTile(world, x, y), `${world} ${x},${y}`).toEqual(proceduralTile(world, x, y));
    }
  }
}

describe('cachedProceduralTile', () => {
  beforeEach(() => clearProceduralTileCache());

  it('matches proceduralTile across chunk edges, the centre, a city and the map border', () => {
    const cx = Math.floor(SLG_MAP_W / 2);
    const cy = Math.floor(SLG_MAP_H / 2);
    expectSameRegion(W, 20, 20, 70, 70);
    expectSameRegion(W, cx - 8, cy - 8, cx + 8, cy + 8);
    const city = allCityNodes(W)[0]!;
    expectSameRegion(W, city.x - 5, city.y - 5, city.x + 5, city.y + 5);
    expectSameRegion(W, SLG_MAP_W - 12, SLG_MAP_H - 12, SLG_MAP_W - 1, SLG_MAP_H - 1);
    // Second pass reads everything from the cache.
    expectSameRegion(W, 20, 20, 70, 70);
  });

  it('keeps worlds apart', () => {
    expectSameRegion('world-a', 100, 100, 140, 140);
    expectSameRegion('world-b', 100, 100, 140, 140);
    expectSameRegion('world-a', 100, 100, 140, 140);
  });

  it('returns frozen shared objects', () => {
    const t = cachedProceduralTile(W, 5, 5);
    expect(Object.isFrozen(t)).toBe(true);
  });

  it('falls through to proceduralTile for out-of-range coordinates', () => {
    expect(cachedProceduralTile(W, -1, 3)).toEqual(proceduralTile(W, -1, 3));
  });
});
