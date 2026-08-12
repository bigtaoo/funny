/**
 * Fixed-point arithmetic utilities.
 *
 * Convention: 1 grid unit = FP_SCALE integer units (fp).
 *
 * ENFORCEMENT RULES — apply to ALL game-logic files:
 *   ✗  Math.random()          → use Prng
 *   ✗  Date.now() / new Date  → forbidden in logic layer
 *   ✗  Assigning raw number to an Fp field  → TypeScript will error
 *   ✓  Use the helpers below (toFp / fp / addFp / subFp / mulFp / scaleFp / negFp / growFp /
 *      divFpByInt / maxFp / minFp / clampFp / …) for all fp ops — never a raw JS operator
 */

// ── Constants ────────────────────────────────────────────────────────────────

/** 1 grid unit expressed in fixed-point integers (scale factor). */
export const FP_SCALE = 1000;

/** Logic tick rate in Hz. */
export const TICK_RATE = 30;

/**
 * One tick duration in fixed-point.
 * dt = 1/30 s → 1000/30 = 33.33… → truncated to 33_fp.
 * Identical truncation on all clients → deterministic.
 */
export const TICK_DT_FP = Math.trunc(FP_SCALE / TICK_RATE) as Fp; // 33

// ── Branded Fp type ───────────────────────────────────────────────────────────

declare const __fpBrand: unique symbol;

/**
 * Fixed-point integer (scale = FP_SCALE = 1000).
 *
 * Branded so TypeScript rejects accidental assignment of plain floats to fp fields:
 *   unit.y_fp = 1.5;          // ✗ compile error — number is not assignable to Fp
 *   unit.y_fp = toFp(1.5);    // ✓
 *   unit.y_fp = addFp(a, b);  // ✓
 *
 * Arithmetic operators (+/-/*) on `Fp` still return plain `number`.
 * Always use the helpers below so the result is re-branded as `Fp`.
 */
export type Fp = number & { readonly [__fpBrand]: true };

// ── Constructors ─────────────────────────────────────────────────────────────

/**
 * Convert float grid units to fixed-point.
 * e.g. toFp(1.5) → 1500_fp
 */
export function toFp(gridUnits: number): Fp {
  return Math.trunc(gridUnits * FP_SCALE) as Fp;
}

/**
 * Treat a raw integer as an Fp value WITHOUT multiplication.
 * Use only when the integer is already correctly scaled.
 * e.g. fp(1000) → 1000_fp = 1 grid unit
 */
export function fp(rawInt: number): Fp {
  return rawInt as Fp;
}

// ── Arithmetic ───────────────────────────────────────────────────────────────

/** a + b (both fp → fp) */
export function addFp(a: Fp, b: Fp): Fp {
  return (a + b) as Fp;
}

/** a - b (both fp → fp) */
export function subFp(a: Fp, b: Fp): Fp {
  return (a - b) as Fp;
}

/**
 * Fixed-point multiply: Math.trunc(a × b / FP_SCALE).
 * Required for any fp × fp operation (e.g. speed_fp × dt_fp).
 */
export function mulFp(a: Fp, b: Fp): Fp {
  return Math.trunc((a * b) / FP_SCALE) as Fp;
}

/**
 * Scale an Fp value by a plain integer coefficient.
 * Use for direction × displacement, or constant factors.
 * `intMultiplier` must be a safe integer (never a float).
 * e.g. scaleFp(-1, dy_fp) → negate displacement
 */
export function scaleFp(intMultiplier: number, a: Fp): Fp {
  return Math.trunc(intMultiplier * a) as Fp;
}

/** Negate an fp value: -a */
export function negFp(a: Fp): Fp {
  return (-a) as Fp;
}

/** max(a, b), both fp → fp. */
export function maxFp(a: Fp, b: Fp): Fp {
  return Math.max(a, b) as Fp;
}

/** min(a, b), both fp → fp. */
export function minFp(a: Fp, b: Fp): Fp {
  return Math.min(a, b) as Fp;
}

/** Clamp `a` to [0, max], both fp → fp. Matches the engine's existing `clamp(v, max)` (0-floor, max-ceiling) convention used for cross-source effect caps (ADR-065). */
export function clampFp(a: Fp, max: Fp): Fp {
  return (a > max ? max : a < 0 ? 0 : a) as Fp;
}

/**
 * Compound a base Fp value by a linear per-step growth rate over `steps` discrete
 * steps — `base × (1 + perStepRate × steps)`. This is the engine's standard "1 +
 * rate×steps" per-level/per-upgrade-level growth shape (balance/{progression,
 * pveUpgrades,equipment}.ts, ADR-065), expressed once so every call site stays
 * consistent instead of hand-rolling `mulFp(base, addFp(toFp(1), scaleFp(...)))`.
 * `steps` must be a safe integer (never a float/Fp).
 */
export function growFp(base: Fp, perStepRate: Fp, steps: number): Fp {
  return mulFp(base, addFp(toFp(1), scaleFp(steps, perStepRate)));
}

/**
 * Divide an Fp value by a plain positive integer, staying in the fp domain.
 * Use for "percentage-points ÷ 100" patterns (crit/lifesteal/reflect damage math,
 * ADR-065): e.g. `divFpByInt(mulFp(damage_fp, critMultBonusPts_fp), 100)` converts
 * a points-on-a-0..100-scale Fp value into the fraction it represents, without an
 * intermediate float. `n` must be a safe positive integer (never a float/Fp).
 */
export function divFpByInt(a: Fp, n: number): Fp {
  return Math.trunc(a / n) as Fp;
}

/**
 * Deterministic integer square root: floor(√n) for n ≥ 0, using only integer
 * arithmetic (no Math.sqrt → no platform float divergence). Used by the
 * projectile system to measure fp distance to a homing target.
 *
 * Bit-by-bit ("digit-by-digit") method — O(log n), exact for all safe integers.
 * Input must be a non-negative integer (e.g. dx*dx + dy*dy in fp²); a negative
 * input clamps to 0.
 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  // Highest power of 4 ≤ n.
  let bit = 1;
  while (bit * 4 <= n) bit *= 4;
  let res = 0;
  let rem = n;
  while (bit !== 0) {
    if (rem >= res + bit) {
      rem -= res + bit;
      res = (res >> 1) + bit;
    } else {
      res >>= 1;
    }
    bit = Math.trunc(bit / 4);
  }
  return res;
}

// ── Conversion (render layer ONLY — never use in logic) ──────────────────────

/**
 * Convert fixed-point back to float grid units.
 * FOR RENDERING ONLY. Never call this inside game logic.
 */
export function fromFp(value: Fp): number {
  return value / FP_SCALE;
}
