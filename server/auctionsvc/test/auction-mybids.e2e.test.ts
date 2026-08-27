// "My Bids" (GET /auction/myBids) end-to-end — bid participation records + the read that joins them
// back to their listings (2026-08-27, AUCTION_DESIGN §4.B).
//
// What this pins that auction.e2e.test.ts cannot: that tab used to be derived client-side by filtering
// the market list on `topBid.bidderId === me`, and `topBid` only ever remembers the CURRENT leader — so
// the moment a bidder was outbid, the listing vanished from their tab entirely. Every assertion below
// that mentions an outbid or losing bidder is that regression; the rest guard the record's own shape
// (one row per (listing, bidder) pair, `amount` = my best not the listing's, TTL anchored to the
// LISTING's lifetime) and the invariant that a row exists exactly when coins were really escrowed.
//
// Requires `cd server && docker compose up -d` (or falls back to mongodb-memory-server via globalSetup).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AUCTION_DURATIONS_SEC, SlgError } from '@nw/shared';
import { createAuctionMongo, type AuctionMongo } from '../src/db';
import { AuctionService } from '../src/auctionService';
import { AUCTION_CLOSED_RETENTION_SEC, MY_BIDS_FETCH_LIMIT, bidRowId } from '../src/auctionService/base';
import type { AuctionCommercialClient } from '../src/commercialClient';
import type { AuctionMetaClient } from '../src/metaClient';
import type { AuctionMailClient } from '../src/mailClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_auction_mybids_e2e_test';

async function tryConnect(): Promise<AuctionMongo | null> {
  try {
    return await createAuctionMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[auctionsvc.mybids.e2e] Mongo unreachable (${URI}) — skipping.`);
}

describe.skipIf(!mongo)('AuctionService.getMyBids e2e', () => {
  // Material-only fakes: every case here is about the bid RECORD, not about what is being traded, so the
  // equipment/card/skin escrow paths auction.e2e.test.ts covers would only add noise.
  const commercial: AuctionCommercialClient = { available: true, async spend() { /* always affordable */ } };
  const mail: AuctionMailClient = { available: true, async sendSystemMail() { /* deliveries asserted elsewhere */ } };
  const meta: AuctionMetaClient = {
    available: true,
    async deductMaterial() { /* seller has stock */ },
    async grantMaterial() { /* returned to seller */ },
    async escrowEquipment() { throw new SlgError('EQUIP_NOT_FOUND'); },
    async grantEquipment() { /* unused */ },
    async escrowCard() { throw new SlgError('CARD_NOT_FOUND'); },
    async grantCard() { /* unused */ },
    async escrowSkin() { throw new SlgError('SKIN_NOT_FOUND'); },
    async grantSkin() { /* unused */ },
  } as unknown as AuctionMetaClient;

  let svc: AuctionService;
  let nowMs = Date.now();
  const DUR = AUCTION_DURATIONS_SEC[0]!;

  beforeEach(async () => {
    await mongo!.collections.auctions.deleteMany({});
    await mongo!.collections.auctionDaily.deleteMany({});
    await mongo!.collections.auctionPrices.deleteMany({});
    await mongo!.collections.auctionOrders.deleteMany({});
    await mongo!.collections.auctionBids.deleteMany({});
    nowMs = Date.now();
    svc = new AuctionService({ cols: mongo!.collections, commercial, meta, mail, now: () => nowMs });
  });

  afterAll(async () => { await mongo?.close(); });

  /** An open auction-mode material listing from `alice`. */
  const listAuction = (startPrice = 10, qty = 1, opts: { buyoutPrice?: number } = {}) =>
    svc.createAuction({
      sellerId: 'alice', itemType: 'material', saleMode: 'auction',
      item: { material: 'scrap' }, qty, startPrice, durationSec: DUR,
      ...(opts.buyoutPrice != null ? { buyoutPrice: opts.buyoutPrice } : {}),
    });

  it('a bid is recorded and comes back as `leading` with my own bid figures', async () => {
    const v = await listAuction(10, 3);
    await svc.placeBid('bob', v.auctionId, 12);

    const bids = await svc.getMyBids('bob');
    expect(bids).toHaveLength(1);
    expect(bids[0]).toMatchObject({
      myBid: 12,
      myTotal: 36, // 12 × qty 3 — the coins actually escrowed
      myBidCount: 1,
      outcome: 'leading',
    });
    expect(bids[0]!.auction.auctionId).toBe(v.auctionId);
    expect(bids[0]!.myBidTs).toBe(nowMs);
  });

  it('being outbid keeps the listing in My Bids as `outbid`, with my bid still my own (the regression)', async () => {
    const v = await listAuction(10);
    await svc.placeBid('bob', v.auctionId, 12);
    await svc.placeBid('carol', v.auctionId, 15);

    // The listing itself no longer names bob anywhere — which is exactly why the old client-side
    // derivation from `topBid` lost him.
    const doc = await mongo!.collections.auctions.findOne({ _id: v.auctionId });
    expect(doc?.topBid).toMatchObject({ bidderId: 'carol', amount: 15 });

    const bobs = await svc.getMyBids('bob');
    expect(bobs).toHaveLength(1);
    expect(bobs[0]!.outcome).toBe('outbid');
    expect(bobs[0]!.myBid).toBe(12);       // my bid, not the listing's
    expect(bobs[0]!.auction.price).toBe(15); // the listing's current price, for the gap to be visible

    const carols = await svc.getMyBids('carol');
    expect(carols).toHaveLength(1);
    expect(carols[0]!.outcome).toBe('leading');
  });

  it('raising my own bid upserts one row: best amount, matching escrow total, bid count 2', async () => {
    const v = await listAuction(10, 2);
    await svc.placeBid('bob', v.auctionId, 12);
    await svc.placeBid('bob', v.auctionId, 20);

    const rows = await mongo!.collections.auctionBids.find({ bidderId: 'bob' }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]!._id).toBe(bidRowId(v.auctionId, 'bob'));

    const bids = await svc.getMyBids('bob');
    expect(bids[0]).toMatchObject({ myBid: 20, myTotal: 40, myBidCount: 2, outcome: 'leading' });
  });

  it('a lower late bid never walks the recorded best backwards (amount and total move together)', async () => {
    const v = await listAuction(10);
    await svc.placeBid('bob', v.auctionId, 18);
    // Bypass placeBid's own increment floor to simulate an out-of-order/retried lower write reaching the
    // record: the row must keep the higher amount AND the total that belongs to it.
    await mongo!.collections.auctionBids.updateOne(
      { _id: bidRowId(v.auctionId, 'bob') },
      [{ $set: { amount: { $max: ['$amount', 5] }, total: { $cond: [{ $gt: [5, '$amount'] }, 5, '$total'] } } }],
    );
    const bids = await svc.getMyBids('bob');
    expect(bids[0]).toMatchObject({ myBid: 18, myTotal: 18 });
  });

  it('settlement splits the participants into `won` and `lost`', async () => {
    const v = await listAuction(10);
    await svc.placeBid('bob', v.auctionId, 12);
    await svc.placeBid('carol', v.auctionId, 15);

    await mongo!.collections.auctions.updateOne({ _id: v.auctionId }, { $set: { expireAt: nowMs - 1000 } });
    expect(await svc.processExpiredAuctions()).toBe(1);

    expect((await svc.getMyBids('carol'))[0]).toMatchObject({ outcome: 'won', myBid: 15 });
    // The losing bidder keeps a history entry — refunded, but still a record that they took part.
    expect((await svc.getMyBids('bob'))[0]).toMatchObject({ outcome: 'lost', myBid: 12 });
  });

  it('a buyout win settles immediately and reads as `won`', async () => {
    const v = await listAuction(10, 1, { buyoutPrice: 18 });
    await svc.placeBid('bob', v.auctionId, 18);
    expect((await svc.getMyBids('bob'))[0]).toMatchObject({ outcome: 'won', myBid: 18 });
  });

  it('ordering: live listings first (soonest to end), then closed history newest-first', async () => {
    const soon = await listAuction(10);
    const later = await listAuction(10);
    const closed = await listAuction(10);
    await mongo!.collections.auctions.updateOne({ _id: later.auctionId }, { $set: { expireAt: nowMs + DUR * 1000 * 2 } });

    // Bid on the closed one FIRST so a naive "newest bid first" ordering would put it at the top.
    await svc.placeBid('bob', closed.auctionId, 12);
    nowMs += 1000;
    await svc.placeBid('bob', later.auctionId, 12);
    nowMs += 1000;
    await svc.placeBid('bob', soon.auctionId, 12);

    await mongo!.collections.auctions.updateOne({ _id: closed.auctionId }, { $set: { expireAt: nowMs - 1000 } });
    await svc.processExpiredAuctions();

    const bids = await svc.getMyBids('bob');
    expect(bids.map((b) => b.auction.auctionId)).toEqual([soon.auctionId, later.auctionId, closed.auctionId]);
  });

  it('a bid row whose listing has already been purged is dropped, not surfaced as a stub', async () => {
    const v = await listAuction(10);
    await svc.placeBid('bob', v.auctionId, 12);
    await mongo!.collections.auctions.deleteOne({ _id: v.auctionId });
    expect(await svc.getMyBids('bob')).toEqual([]);
  });

  it('the row TTL is anchored to the LISTING expiry, not the bid timestamp', async () => {
    const v = await listAuction(10);
    await svc.placeBid('bob', v.auctionId, 12);
    const row = await mongo!.collections.auctionBids.findOne({ _id: bidRowId(v.auctionId, 'bob') });
    const doc = await mongo!.collections.auctions.findOne({ _id: v.auctionId });
    // Anchoring to the bid instead would expire the row up to a full listing duration before
    // purgeClosedListings drops the listing — blanking My Bids while My Listings still shows the trade.
    expect(row!.purgeAt.getTime()).toBe(doc!.expireAt + AUCTION_CLOSED_RETENTION_SEC * 1000);
    expect(row!.purgeAt.getTime()).toBeGreaterThan(row!.ts + AUCTION_CLOSED_RETENTION_SEC * 1000);
  });

  it('buying a fixed-price listing is not a bid and records nothing', async () => {
    const v = await svc.createAuction({
      sellerId: 'alice', itemType: 'material', item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    });
    await svc.buyAuction('bob', v.auctionId);
    expect(await svc.getMyBids('bob')).toEqual([]);
  });

  it('a bid that loses its CAS is refunded and leaves no record behind', async () => {
    const v = await listAuction(10);
    // Slip carol's winning bid in between bob's read and his own compare-and-swap: bob's escrow is
    // refunded by the journal's compensation, so a row for him would claim a bid whose coins came back.
    let fired = false;
    const patched = new Proxy(mongo!.collections.auctions, {
      get(target, prop, receiver) {
        if (prop !== 'findOneAndUpdate') return Reflect.get(target, prop, receiver);
        return async (...args: unknown[]) => {
          if (!fired) {
            fired = true;
            await svc.placeBid('carol', v.auctionId, 20);
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target.findOneAndUpdate as any)(...args);
        };
      },
    });
    const racing = new AuctionService({
      cols: { ...mongo!.collections, auctions: patched }, commercial, meta, mail, now: () => nowMs,
    });
    await expect(racing.placeBid('bob', v.auctionId, 15)).rejects.toMatchObject({ code: 'AUCTION_CLOSED' });

    expect(await svc.getMyBids('bob')).toEqual([]);
    expect((await svc.getMyBids('carol'))[0]).toMatchObject({ outcome: 'leading', myBid: 20 });
  });

  it('the fetch cap never drops a live listing in favour of newer closed history', async () => {
    // An active trader can bid on more listings within the retention window than the cap returns
    // (AUCTION_DAILY_BUY_CAP × 30 days ≫ MY_BIDS_FETCH_LIMIT), and my last bid on a listing I'm still in
    // can be old — I bid once at the start and anti-snipe keeps it open while others fight over it. A
    // fetch ordered by bid time would then hand back a full page of closed history and silently omit the
    // one listing still worth acting on, which is the exact failure this endpoint exists to fix.
    const live = await listAuction(10);
    await svc.placeBid('bob', live.auctionId, 12);

    // …then MY_BIDS_FETCH_LIMIT closed listings, every one of them bid on LATER than the live one.
    const closedDocs = [];
    const closedRows = [];
    for (let i = 0; i < MY_BIDS_FETCH_LIMIT; i++) {
      const id = `a:filler:${i}`;
      closedDocs.push({
        _id: id, sellerId: 'alice', itemType: 'material', item: { material: 'scrap' }, qty: 1,
        price: 10, currency: 'coins', expireAt: nowMs - 1000, status: 'sold' as const, buyerId: 'zoe',
        saleMode: 'auction' as const, startPrice: 10, closedAt: nowMs - 1000, settledAt: nowMs - 1000, rev: 1,
      });
      closedRows.push({
        _id: bidRowId(id, 'bob'), auctionId: id, bidderId: 'bob', amount: 10, total: 10, bids: 1,
        ts: nowMs + 1000 + i, // newer than the live listing's bid
        purgeAt: new Date(nowMs - 1000 + AUCTION_CLOSED_RETENTION_SEC * 1000),
      });
    }
    await mongo!.collections.auctions.insertMany(closedDocs);
    await mongo!.collections.auctionBids.insertMany(closedRows);

    const bids = await svc.getMyBids('bob');
    expect(bids).toHaveLength(MY_BIDS_FETCH_LIMIT);
    expect(bids[0]!.auction.auctionId).toBe(live.auctionId);
    expect(bids[0]!.outcome).toBe('leading');
  });

  it('bidders only ever see their own rows', async () => {
    const v = await listAuction(10);
    await svc.placeBid('bob', v.auctionId, 12);
    await svc.placeBid('carol', v.auctionId, 15);
    expect((await svc.getMyBids('bob')).every((b) => b.myBid === 12)).toBe(true);
    expect(await svc.getMyBids('dave')).toEqual([]);
  });
});
