// auctionsvc AuctionService split — buy / bid / cancel / expiry settlement (see ../auctionService.ts).
//
// Independent sibling class (2026-08-11 re-audit, converted from a linear inheritance chain to
// composition): depends on AuctionServicePricing (checkPriceGuard/bumpDaily/recordSoldPrice) AND
// AuctionServiceDelivery (deliverItem/deliverCoins) — the only file in the chain needing both.
import { AUCTION_TAX_RATE, AUCTION_DAILY_BUY_CAP, AUCTION_MIN_INCREMENT_RATIO, AUCTION_ANTI_SNIPE_WINDOW_SEC, SlgError } from '@nw/shared';
import type { AuctionDoc } from '../db';
import type { AuctionServiceDeps } from './base';
import { docToView, categoryOf, type AuctionView } from './base';
import type { AuctionServicePricing } from './pricing';
import type { AuctionServiceDelivery } from './delivery';

export class AuctionServiceTrade {
  constructor(
    private readonly deps: AuctionServiceDeps,
    private readonly pricing: AuctionServicePricing,
    private readonly delivery: AuctionServiceDelivery,
  ) {}

  /**
   * Purchase an auction listing (fixed-price only; atomically claims status open→sold).
   * Designated-buyer check → daily cap (C) → deduct buyer coins → atomic status update → deliver item → pay seller (after tax).
   * If buyer deduction succeeds but a subsequent step fails: item remains in sold state; ops admin can look up orderId and manually redeliver.
   * Auction listings (saleMode='auction') do not go through this path — bidding/buyout uses placeBid.
   */
  async buyAuction(buyerId: string, auctionId: string, clientPlatform?: string): Promise<AuctionView> {
    const { cols, now, commercial } = this.deps;

    const doc = await cols.auctions.findOne({ _id: auctionId });
    if (!doc) throw new SlgError('AUCTION_NOT_FOUND');
    if (doc.status !== 'open') throw new SlgError('AUCTION_CLOSED');
    if ((doc.saleMode ?? 'fixed') !== 'fixed') throw new SlgError('BAD_REQUEST'); // auction listings use placeBid
    if (doc.sellerId === buyerId) throw new SlgError('BAD_REQUEST');
    if (doc.expireAt < now()) throw new SlgError('AUCTION_CLOSED');
    if (doc.designatedBuyerId && doc.designatedBuyerId !== buyerId) {
      throw new SlgError('NOT_DESIGNATED_BUYER');
    }

    // C Daily purchase cap (reserve slot before charging)
    await this.pricing.bumpDaily(buyerId, 'buys', AUCTION_DAILY_BUY_CAP);

    const totalPrice = doc.price * doc.qty;
    const tax = Math.floor(totalPrice * AUCTION_TAX_RATE);
    const sellerReceives = totalPrice - tax;

    const buyOrderId = `auction_buy:${auctionId}`;

    // 1. Deduct coins from buyer (insufficient funds → throw, no sale)
    await commercial.spend(buyerId, totalPrice, buyOrderId, clientPlatform);

    // 2. Atomic status open→sold (prevents concurrent double-purchase)
    const updated = await cols.auctions.findOneAndUpdate(
      { _id: auctionId, status: 'open' },
      { $set: { status: 'sold', buyerId, soldAt: now(), closedAt: now(), rev: doc.rev + 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      // Concurrently sniped by another buyer → refund buyer coins via mail (best-effort)
      await this.delivery.deliverCoins(buyerId, totalPrice, `${buyOrderId}:refund`, 'refund');
      throw new SlgError('AUCTION_CLOSED');
    }

    // 3. Deliver item to buyer via system mail (escrow-out: buyer claims the attachment)
    await this.delivery.deliverItem(buyerId, doc, `${buyOrderId}:item`, 'sold');

    // 4. Pay seller coins via mail (after tax, best-effort)
    await this.delivery.deliverCoins(doc.sellerId, sellerReceives, `${buyOrderId}:seller`, 'proceeds');

    // G Record sale unit price into sliding window
    await this.pricing.recordSoldPrice(categoryOf(doc), doc.price);

    return docToView(updated);
  }

  /**
   * Place an auction bid (saleMode='auction', B).
   * amount = bid unit price (coins/item); escrowed total = amount × qty.
   * Validate → daily cap → escrow bid coins → atomic topBid write (rev guard) → refund previous bidder → anti-snipe extension.
   * If amount reaches/exceeds buyoutPrice → immediate settlement (item to bidder, seller receives post-tax proceeds; coins already escrowed, no second deduction).
   */
  async placeBid(bidderId: string, auctionId: string, amount: number, clientPlatform?: string): Promise<AuctionView> {
    const { cols, now, commercial } = this.deps;
    if (amount <= 0) throw new SlgError('BAD_REQUEST');

    const doc = await cols.auctions.findOne({ _id: auctionId });
    if (!doc) throw new SlgError('AUCTION_NOT_FOUND');
    if (doc.status !== 'open') throw new SlgError('AUCTION_CLOSED');
    if ((doc.saleMode ?? 'fixed') !== 'auction') throw new SlgError('BAD_REQUEST'); // fixed-price listings use buyAuction
    if (doc.sellerId === bidderId) throw new SlgError('BAD_REQUEST');
    if (doc.expireAt < now()) throw new SlgError('AUCTION_CLOSED');
    if (doc.designatedBuyerId && doc.designatedBuyerId !== bidderId) {
      throw new SlgError('NOT_DESIGNATED_BUYER');
    }

    // Minimum bid: start price / current top bid + minimum increment
    // Buyout bypasses the increment floor — it only needs to clear the seller's buyout price.
    const isBuyout = doc.buyoutPrice != null && amount >= doc.buyoutPrice;
    if (!isBuyout) {
      const startPrice = doc.startPrice ?? doc.price;
      let minBid = startPrice;
      if (doc.topBid) {
        const inc = Math.max(1, Math.floor(doc.topBid.amount * AUCTION_MIN_INCREMENT_RATIO));
        minBid = doc.topBid.amount + inc;
      }
      if (amount < minBid) throw new SlgError('BID_TOO_LOW');
    }

    // G Price guardrail (bid unit price is also subject to the guardrail)
    await this.pricing.checkPriceGuard(categoryOf(doc), amount);

    // C Daily bid cap
    await this.pricing.bumpDaily(bidderId, 'buys', AUCTION_DAILY_BUY_CAP);

    const prevBid = doc.topBid;
    const escrowTotal = amount * doc.qty;
    const bidOrderId = `auction_bid:${auctionId}:${bidderId}:${amount}`;

    // 1. Escrow bid coins (insufficient funds → throw, topBid unchanged)
    await commercial.spend(bidderId, escrowTotal, bidOrderId, clientPlatform);

    // 2. Anti-snipe: bid placed within window before expiry → extend expireAt by the same window
    const ts = now();
    const windowMs = AUCTION_ANTI_SNIPE_WINDOW_SEC * 1000;
    const newExpireAt = doc.expireAt - ts < windowMs ? ts + windowMs : doc.expireAt;

    // 3. Atomic topBid write (rev guard prevents concurrent bid overwrite)
    const updated = await cols.auctions.findOneAndUpdate(
      { _id: auctionId, status: 'open', rev: doc.rev },
      {
        // `price` is kept in sync with the current top bid (not just `topBid.amount`) so that
        // listAuctions' DB-level `.sort({price:1})` reflects the same effective price docToView
        // displays — otherwise an auction-mode listing's browse position stays pinned to its
        // stale startPrice forever while the price shown to players climbs with every bid.
        $set: { topBid: { bidderId, amount, ts }, price: amount, expireAt: newExpireAt, rev: doc.rev + 1 },
      },
      { returnDocument: 'after' },
    );
    if (!updated) {
      // Concurrently superseded or already closed → refund this escrow via mail
      await this.delivery.deliverCoins(bidderId, escrowTotal, `${bidOrderId}:refund`, 'refund');
      throw new SlgError('AUCTION_CLOSED');
    }

    // 4. Refund previous top bidder's escrowed coins via mail (best-effort, idempotent)
    if (prevBid) {
      await this.delivery.deliverCoins(
        prevBid.bidderId,
        prevBid.amount * doc.qty,
        `auction_bid_refund:${auctionId}:${prevBid.bidderId}:${prevBid.amount}`,
        'refund',
      );
    }

    // 5. Buyout: bid reaches/exceeds buyoutPrice → immediate settlement
    if (doc.buyoutPrice != null && amount >= doc.buyoutPrice) {
      return this.settleAuctionWin(updated);
    }
    return docToView(updated);
  }

  /**
   * Settle an auction win (internal): deliver item to the top bidder and pay seller post-tax proceeds (coins already escrowed, no second deduction).
   * Atomic open→sold prevents double-settlement with the expiry scanner or a concurrent buyout. If concurrently already settled → read and return the current state.
   */
  private async settleAuctionWin(doc: AuctionDoc): Promise<AuctionView> {
    const top = doc.topBid!;
    const now = this.deps.now();
    const updated = await this.deps.cols.auctions.findOneAndUpdate(
      { _id: doc._id, status: 'open' },
      { $set: { status: 'sold', buyerId: top.bidderId, soldAt: now, closedAt: now, rev: doc.rev + 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      const cur = await this.deps.cols.auctions.findOne({ _id: doc._id });
      return docToView(cur ?? doc);
    }

    const totalPrice = top.amount * doc.qty;
    const tax = Math.floor(totalPrice * AUCTION_TAX_RATE);
    const sellerReceives = totalPrice - tax;
    const orderId = `auction_settle:${doc._id}`;

    // Deliver item to the winner via system mail (escrow-out: winner claims the attachment)
    await this.delivery.deliverItem(top.bidderId, doc, `${orderId}:item`, 'sold');
    // Pay seller post-tax proceeds via mail
    await this.delivery.deliverCoins(doc.sellerId, sellerReceives, `${orderId}:seller`, 'proceeds');
    // G Record sale unit price
    await this.pricing.recordSoldPrice(categoryOf(doc), top.amount);

    return docToView(updated);
  }

  /**
   * Cancel a listing (seller only, status=open).
   * Auction listing with existing bids → cancel rejected (protects bidders); zero bids → can cancel.
   * Refund item to seller (material / equipment / card / skin, best-effort).
   */
  async cancelAuction(sellerId: string, auctionId: string): Promise<AuctionView> {
    const { cols } = this.deps;

    const doc = await cols.auctions.findOne({ _id: auctionId });
    if (!doc) throw new SlgError('AUCTION_NOT_FOUND');
    if (doc.sellerId !== sellerId) throw new SlgError('NO_PERMISSION');
    if (doc.status !== 'open') throw new SlgError('AUCTION_CLOSED');
    if ((doc.saleMode ?? 'fixed') === 'auction' && doc.topBid) throw new SlgError('BAD_REQUEST'); // cannot cancel with existing bids

    // rev-guard (not just status:'open'): a bid landing between the read above and this write does not change
    // status, so a bare {status:'open'} filter would let the cancel through anyway and orphan the bidder's
    // already-escrowed coins (cancelAuction has no bid-refund path). Guarding on rev makes any concurrent write
    // to this doc — a bid, a buy, another cancel — fail this update instead, so the seller must retry and pick
    // up the fresh (bid-carrying) doc, which then correctly rejects at the topBid check above.
    const updated = await cols.auctions.findOneAndUpdate(
      { _id: auctionId, status: 'open', rev: doc.rev },
      { $set: { status: 'cancelled', closedAt: this.deps.now(), rev: doc.rev + 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new SlgError('AUCTION_CLOSED');

    // Return item to seller via system mail (escrow-out: seller claims the attachment to get it back)
    await this.delivery.deliverItem(sellerId, doc, `auction_cancel:${auctionId}`, 'returned');

    return docToView(updated);
  }

  /**
   * Process expired listings (called periodically by the scheduler).
   * Batch-scans expireAt < now AND status=open:
   *   Auction listing with a topBid → settle (deliver item to top bidder, pay seller post-tax);
   *   Otherwise (fixed-price expired / auction with no bids) → mark expired + return item to seller.
   * At most 50 documents per batch to prevent overly long single scans.
   */
  async processExpiredAuctions(): Promise<number> {
    const { cols, now } = this.deps;
    const ts = now();
    const expired = await cols.auctions
      .find({ status: 'open', expireAt: { $lt: ts } })
      .limit(50)
      .toArray();

    let processed = 0;
    for (const doc of expired) {
      const isAuctionWin = (doc.saleMode ?? 'fixed') === 'auction' && !!doc.topBid;
      if (isAuctionWin) {
        // Settle auction win (settleAuctionWin contains atomic open→sold to prevent concurrent double-settle)
        await this.settleAuctionWin(doc);
        processed++;
        continue;
      }

      // Atomic open→expired (prevents concurrent double-processing)
      const res = await cols.auctions.findOneAndUpdate(
        { _id: doc._id, status: 'open' },
        { $set: { status: 'expired', closedAt: ts, rev: doc.rev + 1 } },
        { returnDocument: 'after' },
      );
      if (!res) continue; // concurrently claimed by another processor, skip

      // Return item to seller via system mail (escrow-out: seller claims the attachment to get it back)
      await this.delivery.deliverItem(doc.sellerId, doc, `auction_expire:${doc._id}`, 'returned');
      processed++;
    }
    return processed;
  }
}
