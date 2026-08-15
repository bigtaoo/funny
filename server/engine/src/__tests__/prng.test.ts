/**
 * Direct unit coverage for math/prng.ts's Prng class.
 *
 * fixed.test.ts (ADR-065) established the pattern of probing a low-level determinism
 * primitive in isolation instead of only through game-logic tests. Prng.nextInt() is
 * already exercised indirectly everywhere (card draws, AI, wave timing), but the
 * Fisher-Yates `shuffle()` method (and the seed=0 guard) had no direct coverage — this
 * file closes that gap.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { Prng } from '../math/prng';

test('constructor: seed 0 is guarded to 1 (LCG with state=0 would stay 0 forever for mult=0-equivalent seeds)', () => {
  const fromZero = new Prng(0);
  const fromOne = new Prng(1);
  // Both must produce the identical sequence — proof the 0-seed guard actually rewrote state to 1.
  assert.equal(fromZero.nextInt(1000), fromOne.nextInt(1000));
  assert.equal(fromZero.nextInt(1000), fromOne.nextInt(1000));
});

test('constructor: negative seeds are coerced to uint32 via >>> 0', () => {
  // -1 >>> 0 === 0xFFFFFFFF; must not throw and must be independently deterministic.
  const a = new Prng(-1);
  const b = new Prng(-1);
  assert.equal(a.nextInt(1000), b.nextInt(1000));
});

test('nextInt: same seed produces the same deterministic sequence', () => {
  const a = new Prng(42);
  const b = new Prng(42);
  const seqA = Array.from({ length: 10 }, () => a.nextInt(1000));
  const seqB = Array.from({ length: 10 }, () => b.nextInt(1000));
  assert.deepEqual(seqA, seqB);
});

test('shuffle: empty array is returned unchanged (loop body never runs)', () => {
  const rng = new Prng(1);
  const arr: number[] = [];
  const result = rng.shuffle(arr);
  assert.equal(result, arr, 'must return the exact same array reference');
  assert.deepEqual(result, []);
});

test('shuffle: single-element array is returned unchanged (loop condition i>0 is false immediately)', () => {
  const rng = new Prng(1);
  const arr = [7];
  const result = rng.shuffle(arr);
  assert.equal(result, arr, 'must return the exact same array reference');
  assert.deepEqual(result, [7]);
});

test('shuffle: mutates the array in place and returns the same reference', () => {
  const rng = new Prng(123);
  const arr = [1, 2, 3, 4, 5];
  const result = rng.shuffle(arr);
  assert.equal(result, arr, 'shuffle must mutate and return the same array, not a copy');
});

test('shuffle: result is always a permutation of the original elements (including duplicates)', () => {
  const rng = new Prng(99);
  const original = [1, 2, 2, 3, 4, 4, 4, 5];
  const arr = [...original];
  rng.shuffle(arr);
  assert.deepEqual([...arr].sort((x, y) => x - y), [...original].sort((x, y) => x - y));
});

test('shuffle: same seed yields the same permutation order across independent runs', () => {
  const arrA = ['a', 'b', 'c', 'd', 'e', 'f'];
  const arrB = ['a', 'b', 'c', 'd', 'e', 'f'];
  new Prng(2026).shuffle(arrA);
  new Prng(2026).shuffle(arrB);
  assert.deepEqual(arrA, arrB, 'deterministic seed must reproduce the identical shuffle order');
});

test('shuffle: different seeds produce a different order for a large-enough array', () => {
  const arrA = Array.from({ length: 20 }, (_, i) => i);
  const arrB = Array.from({ length: 20 }, (_, i) => i);
  new Prng(1).shuffle(arrA);
  new Prng(2).shuffle(arrB);
  assert.notDeepEqual(arrA, arrB, 'two distinct seeds landing on the exact same permutation of 20 elements is not expected');
});
