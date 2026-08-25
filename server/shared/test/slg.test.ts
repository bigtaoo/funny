import { describe, expect, it } from 'vitest';
import {
  CENTER_CAPITAL_IDX,
  NATION_COUNT,
  NATION_KIND_BY_IDX,
  PROVINCE_RESOURCE_OUTER_RADIUS_RATIO,
  SLG_MAP_H,
  SLG_MAP_MAX_LEVEL,
  SLG_MAP_W,
  allCityNodes,
  capitalIdxAt,
  cityFootprint,
  proceduralTile,
  provinceCapitalPositions,
  provinceIdxAt,
  worldSeed,
} from '../src/slg';
import { PROVINCE_CAPITAL_LEVEL } from '../src/slg/mapgen/cities';

const WORLD = 's99-0';

/** Adds every in-bounds cell of the `footprint`×`footprint` block centred on (cx,cy) to `into`. */
function addFootprint(into: Set<string>, cx: number, cy: number, footprint: number): void {
  const r = (footprint - 1) / 2;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= SLG_MAP_W || y < 0 || y >= SLG_MAP_H) continue;
      into.add(`${x}:${y}`);
    }
  }
}

describe('provinceIdxAt (ADR-034 angle-sector ring model)', () => {
  it('classifies the exact map center as the core province', () => {
    expect(provinceIdxAt(SLG_MAP_W / 2, SLG_MAP_H / 2)).toBe(CENTER_CAPITAL_IDX);
  });

  it('returns a value in [0, NATION_COUNT) for every tile on a coarse sample grid', () => {
    for (let y = 0; y < SLG_MAP_H; y += 17) {
      for (let x = 0; x < SLG_MAP_W; x += 17) {
        const idx = provinceIdxAt(x, y);
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(NATION_COUNT);
      }
    }
  });

  it('resource province i (6+i) angularly nests over outer provinces 2i/2i+1', () => {
    // Sample a ring of points just outside the resource boundary and check the outer sector
    // directly radially outward from each resource sector's center matches the expected pairing.
    // Radius ratios are normalized by the map's half-diagonal (not half-width) — see provinceIdxAt.
    const cx = SLG_MAP_W / 2;
    const cy = SLG_MAP_H / 2;
    const halfDiagonal = Math.sqrt(cx ** 2 + cy ** 2);
    const r = (PROVINCE_RESOURCE_OUTER_RADIUS_RATIO + 0.05) * halfDiagonal;
    for (let i = 0; i < 3; i++) {
      const angle = (i + 0.5) * ((2 * Math.PI) / 3);
      const x = Math.round(cx + Math.cos(angle) * r);
      const y = Math.round(cy + Math.sin(angle) * r);
      const outerIdx = provinceIdxAt(x, y);
      expect(outerIdx === 2 * i || outerIdx === 2 * i + 1).toBe(true);
    }
  });
});

describe('provinceCapitalPositions', () => {
  it('places the core province capital exactly at the map center', () => {
    const caps = provinceCapitalPositions(SLG_MAP_W, SLG_MAP_H, 12345);
    expect(caps[CENTER_CAPITAL_IDX]).toEqual([Math.floor(SLG_MAP_W / 2), Math.floor(SLG_MAP_H / 2)]);
  });

  it('is deterministic for the same seed and in-bounds for every capital', () => {
    const a = provinceCapitalPositions(SLG_MAP_W, SLG_MAP_H, 777);
    const b = provinceCapitalPositions(SLG_MAP_W, SLG_MAP_H, 777);
    expect(a).toEqual(b);
    expect(a.length).toBe(NATION_COUNT);
    for (const [x, y] of a) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(SLG_MAP_W);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(SLG_MAP_H);
    }
  });

  it('places each non-core capital inside its own province membership', () => {
    const caps = provinceCapitalPositions(SLG_MAP_W, SLG_MAP_H, 42);
    for (let i = 0; i < NATION_COUNT; i++) {
      if (i === CENTER_CAPITAL_IDX) continue;
      const [x, y] = caps[i]!;
      expect(provinceIdxAt(x, y)).toBe(i);
    }
  });

  it('capitalIdxAt finds each capital at its own coordinates and -1 elsewhere', () => {
    const caps = provinceCapitalPositions(SLG_MAP_W, SLG_MAP_H, 5);
    for (let i = 0; i < NATION_COUNT; i++) {
      const [x, y] = caps[i]!;
      expect(capitalIdxAt(x, y, caps)).toBe(i);
    }
    expect(capitalIdxAt(1, 1, caps)).toBe(-1);
  });
});

describe('proceduralTile (ADR-034)', () => {
  it('is deterministic for the same world+coords', () => {
    const a = proceduralTile(WORLD, 123, 456);
    const b = proceduralTile(WORLD, 123, 456);
    expect(a).toEqual(b);
  });

  it('marks the exact map center as a 9×9 center footprint', () => {
    const cx = Math.floor(SLG_MAP_W / 2);
    const cy = Math.floor(SLG_MAP_H / 2);
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        expect(proceduralTile(WORLD, cx + dx, cy + dy).type).toBe('center');
      }
    }
    expect(proceduralTile(WORLD, cx + 5, cy).type).not.toBe('center');
  });

  it('every province capital tile is a familyKeep city', () => {
    const caps = provinceCapitalPositions(SLG_MAP_W, SLG_MAP_H, worldSeed(WORLD));
    for (let i = 0; i < NATION_COUNT; i++) {
      if (i === CENTER_CAPITAL_IDX) continue; // world-center footprint, checked separately
      const [x, y] = caps[i]!;
      expect(proceduralTile(WORLD, x, y).type).toBe('familyKeep');
    }
  });

  it('produces a plausible mix of tile types + valid levels over a coarse sample', () => {
    const counts: Record<string, number> = {};
    let n = 0;
    for (let y = 0; y < SLG_MAP_H; y += 5) {
      for (let x = 0; x < SLG_MAP_W; x += 5) {
        const t = proceduralTile(WORLD, x, y);
        counts[t.type] = (counts[t.type] ?? 0) + 1;
        n++;
        expect(t.level).toBeGreaterThanOrEqual(1);
        expect(t.level).toBeLessThanOrEqual(SLG_MAP_MAX_LEVEL);
      }
    }
    // Sanity: terrain (obstacle+gate) should be a minority, most tiles should be resource/neutral land.
    const terrainFrac = ((counts.obstacle ?? 0) + (counts.gate ?? 0)) / n;
    expect(terrainFrac).toBeGreaterThan(0.005);
    expect(terrainFrac).toBeLessThan(0.35);
    expect((counts.resource ?? 0) + (counts.neutral ?? 0)).toBeGreaterThan(n * 0.4);
    expect(counts.center ?? 0).toBeGreaterThan(0);
  });

  it('generates familyKeep ONLY as city ground — exactly the capital/graded footprints, no blobs (2026-08-19 / ADR-074)', () => {
    // Regression guard for the deleted scattered-keep branch (see mapgen/tileGen.ts): it used a smooth
    // value-noise threshold, which paved 3.3% of the map with contiguous keep blobs (largest 1,745
    // tiles), each tile stamping its own gatehouse sprite.
    //
    // ADR-074 widened the legitimate set from each city's single ANCHOR cell to its whole FOOTPRINT
    // (cityFootprint(level) = 3/5/7/9), so the expectation is rebuilt from the node list's footprints
    // rather than its anchors. The guard keeps its teeth two ways: the set comparison is still EXACT
    // (any familyKeep tile outside a declared city plot fails), and the count is bounded well below the
    // blob bug's magnitude — legitimate city ground is ~0.1% of the map, the blobs were 3.3%.
    const expected = new Set<string>();
    const caps = provinceCapitalPositions(SLG_MAP_W, SLG_MAP_H, worldSeed(WORLD));
    caps.forEach(([cx, cy], i) => {
      if (i === CENTER_CAPITAL_IDX) return; // core province's capital IS the world center (type 'center')
      addFootprint(expected, cx, cy, cityFootprint(PROVINCE_CAPITAL_LEVEL));
    });
    for (const node of allCityNodes(WORLD)) {
      if (node.kind === 'garrison') addFootprint(expected, node.x, node.y, node.footprint);
    }

    const found: string[] = [];
    for (let y = 0; y < SLG_MAP_H; y++) {
      for (let x = 0; x < SLG_MAP_W; x++) {
        if (proceduralTile(WORLD, x, y).type === 'familyKeep') found.push(`${x}:${y}`);
      }
    }
    expect(new Set(found)).toEqual(expected);
    // Magnitude bound, independent of the set comparison: 54 graded cities (footprint 5/5/5/7/7/7 by
    // tier) + 9 capitals at 9×9 ≈ 2.6k tiles. 0.5% of a 1500×1500 map leaves generous headroom for a
    // future footprint bump while still failing hard on anything blob-shaped.
    expect(found.length).toBeLessThan(SLG_MAP_W * SLG_MAP_H * 0.005);
  });

  it('holds that familyKeep invariant across other seeds too (the deleted noise gate was seed-dependent)', () => {
    // The blob bug's severity swung with the seed (74k tiles on one world, 90k on another), so pin the
    // invariant on more than WORLD. Stride 3 instead of a full scan to keep the suite fast: it samples
    // 1/9 of the map, which cannot miss any cluster ≥3 tiles wide — the only thing being guarded here
    // (the exact footprint sets are asserted cell-by-cell by the full-map test above).
    for (const world of ['s99-1', 'w1', 'preview']) {
      const plots = new Set<string>();
      const caps = provinceCapitalPositions(SLG_MAP_W, SLG_MAP_H, worldSeed(world));
      caps.forEach(([cx, cy], i) => {
        if (i === CENTER_CAPITAL_IDX) return;
        addFootprint(plots, cx, cy, cityFootprint(PROVINCE_CAPITAL_LEVEL));
      });
      for (const node of allCityNodes(world)) {
        if (node.kind === 'garrison') addFootprint(plots, node.x, node.y, node.footprint);
      }
      const strays: string[] = [];
      for (let y = 0; y < SLG_MAP_H; y += 3) {
        for (let x = 0; x < SLG_MAP_W; x += 3) {
          const key = `${x}:${y}`;
          if (proceduralTile(world, x, y).type === 'familyKeep' && !plots.has(key)) strays.push(key);
        }
      }
      expect(strays, `${world} generated familyKeep tiles outside its city plots`).toEqual([]);
    }
  });

  it('keeps strongholds as isolated Bernoulli points — sparse, and never noise blobs (§19.5 intent)', () => {
    // The sibling of the deleted keep branch, and the reason its comment warns against smooth
    // value-noise: `rand2(x,y) > strongholdThreshold` must stay a per-tile coin flip. Sampled over a
    // 600×600 outer-province window (a full-map scan per seed would triple this file's runtime).
    // Measured band across seeds: 0.11–0.20% of tiles, largest 4-connected cluster 2 — a random
    // Bernoulli field does produce the odd touching pair, so the guard is "small cluster", not "none".
    const N = 600, X0 = 1000, Y0 = 1000;
    for (const world of [WORLD, 'w1']) {
      const cells = new Set<string>();
      for (let y = Y0; y < Y0 + N; y++) {
        for (let x = X0; x < X0 + N; x++) {
          if (proceduralTile(world, x, y).type === 'stronghold') cells.add(`${x}:${y}`);
        }
      }
      const frac = cells.size / (N * N);
      expect(frac, `${world} stronghold density`).toBeGreaterThan(0.0008);
      expect(frac, `${world} stronghold density`).toBeLessThan(0.003);

      const seen = new Set<string>();
      let largest = 0;
      for (const start of cells) {
        if (seen.has(start)) continue;
        const queue = [start];
        seen.add(start);
        let size = 0;
        while (queue.length) {
          const [x, y] = queue.pop()!.split(':').map(Number) as [number, number];
          size++;
          for (const nb of [`${x + 1}:${y}`, `${x - 1}:${y}`, `${x}:${y + 1}`, `${x}:${y - 1}`]) {
            if (cells.has(nb) && !seen.has(nb)) { seen.add(nb); queue.push(nb); }
          }
        }
        largest = Math.max(largest, size);
      }
      expect(largest, `${world} largest stronghold cluster`).toBeLessThanOrEqual(4);
    }
  });

  it('assigns higher average level to core province tiles than outer province tiles (ADR-034 §4 intent)', () => {
    let outerSum = 0, outerN = 0, coreSum = 0, coreN = 0;
    for (let y = 0; y < SLG_MAP_H; y += 3) {
      for (let x = 0; x < SLG_MAP_W; x += 3) {
        const t = proceduralTile(WORLD, x, y);
        if (t.type !== 'resource' && t.type !== 'neutral') continue; // exclude cities/terrain, isolate the ring level table
        const kind = NATION_KIND_BY_IDX[provinceIdxAt(x, y)]!;
        if (kind === 'outer') { outerSum += t.level; outerN++; }
        if (kind === 'core') { coreSum += t.level; coreN++; }
      }
    }
    expect(outerN).toBeGreaterThan(0);
    expect(coreN).toBeGreaterThan(0);
    expect(coreSum / coreN).toBeGreaterThan(outerSum / outerN);
  });
});
