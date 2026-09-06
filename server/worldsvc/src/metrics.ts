// worldsvc runtime metrics: event-loop health + per-label latency, in one place with two readers.
//
// Phase 0 of worldsvc-concurrency-2026-09-05 put these behind the heartbeat log, which is the right
// default (Grafana sees them without anyone watching). It is not enough for the load test, though: a
// 200-bot run needs to assert on what happened INSIDE worldsvc — "did the event loop ever stall" is the
// property the whole workstream is about, and it is invisible from the client side, where a stall just
// looks like every request being slow at once. So the same numbers are also served over the internal ops
// port (`GET /admin/world/metrics`).
//
// The two readers must not fight: the heartbeat DRAINS (each report covers the interval since the last
// one), while the endpoint PEEKS (it can be polled at any cadence, by anything, without silently emptying
// the next heartbeat). That asymmetry is the reason this module exists rather than the singletons living
// wherever they happened to be constructed.
import { RouteTimings, startEventLoopMonitor, type Logger, type EventLoopMonitor, type LatencySnapshot, type LoopLagSnapshot } from '@nw/shared';

/**
 * Per-label latency for everything that competes for the one thread: HTTP routes (`GET /world/map`),
 * scheduler tasks (`sched:arrivals`), and anything else worth attributing a stall to.
 *
 * Labels are supplied by call sites, never derived from client input, so this map cannot be grown by a
 * hostile caller varying URLs.
 */
export const routeTimings = new RouteTimings();

let loopMonitor: EventLoopMonitor | null = null;
/**
 * Name of the compute backend in use, recorded by the bootstrap rather than looked up on read: asking
 * `getComputeBackend()` for it would CONSTRUCT the worker pool, and a metrics read must never have that
 * side effect (a test or an ops poll would spawn threads just by looking).
 */
let computeName = 'unset';

/**
 * Free-running counters, for facts that are not durations. Added 2026-09-05 with the `sched:arrivals` deep
 * batching: from the outside a tick that batches 600 marches and a tick that quietly demotes all 600 to the
 * per-march path look the same except for being slow, and "slow" is exactly what everything else looks like
 * too. `arrivals.batched` / `arrivals.serial` make the split a number the load test (and ops) can read.
 *
 * Cumulative and peeked, never drained — the heartbeat's drain-vs-peek asymmetry above applies to windowed
 * latency, whereas a counter that resets on read cannot be polled by two readers at all.
 */
const counters = new Map<string, number>();

/** Add to a counter (labels come from call sites, never from client input — same rule as routeTimings). */
export function bumpCounter(label: string, n = 1): void {
  counters.set(label, (counters.get(label) ?? 0) + n);
}

export interface WorldMetrics {
  /** Milliseconds the event loop ran late. The headline number: a stall here IS the failure mode. */
  loopLagMs: LoopLagSnapshot;
  /** Per-route / per-task latency, slowest p99 first. */
  labels: Record<string, LatencySnapshot>;
  /** Cumulative counters since process start (see `bumpCounter`). */
  counters: Record<string, number>;
  /** Which compute backend is serving pathfinding and siege battles (`worker` / `remote`). */
  compute: string;
  uptimeSec: number;
  rssMb: number;
}

/** Start the event-loop gauge. Idempotent — a second call returns the running monitor. */
export function startWorldMetrics(log: Logger, compute?: string): EventLoopMonitor {
  if (compute) computeName = compute;
  loopMonitor ??= startEventLoopMonitor(log);
  return loopMonitor;
}

/** Non-destructive read for the ops endpoint. Safe to poll; never disturbs the heartbeat's own window. */
export function worldMetricsSnapshot(): WorldMetrics {
  return {
    loopLagMs: loopMonitor?.snapshot() ?? { p50: 0, p90: 0, p99: 0, max: 0 },
    labels: routeTimings.snapshot(),
    counters: Object.fromEntries(counters),
    compute: computeName,
    uptimeSec: Math.round(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / 1048576),
  };
}

/** Stop the gauge (shutdown / tests). */
export function stopWorldMetrics(): void {
  loopMonitor?.stop();
  loopMonitor = null;
  computeName = 'unset';
  counters.clear();
}
