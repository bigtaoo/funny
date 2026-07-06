// auctionsvc scheduler loop (auction task 4): periodically settles expired listings.
// Migrated from server/worldsvc/src/scheduler.ts, auction-only (no march/training/build ticks here).
import type { AuctionService } from './auctionService';

export interface Scheduler {
  stop(): void;
}

/** Process expired auctions once per tickMs (default 2s). */
export function startScheduler(auctionSvc: AuctionService, tickMs = 2000): Scheduler {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void auctionSvc
      .processExpiredAuctions()
      .catch((e) => console.error('[auction-scheduler] processExpiredAuctions failed:', (e as Error).message))
      .finally(() => {
        running = false;
      });
  }, tickMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
