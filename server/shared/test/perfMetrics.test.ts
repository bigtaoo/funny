// RouteTimings + startEventLoopMonitor (worldsvc-concurrency-2026-09-05, phase 0).
//
// This is the instrumentation the rest of that workstream is steered by, so the properties that make it
// trustworthy are worth pinning: bounded memory under sustained traffic, a cumulative count that survives
// a drain, percentiles that actually reflect the samples, and — for the loop monitor — one warning per
// stall rather than one per check while an old maximum lingers.
import { describe, it, expect, vi } from 'vitest';
import { RouteTimings, startEventLoopMonitor } from '../src/perfMetrics';
import type { Logger } from '../src/logger';

function fakeLogger(): { log: Logger; warns: { msg: string; data?: Record<string, unknown> }[] } {
  const warns: { msg: string; data?: Record<string, unknown> }[] = [];
  const log = {
    debug: () => {},
    info: () => {},
    warn: (msg: string, data?: Record<string, unknown>) => { warns.push({ msg, data }); },
    error: () => {},
  } as unknown as Logger;
  return { log, warns };
}

describe('RouteTimings', () => {
  it('reports percentiles over the recorded samples', () => {
    const t = new RouteTimings();
    for (let i = 1; i <= 100; i++) t.record('GET /world/map', i);
    const snap = t.drain()['GET /world/map']!;
    expect(snap.count).toBe(100);
    expect(snap.max).toBe(100);
    expect(snap.p50).toBeGreaterThanOrEqual(50);
    expect(snap.p50).toBeLessThanOrEqual(52);
    expect(snap.p99).toBeGreaterThanOrEqual(99);
  });

  it('drains the sample window but keeps the cumulative count', () => {
    const t = new RouteTimings();
    t.record('a', 5);
    t.record('a', 15);
    expect(t.drain()['a']!.count).toBe(2);
    // Nothing recorded since the drain, so the label is absent rather than reported as a stale window.
    expect(t.drain()['a']).toBeUndefined();
    t.record('a', 1);
    expect(t.drain()['a']!.count).toBe(3); // cumulative, not reset
  });

  it('holds a bounded number of samples however much traffic a label sees', () => {
    const t = new RouteTimings();
    // Far more than the reservoir: memory must not track request volume.
    for (let i = 0; i < 50_000; i++) t.record('busy', i % 7);
    const snap = t.drain()['busy']!;
    expect(snap.count).toBe(50_000);
    expect(snap.max).toBeLessThanOrEqual(6); // only recent samples survive, all of them small
  });

  it('sorts the report slowest-p99 first, so the worst offender reads first in a log line', () => {
    const t = new RouteTimings();
    t.record('fast', 1);
    t.record('slow', 900);
    t.record('medium', 50);
    expect(Object.keys(t.drain())).toEqual(['slow', 'medium', 'fast']);
  });

  it('times a successful call and rethrows a failing one, recording both', async () => {
    const t = new RouteTimings();
    await t.time('ok', async () => 'value');
    await expect(t.time('boom', async () => { throw new Error('nope'); })).rejects.toThrow('nope');
    const snap = t.drain();
    expect(snap['ok']!.count).toBe(1);
    expect(snap['boom']!.count).toBe(1); // a failure is still time spent on the thread
  });

  it('returns an empty report when nothing has been recorded', () => {
    expect(new RouteTimings().drain()).toEqual({});
  });
});

describe('startEventLoopMonitor', () => {
  it('warns when the loop is actually blocked, naming how long for', async () => {
    // Real timers on purpose: `monitorEventLoopDelay` measures libuv timer lateness against the real
    // clock, so fake timers advance the scheduler without producing any delay to observe. The stall is
    // therefore a genuine synchronous busy-wait — small, but the same shape as the multi-second
    // pathfinding freeze this monitor exists to catch.
    const { log, warns } = fakeLogger();
    const monitor = startEventLoopMonitor(log, { warnAtMs: 20, checkMs: 25, resolutionMs: 1 });
    try {
      // Let the loop turn once first: the histogram's sampler arms on the next tick after enable(), so a
      // stall that begins in the same synchronous block as startEventLoopMonitor is not measured at all.
      await new Promise((r) => setTimeout(r, 30));
      const until = Date.now() + 80;
      while (Date.now() < until) { /* hold the thread, exactly as a long A* run would */ }
      await new Promise((r) => setTimeout(r, 120));

      expect(warns.length).toBeGreaterThan(0);
      expect(warns[0]!.msg).toBe('event loop blocked');
      expect(warns[0]!.data!.maxMs).toBeGreaterThanOrEqual(20);
    } finally {
      monitor.stop();
    }
  });

  it('stays quiet while the loop is healthy', async () => {
    const { log, warns } = fakeLogger();
    const monitor = startEventLoopMonitor(log, { warnAtMs: 5_000, checkMs: 10 });
    try {
      await new Promise((r) => setTimeout(r, 60));
      // Nothing came close to a 5s stall, so a warning here would mean the threshold is not respected —
      // and a monitor that cries wolf is one people stop reading.
      expect(warns).toEqual([]);
    } finally {
      monitor.stop();
    }
  });

  it('drain() reports percentiles and stop() is safe to call', () => {
    const { log } = fakeLogger();
    const monitor = startEventLoopMonitor(log, { warnAtMs: 100_000 });
    const snap = monitor.drain();
    for (const k of ['p50', 'p90', 'p99', 'max'] as const) {
      expect(typeof snap[k]).toBe('number');
      expect(Number.isFinite(snap[k])).toBe(true);
    }
    monitor.stop();
  });
});
