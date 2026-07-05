import { describe, expect, it } from 'vitest';
import {
  CENTER_CAPITAL_IDX,
  NATION_COUNT,
  NATION_KIND_BY_IDX,
  PROVINCE_RESOURCE_OUTER_RADIUS_RATIO,
  SLG_MAP_H,
  SLG_MAP_MAX_LEVEL,
  SLG_MAP_W,
  capitalIdxAt,
  proceduralTile,
  provinceCapitalPositions,
  provinceIdxAt,
  worldSeed,
} from '../src/slg';

const WORLD = 's99-0';

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
    expect(counts.familyKeep ?? 0).toBeGreaterThan(0);
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
