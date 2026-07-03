// Unit tests for pveRewards.ts: level-chain integrity, reward/drop sanity, chapter-clear counting,
// upgrade cost math, spot-check gating (PVE_INTEGRITY_PLAN §8). Pure data + pure functions, no DB.
import { describe, it, expect } from 'vitest';
import {
  PVE_LEVELS,
  findPveLevel,
  chaptersClearedCount,
  PVE_UPGRADE_COSTS,
  findPveUpgrade,
  pveUpgradeCost,
  shouldSpotCheck,
  PVE_VERIFY_SAMPLE_RATE,
  type PveMaterial,
} from '../src/pveRewards';

const MATERIALS: PveMaterial[] = ['scrap', 'lead', 'binding'];

// ── level chain integrity ─────────────────────────────────────────────────────────

describe('PVE_LEVELS', () => {
  it('level ids are unique', () => {
    const ids = PVE_LEVELS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every requires prerequisite (if set) references an existing level', () => {
    const ids = new Set(PVE_LEVELS.map((l) => l.id));
    for (const l of PVE_LEVELS) {
      if (l.requires !== null) expect(ids.has(l.requires)).toBe(true);
    }
  });

  it('exactly one level is the root (requires === null)', () => {
    expect(PVE_LEVELS.filter((l) => l.requires === null)).toHaveLength(1);
  });

  it('the prerequisite graph is acyclic and reaches the root', () => {
    const byId = new Map(PVE_LEVELS.map((l) => [l.id, l]));
    for (const start of PVE_LEVELS) {
      const seen = new Set<string>();
      let cur: string | null = start.id;
      while (cur !== null) {
        expect(seen.has(cur)).toBe(false); // no cycle
        seen.add(cur);
        cur = byId.get(cur)!.requires;
      }
    }
  });

  it('reward material amounts are positive integers', () => {
    for (const l of PVE_LEVELS) {
      for (const mat of MATERIALS) {
        const v = l.reward[mat];
        if (v === undefined) continue;
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
    }
  });

  it('equipment drop rates are within (0,1]', () => {
    for (const l of PVE_LEVELS) {
      if (!l.equipmentDrop) continue;
      expect(l.equipmentDrop.rate).toBeGreaterThan(0);
      expect(l.equipmentDrop.rate).toBeLessThanOrEqual(1);
    }
  });

  it('findPveLevel resolves known / misses unknown', () => {
    expect(findPveLevel('ch1_lv1')?.requires).toBeNull();
    expect(findPveLevel('nope')).toBeUndefined();
  });
});

// ── chaptersClearedCount ──────────────────────────────────────────────────────────

describe('chaptersClearedCount', () => {
  it('counts zero when no finale is cleared', () => {
    expect(chaptersClearedCount(['ch1_lv1', 'ch1_lv9'])).toBe(0);
  });

  it('counts a chapter once its finale (lv10) is cleared', () => {
    expect(chaptersClearedCount(['ch1_lv10'])).toBe(1);
  });

  it('counts multiple chapter finales', () => {
    expect(chaptersClearedCount(['ch1_lv10', 'ch2_lv10', 'ch3_lv10'])).toBe(3);
  });

  it('ignores special levels without a chapter index (ch_stress)', () => {
    expect(chaptersClearedCount(['ch_stress'])).toBe(0);
  });

  it('is order-independent and dedups', () => {
    expect(chaptersClearedCount(['ch2_lv10', 'ch1_lv10', 'ch1_lv10'])).toBe(2);
  });
});

// ── upgrade costs ─────────────────────────────────────────────────────────────────

describe('PVE_UPGRADE_COSTS', () => {
  it('upgrade ids are unique', () => {
    const ids = PVE_UPGRADE_COSTS.map((u) => u.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every upgrade uses a known material and positive baseCost/maxLevel', () => {
    for (const u of PVE_UPGRADE_COSTS) {
      expect(MATERIALS).toContain(u.material);
      expect(u.baseCost).toBeGreaterThan(0);
      expect(u.maxLevel).toBeGreaterThan(0);
    }
  });

  it('findPveUpgrade resolves known / misses unknown', () => {
    expect(findPveUpgrade('inf_hp')?.material).toBe('scrap');
    expect(findPveUpgrade('nope')).toBeUndefined();
  });
});

describe('pveUpgradeCost', () => {
  const inf = findPveUpgrade('inf_hp')!; // baseCost 3, maxLevel 5

  it('level 0→1 costs baseCost × 1', () => {
    expect(pveUpgradeCost(inf, 0)).toEqual({ material: 'scrap', amount: 3 });
  });

  it('scales linearly with the target level', () => {
    expect(pveUpgradeCost(inf, 1)!.amount).toBe(6);
    expect(pveUpgradeCost(inf, 4)!.amount).toBe(15);
  });

  it('returns null at or beyond max level', () => {
    expect(pveUpgradeCost(inf, 5)).toBeNull();
    expect(pveUpgradeCost(inf, 99)).toBeNull();
  });

  it('total cost to max is the linear sum', () => {
    let total = 0;
    for (let lv = 0; lv < inf.maxLevel; lv++) total += pveUpgradeCost(inf, lv)!.amount;
    // 3*(1+2+3+4+5) = 45
    expect(total).toBe(45);
  });
});

// ── spot-check gating ─────────────────────────────────────────────────────────────

describe('shouldSpotCheck', () => {
  it('always triggers on a first clear', () => {
    expect(shouldSpotCheck({ isFirstClear: true, blueprintMismatch: false, rand: 0.99 })).toBe(true);
  });

  it('always triggers on a blueprint mismatch', () => {
    expect(shouldSpotCheck({ isFirstClear: false, blueprintMismatch: true, rand: 0.99 })).toBe(true);
  });

  it('samples replays below the configured rate', () => {
    expect(shouldSpotCheck({ isFirstClear: false, blueprintMismatch: false, rand: PVE_VERIFY_SAMPLE_RATE - 0.01 })).toBe(true);
  });

  it('skips replays at or above the rate', () => {
    expect(shouldSpotCheck({ isFirstClear: false, blueprintMismatch: false, rand: PVE_VERIFY_SAMPLE_RATE })).toBe(false);
    expect(shouldSpotCheck({ isFirstClear: false, blueprintMismatch: false, rand: 0.99 })).toBe(false);
  });

  it('honors a custom sample rate', () => {
    expect(shouldSpotCheck({ isFirstClear: false, blueprintMismatch: false, rand: 0.4, sampleRate: 0.5 })).toBe(true);
    expect(shouldSpotCheck({ isFirstClear: false, blueprintMismatch: false, rand: 0.6, sampleRate: 0.5 })).toBe(false);
  });
});
