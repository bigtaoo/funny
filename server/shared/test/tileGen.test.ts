// Unit tests for slg/mapgen/tileGen.ts's obstacleShoreAt (shore-wash lookup for land tiles bordering
// an obstacle band) + proceduralTile's neutral-land branch. proceduralTile itself has broad coverage
// via slg.test.ts/mapgen-biome.test.ts/city-buildings.test.ts; this file targets the two remaining gaps.
import { describe, it, expect, afterEach } from 'vitest';
import { obstacleShoreAt, proceduralTile } from '../src/slg/mapgen';
import { SLG_GEN } from '../src/slg/core';

const WORLD = 'tilegen-shore-test';

describe('obstacleShoreAt', () => {
  it('returns null for a land tile deep inside open land, far from any obstacle band', () => {
    // Well inside the map-center footprint / core disk, safely before any ring/river band starts.
    expect(obstacleShoreAt(WORLD, 750, 750)).toBeNull();
  });

  it('returns the bordering obstacle\'s kind + a positive alpha for a land tile adjacent to an obstacle band', () => {
    let hit: { kind: string; alpha: number } | null = null;
    for (let x = 700; x < 1000 && !hit; x++) {
      const t = proceduralTile(WORLD, x, 750);
      if (t.type === 'obstacle') continue; // only land tiles get a shore wash
      hit = obstacleShoreAt(WORLD, x, 750);
    }
    expect(hit).not.toBeNull();
    expect(['river', 'mountain']).toContain(hit!.kind);
    expect(hit!.alpha).toBeGreaterThan(0);
  });

  it('is deterministic for the same world+coords', () => {
    expect(obstacleShoreAt(WORLD, 866, 750)).toEqual(obstacleShoreAt(WORLD, 866, 750));
  });
});

// ── proceduralTile's neutral-land branch ─────────────────────────────────────────────────────
// SLG_GEN.resourceDensity is currently 1.0 ("no pure no-yield neutral land", ADR-032), so the
// `occ < resourceDensity` check that guards the resource-vs-neutral split is, by design, never
// false at the live constant — the neutral branch only exists as a fallback for a future/lower
// resourceDensity tuning. Exercise it directly by dialing the density down for this one call,
// then restoring it, so a future retune doesn't silently leave this branch permanently dead code.
describe('proceduralTile neutral-land branch (SLG_GEN.resourceDensity < 1)', () => {
  const original = SLG_GEN.resourceDensity;

  afterEach(() => {
    (SLG_GEN as { resourceDensity: number }).resourceDensity = original;
  });

  it('classifies a tile as neutral (capped level) when resourceDensity is dialed down', () => {
    (SLG_GEN as { resourceDensity: number }).resourceDensity = 0;
    // Scan a handful of ordinary (non-city/terrain/keep/stronghold) tiles — with resourceDensity=0
    // every one of them must fall through to the neutral branch.
    let sawNeutral = false;
    for (let x = 760; x < 820; x++) {
      const t = proceduralTile(WORLD, x, 751);
      if (t.type === 'neutral') {
        sawNeutral = true;
        expect(t.level).toBeLessThanOrEqual(SLG_GEN.neutralLevelCap);
      }
    }
    expect(sawNeutral).toBe(true);
  });
});
