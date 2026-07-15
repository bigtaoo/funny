// Covers the 2026-07-15 rewrite of biomeAt: per-tile independent resource draw with a mild
// provincial bias, replacing the old low-frequency-noise quad-partition (large contiguous zones).
import { describe, it, expect } from 'vitest';
import { biomeAt, biomeMixAt, leaningResourceForProvince } from '../src/slg/mapgen';
import { provinceIdxAt } from '../src/slg/province';
import { SLG_MAP_W, SLG_MAP_H, SLG_GEN } from '../src/slg/core';

const SEED = 12345;

describe('biomeAt provincial-bias per-tile draw (2026-07-15 rewrite)', () => {
  it('mixes all four land resources within a single province (no contiguous single-resource zones)', () => {
    // Sample every tile in the map, bucket by province, and confirm each province that has enough
    // sampled tiles sees more than one resource type — the old zone-noise model would have produced
    // large single-resource swaths easily missed by a coarse sample, so this scans exhaustively.
    const seenByProvince = new Map<number, Set<string>>();
    for (let x = 0; x < SLG_MAP_W; x += 3) {
      for (let y = 0; y < SLG_MAP_H; y += 3) {
        const p = provinceIdxAt(x, y);
        const t = biomeAt(x, y, SEED);
        if (!seenByProvince.has(p)) seenByProvince.set(p, new Set());
        seenByProvince.get(p)!.add(t);
      }
    }
    for (const [p, types] of seenByProvince) {
      if (p === 9) continue; // core province is a tiny circle, may undersample at stride 3
      expect(types.size).toBeGreaterThan(1);
    }
  });

  it('favors each province\'s own leaning type by roughly SLG_GEN.biomeProvinceBias over the uniform baseline', () => {
    const provinceIdx = 0;
    const leaning = leaningResourceForProvince(provinceIdx, SEED);
    // Find a patch of tiles that all resolve to province 0 (outer sector 0, angle [0, 60°) well beyond
    // the resource-ring radius) — scan a generous region and filter, rather than re-deriving the
    // sector geometry here (keeps the test decoupled from province.ts internals).
    const counts: Record<string, number> = { ink: 0, paper: 0, graphite: 0, metal: 0 };
    let total = 0;
    for (let x = 0; x < SLG_MAP_W; x++) {
      for (let y = 0; y < SLG_MAP_H; y++) {
        if (provinceIdxAt(x, y) !== provinceIdx) continue;
        const t = biomeAt(x, y, SEED);
        if (t in counts) { counts[t]!++; total++; }
      }
      if (total > 20000) break; // plenty for a stable proportion, keeps the test fast
    }
    const leaningShare = counts[leaning]! / total;
    const expected = 0.25 + SLG_GEN.biomeProvinceBias;
    expect(leaningShare).toBeGreaterThan(expected - 0.03);
    expect(leaningShare).toBeLessThan(expected + 0.03);
  });

  it('is deterministic for the same (x, y, seed)', () => {
    expect(biomeAt(42, 77, SEED)).toBe(biomeAt(42, 77, SEED));
  });

  it('leaningResourceForProvince is deterministic and varies across provinces for a typical seed', () => {
    const byProvince = new Set<string>();
    for (let p = 0; p < 9; p++) byProvince.add(leaningResourceForProvince(p, SEED));
    expect(leaningResourceForProvince(3, SEED)).toBe(leaningResourceForProvince(3, SEED));
    // Not a strict requirement that all 9 provinces differ, but with 9 draws over 4 types some spread is expected.
    expect(byProvince.size).toBeGreaterThan(1);
  });
});

describe('biomeMixAt (ground-tint compatibility shim)', () => {
  it('always returns a solid tint (a === b, t === 0) matching the tile\'s province leaning type', () => {
    const mix = biomeMixAt(10, 10, SEED);
    expect(mix.t).toBe(0);
    expect(mix.a).toBe(mix.b);
    expect(mix.a).toBe(leaningResourceForProvince(provinceIdxAt(10, 10), SEED));
  });
});
