// core/helpers.ts branch-coverage gaps (2026-08-15): lootSummary and sourcesBoundingBox are pure
// functions never directly unit-tested — only exercised incidentally through siege/vision e2e flows,
// which don't necessarily hit every branch (empty loot, missing resource keys, empty vision-source list).
import { describe, expect, it } from 'vitest';
import { lootSummary, sourcesBoundingBox } from '../src/core/helpers';
import type { ResourceType } from '@nw/shared';

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
