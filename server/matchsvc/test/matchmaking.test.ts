// Ranked matchmaking queue unit tests (S1-R, after move to gateway/matchsvc): immediate match within window,
// widening wait beyond window, dequeue, duplicate enqueue override. Injects now() + autoTick:false for manual tick, no real timers.
import { describe, it, expect } from 'vitest';
import { Matchmaking } from '../src/Matchmaking';

describe('Matchmaking', () => {
  it('rating diff within window → immediate match', () => {
    const pairs: [string, string][] = [];
    const mm = new Matchmaking((a, b) => pairs.push([a.accountId, b.accountId]), {
      autoTick: false,
      now: () => 0,
    });
    mm.enqueue('a', 'a', '', 1000);
    mm.enqueue('b', 'b', '', 1050); // diff 50 ≤ baseWindow 100
    expect(pairs).toEqual([['a', 'b']]);
    expect(mm.size).toBe(0);
  });

  it('rating diff exceeds window → no match yet, matches after window widens', () => {
    const pairs: [string, string][] = [];
    let t = 0;
    const mm = new Matchmaking((a, b) => pairs.push([a.accountId, b.accountId]), {
      autoTick: false,
      now: () => t,
      baseWindow: 100,
      widenPerSec: 50,
    });
    mm.enqueue('a', 'a', '', 1000);
    mm.enqueue('b', 'b', '', 1300); // diff 300 > 100
    expect(pairs).toHaveLength(0);
    t = 5000; // window 100 + 5×50 = 350 ≥ 300
    mm.tick();
    expect(pairs).toEqual([['a', 'b']]);
  });

  it('remove dequeues', () => {
    const mm = new Matchmaking(() => {}, { autoTick: false, now: () => 0 });
    mm.enqueue('a', 'a', '', 1000);
    expect(mm.has('a')).toBe(true);
    mm.remove('a');
    expect(mm.has('a')).toBe(false);
  });

  it('duplicate enqueue for same account overwrites, does not self-match', () => {
    const pairs: unknown[] = [];
    const mm = new Matchmaking((a, b) => pairs.push([a, b]), { autoTick: false, now: () => 0 });
    mm.enqueue('a', 'a', '', 1000);
    mm.enqueue('a', 'a', '', 1200);
    expect(mm.size).toBe(1);
    expect(pairs).toHaveLength(0);
  });

  it('three players → closest rating pair matches first, remaining player stays in queue', () => {
    const pairs: [string, string][] = [];
    const mm = new Matchmaking((a, b) => pairs.push([a.accountId, b.accountId]), {
      autoTick: false,
      now: () => 0,
    });
    mm.enqueue('a', 'a', '', 1000);
    mm.enqueue('b', 'b', '', 1500);
    mm.enqueue('c', 'c', '', 1050);
    expect(pairs).toEqual([['a', 'c']]);
    expect(mm.has('b')).toBe(true);
  });

  describe('bot-fallback timeout', () => {
    it('solo player waits past threshold → triggers onTimeout; if still in queue, re-evaluated every botFallbackMs (not fire-once)', () => {
      const timeouts: string[] = [];
      let t = 0;
      // onTimeout does not dequeue (simulates flag-off "keep waiting") → entry stays in queue and should be re-evaluated periodically.
      const mm = new Matchmaking(() => {}, {
        autoTick: false,
        now: () => t,
        botFallbackMs: 30_000,
        onTimeout: (e) => timeouts.push(e.accountId),
      });
      mm.enqueue('a', 'a', '', 1000, '', 'web');
      mm.tick();
      expect(timeouts).toEqual([]); // threshold not yet reached
      t = 30_000;
      mm.tick();
      expect(timeouts).toEqual(['a']); // first timeout
      // throttle: next botFallbackMs window not yet elapsed, no repeat trigger
      t = 45_000;
      mm.tick();
      expect(timeouts).toEqual(['a']);
      // full window elapsed → re-evaluate and trigger again (ensures late flag enable covers entries already in queue)
      t = 60_000;
      mm.tick();
      expect(timeouts).toEqual(['a', 'a']);
    });

    it('botFallbackMs=0 disabled → never triggers', () => {
      const timeouts: string[] = [];
      let t = 0;
      const mm = new Matchmaking(() => {}, {
        autoTick: false,
        now: () => t,
        onTimeout: (e) => timeouts.push(e.accountId),
      });
      mm.enqueue('a', 'a', '', 1000);
      t = 10 * 60_000;
      mm.tick();
      expect(timeouts).toEqual([]);
    });

    it('platform is carried into onTimeout with the entry', () => {
      const seen: string[] = [];
      let t = 0;
      const mm = new Matchmaking(() => {}, {
        autoTick: false,
        now: () => t,
        botFallbackMs: 1000,
        onTimeout: (e) => seen.push(e.platform),
      });
      mm.enqueue('a', 'a', '', 1000, '', 'wechat');
      t = 1000;
      mm.tick();
      expect(seen).toEqual(['wechat']);
    });
  });
});
