// auctionsvc AuctionService split — account-deletion purge (POST /internal/accounts/:accountId/purge).
//
// metaserver soft-deletes an account and, after the grace period, asks every service to drop that
// account's data. The auction house is the one service where "just delete by accountId" is wrong: its
// documents are TRADES, and a trade has a counterparty. A bidder whose coins are escrowed on the deleted
// seller's listing, or a seller still owed proceeds from the deleted buyer's purchase, must end up exactly
// as whole as if the account had never been deleted. So the purge is split in two:
//
//   1. Safe cleanup that cannot interfere with anyone else — closing the deleted seller's own no-bid
//      listings — runs unconditionally.
//   2. Everything that would destroy a counterparty's record waits until no trade involving the account is
//      still in flight. Until then the endpoint answers `done:false` with what it is waiting for, and the
//      metaserver job calls again later. Nothing here force-settles anything: the normal scheduler (expiry
//      settlement + journal sweep) is the one implementation of the settlement rules, and a second one
//      written just for deletion is the "one formula, two languages" trap journal.ts warns about.
//
// Every write is idempotent (rev-guarded close, deleteMany by owner), so a re-run after a partial failure
// simply redoes whatever is left.
import type { Filter } from 'mongodb';
import type { AuctionDoc, AuctionOrderDoc } from '../db';
import type { AuctionServiceDeps } from './base';

/** Why an account's purge cannot finish yet — each count is a set of trades still waiting on the normal settlement path. */
export interface AuctionPurgePending {
  /** Open listings by this seller that carry a bid: the bidder's coins are escrowed, so the listing must settle at expiry. */
  sellerListingsWithBids: number;
  /** Open no-bid listings by this seller that could not be closed yet (an in-flight journal row, or a lost rev race). */
  sellerListingsInFlight: number;
  /** Open listings where this account is the current top bidder: its escrowed coins decide the outcome at expiry. */
  leadingBids: number;
  /** Journal rows still `pending` that move this account's assets or owe it something. */
  pendingSettlements: number;
  /** Closed listings involving this account whose hand-over has not completed (`settledAt` absent). */
  unsettledListings: number;
}

export interface AuctionPurgeResult {
  done: boolean;
  removed: {
    /** This seller's open no-bid listings closed without returning the escrowed item. */
    cancelledListings: number;
    auctionDaily: number;
    auctionBids: number;
    /** This seller's closed + settled listings deleted. */
    closedListings: number;
  };
  pending?: AuctionPurgePending;
}

export class AuctionServiceAccountPurge {
  constructor(private readonly deps: AuctionServiceDeps) {}

  async purgeAccount(accountId: string): Promise<AuctionPurgeResult> {
    const { cols } = this.deps;
    const removed = { cancelledListings: 0, auctionDaily: 0, auctionBids: 0, closedListings: 0 };

    // Journal rows are terminal at `done` / `aborted` (journal.ts `finish`); `pending` is an unpaid debt.
    // Match every place a row can name an account: the actor, any forward step's recipient/payer, any
    // compensation step's recipient, and the buyer an `unclaim` would release — the same net
    // journalAudit.ts casts, plus `buyerId`, because a purge that misses one owed refund loses real coins.
    const pendingRowFilter: Filter<AuctionOrderDoc> = {
      status: 'pending',
      $or: [
        { actorId: accountId },
        { 'steps.accountId': accountId },
        { 'steps.buyerId': accountId },
        { 'compensation.accountId': accountId },
        { 'compensation.buyerId': accountId },
      ],
    };
    const pendingRows = await cols.auctionOrders.find(pendingRowFilter, { projection: { auctionId: 1 } }).toArray();
    const inFlightAuctionIds = new Set(pendingRows.map((r) => r.auctionId));

    // ── 1. Close this seller's open listings that nobody has bid on ──
    //
    // The escrowed item is deliberately NOT returned: the seller account is being deleted, so a return mail
    // would only deliver the item into an inventory that is about to be purged (or, if meta has already
    // gone, fail and sit in the journal as a debt nobody can ever collect). No counterparty holds anything
    // on a no-bid listing, so closing it moves nobody else's assets.
    //
    // `settledAt` is stamped in the same write: its absence on a closed listing is exactly what the journal
    // sweep's repair pass treats as "a hand-over is owed", and without it the sweep would rebuild a return
    // plan and mail the item back anyway. rev-guarded like cancelAuction (trade.ts), so a bid or a buy that
    // lands between the read and the write fails this close instead of being orphaned; that listing is then
    // picked up by the pending checks below (bid) or by its buy journal row, and a later re-run retries.
    //
    // Listings with an in-flight journal row are skipped: a `list` row still pending means the create flow
    // has not finished (its rollback may still hand the item back), and a pending `buy` row is a fixed-price
    // sale mid-claim. Both resolve through the sweep and are reported as pending.
    const now = this.deps.now();
    const openNoBid = await cols.auctions
      .find({ sellerId: accountId, status: 'open', topBid: { $exists: false } })
      .toArray();
    for (const doc of openNoBid) {
      if (inFlightAuctionIds.has(doc._id)) continue;
      const res = await cols.auctions.updateOne(
        { _id: doc._id, status: 'open', rev: doc.rev },
        { $set: { status: 'cancelled', closedAt: now, settledAt: now }, $inc: { rev: 1 } },
      );
      removed.cancelledListings += res.modifiedCount;
    }

    // ── 2. Anything still in flight? ──
    const involved: Filter<AuctionDoc> = {
      $or: [{ sellerId: accountId }, { buyerId: accountId }, { 'topBid.bidderId': accountId }],
    };
    const [sellerListingsWithBids, sellerListingsInFlight, leadingBids, pendingSettlements, unsettledListings] = await Promise.all([
      cols.auctions.countDocuments({ sellerId: accountId, status: 'open', topBid: { $exists: true } }),
      // No-bid listings step 1 could not close: an in-flight journal row, or a rev race it lost.
      cols.auctions.countDocuments({ sellerId: accountId, status: 'open', topBid: { $exists: false } }),
      cols.auctions.countDocuments({ status: 'open', 'topBid.bidderId': accountId }),
      cols.auctionOrders.countDocuments(pendingRowFilter),
      cols.auctions.countDocuments({ ...involved, status: { $ne: 'open' }, settledAt: { $exists: false } }),
    ]);
    const pending: AuctionPurgePending = {
      sellerListingsWithBids, sellerListingsInFlight, leadingBids, pendingSettlements, unsettledListings,
    };
    if (Object.values(pending).some((n) => n > 0)) {
      return { done: false, removed, pending };
    }

    // ── 3. Nothing owed to or by this account any more: drop what is only its own ──
    //
    // Listings where this account was only the buyer / designated buyer are the SELLER's trade history and
    // are left alone (they age out through purgeClosedListings; an open designated listing expires back to
    // its seller normally). Terminal `auctionOrders` rows are left to their `purgeAt` TTL: they are the
    // settlement audit trail ops uses to answer "where did this orderId go", and they hold ids and item
    // snapshots, not personal data.
    const [daily, bids, closed] = await Promise.all([
      cols.auctionDaily.deleteMany({ accountId }),
      cols.auctionBids.deleteMany({ bidderId: accountId }),
      cols.auctions.deleteMany({ sellerId: accountId, status: { $ne: 'open' }, settledAt: { $exists: true } }),
    ]);
    removed.auctionDaily = daily.deletedCount;
    removed.auctionBids = bids.deletedCount;
    removed.closedListings = closed.deletedCount;
    return { done: true, removed };
  }
}
