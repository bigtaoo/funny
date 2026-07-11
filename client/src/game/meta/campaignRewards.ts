// Campaign clear star-rating pure functions (S3-1). Decoupled from UI / save — easy to unit-test.
//
// Composite star scoring (STAR_SCORING.md): a normalized quality score S ∈ [0,1] blended from
// up to three sub-scores (hp / speed / leak) with per-objective weights, then mapped to 1..3 stars
// against `level.rewards.starThresholds` (now a score×100 cutoff, [1★,2★,3★]). A clear always
// grants at least 1★ (base survived); base destroyed = 0★ (failed, not recorded / not unlocked).
//
// Why composite instead of raw base-HP%: in a tower defense a held line leaks nothing → base stays
// at 100% → HP% collapses to "pass = 3★" with no gradient. The speed sub-score (clear time vs a
// wave-derived par) gives offensive objectives a real gradient even on a flawless defense; the leak
// sub-score does the same for leak_limit. See STAR_SCORING.md for the full rationale.
//
// From PVE_INTEGRITY_PLAN §8 onward, clear settlement is server-authoritative: the client computes
// stars from this file and reports them; the judge (judgeRunner.ts) recomputes with the same
// function + the same ctx built from engine end state, so an honest clear reproduces the value.

import { BASE_HP } from '../config';
import type { LevelDefinition, ObjectiveSpec } from '@nw/engine';

/** Clear time ≤ lastSpawnTick × this → speedScore 1.0 (fastest realistic clear). */
const SPEED_FLOOR_MULT = 1.05;
/** Clear time ≥ lastSpawnTick × this → speedScore 0 (slow but still a win). */
const SPEED_PAR_MULT = 1.6;

/** Per-objective sub-score weights (each row sums to 1). See STAR_SCORING.md. */
const WEIGHTS: Record<ObjectiveSpec['kind'], { hp: number; speed: number; leak: number }> = {
  survive:       { hp: 0.5,  speed: 0.5,  leak: 0 },
  destroy_base:  { hp: 0.35, speed: 0.65, leak: 0 },
  boss:          { hp: 0.4,  speed: 0.6,  leak: 0 },
  timed_defense: { hp: 1.0,  speed: 0,    leak: 0 }, // fixed duration → speed meaningless
  leak_limit:    { hp: 0.4,  speed: 0,    leak: 0.6 },
  escort:        { hp: 0.6,  speed: 0.4,  leak: 0 }, // hp = escort survival, not base
};

/**
 * Everything the composite score needs, built identically by all three callers
 * (client settlement / judge / difficulty sim) from the match end state + level.
 */
export interface StarContext {
  objectiveKind: ObjectiveSpec['kind'];
  /** Remaining base HP% (100 = untouched, 0 = destroyed). */
  remainingHpPct: number;
  /** Elapsed ticks at clear. */
  elapsedTicks: number;
  /** Wave-derived: clear at/under this tick → full speed score. */
  floorTicks: number;
  /** Wave-derived: clear at/over this tick → zero speed score. */
  parTicks: number;
  /** Enemy units that reached the base this match. */
  enemyLeaks: number;
  /** leak_limit: the allowance (objective.maxLeaks); ≥1 placeholder otherwise (weight is 0). */
  leakBudget: number;
  /** escort: lowest escort survival ratio 0..100; null when the level has no escorts. */
  escortHpPct: number | null;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Derive the speed-score reference window from the level's wave script (no authored field needed).
 * `lastSpawnTick` = when the final enemy of the last group spawns; floor/par are relative multiples
 * so longer levels get proportionally more clear-time grace.
 */
export function deriveParTicks(level: LevelDefinition): { floorTicks: number; parTicks: number } {
  let lastSpawn = 0;
  for (const w of level.waves.entries) {
    const t = w.atTick + Math.max(0, w.count - 1) * (w.spacingTicks ?? 0);
    if (t > lastSpawn) lastSpawn = t;
  }
  const floorTicks = Math.max(1, Math.round(lastSpawn * SPEED_FLOOR_MULT));
  const parTicks = Math.max(floorTicks + 1, Math.round(lastSpawn * SPEED_PAR_MULT));
  return { floorTicks, parTicks };
}

/**
 * Assemble a StarContext from the level + match end state. Single source so client / judge / sim
 * never drift. `escortMinHpPct` is null for non-escort levels.
 */
export function buildStarContext(
  level: LevelDefinition,
  end: { damageTakenByBase: number; elapsedTicks: number; enemyLeaks: number; escortMinHpPct: number | null },
): StarContext {
  const { floorTicks, parTicks } = deriveParTicks(level);
  const obj = level.objective;
  return {
    objectiveKind: obj.kind,
    remainingHpPct: remainingHpPct(end.damageTakenByBase),
    elapsedTicks: end.elapsedTicks,
    floorTicks,
    parTicks,
    enemyLeaks: end.enemyLeaks,
    leakBudget: obj.kind === 'leak_limit' ? Math.max(1, obj.maxLeaks) : 1,
    escortHpPct: end.escortMinHpPct,
  };
}

/**
 * Composite quality score S ∈ [0,1] for a cleared level. Exposed for diagnostics / tuning;
 * `computeStars` maps it to a star count.
 */
export function computeStarScore(ctx: StarContext): number {
  const w = WEIGHTS[ctx.objectiveKind];
  // Escort levels score defense on the escort's survival, not the base.
  const hpBasis = ctx.objectiveKind === 'escort' && ctx.escortHpPct !== null ? ctx.escortHpPct : ctx.remainingHpPct;
  const hpScore = clamp01(hpBasis / 100);
  const speedScore = ctx.parTicks > ctx.floorTicks
    ? clamp01((ctx.parTicks - ctx.elapsedTicks) / (ctx.parTicks - ctx.floorTicks))
    : 1;
  const leakScore = ctx.leakBudget > 0 ? clamp01(1 - ctx.enemyLeaks / ctx.leakBudget) : 1;
  return w.hp * hpScore + w.speed * speedScore + w.leak * leakScore;
}

/**
 * Composite score → star count (0..3) against non-decreasing thresholds (score×100 cutoffs).
 * A clear always grants at least 1★: base survived (remainingHpPct>0) → the level counts as cleared
 * (unlocks the next level). Thresholds only **upgrade** to 2★/3★; they never demote a win to 0★.
 * Base destroyed (remainingHpPct<=0) → 0★ = failed.
 */
export function computeStars(
  thresholds: [number, number, number] | undefined,
  ctx: StarContext,
): 0 | 1 | 2 | 3 {
  if (ctx.remainingHpPct <= 0) return 0; // base destroyed = level failed
  if (!thresholds) return 1;
  const s100 = Math.round(computeStarScore(ctx) * 100);
  let stars = 0;
  for (const t of thresholds) {
    if (s100 >= t) stars++;
  }
  return Math.max(1, stars) as 0 | 1 | 2 | 3; // floor at 1★ on any win
}

/** Compute remaining base HP% from damage taken by the player's base this match (full HP = 100, clamped to 0..100). */
export function remainingHpPct(damageTakenByBase: number): number {
  return Math.max(0, Math.min(100, BASE_HP - damageTakenByBase));
}
