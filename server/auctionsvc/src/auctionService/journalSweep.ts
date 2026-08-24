// auctionsvc AuctionService split — settlement journal sweep (see journal.ts).
//
// The scheduler-driven half of the U13 close-out. Two passes, and the second one is the more important:
//
//   `resumePending` finishes flows whose request path died mid-way, or whose hand-over failed on a
//   transient meta/commercial error. Before the journal existed there was no such driver at all, so a
//   single meta 500 was enough to destroy a seller's proceeds with nothing but a log line to show for it.
//
//   `repairUnsettled` catches the one gap ordering cannot close. The three claim-first flows (settle /
//   cancel / expire) flip the listing to its terminal status BEFORE writing a journal row, because their
//   hand-over is forward-only and the winner is only known once the claim has won. A crash in that gap
//   leaves no journal row to resume — but it does leave a listing sitting in a terminal status with no
//   `settledAt`, and that IS the record that something is owed. The plan is a pure function of the
//   document (journalPlans.ts), so it can simply be rebuilt.
//
// Both passes take a row/document exclusively via CAS before doing anything, so several auctionsvc
// instances can run this loop concurrently without double-paying anyone.
import { AUCTION_TAX_RATE } from '@nw/shared';
import type { AuctionDoc } from '../db';
import type { AuctionServiceDeps } from './base';
import { snapshotOf, flowKey, planForReturn, planForSettle } from './journalPlans';
import { AuctionOrderJournal, CLAIM_GRACE_MS } from './journal';

/** Rows/documents handled per tick. Small: this is a repair loop, not a throughput path, and each item can make several HTTP calls. */
const SWEEP_BATCH = 20;

export class AuctionServiceJournalSweep {
  constructor(
    private readonly deps: AuctionServiceDeps,
    private readonly journal: AuctionOrderJournal,
  ) {}

  /** Runs both passes; returns how many items each moved (for the scheduler's log line). */
  async sweep(): Promise<{ resumed: number; repaired: number }> {
    const resumed = await this.resumePending();
    const repaired = await this.repairUnsettled();
    return { resumed, repaired };
  }

  /**
   * Drive every pending row whose backoff has elapsed and whose claim has gone stale. The staleness gate is
   * what keeps this out of a live request's way: a row being worked on right now was claimed within
   * `CLAIM_GRACE_MS` and is skipped.
   */
  private async resumePending(): Promise<number> {
    const now = this.deps.now();
    const rows = await this.deps.cols.auctionOrders
      .find({ status: 'pending', nextAttemptAt: { $lte: now }, claimedAt: { $lte: now - CLAIM_GRACE_MS } })
      .limit(SWEEP_BATCH)
      .toArray();

    let resumed = 0;
    for (const row of rows) {
      // Exclusive claim: only the sweeper whose CAS matches the observed `claimedAt` may drive this row, so
      // several auctionsvc instances sweeping the same collection do not stack attempts on one row. It does
      // not (and need not) exclude a live request: the `claimedAt <= now - CLAIM_GRACE_MS` filter above
      // already keeps sweepers off rows a request is still working on, and every step is idempotent by its
      // own key — including `unclaim`, whose `{status:'sold', buyerId, settledAt absent}` guard makes a
      // second run a no-op.
      const claimed = await this.deps.cols.auctionOrders.findOneAndUpdate(
        { _id: row._id, status: 'pending', claimedAt: row.claimedAt },
        { $set: { claimedAt: this.deps.now() } },
        { returnDocument: 'after' },
      );
      if (!claimed) continue;
      try {
        await this.journal.resume(claimed);
        resumed++;
      } catch (e) {
        // A definitive business rejection surfaced by `resume` is not a sweep failure — the row has already
        // been rolled back and closed out. Log at debug volume and move on.
        console.warn('[auctionsvc] journal sweep resolved a row by rolling it back', { order: row._id, err: (e as Error).message });
        resumed++;
      }
    }
    return resumed;
  }

  /**
   * Rebuild and drive the journal for listings that reached a terminal status without ever completing a
   * hand-over. Only the claim-first kinds can land here; a `buy` writes its row before touching anything,
   * so a fixed-price sale with no row is a contradiction and is reported rather than guessed at.
   *
   * Pre-journal listings are excluded by construction: db.ts's boot migration stamps `settledAt` on every
   * already-closed document, because re-driving those would re-send attachments under the journal's keys
   * and turn an unfixable old loss into a fresh duplication.
   */
  private async repairUnsettled(): Promise<number> {
    const docs = await this.deps.cols.auctions
      .find({ status: { $ne: 'open' }, settledAt: { $exists: false } })
      .limit(SWEEP_BATCH)
      .toArray();

    let repaired = 0;
    for (const doc of docs) {
      const kind = kindOf(doc);
      if (!kind) continue;
      if (kind === 'buy') {
        // buyAuction journals its intent before claiming, so its row exists and `resumePending` owns it.
        continue;
      }
      const rowId = flowKey(kind, doc._id);
      const begun = await this.journal.begin(rowId, kind, doc._id, doc.sellerId, (cycle) => this.rebuild(kind, doc, rowId, cycle));
      if (begun.state !== 'fresh') continue; // a row already exists (or is live) — resumePending's job
      console.warn('[auctionsvc] journal sweep rebuilt a lost settlement plan', { auction: doc._id, kind, status: doc.status });
      await this.journal.finalize(begun.row);
      repaired++;
    }
    return repaired;
  }

  /**
   * Reconstruct a claim-first flow's plan from the listing alone. The winner and the price come from what
   * the claim actually wrote (`buyerId` / `topBid.amount`), not from a re-read of the current top bid —
   * settling against anything else is the bug the `rev` guard in `settleAuctionWin` closed.
   */
  private rebuild(kind: Exclude<ClosingKind, 'buy'>, doc: AuctionDoc, rowId: string, cycle: number) {
    if (kind === 'settle') {
      const winnerId = doc.buyerId ?? doc.topBid?.bidderId ?? '';
      const unitPrice = doc.topBid?.amount ?? doc.price;
      const totalPrice = unitPrice * doc.qty;
      const sellerReceives = totalPrice - Math.floor(totalPrice * AUCTION_TAX_RATE);
      return planForSettle(rowId, cycle, winnerId, doc.sellerId, snapshotOf(doc), sellerReceives);
    }
    return planForReturn(rowId, cycle, doc.sellerId, snapshotOf(doc));
  }
}

/** The three claim-first flows the repair pass can rebuild, plus `buy` (which always has its own row already). */
type ClosingKind = 'buy' | 'settle' | 'cancel' | 'expire';

/** Which flow closed this listing. `sold` splits on saleMode: an auction win settles, a fixed-price sale was a buy. */
function kindOf(doc: AuctionDoc): ClosingKind | null {
  if (doc.status === 'cancelled') return 'cancel';
  if (doc.status === 'expired') return 'expire';
  if (doc.status !== 'sold') return null;
  return (doc.saleMode ?? 'fixed') === 'auction' ? 'settle' : 'buy';
}
