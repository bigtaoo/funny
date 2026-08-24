// auctionsvc scheduler loop (auction task 4): periodically settles expired listings.
// Migrated from server/worldsvc/src/scheduler.ts, auction-only (no march/training/build ticks here).
import type { AuctionService } from './auctionService';

export interface Scheduler {
  stop(): void;
}

/** How often to purge closed-listing history (sold/cancelled/expired past the retention window). Coarse — data isn't time-critical. */
const PURGE_TICK_MS = 60 * 60 * 1000; // 1h

/**
 * How often to sweep the settlement journal (U13 close-out): resume flows whose request path died, and
 * repair listings that closed without handing anything over. Faster than the purge tick because these are
 * unpaid debts — a player waiting on an item or their coins — but far slower than the expiry tick, since
 * the journal's own per-row backoff (2s doubling to 5min) already decides when each row is actually due.
 */
const SWEEP_TICK_MS = 10 * 1000; // 10s

/** Process expired auctions once per tickMs (default 2s); sweep the settlement journal per SWEEP_TICK_MS; purge closed-listing history once per PURGE_TICK_MS. */
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

  let sweeping = false;
  const sweepTimer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void auctionSvc
      .sweepSettlements()
      .then(({ resumed, repaired }) => {
        if (resumed > 0 || repaired > 0) {
          console.log(`[auction-scheduler] settlement sweep: resumed ${resumed}, repaired ${repaired}`);
        }
      })
      .catch((e) => console.error('[auction-scheduler] sweepSettlements failed:', (e as Error).message))
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_TICK_MS);
  sweepTimer.unref?.();

  let purging = false;
  const purgeTimer = setInterval(() => {
    if (purging) return;
    purging = true;
    void auctionSvc
      .purgeClosedListings()
      .then((n) => { if (n > 0) console.log(`[auction-scheduler] purged ${n} closed listing(s) past retention`); })
      .catch((e) => console.error('[auction-scheduler] purgeClosedListings failed:', (e as Error).message))
      .finally(() => {
        purging = false;
      });
  }, PURGE_TICK_MS);
  purgeTimer.unref?.();

  return { stop: () => { clearInterval(timer); clearInterval(sweepTimer); clearInterval(purgeTimer); } };
}
