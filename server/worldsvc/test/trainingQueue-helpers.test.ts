// Pure-unit cover for the two `trainingQueue` helpers in `src/db/playerDocs.ts`. Both were only ever
// exercised indirectly, through the Mongo e2e suites — which meant two contracts that the rest of the
// service leans on had no direct assertion anywhere:
//
//   ① `trainingQueueOps` must mirror the queue's EARLIEST completeAt. Until ADR-079 (2026-09-02) it took
//      `queue[0]` and the doc comment justified that with "the queue is always kept sorted — chained
//      scheduling". Parallel slots ended that: the array is in enqueue order, completion order is
//      whatever the batch sizes say. The mirror is the ONLY field the scheduler's indexed due-scan reads,
//      so getting it wrong does not slow anything down — it makes a finished batch invisible and its
//      troops never arrive. Pinned here on an explicitly unsorted array, which is the shape an e2e can
//      only produce indirectly.
//   ② `applyTrainingSpeedupCatchup` must return the SAME ARRAY REFERENCE when there is nothing to catch
//      up. Three callers (CityTrainingService, ShopService, processCompletedTraining) use `queue ===
//      doc.trainingQueue` to skip a wasted write — processCompletedTraining does it per buffed document
//      on every 2s tick. That is a load-bearing identity, documented in the function's comment and, until
//      now, asserted nowhere: a `.map()` added "for safety" would keep every test green and quietly turn
//      the tick back into a write storm.
import { describe, expect, it } from 'vitest';
import { TRAIN_SPEEDUP_BUFF_MULT } from '@nw/shared';
import { trainingQueueOps, applyTrainingSpeedupCatchup, type TrainingEntry } from '../src/db';

const entry = (qty: number, startAt: number, completeAt: number): TrainingEntry => ({ qty, inkCost: 0, startAt, completeAt });

describe('trainingQueueOps — the indexed due-scan mirror', () => {
  it('mirrors the earliest completeAt when the array is NOT in completion order', () => {
    // The exact shape ADR-079 introduced: a big batch enqueued first, a tiny one enqueued second.
    const queue = [entry(5000, 1_000, 11_000), entry(2, 1_000, 1_004)];
    expect(trainingQueueOps(queue).set).toEqual({ nextTrainingCompleteAt: 1_004 });
  });

  it('mirrors the earliest of three unsorted entries, not the first or the smallest qty', () => {
    const queue = [entry(100, 0, 5_000), entry(1, 0, 9_000), entry(50, 0, 2_000)];
    expect(trainingQueueOps(queue).set).toEqual({ nextTrainingCompleteAt: 2_000 });
  });

  it('a single entry mirrors itself, and ties mirror that shared instant', () => {
    expect(trainingQueueOps([entry(10, 0, 700)]).set).toEqual({ nextTrainingCompleteAt: 700 });
    // Equal-size batches queued in the same request now genuinely complete together (parallel slots).
    expect(trainingQueueOps([entry(10, 0, 700), entry(10, 0, 700)]).set).toEqual({ nextTrainingCompleteAt: 700 });
  });

  it('an empty queue $unsets the field rather than writing null — the partial index depends on absence', () => {
    const ops = trainingQueueOps([]);
    expect(ops.set).toEqual({});
    expect(ops.unset).toEqual({ nextTrainingCompleteAt: '' });
  });

  it('a non-empty queue never emits an $unset fragment', () => {
    expect(trainingQueueOps([entry(1, 0, 5)]).unset).toEqual({});
  });
});

describe('applyTrainingSpeedupCatchup — buff time-compression across parallel slots', () => {
  const queue = [entry(100, 0, 10_000), entry(20, 0, 3_000)];

  it('returns the SAME reference (not a copy) when no buff has ever been bought', () => {
    expect(applyTrainingSpeedupCatchup(queue, undefined, 0, 5_000)).toBe(queue);
  });

  it('returns the SAME reference when the buff expired before the window opened', () => {
    // speedupUntil (4_000) is behind fromT (5_000): overlap is negative, nothing to fold in.
    expect(applyTrainingSpeedupCatchup(queue, 4_000, 5_000, 9_000)).toBe(queue);
  });

  it('returns the SAME reference for an empty queue or a zero-length window', () => {
    expect(applyTrainingSpeedupCatchup([], 9_999_999, 0, 5_000)).toEqual([]);
    expect(applyTrainingSpeedupCatchup(queue, 9_999_999, 5_000, 5_000)).toBe(queue);
    expect(applyTrainingSpeedupCatchup(queue, 9_999_999, 5_000, 4_000)).toBe(queue); // clock went backwards
  });

  it('shifts EVERY slot earlier by the same amount — the parallel-correct reading of the buff', () => {
    // 1_000ms of real time under a 2x buff is 1_000ms of extra progress, and each slot advances on its
    // own clock, so each slot gets all of it. (Under the pre-ADR-079 chained queue the same arithmetic
    // happened to also preserve the startAt(i+1)===completeAt(i) links; that reasoning is now moot.)
    const out = applyTrainingSpeedupCatchup(queue, 9_999_999, 0, 1_000);
    const extra = 1_000 * (TRAIN_SPEEDUP_BUFF_MULT - 1);
    expect(out.map((e) => e.completeAt)).toEqual([10_000 - extra, 3_000 - extra]);
    expect(out.map((e) => e.startAt)).toEqual([0 - extra, 0 - extra]);
    // Each slot keeps its own duration: the buff compresses the clock, it does not re-plan the work.
    expect(out.map((e) => e.completeAt - e.startAt)).toEqual(queue.map((e) => e.completeAt - e.startAt));
  });

  it('credits only the part of the window the buff was actually live for', () => {
    // Buff ends at 600 but the caller is settling up to 1_000 — only 600ms of overlap may be spent.
    const out = applyTrainingSpeedupCatchup(queue, 600, 0, 1_000);
    const extra = 600 * (TRAIN_SPEEDUP_BUFF_MULT - 1);
    expect(out[0]!.completeAt).toBe(10_000 - extra);
  });

  it('never mutates the input array or its entries', () => {
    const original = [entry(100, 0, 10_000)];
    const snapshot = JSON.parse(JSON.stringify(original));
    applyTrainingSpeedupCatchup(original, 9_999_999, 0, 1_000);
    expect(original).toEqual(snapshot);
  });

  it('the mirror stays a min() after a catch-up reorders nothing but moves everything', () => {
    // Compression is uniform, so it cannot change WHICH slot finishes first — but the mirror still has
    // to be recomputed from the compressed values, which is why every caller re-runs trainingQueueOps.
    const out = applyTrainingSpeedupCatchup(queue, 9_999_999, 0, 1_000);
    const extra = 1_000 * (TRAIN_SPEEDUP_BUFF_MULT - 1);
    expect(trainingQueueOps(out).set).toEqual({ nextTrainingCompleteAt: 3_000 - extra });
  });
});
