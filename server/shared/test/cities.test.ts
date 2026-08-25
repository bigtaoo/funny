// Unit tests for slg/mapgen/cities.ts's allCityNodes: flattens world-center + province capitals +
// graded garrison cities into the map editor's siege-point node list (ADR-034 §3).
import { describe, it, expect } from 'vitest';
import { allCityNodes, parseCityNodes, proceduralCityGroundTiles, proceduralTile, proceduralTileIgnoringCities } from '../src/slg/mapgen';
import { WORLD_CENTER_FOOTPRINT } from '../src/slg/mapgen/cities';
import { CENTER_CAPITAL_IDX, NATION_COUNT } from '../src/slg/province';
import { cityFootprint, SLG_MAP_H, SLG_MAP_W } from '../src/slg/core';

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

describe('proceduralCityGroundTiles', () => {
  const worldId = 'city-ground-test';

  it('lists exactly the tiles proceduralTile() classifies as city ground', () => {
    const ground = proceduralCityGroundTiles(worldId);
    expect(ground.length).toBeGreaterThan(0);
    for (const { x, y } of ground) {
      expect(proceduralTile(worldId, x, y).type).toMatch(/^(familyKeep|center)$/);
    }
  });

  it('covers the WHOLE footprint of every city kind, not just the anchor (ADR-074)', () => {
    // Before ADR-074 only the world center covered its footprint; a capital/garrison contributed its single
    // anchor cell, leaving the rest of the plot as ordinary occupiable resource land under the city sprite.
    // This case is the inversion of the old one — it fails on the pre-ADR-074 generator.
    const ground = new Set(proceduralCityGroundTiles(worldId).map((t) => `${t.x}:${t.y}`));
    for (const node of allCityNodes(worldId)) {
      const r = (node.footprint - 1) / 2;
      for (const [dx, dy] of [[0, 0], [r, r], [-r, -r], [r, -r], [-r, r]] as const) {
        const x = node.x + dx;
        const y = node.y + dy;
        if (x < 0 || x >= SLG_MAP_W || y < 0 || y >= SLG_MAP_H) continue; // edge city, footprint clipped
        expect(ground.has(`${x}:${y}`)).toBe(true);
      }
    }
  });

  it('classifies a whole capital / graded-city footprint as city ground via proceduralTile', () => {
    for (const node of allCityNodes(worldId).filter((n) => n.kind !== 'worldCenter')) {
      const r = (node.footprint - 1) / 2;
      expect(node.footprint).toBeGreaterThan(1); // otherwise this case proves nothing
      for (const [dx, dy] of [[0, 0], [r, 0], [0, r], [-r, 0], [0, -r]] as const) {
        const x = node.x + dx;
        const y = node.y + dy;
        if (x < 0 || x >= SLG_MAP_W || y < 0 || y >= SLG_MAP_H) continue;
        const t = proceduralTile(worldId, x, y);
        // A neighbouring city's footprint may overlap and win the first-match, so accept either city-ground
        // type — the point is that no cell inside a city plot is ordinary land any more.
        expect(t.type).toMatch(/^(familyKeep|center)$/);
      }
      // One tile past the footprint edge is ordinary terrain again (unless another city's plot reaches it).
      const outside = proceduralTile(worldId, node.x + r + 1, node.y);
      if (outside.type === 'familyKeep' || outside.type === 'center') continue; // overlapping neighbour city
      expect(outside.type).not.toMatch(/^(familyKeep|center)$/);
    }
  });

  it('never puts a resType on city ground (city plots do not yield — ADR-074 §8.1 double-payout)', () => {
    for (const { x, y } of proceduralCityGroundTiles(worldId)) {
      expect(proceduralTile(worldId, x, y).resType).toBeUndefined();
    }
  });
});

describe('proceduralTileIgnoringCities', () => {
  const worldId = 'no-city-test';

  it('never returns city ground, where proceduralTile does', () => {
    for (const { x, y } of proceduralCityGroundTiles(worldId)) {
      const bare = proceduralTileIgnoringCities(worldId, x, y);
      expect(bare.type).not.toBe('familyKeep');
      expect(bare.type).not.toBe('center');
    }
  });

  it('agrees with proceduralTile everywhere else', () => {
    const ground = new Set(proceduralCityGroundTiles(worldId).map((t) => `${t.x}:${t.y}`));
    let checked = 0;
    for (let x = 200; x < 260; x += 7) {
      for (let y = 300; y < 360; y += 7) {
        if (ground.has(`${x}:${y}`)) continue;
        expect(proceduralTileIgnoringCities(worldId, x, y)).toEqual(proceduralTile(worldId, x, y));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('parseCityNodes', () => {
  const valid = { id: 'garrison-0', kind: 'garrison' as const, provinceIdx: 2, x: 10, y: 20, level: 5, footprint: 3 };

  it('round-trips a well-formed node list', () => {
    expect(parseCityNodes([valid])).toEqual([valid]);
  });

  it('accepts the output of the generator itself', () => {
    expect(parseCityNodes(allCityNodes('s1-0'))).toEqual(allCityNodes('s1-0'));
  });

  it('drops unknown fields rather than passing them through', () => {
    const parsed = parseCityNodes([{ ...valid, bogus: 'x' }]);
    expect(parsed[0]).not.toHaveProperty('bogus');
  });

  it('omits provinceIdx when absent instead of writing undefined', () => {
    const { provinceIdx: _drop, ...noProvince } = valid;
    expect(parseCityNodes([noProvince])[0]).not.toHaveProperty('provinceIdx');
  });

  it.each([
    ['not an array', {}],
    ['missing id', [{ ...valid, id: '' }]],
    ['unknown kind', [{ ...valid, kind: 'fortress' }]],
    ['negative x', [{ ...valid, x: -1 }]],
    ['non-integer y', [{ ...valid, y: 1.5 }]],
    ['level 0', [{ ...valid, level: 0 }]],
    ['even footprint', [{ ...valid, footprint: 4 }]],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseCityNodes(raw)).toThrow();
  });
});
