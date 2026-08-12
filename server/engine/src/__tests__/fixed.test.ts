/**
 * Direct unit coverage for math/fixed.ts's arithmetic helpers.
 *
 * Before ADR-065 these functions were only ever exercised indirectly through
 * game-logic tests (armor.test.ts, equip_crit.test.ts, ...), which pin specific
 * balance numbers but don't probe the helpers' own edge cases — truncation
 * direction on negative operands, boundary behavior, compounding shape. That
 * gap is exactly how ADR-065 shipped with a live silent bug (EquipmentScene/
 * helpers.ts's affixDesc did `plainNumber * fpValue`, which type-checks fine
 * because Fp is structurally still `number`, but is 1000x wrong) — caught only
 * by running the full suite, not by tsc. These tests pin the helpers'
 * behavior in isolation so a future regression fails fast, close to the cause.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  FP_SCALE,
  TICK_RATE,
  TICK_DT_FP,
  toFp,
  fp,
  addFp,
  subFp,
  mulFp,
  scaleFp,
  negFp,
  maxFp,
  minFp,
  clampFp,
  growFp,
  divFpByInt,
  isqrt,
  fromFp,
} from '../math/fixed';

test('FP_SCALE / TICK_DT_FP: tick duration truncates (not rounds) to 33', () => {
  assert.equal(FP_SCALE, 1000);
  assert.equal(TICK_RATE, 30);
  // 1000/30 = 33.33... -> truncated, not rounded (would be 33 either way here,
  // but the truncation is load-bearing for determinism, not the specific digit).
  assert.equal(TICK_DT_FP, 33);
  assert.equal(Math.trunc(FP_SCALE / TICK_RATE), TICK_DT_FP);
});

test('toFp truncates toward zero for both positive and negative fractional input', () => {
  assert.equal(toFp(1.5), 1500);
  assert.equal(toFp(1.9999), 1999); // truncation, not rounding
  assert.equal(toFp(0), 0);
  assert.equal(toFp(-1.5), -1500);
  assert.equal(toFp(-1.9999), -1999); // truncates toward zero, i.e. -1999 not -2000
});

test('fp is a pure re-brand: no scaling applied', () => {
  assert.equal(fp(1000), 1000);
  assert.equal(fp(0), 0);
  assert.equal(fp(-500), -500);
});

test('addFp / subFp / negFp: plain integer arithmetic in the fp domain', () => {
  const a = toFp(2.5); // 2500
  const b = toFp(1.25); // 1250
  assert.equal(addFp(a, b), 3750);
  assert.equal(subFp(a, b), 1250);
  assert.equal(subFp(b, a), -1250);
  assert.equal(negFp(a), -2500);
  // negFp(0) legitimately yields JS's -0 (unary minus on 0). assert.equal (strict
  // mode) uses Object.is, which treats -0 !== 0, so compare with === instead —
  // that's the equality that actually matters for arithmetic correctness.
  assert.ok(negFp(fp(0)) === 0);
});

test('mulFp: Math.trunc(a*b/FP_SCALE), including sign-mixed operands', () => {
  // 2.0 * 3.0 = 6.0
  assert.equal(mulFp(toFp(2), toFp(3)), toFp(6));
  // 1.5 * 0.5 = 0.75 -> exact, no truncation loss
  assert.equal(mulFp(toFp(1.5), toFp(0.5)), toFp(0.75));
  // Truncation toward zero on a non-exact product: 1_fp * 1_fp/1000 style tiny values.
  // 0.0015 * 0.0015 in real units is far below fp resolution -> truncates to 0.
  assert.equal(mulFp(fp(2), fp(2)), 0); // (2*2)/1000 = 0.004 -> trunc -> 0
  // Negative operand: sign is preserved, magnitude still truncates toward zero.
  assert.equal(mulFp(toFp(-2), toFp(3)), toFp(-6));
  assert.equal(mulFp(toFp(-1.5), toFp(-2)), toFp(3));
});

test('scaleFp: integer coefficient times fp value, positive and negative multiplier', () => {
  assert.equal(scaleFp(3, toFp(2)), toFp(6));
  assert.equal(scaleFp(-1, toFp(2)), toFp(-2)); // the "negate displacement" use case
  assert.equal(scaleFp(0, toFp(5)), 0);
  assert.equal(scaleFp(4, fp(0)), 0);
});

test('maxFp / minFp: including the equal-values case', () => {
  const lo = toFp(1);
  const hi = toFp(5);
  assert.equal(maxFp(lo, hi), hi);
  assert.equal(maxFp(hi, lo), hi);
  assert.equal(minFp(lo, hi), lo);
  assert.equal(minFp(hi, lo), lo);
  assert.equal(maxFp(lo, lo), lo);
  assert.equal(minFp(lo, lo), lo);
});

test('clampFp: 0-floor, max-ceiling, and the exact-boundary cases', () => {
  const max = toFp(10);
  assert.equal(clampFp(toFp(5), max), toFp(5), 'in-range value passes through unchanged');
  assert.equal(clampFp(toFp(-3), max), 0, 'below-zero clamps to 0');
  assert.equal(clampFp(toFp(15), max), max, 'above-max clamps to max');
  assert.equal(clampFp(toFp(0), max), 0, 'exact 0 boundary');
  assert.equal(clampFp(max, max), max, 'exact max boundary');
});

test('growFp: base * (1 + perStepRate * steps), including steps=0 and a shrink rate', () => {
  const base = toFp(100);
  // 0 steps -> no growth at all, regardless of rate.
  assert.equal(growFp(base, toFp(0.1), 0), base);
  // +10% per step over 3 steps -> 100 * (1 + 0.3) = 130
  assert.equal(growFp(base, toFp(0.1), 3), toFp(130));
  // A negative per-step rate shrinks the base (e.g. a decaying bonus table).
  assert.equal(growFp(base, toFp(-0.1), 2), toFp(80)); // 100 * (1 - 0.2) = 80
});

test('divFpByInt: Math.trunc(a/n), positive and negative dividend', () => {
  // 50 crit points on a 0..100 scale -> 0.5 fraction.
  assert.equal(divFpByInt(toFp(50), 100), toFp(0.5));
  // Truncates toward zero, does not round: 7/2 = 3.5 -fp-> trunc, not 4.
  assert.equal(divFpByInt(fp(7), 2), 3);
  assert.equal(divFpByInt(fp(-7), 2), -3); // toward zero, not toward -infinity
  assert.equal(divFpByInt(fp(0), 5), 0);
});

test('isqrt: exact squares, non-squares, and boundary inputs', () => {
  assert.equal(isqrt(0), 0);
  assert.equal(isqrt(1), 1);
  assert.equal(isqrt(4), 2);
  assert.equal(isqrt(9), 3);
  assert.equal(isqrt(10000), 100);
  // Non-perfect squares floor toward the nearest lower integer root.
  assert.equal(isqrt(8), 2); // sqrt(8) ≈ 2.828
  assert.equal(isqrt(15), 3); // sqrt(15) ≈ 3.873
  assert.equal(isqrt(15999), 126); // 126^2=15876 <= 15999 < 127^2=16129
  // Negative input clamps to 0 rather than throwing/NaN (documented contract).
  assert.equal(isqrt(-5), 0);
});

test('fromFp: pure division back to real units, is the exact inverse of toFp for scale-exact input', () => {
  assert.equal(fromFp(toFp(2.5)), 2.5);
  assert.equal(fromFp(fp(0)), 0);
  assert.equal(fromFp(fp(-1500)), -1.5);
});
