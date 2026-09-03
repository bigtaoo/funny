// trade.ts branch-coverage gap-fill (2026-09-03 branch-gate pass): the file was at 96.8% lines but
// 75.7% branches — a quarter of the whole package's uncovered branches sat here.
//
// What the e2e suites structurally cannot reach, and why each shape matters:
//   • **Every validation refusal reached through a listing the e2e never creates**: a legacy document
//     with no `saleMode` at all (`?? 'fixed'`), a still-open listing already past `expireAt`, an
//     auction-mode listing with no `startPrice`. `createAuction` always writes `saleMode`, so no e2e
//     listing can ever exercise the fallback that exists for documents predating field B.
//   • **Lost CAS races.** buyAuction's `rev`-guarded claim losing to a concurrent write while the
//     listing is still open must report REV_CONFLICT rather than AUCTION_CLOSED, and the expiry
//     scanner must skip a document another instance claimed since its batch read. Both need the
//     competing write to land inside the read→write window, which no sequence of e2e calls produces.
//   • **The journal's `replay` / non-`fresh` verdicts**, i.e. a duplicate submission of a flow that
//     already completed. Reaching those against real Mongo means racing a duplicate-key insert.
//
// Stub collections rather than more e2e (see stubDeps.ts): the service is the real one, and only the
// two or three collection calls a branch touches are stubbed, so a test that wanders elsewhere throws.
import { describe, expect, it, vi } from 'vitest';
import { SlgError } from '@nw/shared';
import type { AuctionDoc } from '../src/db';
import { dupKeyError, mkAuction, mkOrder, NOW, stubDeps } from './stubDeps';

/** `findOne` that answers a scripted sequence of reads (the last value repeats). */
function reads(...docs: Array<AuctionDoc | null>) {
  let i = 0;
  return async () => docs[Math.min(i++, docs.length - 1)] ?? null;
}

/** The listing write a rollback's `unclaim` step needs (a no-op match is the expected outcome). */
const auctionsWrite = { updateOne: async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0 }) };

/** A journal-row collection that accepts the claim and every progress write, and reads back nothing. */
const orderCols = {
  insertOne: async () => ({ acknowledged: true }),
  updateOne: async () => ({ acknowledged: true, matchedCount: 1, modifiedCount: 1 }),
  findOne: async () => null,
};

/** A daily-cap counter that always answers "one used today". */
const dailyOk = { findOneAndUpdate: async () => ({ buys: 1, lists: 1 }) };

async function rejects(p: Promise<unknown>, code: string): Promise<void> {
  await expect(p).rejects.toThrow(SlgError);
  await expect(p).rejects.toMatchObject({ code });
}

describe('buyAuction refusals', () => {
  it('unknown listing -> AUCTION_NOT_FOUND', async () => {
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(null) } } });
    await rejects(svc.buyAuction('buyer-1', 'a:nobody:0:0'), 'AUCTION_NOT_FOUND');
  });

  it('auction-mode listing -> BAD_REQUEST (bidding goes through placeBid)', async () => {
    const doc = mkAuction({ saleMode: 'auction', startPrice: 50 });
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(doc) } } });
    await rejects(svc.buyAuction('buyer-1', doc._id), 'BAD_REQUEST');
  });

  it('a legacy listing with no saleMode field is treated as fixed, and its expiry still refuses the buy', async () => {
    // Both halves matter: `saleMode ?? 'fixed'` has to let this document through (it predates field B),
    // and the expiry check has to catch a listing the scanner has not swept to `expired` yet.
    const doc = mkAuction({ expireAt: NOW - 1 });
    expect(doc.saleMode).toBeUndefined();
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(doc) } } });
    await rejects(svc.buyAuction('buyer-1', doc._id), 'AUCTION_CLOSED');
  });

  it('losing the rev guard while the listing is still open -> REV_CONFLICT, not AUCTION_CLOSED', async () => {
    // The distinction is the point: REV_CONFLICT is retryable and AUCTION_CLOSED is not, so reporting
    // the wrong one tells a buyer to give up on a listing they could still have bought.
    const doc = mkAuction({ saleMode: 'fixed' });
    const { svc, spends } = stubDeps({
      cols: {
        auctions: { findOne: reads(doc, doc), findOneAndUpdate: async () => null, ...auctionsWrite },
        auctionDaily: dailyOk,
        auctionOrders: orderCols,
      },
    });
    await rejects(svc.buyAuction('buyer-1', doc._id), 'REV_CONFLICT');
    expect(spends).toEqual([]); // claim-before-charge: a lost claim never moved coins
  });

  it('losing the claim to a listing that has since closed -> AUCTION_CLOSED', async () => {
    const doc = mkAuction({ saleMode: 'fixed' });
    const { svc } = stubDeps({
      cols: {
        auctions: { findOne: reads(doc, { ...doc, status: 'sold' }), findOneAndUpdate: async () => null, ...auctionsWrite },
        auctionDaily: dailyOk,
        auctionOrders: orderCols,
      },
    });
    await rejects(svc.buyAuction('buyer-1', doc._id), 'AUCTION_CLOSED');
  });

  it('a daily-cap rejection releases the journal row without ever claiming the listing', async () => {
    const doc = mkAuction({ saleMode: 'fixed' });
    const claim = vi.fn(async () => null);
    const { svc } = stubDeps({
      cols: {
        auctions: { findOne: reads(doc), findOneAndUpdate: claim, ...auctionsWrite },
        auctionDaily: { findOneAndUpdate: async () => ({ buys: 1e6 }), updateOne: async () => ({ acknowledged: true }) },
        auctionOrders: orderCols,
      },
    });
    await rejects(svc.buyAuction('buyer-1', doc._id), 'AUCTION_LIMIT_REACHED');
    expect(claim).not.toHaveBeenCalled();
  });

  it('a duplicate submission of a completed purchase replays the current listing view, charging nothing', async () => {
    // The listing itself is still open on the read this call makes; the row is what says the flow
    // already finished, and the view comes from a re-read that now shows it sold.
    const doc = mkAuction({ saleMode: 'fixed' });
    const { svc, spends } = stubDeps({
      cols: {
        auctions: { findOne: reads(doc, { ...doc, status: 'sold', buyerId: 'buyer-1' }) },
        auctionOrders: {
          insertOne: async () => { throw dupKeyError(); },
          findOne: async () => mkOrder({ status: 'done', actorId: 'buyer-1' }),
        },
      },
    });
    const view = await svc.buyAuction('buyer-1', doc._id);
    expect(view.status).toBe('sold');
    expect(spends).toEqual([]);
  });

  it('a replay whose listing has since been purged still answers from the snapshot it read', async () => {
    const doc = mkAuction({ saleMode: 'fixed' });
    const { svc } = stubDeps({
      cols: {
        auctions: { findOne: reads(doc, null) },
        auctionOrders: {
          insertOne: async () => { throw dupKeyError(); },
          findOne: async () => mkOrder({ status: 'done', actorId: 'buyer-1' }),
        },
      },
    });
    expect((await svc.buyAuction('buyer-1', doc._id)).auctionId).toBe(doc._id);
  });
});

describe('placeBid refusals', () => {
  const auctionDoc = (over: Partial<AuctionDoc> = {}) => mkAuction({ saleMode: 'auction', startPrice: 50, item: {}, ...over });

  it.each([0, -1])('a non-positive amount (%i) is refused before the listing is even read', async (amount) => {
    const findOne = vi.fn(async () => null);
    const { svc } = stubDeps({ cols: { auctions: { findOne } } });
    await rejects(svc.placeBid('bidder-1', 'a:x:0:0', amount), 'BAD_REQUEST');
    expect(findOne).not.toHaveBeenCalled();
  });

  it('unknown listing -> AUCTION_NOT_FOUND', async () => {
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(null) } } });
    await rejects(svc.placeBid('bidder-1', 'a:x:0:0', 60), 'AUCTION_NOT_FOUND');
  });

  it('already-closed listing -> AUCTION_CLOSED', async () => {
    const doc = auctionDoc({ status: 'sold' });
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(doc) } } });
    await rejects(svc.placeBid('bidder-1', doc._id, 60), 'AUCTION_CLOSED');
  });

  it('a legacy listing with no saleMode is fixed-price, so bidding on it -> BAD_REQUEST', async () => {
    const doc = mkAuction();
    expect(doc.saleMode).toBeUndefined();
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(doc) } } });
    await rejects(svc.placeBid('bidder-1', doc._id, 60), 'BAD_REQUEST');
  });

  it('the seller cannot bid on their own listing', async () => {
    const doc = auctionDoc();
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(doc) } } });
    await rejects(svc.placeBid(doc.sellerId, doc._id, 60), 'BAD_REQUEST');
  });

  it('an expired but still-open listing -> AUCTION_CLOSED', async () => {
    const doc = auctionDoc({ expireAt: NOW - 1 });
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(doc) } } });
    await rejects(svc.placeBid('bidder-1', doc._id, 60), 'AUCTION_CLOSED');
  });

  it('a listing designated to someone else -> NOT_DESIGNATED_BUYER', async () => {
    const doc = auctionDoc({ designatedBuyerId: 'friend-1' });
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(doc) } } });
    await rejects(svc.placeBid('bidder-1', doc._id, 60), 'NOT_DESIGNATED_BUYER');
  });

  it('an auction-mode listing with no startPrice falls back to `price` as the minimum bid', async () => {
    const doc = auctionDoc({ startPrice: undefined, price: 80 });
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(doc) } } });
    await rejects(svc.placeBid('bidder-1', doc._id, 79), 'BID_TOO_LOW');
  });

  it('a daily-cap rejection rolls the bid back without charging — and without firing the un-started escrow', async () => {
    // The rollback must SKIP the `spend` step it never attempted: firing it here would charge the bidder
    // purely so the compensation could mail the coins straight back (that is what `started` exists for).
    const doc = auctionDoc();
    const { svc, spends, mails } = stubDeps({
      cols: {
        auctions: { findOne: reads(doc) },
        auctionDaily: { findOneAndUpdate: async () => ({ buys: 1e6 }), updateOne: async () => ({ acknowledged: true }) },
        auctionOrders: orderCols,
      },
    });
    await rejects(svc.placeBid('bidder-1', doc._id, 60), 'AUCTION_LIMIT_REACHED');
    expect(spends).toEqual([]);
    expect(mails).toEqual([]);
  });

  it('a duplicate submission of an identical completed bid replays instead of charging twice', async () => {
    const doc = auctionDoc();
    const settled = { ...doc, topBid: { bidderId: 'bidder-1', amount: 60, ts: NOW }, price: 60, rev: 1 };
    const { svc, spends } = stubDeps({
      cols: {
        auctions: { findOne: reads(doc, settled) },
        auctionOrders: {
          insertOne: async () => { throw dupKeyError(); },
          findOne: async () => mkOrder({ kind: 'bid', status: 'done', actorId: 'bidder-1' }),
        },
      },
    });
    expect((await svc.placeBid('bidder-1', doc._id, 60)).topBid?.amount).toBe(60);
    expect(spends).toEqual([]);
  });

  it('a bid replay whose listing has since been purged answers from the snapshot it read', async () => {
    const doc = auctionDoc();
    const { svc } = stubDeps({
      cols: {
        auctions: { findOne: reads(doc, null) },
        auctionOrders: {
          insertOne: async () => { throw dupKeyError(); },
          findOne: async () => mkOrder({ kind: 'bid', status: 'done', actorId: 'bidder-1' }),
        },
      },
    });
    expect((await svc.placeBid('bidder-1', doc._id, 60)).auctionId).toBe(doc._id);
  });

  it.each([
    ['an Error', new Error('bid history write failed')],
    ['a thrown non-Error (a rejected driver promise)', 'bid history write failed'],
  ])('a failed bid-participation write is logged and swallowed — %s', async (_label, thrown) => {
    // My-Bids history has no asset behind it: the coins are escrowed and the topBid is recorded, so
    // throwing here would report a failure for a bid that went through.
    const doc = auctionDoc({ price: 50 });
    const updated = { ...doc, topBid: { bidderId: 'bidder-1', amount: 60, ts: NOW }, price: 60, rev: 1 };
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { svc, spends } = stubDeps({
      cols: {
        auctions: { findOne: reads(doc), findOneAndUpdate: async () => updated },
        auctionDaily: dailyOk,
        auctionOrders: orderCols,
        auctionBids: { updateOne: async () => { throw thrown; } },
      },
    });
    const view = await svc.placeBid('bidder-1', doc._id, 60);
    expect(view.topBid).toEqual({ bidderId: 'bidder-1', amount: 60, ts: NOW });
    expect(spends).toEqual([{ account: 'bidder-1', amount: 120, orderId: `auction_bid:${doc._id}:bidder-1:60` }]);
    err.mockRestore();
  });
});

describe('cancelAuction refusals', () => {
  it('unknown listing -> AUCTION_NOT_FOUND', async () => {
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(null) } } });
    await rejects(svc.cancelAuction('seller-1', 'a:seller-1:0:0'), 'AUCTION_NOT_FOUND');
  });

  it('an already-closed listing -> AUCTION_CLOSED', async () => {
    const doc = mkAuction({ status: 'expired' });
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(doc) } } });
    await rejects(svc.cancelAuction('seller-1', doc._id), 'AUCTION_CLOSED');
  });

  it('an auction-mode listing that already carries a bid cannot be cancelled (it protects the bidder)', async () => {
    const doc = mkAuction({ saleMode: 'auction', startPrice: 50, topBid: { bidderId: 'bidder-1', amount: 60, ts: NOW } });
    const { svc } = stubDeps({ cols: { auctions: { findOne: reads(doc) } } });
    await rejects(svc.cancelAuction('seller-1', doc._id), 'BAD_REQUEST');
  });

  it('a cancel whose hand-over is already journaled by the sweep does not re-mail the item', async () => {
    // `runClaimedFlow` sees a non-`fresh` verdict and returns: the listing is already flipped, and the
    // row that exists owns the return mail.
    const doc = mkAuction();
    const { svc, mails } = stubDeps({
      cols: {
        auctions: { findOne: reads(doc), findOneAndUpdate: async () => ({ ...doc, status: 'cancelled', rev: 1 }) },
        auctionOrders: {
          insertOne: async () => { throw dupKeyError(); },
          findOne: async () => mkOrder({ kind: 'cancel', status: 'done', actorId: 'seller-1' }),
        },
      },
    });
    expect((await svc.cancelAuction('seller-1', doc._id)).status).toBe('cancelled');
    expect(mails).toEqual([]);
  });
});

describe('processExpiredAuctions', () => {
  const batch = (docs: AuctionDoc[]) => ({
    find: () => ({ limit: () => ({ toArray: async () => docs }) }),
  });

  it('a legacy listing with no saleMode expires down the return path, not the settle path', async () => {
    const doc = mkAuction({ expireAt: NOW - 1 });
    expect(doc.saleMode).toBeUndefined();
    const { svc, mails } = stubDeps({
      cols: {
        auctions: {
          ...batch([doc]),
          findOneAndUpdate: async () => ({ ...doc, status: 'expired', rev: 1 }),
          updateOne: async () => ({ acknowledged: true }),
        },
        auctionOrders: orderCols,
      },
    });
    expect(await svc.processExpiredAuctions()).toBe(1);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.account).toBe('seller-1');
    expect(mails[0]!.content.attachments).toEqual([{ kind: 'material', id: 'scrap', count: 2 }]);
  });

  it('a document another instance claimed since the batch read is skipped, not double-expired', async () => {
    const doc = mkAuction({ expireAt: NOW - 1 });
    const { svc, mails } = stubDeps({
      cols: { auctions: { ...batch([doc]), findOneAndUpdate: async () => null } },
    });
    expect(await svc.processExpiredAuctions()).toBe(0);
    expect(mails).toEqual([]);
  });

  it('an auction win whose settle CAS is lost reports the current state instead of settling a stale topBid', async () => {
    // The rev guard is what makes this a no-op: a bid landing between the batch read and this write must
    // not deliver the item to the previous (already-refunded) bidder.
    const doc = mkAuction({
      saleMode: 'auction', startPrice: 50, expireAt: NOW - 1,
      topBid: { bidderId: 'bidder-1', amount: 60, ts: NOW - 10 },
    });
    const { svc, mails } = stubDeps({
      cols: { auctions: { ...batch([doc]), findOneAndUpdate: async () => null, findOne: reads(null) } },
    });
    expect(await svc.processExpiredAuctions()).toBe(1); // counted as handled; the next tick re-reads it
    expect(mails).toEqual([]);
  });
});
