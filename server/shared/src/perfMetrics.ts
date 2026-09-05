// Event-loop health + per-route latency instrumentation (worldsvc-concurrency-2026-09-05, phase 0).
//
// Why this exists: the SLG concurrency investigation found that worldsvc's dominant failure mode is not
// lock contention but head-of-line blocking — one synchronous CPU burst (an unreachable-target A* run,
// measured at 2-6 SECONDS) freezes the whole event loop, so every other player's request, every Mongo/
// Redis callback and every scheduler tick queue behind it. That failure is invisible in ordinary logs:
// nothing errors, every individual query looks fast, the process just stops for a while. Without a lag
// gauge every subsequent optimisation in this workstream would be guesswork, so this lands first.
//
// Deliberately dependency-free and allocation-light (see logger.ts for the same reasoning): a metrics
// module that itself costs measurable event-loop time would be self-defeating.
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { Logger } from './logger';

/** Reservoir size for {@link RouteTimings}. Timings are kept unsorted and sorted on read (reads are per-heartbeat, i.e. rare). */
const SAMPLE_CAP = 512;

export interface LatencySnapshot {
  count: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

/**
 * Fixed-memory latency reservoir for one label. Keeps the most recent {@link SAMPLE_CAP} samples in a
 * ring buffer — bounded memory regardless of traffic, and biased toward recent behaviour, which is what
 * a "is the service healthy right now" gauge wants (a lifetime histogram would hide a regression under
 * hours of good samples).
 */
class Reservoir {
  private readonly buf = new Float64Array(SAMPLE_CAP);
  private n = 0;
  private total = 0;

  add(ms: number): void {
    this.buf[this.n % SAMPLE_CAP] = ms;
    this.n++;
    this.total++;
  }

  /** Read the sample window without disturbing it. */
  peek(): LatencySnapshot | null {
    const len = Math.min(this.n, SAMPLE_CAP);
    if (len === 0) return null;
    const s = Array.from(this.buf.subarray(0, len)).sort((a, b) => a - b);
    const at = (q: number): number => Math.round(s[Math.min(len - 1, Math.floor(q * len))]! * 10) / 10;
    return { count: this.total, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: Math.round(s[len - 1]! * 10) / 10 };
  }

  /** Snapshot + reset the sample window (the total count is cumulative and is NOT reset). */
  drain(): LatencySnapshot | null {
    const snap = this.peek();
    this.n = 0;
    return snap;
  }
}

/**
 * Per-label latency tracker (label = route, scheduler task, compute-pool op — anything worth attributing
 * a stall to). Labels are supplied by call sites, never derived from a request path, so a hostile client
 * cannot grow this map by varying URLs.
 */
export class RouteTimings {
  private readonly byLabel = new Map<string, Reservoir>();

  record(label: string, ms: number): void {
    let r = this.byLabel.get(label);
    if (!r) {
      r = new Reservoir();
      this.byLabel.set(label, r);
    }
    r.add(ms);
  }

  /** Time `fn`, record it under `label`, and return its result — errors are timed too, then rethrown. */
  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.record(label, performance.now() - t0);
    }
  }

  /**
   * Every label that saw traffic since the last drain, slowest p99 first, WITHOUT resetting the windows.
   *
   * Exists because two readers now want this table and only one of them may consume it: the heartbeat
   * drains it on its own schedule, while an ops/metrics endpoint must be able to look at any time without
   * silently emptying the next heartbeat's report.
   */
  snapshot(): Record<string, LatencySnapshot> {
    return this.collect((r) => r.peek());
  }

  /** Snapshot every label that saw traffic since the last drain, slowest p99 first; resets the windows. */
  drain(): Record<string, LatencySnapshot> {
    return this.collect((r) => r.drain());
  }

  private collect(read: (r: Reservoir) => LatencySnapshot | null): Record<string, LatencySnapshot> {
    const out: [string, LatencySnapshot][] = [];
    for (const [label, r] of this.byLabel) {
      const snap = read(r);
      if (snap) out.push([label, snap]);
    }
    out.sort((a, b) => b[1].p99 - a[1].p99);
    return Object.fromEntries(out);
  }
}

export interface EventLoopMonitorOptions {
  /**
   * Sampling resolution in ms passed to `monitorEventLoopDelay`. 20ms is fine-grained enough to see a
   * stall build up without the histogram itself becoming a scheduling burden.
   */
  resolutionMs?: number;
  /**
   * Log a warning whenever the loop was blocked for at least this long. Default 250ms: comfortably above
   * ordinary GC / large-JSON pauses, well below the multi-second freezes this workstream is hunting.
   */
  warnAtMs?: number;
  /** How often to check the histogram for a breach. Default 1s. */
  checkMs?: number;
}

export interface LoopLagSnapshot {
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

export interface EventLoopMonitor {
  /** Percentiles since the last {@link drain}, in milliseconds, WITHOUT resetting the histogram. */
  snapshot(): LoopLagSnapshot;
  /** Percentiles since the last drain, in milliseconds; resets the histogram. */
  drain(): LoopLagSnapshot;
  stop(): void;
}

/**
 * Continuous event-loop delay gauge. `monitorEventLoopDelay` measures how late a libuv timer fires versus
 * when it was due — i.e. exactly the "somebody held the thread" quantity, with none of the self-measurement
 * error a `setInterval` + `Date.now()` loop has (that loop cannot report a stall it was itself blocked by
 * until after the fact, and cannot distinguish one 2s stall from eighty 25ms ones).
 *
 * The breach warning is edge-triggered off `max` since the previous check, so one stall produces one log
 * line rather than one per subsequent check.
 *
 * One measurement caveat, found while testing this: the histogram's sampler arms on the loop turn AFTER
 * `enable()`, so a stall inside the same synchronous block that started the monitor is invisible to it.
 * That is fine for the intended use (a long-lived service, monitoring started at boot) but means this
 * cannot be used to measure a specific synchronous span — wrap that in {@link RouteTimings.time} instead.
 */
export function startEventLoopMonitor(log: Logger, opts: EventLoopMonitorOptions = {}): EventLoopMonitor {
  const { resolutionMs = 20, warnAtMs = 250, checkMs = 1000 } = opts;
  const h: IntervalHistogram = monitorEventLoopDelay({ resolution: resolutionMs });
  h.enable();
  // Percentiles come back in nanoseconds.
  const ms = (ns: number): number => Math.round(ns / 1e5) / 10;
  const timer = setInterval(() => {
    const maxMs = ms(h.max);
    if (maxMs >= warnAtMs) {
      log.warn('event loop blocked', { maxMs, p99Ms: ms(h.percentile(99)), meanMs: ms(h.mean) });
      h.reset(); // edge-trigger: one line per stall, not one per check while the old max lingers
    }
  }, checkMs);
  if (typeof timer.unref === 'function') timer.unref();
  const read = (): LoopLagSnapshot => ({ p50: ms(h.percentile(50)), p90: ms(h.percentile(90)), p99: ms(h.percentile(99)), max: ms(h.max) });
  return {
    snapshot: read,
    drain: () => {
      const snap = read();
      h.reset();
      return snap;
    },
    stop: () => {
      clearInterval(timer);
      h.disable();
    },
  };
}
