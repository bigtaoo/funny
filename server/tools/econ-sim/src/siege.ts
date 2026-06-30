// ─────────────────────────────────────────────────────────────────────────────
// C-track: siege win-rate & cheap-ratio validation (SLG_ECONOMY_CHECK §5).
//
// Uses the deterministic Lanchester linear model (resolveSiege + nationDefenseStrength)
// from @nw/shared — the same formula used as the fallback in applySiege.
// Variance across "seeds" = different (atk, garrison) pair sizes drawn from a
// uniform distribution, simulating the spread of real siege scenarios.
// ─────────────────────────────────────────────────────────────────────────────

import {
  nationDefenseStrength,
  resolveSiege,
  NATION_BONUS_DEFENSE,
  SIEGE_CHEAP_RATIO,
} from '@nw/shared';

// ── Minimal reproducible PRNG (LCG; avoids Math.random for determinism) ─────
function makeLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(1664525, s) + 1013904223;
    s = s >>> 0;
    return s / 4294967296;
  };
}

function uniformInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ── C1: NATION_BONUS_DEFENSE win-rate ────────────────────────────────────────

export interface DefenseWinRateResult {
  total: number;
  attackerWins: number;
  defenderWins: number;
  winRate: number;
  /** Analytical upper bound on attacker win rate from pure-math integration */
  analyticalWinRate: number;
  nation_bonus: number;
  lo: number;
  hi: number;
}

/**
 * Simulate N siege fights where attacker and garrison are each drawn independently
 * from Uniform[lo, hi].  nationDefenseStrength is applied to the garrison.
 * Returns attacker win rate (Lanchester linear).
 */
export function runNationDefenseWinRate(
  n: number,
  lo: number,
  hi: number,
  seed: number,
): DefenseWinRateResult {
  const rng = makeLcg(seed);
  let attackerWins = 0;
  for (let i = 0; i < n; i++) {
    const atk = uniformInt(rng, lo, hi);
    const garrison = uniformInt(rng, lo, hi);
    const defEff = nationDefenseStrength(garrison, true); // +15% in own nation
    if (resolveSiege(atk, defEff).outcome === 'attacker_win') attackerWins++;
  }
  // Analytical formula: P(X > floor(Y*(1+b))) ≈ P(X/Y > 1+b) for U[lo,hi] i.i.d.
  // Exact closed form for continuous U[0,1]: integral_0^(1/(1+b)) (1 - (1+b)*y) dy = 1/(2*(1+b))
  // For U[lo,hi] it converges to the same as hi/lo → ∞.  Approximation here:
  const b = NATION_BONUS_DEFENSE;
  const analyticalWinRate = 1 / (2 * (1 + b)); // ≈ 0.435 for b=0.15
  return {
    total: n,
    attackerWins,
    defenderWins: n - attackerWins,
    winRate: attackerWins / n,
    analyticalWinRate,
    nation_bonus: NATION_BONUS_DEFENSE,
    lo,
    hi,
  };
}

// ── C2: SIEGE_CHEAP_RATIO threshold classification accuracy ─────────────────

export interface RatioSample {
  atk: number;
  defEffective: number;
  ratio: number;
  linearOutcome: string;
  cheapClassified: boolean; // true if ratio >= SIEGE_CHEAP_RATIO (skips engine)
  misclassified: boolean;   // cheapClassified=true but linear says defender_win
}

export interface CheapRatioResult {
  total: number;
  normalBattle: number;
  overwhelming: number;
  misclassifications: number;
  misclassRate: number;
  pass: boolean;
  samples: RatioSample[];
}

/**
 * Constructs explicit ratio samples across [ratioLo, ratioHi], evaluates the
 * Lanchester linear model, and checks whether the SIEGE_CHEAP_RATIO=10 threshold
 * is safe (misclassification rate ≤ 1%).
 *
 * A "misclassification" means: the cheap path would skip the engine (ratio ≥ threshold)
 * but the linear model itself says defender wins — a logical impossibility in Lanchester
 * (if atk/defEff ≥ 10 then atk > defEff always), so the rate should be exactly 0%.
 */
export function runCheapRatioValidation(
  baseDefEffective: number,
  ratioStep: number,
): CheapRatioResult {
  const samples: RatioSample[] = [];
  // Sweep ratios from 0.5 to 20 in ratioStep increments
  for (let ratio = 0.5; ratio <= 20.01; ratio += ratioStep) {
    const atk = Math.round(baseDefEffective * ratio);
    const defEffective = baseDefEffective;
    const linear = resolveSiege(atk, defEffective);
    const cheapClassified = ratio >= SIEGE_CHEAP_RATIO;
    const misclassified = cheapClassified && linear.outcome === 'defender_win';
    samples.push({
      atk,
      defEffective,
      ratio: Math.round(ratio * 100) / 100,
      linearOutcome: linear.outcome,
      cheapClassified,
      misclassified,
    });
  }
  const overwhelming = samples.filter((s) => s.cheapClassified).length;
  const misclassifications = samples.filter((s) => s.misclassified).length;
  return {
    total: samples.length,
    normalBattle: samples.length - overwhelming,
    overwhelming,
    misclassifications,
    misclassRate: overwhelming > 0 ? misclassifications / overwhelming : 0,
    pass: misclassifications / Math.max(1, overwhelming) <= 0.01,
    samples,
  };
}

// ── Structural proof helper ──────────────────────────────────────────────────

/**
 * Proof sketch: at ratio r = atk/defEffective ≥ SIEGE_CHEAP_RATIO,
 *   atk = r * defEffective ≥ 10 * defEffective > defEffective
 *   → resolveSiege(atk, defEffective).outcome = 'attacker_win' always.
 * Misclassification rate in the Lanchester model = 0% (structural guarantee).
 *
 * For the full game engine: at 10:1 troop advantage, the attacker deploys ~10×
 * more unit HP on the board; Lanchester square law gives attacker an overwhelming
 * advantage (defender needs √10 ≈ 3.16× the troops to equalize).
 * Expected engine misclassification rate ≈ 0% (no edge cases possible at 10:1).
 */
export function structuralProof(): {
  threshold: number;
  proof: string;
  expectedMisclassRate: number;
} {
  return {
    threshold: SIEGE_CHEAP_RATIO,
    proof: `atk/defEff >= ${SIEGE_CHEAP_RATIO} ⇒ atk > defEff ⇒ resolveSiege outcome = 'attacker_win' (Lanchester linear is deterministic; no randomness can flip this)`,
    expectedMisclassRate: 0,
  };
}
