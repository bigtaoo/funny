// core/helpers.ts branch-coverage gaps (2026-08-15): lootSummary and sourcesBoundingBox are pure
// functions never directly unit-tested — only exercised incidentally through siege/vision e2e flows,
// which don't necessarily hit every branch (empty loot, missing resource keys, empty vision-source list).
import { describe, expect, it } from 'vitest';
import { liveGarrison, lootSummary, sourcesBoundingBox } from '../src/core/helpers';
import { TILE_GARRISON_REGEN_MS, tileGarrisonBaseline, type ResourceType } from '@nw/shared';
import type { TileDoc } from '../src/db';

describe('lootSummary', () => {
  it('formats only the non-zero resource types, in RESOURCE_TYPES order', () => {
    const loot = { ink: 250, paper: 0, graphite: 0, metal: 40, sticker: 0 } as Record<ResourceType, number>;
    expect(lootSummary(loot)).toBe('ink+250,metal+40');
  });

  it('returns an empty string when nothing was looted (all zero)', () => {
    const loot = { ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 } as Record<ResourceType, number>;
    expect(lootSummary(loot)).toBe('');
  });

  it('treats a missing resource key as 0 (nullish-coalescing branch)', () => {
    const loot = { ink: 10 } as Record<ResourceType, number>; // paper/graphite/metal/sticker absent entirely
    expect(lootSummary(loot)).toBe('ink+10');
  });
});

describe('sourcesBoundingBox', () => {
  it('returns null for an empty source list', () => {
    expect(sourcesBoundingBox([])).toBeNull();
  });

  it('computes the enclosing box across multiple sources with different radii', () => {
    const box = sourcesBoundingBox([
      { x: 10, y: 10, radius: 2, kind: 'territory' } as never,
      { x: 50, y: 5, radius: 5, kind: 'capital' } as never,
    ]);
    expect(box).toEqual({ loX: 8, hiX: 55, loY: 0, hiY: 12 });
  });
});

describe('liveGarrison (2026-09-04 baseline heal, SLG_DESIGN §5.6)', () => {
  const NOW = 1_700_000_000_000;
  const OWNER = 'acc-1';
  const BASELINE_5 = tileGarrisonBaseline(5); // 600

  function tile(overrides: Partial<TileDoc> = {}): TileDoc {
    return {
      _id: 'w1:3:3', worldId: 'w1', x: 3, y: 3, type: 'territory', level: 5,
      ownerId: OWNER, garrison: 0, garrisonRegenAt: NOW, rev: 0,
      ...overrides,
    } as unknown as TileDoc;
  }

  it('heals an owned territory back to its level baseline over the regen window', () => {
    expect(liveGarrison(tile(), NOW)).toBe(0);
    expect(liveGarrison(tile(), NOW + TILE_GARRISON_REGEN_MS / 2)).toBe(BASELINE_5 / 2);
    expect(liveGarrison(tile(), NOW + TILE_GARRISON_REGEN_MS)).toBe(BASELINE_5);
  });

  it('an ABSENT checkpoint reads as "no recent battle" — already at the baseline', () => {
    // This is the migration path for TileDocs written before the field existed. Every founding and
    // casualty write stamps it, so a freshly taken tile never lands here.
    const legacy = tile({ garrisonRegenAt: undefined });
    expect(liveGarrison(legacy, NOW)).toBe(BASELINE_5);
  });

  it('leaves a reinforced surplus exactly as stored', () => {
    expect(liveGarrison(tile({ garrison: 5_000 }), NOW + TILE_GARRISON_REGEN_MS)).toBe(5_000);
  });

  it('does not heal an UNOWNED tile — a neutral tile\'s strength is npcGarrison, computed at use', () => {
    const neutral = tile({ ownerId: undefined, garrison: 0, garrisonRegenAt: 0 });
    expect(liveGarrison(neutral, NOW)).toBe(0);
  });

  it('does not heal a base anchor or its ring — the capital defends with in-base teams (ADR-026 §2)', () => {
    expect(liveGarrison(tile({ type: 'base', garrisonRegenAt: 0 }), NOW)).toBe(0);
    expect(liveGarrison(tile({ baseRing: true, garrisonRegenAt: 0 }), NOW)).toBe(0);
  });

  it('treats a missing garrison field as 0 stored (and still heals from it)', () => {
    const bare = tile({ garrison: undefined });
    expect(liveGarrison(bare, NOW)).toBe(0);
    expect(liveGarrison(bare, NOW + TILE_GARRISON_REGEN_MS)).toBe(BASELINE_5);
  });

  it('scales the ceiling with tile level — the same stored 0 heals to different figures', () => {
    const lo = tile({ level: 1 });
    const hi = tile({ level: 10 });
    expect(liveGarrison(lo, NOW + TILE_GARRISON_REGEN_MS)).toBe(tileGarrisonBaseline(1));
    expect(liveGarrison(hi, NOW + TILE_GARRISON_REGEN_MS)).toBe(tileGarrisonBaseline(10));
  });
});
