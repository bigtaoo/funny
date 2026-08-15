// Unit tests for slg/mapgen/cities.ts's allCityNodes: flattens world-center + province capitals +
// graded garrison cities into the map editor's siege-point node list (ADR-034 §3).
import { describe, it, expect } from 'vitest';
import { allCityNodes } from '../src/slg/mapgen';
import { WORLD_CENTER_FOOTPRINT } from '../src/slg/mapgen/cities';
import { CENTER_CAPITAL_IDX, NATION_COUNT } from '../src/slg/province';
import { cityFootprint } from '../src/slg/core';

describe('allCityNodes', () => {
  const nodes = allCityNodes('s1-0');

  it('includes exactly one worldCenter node with the world-center footprint', () => {
    const centers = nodes.filter((n) => n.kind === 'worldCenter');
    expect(centers).toHaveLength(1);
    expect(centers[0]!.id).toBe('worldCenter');
    expect(centers[0]!.footprint).toBe(WORLD_CENTER_FOOTPRINT);
    expect(centers[0]!.provinceIdx).toBeUndefined();
  });

  it('includes one capital node per non-core province (NATION_COUNT - 1)', () => {
    const capitals = nodes.filter((n) => n.kind === 'capital');
    expect(capitals).toHaveLength(NATION_COUNT - 1);
    for (const c of capitals) {
      expect(c.provinceIdx).not.toBe(CENTER_CAPITAL_IDX);
      expect(c.footprint).toBe(cityFootprint(c.level));
    }
  });

  it('includes graded garrison nodes with sequential ids and matching footprints', () => {
    const garrisons = nodes.filter((n) => n.kind === 'garrison');
    expect(garrisons.length).toBeGreaterThan(0);
    expect(garrisons[0]!.id).toBe('garrison-0');
    expect(garrisons[garrisons.length - 1]!.id).toBe(`garrison-${garrisons.length - 1}`);
    for (const g of garrisons) expect(g.footprint).toBe(cityFootprint(g.level));
  });

  it('is deterministic for the same worldId', () => {
    expect(allCityNodes('s1-0')).toEqual(allCityNodes('s1-0'));
  });

  it('differs across worlds with different seeds', () => {
    const other = allCityNodes('s2-0');
    // World-center node is identical (fixed position), but garrison/capital layouts should differ.
    const garrisonsA = nodes.filter((n) => n.kind === 'garrison').map((n) => `${n.x}:${n.y}`);
    const garrisonsB = other.filter((n) => n.kind === 'garrison').map((n) => `${n.x}:${n.y}`);
    expect(garrisonsA).not.toEqual(garrisonsB);
  });
});
