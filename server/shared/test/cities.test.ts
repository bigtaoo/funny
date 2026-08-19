// Unit tests for slg/mapgen/cities.ts's allCityNodes: flattens world-center + province capitals +
// graded garrison cities into the map editor's siege-point node list (ADR-034 §3).
import { describe, it, expect } from 'vitest';
import { allCityNodes, parseCityNodes, proceduralCityGroundTiles, proceduralTile, proceduralTileIgnoringCities } from '../src/slg/mapgen';
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

describe('proceduralCityGroundTiles', () => {
  const worldId = 'city-ground-test';

  it('lists exactly the tiles proceduralTile() classifies as city ground', () => {
    const ground = proceduralCityGroundTiles(worldId);
    expect(ground.length).toBeGreaterThan(0);
    for (const { x, y } of ground) {
      expect(proceduralTile(worldId, x, y).type).toMatch(/^(familyKeep|center)$/);
    }
  });

  it('covers the whole world-center footprint but only the anchor tile of every other city', () => {
    const ground = new Set(proceduralCityGroundTiles(worldId).map((t) => `${t.x}:${t.y}`));
    const center = allCityNodes(worldId).find((n) => n.kind === 'worldCenter')!;
    const r = (WORLD_CENTER_FOOTPRINT - 1) / 2;
    expect(ground.has(`${center.x + r}:${center.y + r}`)).toBe(true);
    // A capital/garrison contributes one tile: its immediate neighbour is ordinary terrain, since
    // proceduralTile only marks the anchor (the sprite covers the rest of the plot visually).
    const garrison = allCityNodes(worldId).find((n) => n.kind === 'garrison')!;
    expect(ground.has(`${garrison.x}:${garrison.y}`)).toBe(true);
    expect(ground.has(`${garrison.x + 1}:${garrison.y}`)).toBe(false);
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
