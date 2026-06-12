import { describe, it, expect } from 'vitest';
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
  fromFp,
} from '../src/game/math/fixed';
import { Prng } from '../src/game/math/prng';

describe('fixed-point arithmetic', () => {
  it('FP_SCALE / TICK_RATE constants are as documented', () => {
    expect(FP_SCALE).toBe(1000);
    expect(TICK_RATE).toBe(30);
    // dt = trunc(1000/30) = 33, truncated identically on all clients
    expect(TICK_DT_FP).toBe(33);
  });

  it('toFp truncates toward zero (no rounding drift)', () => {
    expect(toFp(1.5)).toBe(1500);
    expect(toFp(1)).toBe(1000);
    // 0.0335 * 1000 = 33.5 → trunc → 33 (must NOT round to 34)
    expect(toFp(0.0335)).toBe(33);
    expect(toFp(-1.9)).toBe(-1900);
  });

  it('fp() reinterprets a raw integer without scaling', () => {
    expect(fp(1000)).toBe(1000);
    expect(fromFp(fp(1000))).toBe(1);
  });

  it('add / sub are plain integer ops', () => {
    expect(addFp(toFp(1), toFp(2))).toBe(3000);
    expect(subFp(toFp(2), toFp(0.5))).toBe(1500);
  });

  it('mulFp divides by FP_SCALE with truncation', () => {
    // 1.5 grid * 2 grid = 3 grid → 3000 fp
    expect(mulFp(toFp(1.5), toFp(2))).toBe(3000);
    // speed_fp(1000 fp/s) * dt(33 fp) = trunc(33000/1000) = 33 fp/tick
    expect(mulFp(toFp(1), TICK_DT_FP)).toBe(33);
  });

  it('scaleFp multiplies by a plain integer (e.g. direction)', () => {
    expect(scaleFp(-1, toFp(2))).toBe(-2000);
    expect(scaleFp(3, toFp(0.5))).toBe(1500);
  });

  it('negFp negates', () => {
    expect(negFp(toFp(2))).toBe(-2000);
  });

  it('fromFp is the inverse of toFp for exact values', () => {
    expect(fromFp(toFp(2.5))).toBe(2.5);
  });
});

describe('Prng (deterministic LCG)', () => {
  it('produces identical sequences for the same seed', () => {
    const a = new Prng(12345);
    const b = new Prng(12345);
    for (let i = 0; i < 100; i++) {
      expect(a.nextInt(1000)).toBe(b.nextInt(1000));
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = new Prng(1);
    const b = new Prng(2);
    const seqA = Array.from({ length: 20 }, () => a.nextInt(1_000_000));
    const seqB = Array.from({ length: 20 }, () => b.nextInt(1_000_000));
    expect(seqA).not.toEqual(seqB);
  });

  it('seed 0 is coerced to a non-degenerate state', () => {
    const a = new Prng(0);
    // Should not be stuck at 0 forever
    const vals = Array.from({ length: 10 }, () => a.nextInt(1_000_000));
    expect(vals.some((v) => v !== 0)).toBe(true);
  });

  it('nextInt stays within [0, max)', () => {
    const a = new Prng(99);
    for (let i = 0; i < 1000; i++) {
      const v = a.nextInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it('shuffle is a deterministic permutation for a given seed', () => {
    const base = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const r1 = new Prng(42).shuffle([...base]);
    const r2 = new Prng(42).shuffle([...base]);
    expect(r1).toEqual(r2);
    // Still a permutation (same multiset)
    expect([...r1].sort((a, b) => a - b)).toEqual(base);
  });

  it('two independently-seeded PRNGs do not share state', () => {
    const a = new Prng(7);
    const b = new Prng(7 ^ 0xdeadbeef);
    a.nextInt(100);
    a.nextInt(100);
    // b is untouched by a's advances
    const bFresh = new Prng(7 ^ 0xdeadbeef);
    expect(b.nextInt(100)).toBe(bFresh.nextInt(100));
  });
});
