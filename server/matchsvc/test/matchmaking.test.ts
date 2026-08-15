// Ranked matchmaking queue unit tests (S1-R, after move to gateway/matchsvc): immediate match within window,
// widening wait beyond window, dequeue, duplicate enqueue override. Injects now() + autoTick:false for manual tick, no real timers.
// enqueue/remove/tick are async (audit-followup-fixes-0730: the pairing path awaits onDequeued before firing
// onPair, so a matchsvc crash right after a match_found push never finds a stale Redis queue mirror) — every
// call here is awaited so assertions run after the pairing pass (and its onPair/onTimeout callbacks) actually complete.
import { describe, it, expect } from 'vitest';
import { Matchmaking } from '../src/Matchmaking';

describe('Matchmaking', () => {
  it('rating diff within window → immediate match', async () => {
    const pairs: [string, string][] = [];
    const mm = new Matchmaking((a, b) => pairs.push([a.accountId, b.accountId]), {
      autoTick: false,
      now: () => 0,
    });
    await mm.enqueue('a', 'a', '', 1000);
    await mm.enqueue('b', 'b', '', 1050); // diff 50 ≤ baseWindow 100
    expect(pairs).toEqual([['a', 'b']]);
    expect(mm.size).toBe(0);
  });

  it('rating diff exceeds window → no match yet, matches after window widens', async () => {
    const pairs: [string, string][] = [];
    let t = 0;
    const mm = new Matchmaking((a, b) => pairs.push([a.accountId, b.accountId]), {
      autoTick: false,
      now: () => t,
      baseWindow: 100,
      widenPerSec: 50,
    });
    await mm.enqueue('a', 'a', '', 1000);
    await mm.enqueue('b', 'b', '', 1300); // diff 300 > 100
    expect(pairs).toHaveLength(0);
    t = 5000; // window 100 + 5×50 = 350 ≥ 300
    await mm.tick();
    expect(pairs).toEqual([['a', 'b']]);
  });

  it('remove dequeues', async () => {
    const mm = new Matchmaking(() => {}, { autoTick: false, now: () => 0 });
    await mm.enqueue('a', 'a', '', 1000);
    expect(mm.has('a')).toBe(true);
    await mm.remove('a');
    expect(mm.has('a')).toBe(false);
  });

  it('duplicate enqueue for same account overwrites, does not self-match', async () => {
    const pairs: unknown[] = [];
    const mm = new Matchmaking((a, b) => pairs.push([a, b]), { autoTick: false, now: () => 0 });
    await mm.enqueue('a', 'a', '', 1000);
    await mm.enqueue('a', 'a', '', 1200);
    expect(mm.size).toBe(1);
    expect(pairs).toHaveLength(0);
  });

  it('three players → closest rating pair matches first, remaining player stays in queue', async () => {
    const pairs: [string, string][] = [];
    const mm = new Matchmaking((a, b) => pairs.push([a.accountId, b.accountId]), {
      autoTick: false,
      now: () => 0,
    });
    await mm.enqueue('a', 'a', '', 1000);
    await mm.enqueue('b', 'b', '', 1500);
    await mm.enqueue('c', 'c', '', 1050);
    expect(pairs).toEqual([['a', 'c']]);
    expect(mm.has('b')).toBe(true);
  });

  describe('crash-safety ordering (audit-followup-fixes-0730)', () => {
    it('onPair never fires until onDequeued has actually resolved for both paired accounts', async () => {
      const pairs: [string, string][] = [];
      const dequeued: string[] = [];
      let release: () => void;
      // Simulates a Redis delete that hasn't landed yet (network latency, or matchsvc about to crash
      // before it completes) — onDequeued for BOTH paired accounts is gated behind this one promise.
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const mm = new Matchmaking((a, b) => pairs.push([a.accountId, b.accountId]), {
        autoTick: false,
        now: () => 0,
        onDequeued: async (accountId) => {
          await gate;
          dequeued.push(accountId);
        },
      });
      await mm.enqueue('a', 'a', '', 1000);
      const pairing = mm.enqueue('b', 'b', '', 1050); // diff 50 ≤ baseWindow 100 → pairs this tick

      // Let as many microtasks run as will without ever resolving the gate.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // The pairing pass is stuck awaiting the (still-pending) Redis dequeue for both accounts — onPair
      // must not have fired. A crash right now would find both accounts still in Redis's queue mirror,
      // which correctly reflects reality: neither was ever told they matched.
      expect(dequeued).toEqual([]);
      expect(pairs).toEqual([]);

      release!();
      await pairing;
      // Only once the Redis-side dequeue actually resolves does the pairing (and its match_found push,
      // in the real Matchsvc) fire.
      expect(dequeued.sort()).toEqual(['a', 'b']);
      expect(pairs).toEqual([['a', 'b']]);
    });
  });

  describe('bot-fallback timeout', () => {
    it('solo player waits past threshold → triggers onTimeout; if still in queue, re-evaluated every botFallbackMs (not fire-once)', async () => {
      const timeouts: string[] = [];
      let t = 0;
      // onTimeout does not dequeue (simulates flag-off "keep waiting") → entry stays in queue and should be re-evaluated periodically.
      const mm = new Matchmaking(() => {}, {
        autoTick: false,
        now: () => t,
        botFallbackMs: 30_000,
        onTimeout: (e) => timeouts.push(e.accountId),
      });
      await mm.enqueue('a', 'a', '', 1000, '', '', 'web');
      await mm.tick();
      expect(timeouts).toEqual([]); // threshold not yet reached
      t = 30_000;
      await mm.tick();
      expect(timeouts).toEqual(['a']); // first timeout
      // throttle: next botFallbackMs window not yet elapsed, no repeat trigger
      t = 45_000;
      await mm.tick();
      expect(timeouts).toEqual(['a']);
      // full window elapsed → re-evaluate and trigger again (ensures late flag enable covers entries already in queue)
      t = 60_000;
      await mm.tick();
      expect(timeouts).toEqual(['a', 'a']);
    });

    it('botFallbackMs=0 disabled → never triggers', async () => {
      const timeouts: string[] = [];
      let t = 0;
      const mm = new Matchmaking(() => {}, {
        autoTick: false,
        now: () => t,
        onTimeout: (e) => timeouts.push(e.accountId),
      });
      await mm.enqueue('a', 'a', '', 1000);
      t = 10 * 60_000;
      await mm.tick();
      expect(timeouts).toEqual([]);
    });

    it('platform is carried into onTimeout with the entry', async () => {
      const seen: string[] = [];
      let t = 0;
      const mm = new Matchmaking(() => {}, {
        autoTick: false,
        now: () => t,
        botFallbackMs: 1000,
        onTimeout: (e) => seen.push(e.platform),
      });
      await mm.enqueue('a', 'a', '', 1000, '', '', 'wechat');
      t = 1000;
      await mm.tick();
      expect(seen).toEqual(['wechat']);
    });
  });

  describe('clear()', () => {
    it('empties the queue and stops the scan timer (never exercised by any other test)', async () => {
      const mm = new Matchmaking(() => {}, { now: () => 0 }); // autoTick default true -> a real timer gets armed
      await mm.enqueue('a', 'a', '', 1000); // solo, stays queued, timer stays armed
      expect(mm.size).toBe(1);

      mm.clear();
      expect(mm.size).toBe(0);
      expect(mm.has('a')).toBe(false);

      // Timer was actually stopped, not just the queue array cleared: re-enqueuing still works normally
      // afterward (ensureTimer() can re-arm because clear() nulled it out, not merely emptied the queue).
      await mm.enqueue('b', 'b', '', 1000);
      expect(mm.size).toBe(1);
    });
  });
});
