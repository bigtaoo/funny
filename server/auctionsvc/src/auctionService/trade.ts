// auctionsvc AuctionService split — buy / bid / cancel / expiry settlement (see ../auctionService.ts).
//
// Independent sibling class (2026-08-11 re-audit, converted from a linear inheritance chain to
// composition): depends on AuctionServicePricing (checkPriceGuard/bumpDaily/recordSoldPrice) AND
// AuctionOrderJournal (every cross-service side effect) — the only file in the chain needing both.
//
// 2026-08-24 (U13 close-out): every flow here now runs against the settlement journal instead of firing
// cross-service calls inline. What that changed, beyond crash-safety:
//   • `buyAuction` claims the listing BEFORE charging, so the old "charged, then sniped, then refunded
//     under a key shared with the winning buyer" path is gone entirely.
//   • Both purchase keys carry the buyer. `auction_buy:{id}` did not, so the second of two racing buyers
//     got a bare BAD_REQUEST from commercial's cross-account guard, and a crash after a charge left the
//     key owned forever by a buyer who never got the item — nobody could buy that listing again.
//   • `settleAuctionWin` claims under a `rev` guard. Without one, a bid landing between the expiry
//     scanner's batch read and its settle CAS was silently overwritten: the item went to the previous
//     bidder (who had already been refunded) and the new top bidder's escrow was orphaned.
//   • Two concurrent same-amount bids from one bidder collide on the journal row instead of sharing a
//     `spend` orderId, which used to mail a full refund against a single charge.
import { AUCTION_TAX_RATE, AUCTION_DAILY_BUY_CAP, AUCTION_MIN_INCREMENT_RATIO, AUCTION_ANTI_SNIPE_WINDOW_SEC, SlgError, createLogger } from '@nw/shared';
import type { AuctionDoc } from '../db';
import type { AuctionServiceDeps } from './base';
import { docToView, categoryOf, bidRowId, AUCTION_CLOSED_RETENTION_SEC, type AuctionView } from './base';
import type { AuctionServicePricing } from './pricing';
import type { AuctionOrderJournal } from './journal';
import { flowKey, outbidRefundStep, planForBid, planForBuy, planForReturn, planForSettle, snapshotOf } from './journalPlans';

const log = createLogger('auctionsvc');

export class AuctionServiceTrade {
  constructor(
    private readonly deps: AuctionServiceDeps,
    private readonly pricing: AuctionServicePricing,
    private readonly journal: AuctionOrderJournal,
  ) {}

  /**
   * Purchase an auction listing (fixed-price only).
   *
   * Order of operations: validate → journal the intent → atomically claim the listing (open→sold) →
   * charge → deliver item → pay seller (post-tax). Claiming before charging is what makes the failure
   * modes benign: losing the claim means no coins ever moved, and a charge that is definitively refused
   * releases the claim again through the journal's compensation, so at worst the listing is briefly
   * unavailable. A charge whose outcome is unknown (timeout) is neither delivered nor refunded — it is
   * retried against commercial's own orderId idempotency until it answers.
   *
   * Auction listings (saleMode='auction') do not go through this path — bidding/buyout uses placeBid.
   */
  async buyAuction(buyerId: string, auctionId: string, clientPlatform?: string): Promise<AuctionView> {
    const { cols, now } = this.deps;

    const doc = await cols.auctions.findOne({ _id: auctionId });
    if (!doc) throw new SlgError('AUCTION_NOT_FOUND');
    if (doc.status !== 'open') throw new SlgError('AUCTION_CLOSED');
    if ((doc.saleMode ?? 'fixed') !== 'fixed') throw new SlgError('BAD_REQUEST'); // auction listings use placeBid
    if (doc.sellerId === buyerId) throw new SlgError('BAD_REQUEST');
    if (doc.expireAt < now()) throw new SlgError('AUCTION_CLOSED');
    if (doc.designatedBuyerId && doc.designatedBuyerId !== buyerId) {
      throw new SlgError('NOT_DESIGNATED_BUYER');
    }

    const totalPrice = doc.price * doc.qty;
    const tax = Math.floor(totalPrice * AUCTION_TAX_RATE);
    const sellerReceives = totalPrice - tax; // tax is a pure coin sink (AUCTION_DESIGN §2.2) — nothing to credit
    const snapshot = snapshotOf(doc);
    const rowId = flowKey('buy', auctionId, buyerId);

    const begun = await this.journal.begin(rowId, 'buy', auctionId, buyerId, (cycle) =>
      planForBuy(rowId, cycle, buyerId, doc.sellerId, auctionId, snapshot, totalPrice, sellerReceives, clientPlatform),
    );
    if (begun.state === 'inflight') throw new SlgError('REV_CONFLICT', 'A purchase of this listing is already being settled, please retry');
    if (begun.state === 'replay') return docToView((await cols.auctions.findOne({ _id: auctionId })) ?? doc);
    const row = begun.row;

    // C Daily purchase cap. Checked after the journal key is claimed so a duplicate submission or a replay
    // cannot burn a slot; a rejection here releases the row without ever having moved anything.
    try {
      await this.pricing.bumpDaily(buyerId, 'buys', AUCTION_DAILY_BUY_CAP);
    } catch (e) {
      await this.journal.abort(row);
      throw e;
    }

    // Atomic claim open→sold. The `rev` guard makes "the price I charge is the price I read" structural:
    // the total was computed from this snapshot, so any concurrent write to the listing must invalidate it
    // rather than let a stale total through.
    const claimed = await cols.auctions.findOneAndUpdate(
      { _id: auctionId, status: 'open', rev: doc.rev },
      { $set: { status: 'sold', buyerId, soldAt: now(), closedAt: now() }, $inc: { rev: 1 } },
      { returnDocument: 'after' },
    );
    if (!claimed) {
      await this.journal.abort(row);
      // Distinguish honestly rather than reporting AUCTION_CLOSED for both: a lost `rev` race on a still-open
      // listing is retryable, a closed listing is not.
      const cur = await cols.auctions.findOne({ _id: auctionId });
      if (cur && cur.status === 'open') throw new SlgError('REV_CONFLICT', 'Listing changed while purchasing, please retry');
      throw new SlgError('AUCTION_CLOSED');
    }

    await this.journal.decide(row);
    await this.journal.finalize(row);

    // The buyer's answer hinges on the charge alone. If it landed, they own the listing even when the
    // delivery mails are still owed (the sweep keeps retrying those). If its outcome is still unknown,
    // saying "bought" would be a lie — report retryable instead and let the sweep settle or release it.
    const settled = await this.journal.read(rowId);
    if (settled?.done['spend'] == null) {
      throw new SlgError('REV_CONFLICT', 'Payment is still being confirmed, please retry');
    }

    // G Record sale unit price into the sliding window.
    await this.pricing.recordSoldPrice(categoryOf(doc), doc.price);

    return docToView(claimed);
  }

  /**
   * Place an auction bid (saleMode='auction', B).
   * amount = bid unit price (coins/item); escrowed total = amount × qty.
   * Validate → journal → escrow bid coins → atomic topBid write (rev guard) → refund the outbid bidder →
   * anti-snipe extension. If amount reaches/exceeds buyoutPrice → immediate settlement (coins already
   * escrowed, no second deduction).
   *
   * Note the deliberate asymmetry with buyAuction: here the coins are taken FIRST. A recorded `topBid` is
   * what a later settlement pays the seller against, so it must never exist without escrowed coins behind
   * it — which is why this flow keeps a refund path at all, now journaled rather than best-effort.
   */
  async placeBid(bidderId: string, auctionId: string, amount: number, clientPlatform?: string): Promise<AuctionView> {
    const { cols, now } = this.deps;
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

    // Minimum bid: start price / current top bid + minimum increment.
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

    const prevBid = doc.topBid;
    const escrowTotal = amount * doc.qty;
    const rowId = flowKey('bid', auctionId, bidderId, String(amount));

    // Claiming the row before charging is what closes the old double-refund: two concurrent identical bids
    // from one bidder used to share a `spend` orderId, so commercial charged once while the CAS loser
    // mailed out a full refund.
    const begun = await this.journal.begin(rowId, 'bid', auctionId, bidderId, (cycle) =>
      planForBid(rowId, cycle, bidderId, escrowTotal, clientPlatform),
    );
    if (begun.state === 'inflight') throw new SlgError('REV_CONFLICT', 'An identical bid is already being processed, please retry');
    if (begun.state === 'replay') return docToView((await cols.auctions.findOne({ _id: auctionId })) ?? doc);
    const row = begun.row;

    // C Daily bid cap (see buyAuction for why this sits after the journal claim).
    try {
      await this.pricing.bumpDaily(bidderId, 'buys', AUCTION_DAILY_BUY_CAP);
    } catch (e) {
      await this.journal.abort(row);
      throw e;
    }

    // 1. Escrow the bid coins (insufficient funds → throws, topBid unchanged).
    try {
      await this.journal.advance(row);
    } catch (e) {
      await this.journal.abort(row);
      throw e;
    }
    if (row.done['spend'] == null) {
      // Indeterminate charge: the row stays pending and the sweep resolves it (escrow then refund, since
      // the bid was never recorded). Recording a topBid now could leave a bid with no coins behind it.
      throw new SlgError('REV_CONFLICT', 'Payment is still being confirmed, please retry');
    }

    // 2. Anti-snipe: a bid placed within the window before expiry extends expireAt by the same window.
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
        $set: { topBid: { bidderId, amount, ts }, price: amount, expireAt: newExpireAt },
        $inc: { rev: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!updated) {
      // Concurrently superseded or already closed → the journal's compensation refunds this escrow, and
      // (unlike before) keeps retrying until the refund mail actually lands.
      await this.journal.abort(row);
      throw new SlgError('AUCTION_CLOSED');
    }

    // 4. Record the decision, appending the outbid bidder's refund — known only now.
    await this.journal.decide(row, prevBid ? [outbidRefundStep(auctionId, prevBid.bidderId, prevBid.amount, doc.qty)] : []);
    await this.journal.finalize(row);

    // 4b. Remember that this account bid on this listing, so My Bids can still show it after someone
    // outbids them (`topBid` only ever remembers the current leader).
    await this.recordBidParticipation(updated, bidderId, amount, escrowTotal);

    // 5. Buyout: bid reaches/exceeds buyoutPrice → immediate settlement
    if (doc.buyoutPrice != null && amount >= doc.buyoutPrice) {
      return this.settleAuctionWin(updated);
    }
    return docToView(updated);
  }

  /**
   * Remember that `bidderId` bid on this listing ("My Bids", 2026-08-27).
   *
   * Called only once the topBid write has landed, so a row exists exactly when coins were really
   * escrowed against this listing — never for a bid that lost its CAS and got refunded.
   *
   * The update is a pipeline rather than `$max`/`$set` operators because `amount` and `total` have to move
   * together: `$max` alone could keep an earlier, higher `amount` while `$set` overwrote `total` with the
   * lower bid's escrow, leaving a row claiming a coin figure that never matched its own price.
   *
   * Failures are logged and swallowed. This is history with no asset behind it: the bid has already
   * succeeded and the coins are already escrowed, so throwing here would report a failure for a bid that
   * went through — strictly worse than a missing history row.
   */
  private async recordBidParticipation(doc: AuctionDoc, bidderId: string, amount: number, escrowTotal: number): Promise<void> {
    try {
      await this.deps.cols.auctionBids.updateOne(
        { _id: bidRowId(doc._id, bidderId) },
        [{
          $set: {
            auctionId: doc._id,
            bidderId,
            ts: this.deps.now(),
            // Anchored to the LISTING's expiry, not this bid's timestamp — see AuctionBidDoc.purgeAt.
            purgeAt: new Date(doc.expireAt + AUCTION_CLOSED_RETENTION_SEC * 1000),
            amount: { $max: [{ $ifNull: ['$amount', 0] }, amount] },
            total: { $cond: [{ $gt: [amount, { $ifNull: ['$amount', 0] }] }, escrowTotal, { $ifNull: ['$total', escrowTotal] }] },
            bids: { $add: [{ $ifNull: ['$bids', 0] }, 1] },
          },
        }],
        { upsert: true },
      );
    } catch (e) {
      log.error('failed to record bid participation', { auctionId: doc._id, bidderId, err: e instanceof Error ? e : String(e) });
    }
  }

  /**
   * Settle an auction win (internal): deliver the item to the top bidder and pay the seller post-tax
   * proceeds (coins already escrowed at bid time, so this flow is forward-only — there is no charge to
   * fail and nothing to compensate).
   *
   * The claim is guarded on `rev`, not just `status:'open'`. A bare status filter let the expiry scanner
   * settle against a `topBid` that had already been superseded between its batch read and this write:
   * the item went to the previous bidder — who had by then been refunded — while the new top bidder's
   * escrow was orphaned. Losing the guard now just means the caller sees the current state and the
   * scanner picks the listing up again on its next tick with a fresh snapshot.
   */
  private async settleAuctionWin(doc: AuctionDoc): Promise<AuctionView> {
    const { cols } = this.deps;
    const top = doc.topBid!;
    const now = this.deps.now();
    const updated = await cols.auctions.findOneAndUpdate(
      { _id: doc._id, status: 'open', rev: doc.rev },
      { $set: { status: 'sold', buyerId: top.bidderId, soldAt: now, closedAt: now }, $inc: { rev: 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      const cur = await cols.auctions.findOne({ _id: doc._id });
      return docToView(cur ?? doc);
    }

    const totalPrice = top.amount * doc.qty;
    const tax = Math.floor(totalPrice * AUCTION_TAX_RATE);
    const sellerReceives = totalPrice - tax;
    await this.runClaimedFlow('settle', updated, (rowId, cycle) =>
      planForSettle(rowId, cycle, top.bidderId, doc.sellerId, snapshotOf(doc), sellerReceives),
    );

    // G Record sale unit price
    await this.pricing.recordSoldPrice(categoryOf(doc), top.amount);

    return docToView(updated);
  }

  /**
   * Cancel a listing (seller only, status=open).
   * Auction listing with existing bids → cancel rejected (protects bidders); zero bids → can cancel.
   * The escrowed item goes back to the seller through the journal, so a crash or a meta hiccup after the
   * status flip no longer destroys it.
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
      { $set: { status: 'cancelled', closedAt: this.deps.now() }, $inc: { rev: 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new SlgError('AUCTION_CLOSED');

    await this.runClaimedFlow('cancel', updated, (rowId, cycle) => planForReturn(rowId, cycle, sellerId, snapshotOf(doc)));

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
        // settleAuctionWin's rev-guarded claim prevents a double settle and, unlike the old status-only
        // filter, refuses to settle against a topBid that was superseded since this batch was read.
        await this.settleAuctionWin(doc);
        processed++;
        continue;
      }

      // Atomic open→expired. rev-guarded for the same reason as cancelAuction: a bid landing since the
      // batch read leaves status untouched, and expiring a listing that now carries an escrowed bid would
      // orphan the bidder's coins (this branch has no refund path — a bid-carrying listing must go through
      // settleAuctionWin instead, which the next tick will do with a fresh snapshot).
      const res = await cols.auctions.findOneAndUpdate(
        { _id: doc._id, status: 'open', rev: doc.rev },
        { $set: { status: 'expired', closedAt: ts }, $inc: { rev: 1 } },
        { returnDocument: 'after' },
      );
      if (!res) continue; // concurrently claimed or superseded, skip

      await this.runClaimedFlow('expire', res, (rowId, cycle) => planForReturn(rowId, cycle, doc.sellerId, snapshotOf(doc)));
      processed++;
    }
    return processed;
  }

  /**
   * Shared tail for the three claim-first flows (settle / cancel / expire): the listing is already in its
   * terminal status, so the hand-over is forward-only and the journal row is written `decided`.
   *
   * A crash in the gap between the claim and this row is covered by the sweep's repair pass rather than by
   * ordering: a listing sitting in a terminal status with no `settledAt` IS the record that a hand-over is
   * owed, and the plan can be rebuilt from the document alone.
   */
  private async runClaimedFlow(
    kind: 'settle' | 'cancel' | 'expire',
    doc: AuctionDoc,
    build: (rowId: string, cycle: number) => ReturnType<typeof planForReturn>,
  ): Promise<void> {
    const rowId = flowKey(kind, doc._id);
    const begun = await this.journal.begin(rowId, kind, doc._id, doc.sellerId, (cycle) => build(rowId, cycle));
    if (begun.state !== 'fresh') return; // already settled, or being settled by the sweep
    await this.journal.finalize(begun.row);
  }
}
