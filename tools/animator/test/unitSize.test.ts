// Unit height standard (src/io/unitSize.ts) — a hand-synced MIRROR of the game's single source of
// truth at client/src/render/unitSize.ts (the animator can't import across the package boundary).
// Pure constant lookup; this pins the mirror's own internal consistency, not cross-package sync
// (a drift there would need a diff against the game file itself, which this package can't import).
import { describe, it, expect } from 'vitest';
import { TARGET_SCREEN_PX, SUPERSAMPLE, SIZE_TIER_LABELS, SizeTierKey } from '../src/io/unitSize';

const TIERS: SizeTierKey[] = ['S', 'M', 'L', 'XL'];

describe('TARGET_SCREEN_PX', () => {
  it('has an entry for every tier, strictly increasing S < M < L < XL', () => {
    for (const t of TIERS) expect(TARGET_SCREEN_PX[t]).toBeGreaterThan(0);
    expect(TARGET_SCREEN_PX.S).toBeLessThan(TARGET_SCREEN_PX.M);
    expect(TARGET_SCREEN_PX.M).toBeLessThan(TARGET_SCREEN_PX.L);
    expect(TARGET_SCREEN_PX.L).toBeLessThan(TARGET_SCREEN_PX.XL);
  });

  it('pins the exact mirrored values (must match client/src/render/unitSize.ts if this ever changes)', () => {
    expect(TARGET_SCREEN_PX).toEqual({ S: 46, M: 54, L: 64, XL: 81 });
  });
});

describe('SUPERSAMPLE', () => {
  it('is 2 (mirrors client/src/render/unitSize.ts)', () => {
    expect(SUPERSAMPLE).toBe(2);
  });
});

describe('SIZE_TIER_LABELS', () => {
  it('has exactly one label per tier, in the same key set as TARGET_SCREEN_PX', () => {
    expect(Object.keys(SIZE_TIER_LABELS).sort()).toEqual(TIERS.slice().sort());
  });

  it('every label is non-empty and mentions its own tier letter', () => {
    for (const t of TIERS) {
      expect(SIZE_TIER_LABELS[t].length).toBeGreaterThan(0);
      expect(SIZE_TIER_LABELS[t].startsWith(t)).toBe(true);
    }
  });

  it('only XL is flagged mythic-creature-only', () => {
    expect(SIZE_TIER_LABELS.XL).toContain('mythic');
    for (const t of ['S', 'M', 'L'] as SizeTierKey[]) {
      expect(SIZE_TIER_LABELS[t]).not.toContain('mythic');
    }
  });
});
