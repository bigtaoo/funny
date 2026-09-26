// worldsvc/src/metrics.ts — the two-reader contract (worldsvc-concurrency-2026-09-05).
//
// The module exists for one reason: the heartbeat DRAINS these numbers while the ops endpoint PEEKS at
// them. Get that backwards and the failure is silent and awful to diagnose — every heartbeat reports an
// empty table because something polled `/admin/world/metrics` a moment earlier, or the endpoint reports
// stale windows forever. So the asymmetry is pinned here rather than left to the comment.
import { describe, it, expect, afterEach } from 'vitest';
import { createLogger } from '@nw/shared';
import { INSTANCE_ID, initialSeq } from '../src/instance';
import { routeTimings, startWorldMetrics, stopWorldMetrics, worldMetricsSnapshot, countMongoCommands, worldCounters } from '../src/metrics';

const log = createLogger('worldsvc-metrics-test');

afterEach(() => {
  stopWorldMetrics();
  routeTimings.drain(); // leave no samples behind for the next test
});

describe('worldMetricsSnapshot', () => {
  it('reports label timings without consuming them, so the heartbeat still sees its own window', () => {
    startWorldMetrics(log, 'worker');
    routeTimings.record('POST /world/march', 12);
    routeTimings.record('POST /world/march', 34);

    const first = worldMetricsSnapshot();
    expect(first.labels['POST /world/march']!.count).toBe(2);
    // Peeking twice must not empty it — this is the whole point of the split.
    expect(worldMetricsSnapshot().labels['POST /world/march']!.count).toBe(2);
    // ...and the heartbeat's drain still gets the samples afterwards.
    expect(routeTimings.drain()['POST /world/march']!.count).toBe(2);
    // Now they are consumed, and the endpoint reflects that rather than replaying stale numbers.
    expect(worldMetricsSnapshot().labels['POST /world/march']).toBeUndefined();
  });

  it('names the compute backend the bootstrap registered', () => {
    startWorldMetrics(log, 'worker');
    expect(worldMetricsSnapshot().compute).toBe('worker');
  });

  it('reports an unset backend rather than constructing one just to be asked', () => {
    // Reading metrics must have no side effects: resolving the name via getComputeBackend() would spawn
    // the worker pool, so an ops poll (or this test) would create threads merely by looking.
    expect(worldMetricsSnapshot().compute).toBe('unset');
  });

  it('names the process it came from, so snapshots from two instances are never mixed up', () => {
    expect(worldMetricsSnapshot().instance).toBe(INSTANCE_ID);
    expect(INSTANCE_ID).toMatch(/^.+:\d+:[0-9a-f]{6}$/);
  });

  it('still answers before the monitor is started, with a zeroed lag block', () => {
    const snap = worldMetricsSnapshot();
    expect(snap.loopLagMs).toEqual({ p50: 0, p90: 0, p99: 0, max: 0 });
    expect(snap.uptimeSec).toBeGreaterThanOrEqual(0);
    expect(snap.rssMb).toBeGreaterThan(0);
  });

  it('carries real loop-lag numbers once the monitor is running', () => {
    startWorldMetrics(log, 'worker');
    const snap = worldMetricsSnapshot();
    for (const k of ['p50', 'p90', 'p99', 'max'] as const) {
      expect(Number.isFinite(snap.loopLagMs[k])).toBe(true);
    }
  });
});

describe('startWorldMetrics', () => {
  it('is idempotent — a second call returns the running monitor rather than a second gauge', () => {
    const first = startWorldMetrics(log, 'worker');
    expect(startWorldMetrics(log)).toBe(first);
  });

  it('keeps the previously registered compute name when called again without one', () => {
    startWorldMetrics(log, 'worker');
    startWorldMetrics(log);
    expect(worldMetricsSnapshot().compute).toBe('worker');
  });
});

describe('countMongoCommands (ADR-092 / audit §12.7 phase 0)', () => {
  it('counts every commandStarted event in total and per command name', () => {
    const listeners: ((e: { commandName: string }) => void)[] = [];
    countMongoCommands({ on: (_event, fn) => listeners.push(fn) });
    for (const commandName of ['find', 'find', 'update', 'getMore']) listeners.forEach((fn) => fn({ commandName }));

    const c = worldCounters();
    expect(c['mongo.ops']).toBe(4);
    expect(c['mongo.op.find']).toBe(2);
    expect(c['mongo.op.update']).toBe(1);
    expect(c['mongo.op.getMore']).toBe(1);
    // Same object the endpoint serves, and reading it does not reset anything (counters are never drained).
    expect(worldMetricsSnapshot().counters['mongo.ops']).toBe(4);
    expect(worldCounters()['mongo.ops']).toBe(4);
  });

  it('subscribes to exactly the commandStarted event', () => {
    const events: string[] = [];
    countMongoCommands({ on: (event) => events.push(event) });
    expect(events).toEqual(['commandStarted']);
  });
});

describe('worldMetricsSnapshot elu', () => {
  it('reports cumulative main-thread active/idle ms that only grow', async () => {
    const a = worldMetricsSnapshot().elu;
    const t0 = Date.now();
    while (Date.now() - t0 < 30) { /* busy: accrues active time */ }
    await new Promise((r) => setTimeout(r, 30));
    const b = worldMetricsSnapshot().elu;
    expect(b.activeMs + b.idleMs).toBeGreaterThan(a.activeMs + a.idleMs);
    expect(b.activeMs).toBeGreaterThanOrEqual(a.activeMs);
  });
});

describe('initialSeq', () => {
  it('starts id counters at a random non-negative integer, well inside the safe-integer range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const n = initialSeq();
      expect(Number.isSafeInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(2 ** 40);
      seen.add(n);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

