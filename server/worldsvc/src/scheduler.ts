// worldsvc scheduler loop (S8-2 march + training; auction expiry moved to auctionsvc, §9 task 6).
// March: periodically calls WorldService.processDueArrivals to settle all arrivals (capture / reinforce / retreat).
// Training: periodically calls WorldService.processCompletedTraining to convert completed batches into troop strength (S8-2).
// Builds: periodically calls WorldService.processCompletedBuilds to apply completed home-city building upgrades (SLG_CITY_DESIGN P1).
// Season (§17.14): when autoSettleSeasons is on, calls WorldService.processDueSeasonSettlement to auto-settle active worlds
//   whose season clock (WorldDoc.settleAt) has elapsed. Reset/close stay admin-driven.
// Mongo index scans are authoritative (correct even without Redis); timers use unref() to avoid blocking
// process exit, and each task has its own re-entrancy guard.
//
// 2026-09-05 (worldsvc-concurrency, phase 3): the five tasks used to share ONE setInterval and ONE `running`
// flag, with a `Promise.allSettled` inside it. That made them a convoy: whichever task was slowest set the
// cadence for all of them, and a single slow tick delayed arrivals, training, builds, siege damage and
// occupations alike — for as long as it took, silently, with no signal that anything was behind. They are
// independent (different collections, different due-time indexes), so they now run on independent timers with
// independent guards, and each one is timed. A task that overruns its own interval logs a warning naming
// itself, so "the scheduler is behind" becomes a specific, attributable statement instead of a hunch.
import type { RouteTimings } from '@nw/shared';
import type { WorldService } from './service';

export interface Scheduler {
  stop(): void;
}

export interface SchedulerOptions {
  tickMs?: number;
  /**
   * Interval for the settling half of the arrival tick. Defaults to a quarter of `tickMs`, floored at
   * MIN_SETTLE_TICK_MS and never slower than `tickMs` itself. Exposed mainly so tests can pin the cadence.
   */
  settleTickMs?: number;
  /** Auto-run season settlement when a world's clock elapses (§17.14). Default false — caller (index.ts) passes env.autoSettleSeasons. */
  autoSettleSeasons?: boolean;
  /**
   * Where per-task durations are recorded (phase 0). Shared with the HTTP layer so the heartbeat reports one
   * table covering request handling and background settlement alike — the two compete for the same thread,
   * so reading them apart is how you end up blaming the wrong one.
   */
  timings?: RouteTimings;
}

/**
 * Season settlement scans a `status`+`settleAt` index that is empty except in the minutes around a season
 * roll, so polling it as often as arrivals is pure waste. 30s is far finer than the granularity anyone
 * perceives in a season ending.
 */
const SEASON_TICK_MS = 30_000;

/**
 * How often the settling half of the arrival tick runs, as a fraction of the base tick
 * (WORLDSVC_CONCURRENCY_AUDIT §6.7 item 1). Settlements are the expensive, unbatchable half — a real capture
 * battle plus a metaserver round trip each — and they are bounded by a wall-clock slice inside
 * `processDueArrivalSettlements`. Running them on a quarter of the base interval is what turns that slice
 * into a duty cycle rather than a throughput cut: with the default 150ms slice against a 500ms interval,
 * settlements may hold roughly 30% of the thread under a storm and none of it otherwise, while the walking
 * half — now free of them — keeps its own 2s cadence and its ~2ms cost.
 *
 * Floored at 250ms so a small `tickMs` (tests pass 10ms) cannot turn this into a busy loop.
 */
const SETTLE_TICK_DIVISOR = 4;
const MIN_SETTLE_TICK_MS = 250;

interface TaskSpec {
  label: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

/** Process due marches + completed training/builds + (optionally) due season settlement, each on its own timer. */
export function startScheduler(svc: WorldService, opts: SchedulerOptions = {}): Scheduler {
  const { tickMs = 2000, autoSettleSeasons = false, timings } = opts;

  // Never slower than the base tick (so a test that passes tickMs=10 still gets settlements at 10ms), never
  // busier than MIN_SETTLE_TICK_MS unless the caller asked for a faster base tick than that.
  const settleTickMs = opts.settleTickMs ?? Math.min(tickMs, Math.max(MIN_SETTLE_TICK_MS, Math.floor(tickMs / SETTLE_TICK_DIVISOR)));

  const tasks: TaskSpec[] = [
    // 2026-09-09 (§6.7 item 1): the arrival tick is two tasks, because it was two workloads. Walking is
    // cheap, batched and constant-cost (p50 ~2ms since the 2026-09-05 batching); settling is a real capture
    // battle plus a metaserver round trip each, cannot be batched, and used to hold this same tick for
    // seconds at a time — during which the walking half, every other task and every HTTP request waited on
    // the one thread. Splitting them lets the cheap half keep its cadence while the expensive half runs
    // more often in smaller, time-sliced bites.
    { label: 'sched:arrivals', intervalMs: tickMs, run: () => svc.processDueArrivalSteps() },
    { label: 'sched:arrivalSettle', intervalMs: settleTickMs, run: () => svc.processDueArrivalSettlements() },
    { label: 'sched:training', intervalMs: tickMs, run: () => svc.processCompletedTraining() },
    { label: 'sched:builds', intervalMs: tickMs, run: () => svc.processCompletedBuilds() },
    // ADR-026: settle due delayed building-HP hits (5-min siege-value settlement → HP deduction / capture).
    { label: 'sched:siegeDamage', intervalMs: tickMs, run: () => svc.processDueSiegeDamage() },
    // ADR-037 (§5.4): settle due occupation holds (occupy-march PvE win → 5-min hold → territory ownership).
    { label: 'sched:occupations', intervalMs: tickMs, run: () => svc.processDueOccupations() },
  ];
  // §17.14: auto season settlement (opt-out via NW_SLG_AUTO_SETTLE=0).
  if (autoSettleSeasons) {
    tasks.push({ label: 'sched:season', intervalMs: SEASON_TICK_MS, run: () => svc.processDueSeasonSettlement() });
  }

  const timers = tasks.map((task) => {
    let running = false;
    const timer = setInterval(() => {
      if (running) return; // still working on the previous tick — skip rather than pile up
      running = true;
      const startedAt = performance.now();
      void task
        .run()
        .catch((e) => console.error(`[world-scheduler] ${task.label} failed:`, (e as Error).message))
        .finally(() => {
          const ms = performance.now() - startedAt;
          timings?.record(task.label, ms);
          // Overrunning the interval means this task can no longer keep up with its own due queue, so
          // everything it settles is drifting later and later. Worth a line: it is the first symptom of the
          // load ceiling this workstream exists to raise, and it is otherwise completely silent.
          if (ms > task.intervalMs) {
            console.warn(`[world-scheduler] ${task.label} took ${Math.round(ms)}ms, longer than its ${task.intervalMs}ms interval`);
          }
          running = false;
        });
    }, task.intervalMs);
    timer.unref?.();
    return timer;
  });

  return { stop: () => timers.forEach((t) => clearInterval(t)) };
}
