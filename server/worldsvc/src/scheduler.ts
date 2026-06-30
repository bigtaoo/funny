// worldsvc scheduler loop (S8-2 march + training + S8-5 auction expiry).
// March: periodically calls WorldService.processDueArrivals to settle all arrivals (capture / reinforce / retreat).
// Training: periodically calls WorldService.processCompletedTraining to convert completed batches into troop strength (S8-2).
// Auction: periodically calls AuctionService.processExpiredAuctions to handle expired listings (returns the seller's lot).
// All three share a single setInterval (tickMs = 2s); Mongo index scan is authoritative (correct even without Redis).
// timer uses unref() to avoid blocking process exit; running guard prevents re-entrant ticks.
import type { WorldService } from './service';
import type { AuctionService } from './auctionService';

export interface Scheduler {
  stop(): void;
}

/** Process due marches + completed training + expired auctions once per tickMs (default 2s). */
export function startScheduler(svc: WorldService, auctionSvc?: AuctionService, tickMs = 2000): Scheduler {
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
    ];
    if (auctionSvc) {
      tasks.push(
        auctionSvc
          .processExpiredAuctions()
          .catch((e) => console.error('[world-scheduler] processExpiredAuctions failed:', (e as Error).message)),
      );
    }
    void Promise.allSettled(tasks).finally(() => {
      running = false;
    });
  }, tickMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
