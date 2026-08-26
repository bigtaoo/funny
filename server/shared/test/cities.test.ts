// Unit tests for slg/mapgen/cities.ts's allCityNodes: flattens world-center + province capitals +
// graded garrison cities into the map editor's siege-point node list (ADR-034 §3).
import { describe, it, expect } from 'vitest';
import { allCityNodes, parseCityNodes, proceduralCityGroundTiles, proceduralTile, proceduralTileIgnoringCities } from '../src/slg/mapgen';
import { WORLD_CENTER_FOOTPRINT, PROVINCE_CAPITAL_LEVEL, _cityGroundNodeAt, _inCityFootprint } from '../src/slg/mapgen/cities';
import { CENTER_CAPITAL_IDX, NATION_COUNT, provinceCapitalPositions } from '../src/slg/province';
import { worldSeed } from '../src/slg/noise';
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

describe('_inCityFootprint / _cityGroundNodeAt (ADR-074 footprint resolution)', () => {
  const worldId = 'city-ground-test';
  const seed = worldSeed(worldId);

  it('includes the footprint edge and excludes one cell past it', () => {
    // Off-by-one here is the difference between a city plot and a city plot with a claimable ring of land
    // around its wall — the exact shape of the bug ADR-074 fixes, one radius out.
    for (const fp of [3, 5, 7, 9]) {
      const r = (fp - 1) / 2;
      expect(_inCityFootprint(100, 100, 100, 100, fp)).toBe(true);      // anchor
      expect(_inCityFootprint(100 + r, 100 + r, 100, 100, fp)).toBe(true);  // far corner
      expect(_inCityFootprint(100 - r, 100 - r, 100, 100, fp)).toBe(true);  // near corner
      expect(_inCityFootprint(100 + r + 1, 100, 100, 100, fp)).toBe(false); // one past the edge
      expect(_inCityFootprint(100, 100 + r + 1, 100, 100, fp)).toBe(false);
    }
  });

  it('a 1-tile footprint is the anchor alone (the degenerate case the editor allows)', () => {
    expect(_inCityFootprint(50, 50, 50, 50, 1)).toBe(true);
    expect(_inCityFootprint(51, 50, 50, 50, 1)).toBe(false);
  });

  it('never claims the core province capital — that block is the world center, typed `center`', () => {
    // provinceCapitalPositions pins the core province's "capital" to the exact map centre, and
    // `proceduralTile` classifies that 9×9 as `center` in its own earlier branch. If _cityGroundNodeAt
    // also claimed it as a familyKeep capital footprint, any caller reaching here first would get the
    // wrong type for the world centre — and no city sprite is drawn for that phantom capital.
    const caps = provinceCapitalPositions(SLG_MAP_W, SLG_MAP_H, seed);
    const [ccx, ccy] = caps[CENTER_CAPITAL_IDX]!;
    expect(_cityGroundNodeAt(SLG_MAP_W, SLG_MAP_H, seed, ccx, ccy)).toBeNull();
    expect(proceduralTile(worldId, ccx, ccy).type).toBe('center');
  });

  it('resolves a cell shared by two plots to the CAPITAL, matching rasterizeMapEdits priority', () => {
    // Overlaps are real (a map-edge city's anchor is clamped inward, so its plot can reach a neighbour's).
    // Both paths must pick the same winner or a published template disagrees with the generator about that
    // cell's level — from ADR-074 P1 that level is the city's HP/garrison scale. See the matching
    // mapEdit.test.ts case for the publish side.
    //
    // Pinned to a seed that MEASURABLY overlaps: 's1-cityground' has 15 garrison cells inside a capital's
    // plot, while this file's usual 'city-ground-test' (and 's99-0', 'w1') have none — written against
    // those, this case looked green while covering nothing. The loop therefore also asserts it found some,
    // so a future seed change cannot silently turn it back into a no-op.
    const overlapWorld = 's1-cityground';
    const overlapSeed = worldSeed(overlapWorld);
    const caps = provinceCapitalPositions(SLG_MAP_W, SLG_MAP_H, overlapSeed);
    const capR = (cityFootprint(PROVINCE_CAPITAL_LEVEL) - 1) / 2;
    let checked = 0;
    for (const node of allCityNodes(overlapWorld)) {
      if (node.kind !== 'garrison') continue;
      const r = (node.footprint - 1) / 2;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = node.x + dx;
          const y = node.y + dy;
          if (x < 0 || x >= SLG_MAP_W || y < 0 || y >= SLG_MAP_H) continue;
          const inCapital = caps.some(([cx, cy], i) => i !== CENTER_CAPITAL_IDX && _inCityFootprint(x, y, cx, cy, capR * 2 + 1));
          if (!inCapital) continue;
          expect(_cityGroundNodeAt(SLG_MAP_W, SLG_MAP_H, overlapSeed, x, y)?.level).toBe(PROVINCE_CAPITAL_LEVEL);
          expect(proceduralTile(overlapWorld, x, y).level).toBe(PROVINCE_CAPITAL_LEVEL);
          checked++;
        }
      }
    }
    expect(checked, 'no overlapping plots on this seed — the case covered nothing').toBe(15);
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
