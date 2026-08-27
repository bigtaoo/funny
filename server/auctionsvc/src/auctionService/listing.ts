// auctionsvc AuctionService split — read-only listing queries (see ../auctionService.ts).
//
// Independent sibling class (2026-08-11 re-audit, converted from a linear inheritance chain to
// composition): zero dependencies on any other layer, only `deps`.
import type { AuctionListingAdminView, AuctionListingQuery } from '@nw/shared';
import type { AuctionServiceDeps } from './base';
import {
  docToAdminView, docToView, bidOutcome, type AuctionBidView, type AuctionView,
  AUCTION_CLOSED_RETENTION_SEC, MY_BIDS_FETCH_LIMIT, MY_LISTINGS_FETCH_LIMIT, QUERY_FETCH_CAP,
} from './base';

export class AuctionServiceListing {
  constructor(private readonly deps: AuctionServiceDeps) {}

  /**
   * Lists open auctions (optionally filtered by itemType), sorted by price ascending, limit ≤50.
   * Designated-buyer listings are hidden from everyone except the seller and the designated buyer
   * (§ requirement 2026-07-18); a listing designated to `accountId` is pinned to the front of the page.
   */
  async listAuctions(itemType?: string, limit = 20, accountId?: string): Promise<AuctionView[]> {
    const query: Record<string, unknown> = {
      status: 'open',
      $or: [
        { designatedBuyerId: { $exists: false } },
        ...(accountId ? [{ designatedBuyerId: accountId }, { sellerId: accountId }] : []),
      ],
    };
    if (itemType) query['itemType'] = itemType;
    const docs = await this.deps.cols.auctions
      .find(query)
      .sort({ price: 1 })
      .limit(Math.min(Math.max(limit, 1), 50))
      .toArray();
    // Pin listings designated to the current account to the front (stable relative order otherwise).
    if (accountId) {
      docs.sort((a, b) => {
        const aPinned = a.designatedBuyerId === accountId ? 0 : 1;
        const bPinned = b.designatedBuyerId === accountId ? 0 : 1;
        return aPinned - bPinned;
      });
    }
    return docs.map(docToView);
  }

  /**
   * Ops lookup (internal, admin.slg.audit.view): query listings across every status (open/sold/cancelled/expired)
   * by sellerId / itemType / status, optionally narrowed by itemName (case-insensitive substring against the
   * derived display name). sellerId/itemType/status filter at the DB level; itemName filters in memory over a
   * capped fetch (QUERY_FETCH_CAP) since the underlying field differs per itemType and isn't directly indexable.
   */
  async queryListings(filter: AuctionListingQuery): Promise<AuctionListingAdminView[]> {
    const query: Record<string, unknown> = {};
    if (filter.sellerId) query['sellerId'] = filter.sellerId;
    if (filter.itemType) query['itemType'] = filter.itemType;
    if (filter.status) query['status'] = filter.status;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
    const fetchLimit = filter.itemName ? QUERY_FETCH_CAP : limit;
    const docs = await this.deps.cols.auctions
      .find(query)
      .sort({ expireAt: -1 })
      .limit(fetchLimit)
      .toArray();
    const views = docs.map(docToAdminView);
    const needle = filter.itemName?.toLowerCase();
    const filtered = needle ? views.filter((v) => v.itemName.toLowerCase().includes(needle)) : views;
    return filtered.slice(0, limit);
  }

  /** My listings (all statuses; open first by expireAt desc, then recent closed history within the retention window). */
  async getMyListings(accountId: string): Promise<AuctionView[]> {
    const docs = await this.deps.cols.auctions
      .find({ sellerId: accountId })
      .sort({ expireAt: -1 })
      .limit(MY_LISTINGS_FETCH_LIMIT)
      .toArray();
    return docs.map(docToView);
  }

  /**
   * My Bids: every listing this account has bid on, live or already settled (2026-08-27).
   *
   * Two reads, not an aggregation `$lookup`: the bid rows live in their own collection precisely so the
   * bidding write path never touches them, and a `$lookup` would put the join on the server side of a
   * cross-collection query for at most MY_BIDS_FETCH_LIMIT ids — a batched `_id: {$in}` is both cheaper
   * and keeps the outcome derivation in one readable place.
   *
   * A bid row whose listing is gone is dropped rather than surfaced as a stub: `purgeClosedListings`
   * removes listings on the same retention window the bid rows' TTL uses, so this only happens in the
   * short overlap where one has already been collected and the other has not.
   *
   * Ordering is live-first (soonest to end first — those are the ones still worth acting on), then closed
   * history newest-first.
   *
   * The FETCH sorts by `purgeAt`, not by my bid time, purely so the MY_BIDS_FETCH_LIMIT cap cannot drop a
   * listing I am still bidding on. `purgeAt` is the listing's own expiry plus a constant, so "purgeAt in
   * the future" is exactly "this listing has not run out yet" — sorting by it desc puts every live row
   * ahead of every closed one, whatever their bid times. Sorting by `ts` looked equivalent and is not: my
   * last bid on a live listing can be arbitrarily old (I bid once at the start; anti-snipe then keeps the
   * listing open while other people fight over it), so an active trader with a page of newer closed rows
   * would have lost the live one — the same "a bid you're losing becomes invisible" failure this endpoint
   * exists to fix. Which CLOSED rows survive the cap therefore ranks by listing expiry rather than by bid
   * time; the two orderings only differ within a single listing's window, and the returned closed group is
   * still sorted by `myBidTs` below.
   */
  async getMyBids(accountId: string): Promise<AuctionBidView[]> {
    const rows = await this.deps.cols.auctionBids
      .find({ bidderId: accountId })
      .sort({ purgeAt: -1 })
      .limit(MY_BIDS_FETCH_LIMIT)
      .toArray();
    if (rows.length === 0) return [];

    const docs = await this.deps.cols.auctions
      .find({ _id: { $in: rows.map((r) => r.auctionId) } })
      .toArray();
    const byId = new Map(docs.map((d) => [d._id, d]));

    const views: AuctionBidView[] = [];
    for (const row of rows) {
      const doc = byId.get(row.auctionId);
      if (!doc) continue; // listing already purged — its bid row is on its way out too
      views.push({
        auction: docToView(doc),
        myBid: row.amount,
        myTotal: row.total,
        myBidCount: row.bids,
        myBidTs: row.ts,
        outcome: bidOutcome(doc, accountId),
      });
    }
    views.sort((a, b) => {
      const aOpen = a.auction.status === 'open' ? 0 : 1;
      const bOpen = b.auction.status === 'open' ? 0 : 1;
      if (aOpen !== bOpen) return aOpen - bOpen;
      return aOpen === 0 ? a.auction.expireAt - b.auction.expireAt : b.myBidTs - a.myBidTs;
    });
    return views;
  }

  /**
   * Purge closed listings (sold/cancelled/expired) older than the retention window from every seller's
   * My-Listings history, so the list can't grow without bound. Open listings are never purged (they still
   * hold escrowed goods / active bids). Anchor is closedAt; legacy closed docs written before closedAt
   * existed fall back to expireAt. Called periodically by the scheduler. Returns the number deleted.
   */
  async purgeClosedListings(retentionSec: number = AUCTION_CLOSED_RETENTION_SEC): Promise<number> {
    const cutoff = this.deps.now() - retentionSec * 1000;
    const res = await this.deps.cols.auctions.deleteMany({
      status: { $ne: 'open' },
      // Never purge a listing whose hand-over is still owed (U13 close-out): a terminal status with no
      // `settledAt` is exactly what the journal sweep's repair pass scans for, and it rebuilds the plan
      // from this document — deleting it would destroy the only record that the seller is still owed
      // their item or the buyer their purchase.
      settledAt: { $exists: true },
      $or: [
        { closedAt: { $lt: cutoff } },
        { closedAt: { $exists: false }, expireAt: { $lt: cutoff } },
      ],
    });
    return res.deletedCount ?? 0;
  }
}
