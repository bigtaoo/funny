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

interface TaskSpec {
  label: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

/** Process due marches + completed training/builds + (optionally) due season settlement, each on its own timer. */
export function startScheduler(svc: WorldService, opts: SchedulerOptions = {}): Scheduler {
  const { tickMs = 2000, autoSettleSeasons = false, timings } = opts;

  const tasks: TaskSpec[] = [
    { label: 'sched:arrivals', intervalMs: tickMs, run: () => svc.processDueArrivals() },
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
