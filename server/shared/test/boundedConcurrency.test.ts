// Unit tests for boundedConcurrency.ts's runBounded fan-out helper: empty input, limit >= items.length
// (fully parallel), limit < items.length (actually caps concurrency, verified via an in-flight counter),
// and error propagation (a throwing fn should reject the overall Promise.all, same as native Promise.all).
import { describe, it, expect } from 'vitest';
import { runBounded } from '../src/boundedConcurrency';

describe('runBounded', () => {
  it('empty array: returns immediately without invoking fn', async () => {
    const fn = async (): Promise<void> => {
      throw new Error('should never be called');
    };
    await expect(runBounded([], 3, fn)).resolves.toBeUndefined();
  });

  it('limit >= items.length: all items are processed (fully parallel)', async () => {
    const seen: number[] = [];
    await runBounded([1, 2, 3], 10, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([1, 2, 3]);
  });

  it('processes every item exactly once, passing (item, index) correctly', async () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const calls: Array<[string, number]> = [];
    await runBounded(items, 2, async (item, index) => {
      calls.push([item, index]);
    });
    expect(calls).toHaveLength(5);
    // Every (item, index) pair should match the original array position.
    for (const [item, index] of calls) {
      expect(items[index]).toBe(item);
    }
    expect(calls.map(([item]) => item).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('limit < items.length: concurrency is actually capped (never more than `limit` in flight at once)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await runBounded(items, 3, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield to the microtask queue so other workers get a chance to start concurrently.
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(0);
  });

  it('a throwing fn rejects the overall call (Promise.all semantics)', async () => {
    await expect(
      runBounded([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
