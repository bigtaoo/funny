// worldsvc scheduler loop (S8-2 march + training; auction expiry moved to auctionsvc, §9 task 6).
// March: periodically calls WorldService.processDueArrivals to settle all arrivals (capture / reinforce / retreat).
// Training: periodically calls WorldService.processCompletedTraining to convert completed batches into troop strength (S8-2).
// Builds: periodically calls WorldService.processCompletedBuilds to apply completed home-city building upgrades (SLG_CITY_DESIGN P1).
// Season (§17.14): when autoSettleSeasons is on, calls WorldService.processDueSeasonSettlement to auto-settle active worlds
//   whose season clock (WorldDoc.settleAt) has elapsed. Reset/close stay admin-driven.
// All share a single setInterval (tickMs = 2s); Mongo index scan is authoritative (correct even without Redis).
// timer uses unref() to avoid blocking process exit; running guard prevents re-entrant ticks.
import type { WorldService } from './service';

export interface Scheduler {
  stop(): void;
}

export interface SchedulerOptions {
  tickMs?: number;
  /** Auto-run season settlement when a world's clock elapses (§17.14). Default false — caller (index.ts) passes env.autoSettleSeasons. */
  autoSettleSeasons?: boolean;
}

/** Process due marches + completed training/builds + (optionally) due season settlement once per tickMs (default 2s). */
export function startScheduler(svc: WorldService, opts: SchedulerOptions = {}): Scheduler {
  const { tickMs = 2000, autoSettleSeasons = false } = opts;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    const tasks: Promise<unknown>[] = [
      svc
        .processDueArrivals()
        .catch((e) => console.error('[world-scheduler] processDueArrivals failed:', (e as Error).message)),
      svc
        .processCompletedTraining()
        .catch((e) => console.error('[world-scheduler] processCompletedTraining failed:', (e as Error).message)),
      svc
        .processCompletedBuilds()
        .catch((e) => console.error('[world-scheduler] processCompletedBuilds failed:', (e as Error).message)),
      // ADR-026: settle due delayed building-HP hits (5-min siege-value settlement → HP deduction / capture).
      svc
        .processDueSiegeDamage()
        .catch((e) => console.error('[world-scheduler] processDueSiegeDamage failed:', (e as Error).message)),
      // ADR-037 (§5.4): settle due occupation holds (occupy-march PvE win → 5-min hold → territory ownership).
      svc
        .processDueOccupations()
        .catch((e) => console.error('[world-scheduler] processDueOccupations failed:', (e as Error).message)),
    ];
    // §17.14: auto season settlement (opt-out via NW_SLG_AUTO_SETTLE=0). Only fires for worlds past settleAt (indexed, cheap when none due).
    if (autoSettleSeasons) {
      tasks.push(
        svc
          .processDueSeasonSettlement()
          .catch((e) => console.error('[world-scheduler] processDueSeasonSettlement failed:', (e as Error).message)),
      );
    }
    void Promise.allSettled(tasks).finally(() => {
      running = false;
    });
  }, tickMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
