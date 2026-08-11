// auctionsvc AuctionService split — read-only listing queries (see ../auctionService.ts).
//
// Independent sibling class (2026-08-11 re-audit, converted from a linear inheritance chain to
// composition): zero dependencies on any other layer, only `deps`.
import type { AuctionListingAdminView, AuctionListingQuery } from '@nw/shared';
import type { AuctionServiceDeps } from './base';
import { docToAdminView, docToView, type AuctionView, AUCTION_CLOSED_RETENTION_SEC, MY_LISTINGS_FETCH_LIMIT, QUERY_FETCH_CAP } from './base';

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
   * Purge closed listings (sold/cancelled/expired) older than the retention window from every seller's
   * My-Listings history, so the list can't grow without bound. Open listings are never purged (they still
   * hold escrowed goods / active bids). Anchor is closedAt; legacy closed docs written before closedAt
   * existed fall back to expireAt. Called periodically by the scheduler. Returns the number deleted.
   */
  async purgeClosedListings(retentionSec: number = AUCTION_CLOSED_RETENTION_SEC): Promise<number> {
    const cutoff = this.deps.now() - retentionSec * 1000;
    const res = await this.deps.cols.auctions.deleteMany({
      status: { $ne: 'open' },
      $or: [
        { closedAt: { $lt: cutoff } },
        { closedAt: { $exists: false }, expireAt: { $lt: cutoff } },
      ],
    });
    return res.deletedCount ?? 0;
  }
}
