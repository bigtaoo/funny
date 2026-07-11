import { describe, it, expect } from 'vitest';
import {
  computeStars,
  computeStarScore,
  deriveParTicks,
  buildStarContext,
  remainingHpPct,
  type StarContext,
} from '../src/game/meta/campaignRewards';
import type { LevelDefinition } from '@nw/engine';

// From PVE_INTEGRITY_PLAN §8, clear settlement (progress/stars/materials) is server-authoritative;
// the client star-rating pure functions are reported to the server for verification.
// Composite star scoring model: STAR_SCORING.md.

/** Build a StarContext with sensible defaults, overriding only the fields a case cares about. */
function ctx(over: Partial<StarContext>): StarContext {
  return {
    objectiveKind: 'timed_defense', // wHp=1 → score == hpScore, the simplest axis to reason about
    remainingHpPct: 100,
    elapsedTicks: 0,
    floorTicks: 100,
    parTicks: 200,
    enemyLeaks: 0,
    leakBudget: 1,
    escortHpPct: null,
    ...over,
  };
}

describe('computeStars — composite score → stars', () => {
  const THR: [number, number, number] = [1, 50, 80];

  it('timed_defense (hp-only): remaining HP% maps straight to the score axis', () => {
    expect(computeStars(THR, ctx({ remainingHpPct: 100 }))).toBe(3); // score 100 ≥ 80
    expect(computeStars(THR, ctx({ remainingHpPct: 60 }))).toBe(2);  // score 60 ∈ [50,80)
    expect(computeStars(THR, ctx({ remainingHpPct: 30 }))).toBe(1);  // score 30 ∈ [1,50)
  });

  it('floors any clear (base alive) to 1★ even below the first upgrade threshold', () => {
    expect(computeStars(THR, ctx({ remainingHpPct: 5 }))).toBe(1);
  });

  it('returns 0★ only when the base was destroyed (HP ≤ 0)', () => {
    expect(computeStars(THR, ctx({ remainingHpPct: 0 }))).toBe(0);
    expect(computeStars(undefined, ctx({ remainingHpPct: 0 }))).toBe(0);
  });

  it('falls back to 1★ on clear when no thresholds given', () => {
    expect(computeStars(undefined, ctx({ remainingHpPct: 100 }))).toBe(1);
  });

  it('survive blends hp + speed: a flawless-defense clear still differentiates on clear speed', () => {
    // hp=100, but slow clear (at par) → speed 0 → score 0.5 → 2★, not an automatic 3★.
    expect(computeStars(THR, ctx({
      objectiveKind: 'survive', remainingHpPct: 100, elapsedTicks: 200, floorTicks: 100, parTicks: 200,
    }))).toBe(2);
    // hp=100 + fast clear (at floor) → speed 1 → score 1.0 → 3★.
    expect(computeStars(THR, ctx({
      objectiveKind: 'survive', remainingHpPct: 100, elapsedTicks: 100, floorTicks: 100, parTicks: 200,
    }))).toBe(3);
  });

  it('destroy_base rewards rushing: clearing before the last spawn caps speed at 1.0', () => {
    // elapsed < floor → speed clamps to 1; hp=100 → score 1.0 → 3★.
    expect(computeStars(THR, ctx({
      objectiveKind: 'destroy_base', remainingHpPct: 100, elapsedTicks: 40, floorTicks: 100, parTicks: 200,
    }))).toBe(3);
  });

  it('leak_limit rewards fewer leaks', () => {
    const base = { objectiveKind: 'leak_limit' as const, remainingHpPct: 100, leakBudget: 5 };
    expect(computeStars(THR, ctx({ ...base, enemyLeaks: 0 }))).toBe(3); // leak 1.0 → score 1.0
    expect(computeStars(THR, ctx({ ...base, enemyLeaks: 2 }))).toBe(2); // leak 0.6 → score 0.76
    expect(computeStars(THR, ctx({ ...base, enemyLeaks: 5 }))).toBe(1); // leak 0.0 → score 0.40
  });

  it('escort scores on escort survival, not base HP', () => {
    // base untouched but escort barely survived → low score.
    expect(computeStars(THR, ctx({
      objectiveKind: 'escort', remainingHpPct: 100, escortHpPct: 10, elapsedTicks: 200, floorTicks: 100, parTicks: 200,
    }))).toBe(1); // hp 0.1*0.6 + speed 0 = 0.06 → 1★ floor
    expect(computeStars(THR, ctx({
      objectiveKind: 'escort', remainingHpPct: 100, escortHpPct: 100, elapsedTicks: 100, floorTicks: 100, parTicks: 200,
    }))).toBe(3); // hp 1*0.6 + speed 1*0.4 = 1.0 → 3★
  });
});

describe('computeStarScore — speed sub-score window', () => {
  it('clamps to [0,1] across the floor→par window', () => {
    const mk = (elapsed: number) => computeStarScore(ctx({
      objectiveKind: 'survive', remainingHpPct: 0, elapsedTicks: elapsed, floorTicks: 100, parTicks: 200,
    }));
    // hp=0 so score == 0.5 * speed. floor→1, mid→0.5, par→0.
    expect(mk(100)).toBeCloseTo(0.5);   // speed 1
    expect(mk(150)).toBeCloseTo(0.25);  // speed 0.5
    expect(mk(200)).toBeCloseTo(0);     // speed 0
    expect(mk(300)).toBeCloseTo(0);     // clamped
  });
});

describe('deriveParTicks — from wave script', () => {
  it('uses the last enemy spawn tick and relative multipliers', () => {
    const level = {
      waves: { entries: [
        { atTick: 120, unitType: 'max', col: 4, count: 2, spacingTicks: 24 },   // last @ 144
        { atTick: 600, unitType: 'max', col: 7, count: 3, spacingTicks: 30 },   // last @ 660
      ] },
    } as unknown as LevelDefinition;
    const { floorTicks, parTicks } = deriveParTicks(level);
    expect(floorTicks).toBe(Math.round(660 * 1.05));
    expect(parTicks).toBe(Math.round(660 * 1.6));
    expect(parTicks).toBeGreaterThan(floorTicks);
  });
});

describe('buildStarContext', () => {
  it('wires leak budget from the leak_limit objective and escort HP through', () => {
    const level = {
      objective: { kind: 'leak_limit', maxLeaks: 8 },
      waves: { entries: [{ atTick: 300, unitType: 'max', col: 1, count: 1 }] },
    } as unknown as LevelDefinition;
    const c = buildStarContext(level, { damageTakenByBase: 40, elapsedTicks: 500, enemyLeaks: 3, escortMinHpPct: null });
    expect(c.objectiveKind).toBe('leak_limit');
    expect(c.remainingHpPct).toBe(60);
    expect(c.leakBudget).toBe(8);
    expect(c.enemyLeaks).toBe(3);
  });
});

describe('remainingHpPct', () => {
  it('is 100 minus base damage, clamped 0..100', () => {
    expect(remainingHpPct(0)).toBe(100);
    expect(remainingHpPct(30)).toBe(70);
    expect(remainingHpPct(140)).toBe(0);
  });
});
