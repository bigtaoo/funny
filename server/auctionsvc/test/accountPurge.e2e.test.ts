// Account-deletion purge (POST /internal/accounts/:accountId/purge) end-to-end against a real Mongo.
//
// What this pins: the purge must never cost a counterparty anything. Every `done:false` case below is a
// trade still settling through the normal scheduler (a bidder's escrowed coins, an owed refund, a hand-over
// in flight), and each asserts that the counterparty's documents survive untouched. The `done:true` cases
// pin what IS dropped (daily counters, bid rows, the seller's own settled history) and what is left for
// the other party (listings where the deleted account was only the buyer).
//
// Requires `cd server && docker compose up -d` (or falls back to mongodb-memory-server via globalSetup).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';
import { AUCTION_DURATIONS_SEC, SlgError } from '@nw/shared';
import { createAuctionMongo, type AuctionDoc, type AuctionMongo, type AuctionOrderDoc } from '../src/db';
import { AuctionService } from '../src/auctionService';
import { startHttpApi } from '../src/httpApi';
import type { AuctionCommercialClient } from '../src/commercialClient';
import type { AuctionMetaClient } from '../src/metaClient';
import type { AuctionMailClient } from '../src/mailClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_auction_account_purge_e2e_test';
const INTERNAL_KEY = 'test-internal-key';

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
  console.warn(`[auctionsvc.accountPurge.e2e] Mongo unreachable (${URI}) — skipping.`);
}

describe.skipIf(!mongo)('AuctionService.purgeAccount e2e', () => {
  const mails: Array<{ to: string }> = [];
  const commercial: AuctionCommercialClient = { available: true, async spend() { /* always affordable */ } };
  const mail: AuctionMailClient = {
    available: true,
    async sendSystemMail(to: string) { mails.push({ to }); },
  } as unknown as AuctionMailClient;
  const meta: AuctionMetaClient = {
    available: true,
    async deductMaterial() { /* seller has stock */ },
    async grantMaterial() { /* unused */ },
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
    const c = mongo!.collections;
    await Promise.all([
      c.auctions.deleteMany({}), c.auctionDaily.deleteMany({}), c.auctionPrices.deleteMany({}),
      c.auctionOrders.deleteMany({}), c.auctionBids.deleteMany({}),
    ]);
    mails.length = 0;
    nowMs = Date.now();
    svc = new AuctionService({ cols: mongo!.collections, commercial, meta, mail, now: () => nowMs });
  });

  afterAll(async () => { await mongo?.close(); });

  /** A hand-built listing doc — lets each case pin exactly one state without driving a whole flow. */
  const listing = (id: string, over: Partial<AuctionDoc>): AuctionDoc => ({
    _id: id, sellerId: 'alice', itemType: 'material', item: { material: 'scrap' }, qty: 1, price: 10,
    currency: 'coins', expireAt: nowMs + 3600_000, status: 'open', rev: 0, ...over,
  });

  const pendingRow = (id: string, over: Partial<AuctionOrderDoc>): AuctionOrderDoc => ({
    _id: id, auctionId: 'a:x', kind: 'bid', actorId: 'bob', status: 'pending', steps: [], prefix: 0,
    done: {}, started: {}, decided: true, compensation: [], cycle: 0, claimedAt: nowMs, attempts: 0,
    nextAttemptAt: nowMs, ts: nowMs, ...over,
  });

  it('closes the seller\'s no-bid listings without returning the item, stamping settledAt', async () => {
    const v = await svc.createAuction({
      sellerId: 'alice', itemType: 'material', item: { material: 'scrap' }, qty: 2, price: 10, durationSec: DUR,
    });
    mails.length = 0;

    const r = await svc.purgeAccount('alice');
    expect(r.done).toBe(true);
    expect(r.removed.cancelledListings).toBe(1);

    // No return mail went out, and the journal sweep's repair pass has nothing to rebuild.
    expect(mails).toEqual([]);
    expect(await svc.sweepSettlements()).toEqual({ resumed: 0, repaired: 0 });
    // The closed + settled listing is then the seller's own history and is deleted in the same run.
    expect(r.removed.closedListings).toBe(1);
    expect(await mongo!.collections.auctions.findOne({ _id: v.auctionId })).toBeNull();
  });

  it('seller listing with a bid → done:false, listing and the bidder\'s escrow untouched', async () => {
    await mongo!.collections.auctions.insertOne(listing('a:1', {
      saleMode: 'auction', startPrice: 10, topBid: { bidderId: 'bob', amount: 12, ts: nowMs },
    }));
    const r = await svc.purgeAccount('alice');
    expect(r.done).toBe(false);
    expect(r.pending).toMatchObject({ sellerListingsWithBids: 1 });
    expect(r.removed.cancelledListings).toBe(0);
    expect(await mongo!.collections.auctions.findOne({ _id: 'a:1' })).toMatchObject({ status: 'open', rev: 0 });
  });

  it('account is the leading bidder on someone else\'s listing → done:false', async () => {
    await mongo!.collections.auctions.insertOne(listing('a:2', {
      sellerId: 'carol', saleMode: 'auction', topBid: { bidderId: 'alice', amount: 12, ts: nowMs },
    }));
    const r = await svc.purgeAccount('alice');
    expect(r).toMatchObject({ done: false, pending: { leadingBids: 1 } });
  });

  it('a pending journal row owing the account (outbid refund) → done:false, bid rows kept', async () => {
    await mongo!.collections.auctionOrders.insertOne(pendingRow('o:1', {
      steps: [{ name: 'refund', key: 'k', op: 'mailCoins', accountId: 'alice', amount: 12, reason: 'refund' }],
    }));
    await mongo!.collections.auctionBids.insertOne({
      _id: 'a:x|alice', auctionId: 'a:x', bidderId: 'alice', amount: 12, total: 12, bids: 1, ts: nowMs,
      purgeAt: new Date(nowMs + 3600_000),
    });
    const r = await svc.purgeAccount('alice');
    expect(r).toMatchObject({ done: false, pending: { pendingSettlements: 1 } });
    expect(await mongo!.collections.auctionBids.countDocuments({ bidderId: 'alice' })).toBe(1);

    // Once the row goes terminal the purge completes.
    await mongo!.collections.auctionOrders.updateOne({ _id: 'o:1' }, { $set: { status: 'done' } });
    const r2 = await svc.purgeAccount('alice');
    expect(r2).toMatchObject({ done: true, removed: { auctionBids: 1 } });
    // Terminal journal rows are left to their own TTL (settlement audit trail).
    expect(await mongo!.collections.auctionOrders.countDocuments({ _id: 'o:1' })).toBe(1);
  });

  it('a pending row naming the account only as an unclaim buyer or compensation recipient → done:false', async () => {
    await mongo!.collections.auctionOrders.insertOne(pendingRow('o:2', {
      actorId: 'carol',
      compensation: [{ name: 'unclaim', key: 'k', op: 'unclaim', auctionId: 'a:x', buyerId: 'alice' }],
    }));
    expect(await svc.purgeAccount('alice')).toMatchObject({ done: false, pending: { pendingSettlements: 1 } });
  });

  it('no-bid listing with an in-flight journal row is not closed', async () => {
    await mongo!.collections.auctions.insertOne(listing('a:3', {}));
    await mongo!.collections.auctionOrders.insertOne(pendingRow('o:3', { auctionId: 'a:3', kind: 'list', actorId: 'alice' }));
    const r = await svc.purgeAccount('alice');
    expect(r).toMatchObject({ done: false, removed: { cancelledListings: 0 }, pending: { sellerListingsInFlight: 1, pendingSettlements: 1 } });
    expect(await mongo!.collections.auctions.findOne({ _id: 'a:3' })).toMatchObject({ status: 'open' });
  });

  it('closed listing involving the account with no settledAt → done:false (as seller or buyer)', async () => {
    await mongo!.collections.auctions.insertOne(listing('a:4', { sellerId: 'carol', buyerId: 'alice', status: 'sold', closedAt: nowMs }));
    expect(await svc.purgeAccount('alice')).toMatchObject({ done: false, pending: { unsettledListings: 1 } });
    await mongo!.collections.auctions.updateOne({ _id: 'a:4' }, { $set: { settledAt: nowMs } });
    expect((await svc.purgeAccount('alice')).done).toBe(true);
  });

  it('done: deletes daily/bids/own settled history; keeps other parties\' listings; idempotent', async () => {
    const c = mongo!.collections;
    await c.auctionDaily.insertOne({ _id: 'alice:2026-09-29', accountId: 'alice', dayKey: '2026-09-29', lists: 1, buys: 0, expiresAt: new Date(nowMs + 86400_000) });
    await c.auctionDaily.insertOne({ _id: 'bob:2026-09-29', accountId: 'bob', dayKey: '2026-09-29', lists: 1, buys: 0, expiresAt: new Date(nowMs + 86400_000) });
    await c.auctionBids.insertOne({ _id: 'a:9|alice', auctionId: 'a:9', bidderId: 'alice', amount: 1, total: 1, bids: 1, ts: nowMs, purgeAt: new Date(nowMs + 3600_000) });
    await c.auctionBids.insertOne({ _id: 'a:9|bob', auctionId: 'a:9', bidderId: 'bob', amount: 1, total: 1, bids: 1, ts: nowMs, purgeAt: new Date(nowMs + 3600_000) });
    await c.auctions.insertMany([
      listing('a:own-sold', { status: 'sold', buyerId: 'bob', closedAt: nowMs, settledAt: nowMs }),
      listing('a:own-expired', { status: 'expired', closedAt: nowMs, settledAt: nowMs }),
      listing('a:bought', { sellerId: 'carol', buyerId: 'alice', status: 'sold', closedAt: nowMs, settledAt: nowMs }),
      listing('a:designated', { sellerId: 'carol', designatedBuyerId: 'alice' }),
    ]);

    const r = await svc.purgeAccount('alice');
    expect(r).toEqual({ done: true, removed: { cancelledListings: 0, auctionDaily: 1, auctionBids: 1, closedListings: 2 } });
    expect(await c.auctionDaily.countDocuments({ accountId: 'bob' })).toBe(1);
    expect(await c.auctionBids.countDocuments({ bidderId: 'bob' })).toBe(1);
    expect((await c.auctions.find({}).toArray()).map((d) => d._id).sort()).toEqual(['a:bought', 'a:designated']);

    const again = await svc.purgeAccount('alice');
    expect(again).toEqual({ done: true, removed: { cancelledListings: 0, auctionDaily: 0, auctionBids: 0, closedListings: 0 } });
  });

  describe('HTTP', () => {
    async function start(): Promise<{ base: string; close: () => void }> {
      const server = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: 'test-secret', internalKey: INTERNAL_KEY }, svc);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
    }

    it('401 without X-Internal-Key, nothing touched', async () => {
      await mongo!.collections.auctions.insertOne(listing('a:5', {}));
      const { base, close } = await start();
      try {
        const res = await fetch(`${base}/internal/accounts/alice/purge`, { method: 'POST' });
        expect(res.status).toBe(401);
        expect(await mongo!.collections.auctions.findOne({ _id: 'a:5' })).toMatchObject({ status: 'open' });
      } finally { close(); }
    });

    it('with key: returns the ok() envelope', async () => {
      await mongo!.collections.auctions.insertOne(listing('a:6', {}));
      const { base, close } = await start();
      try {
        const res = await fetch(`${base}/internal/accounts/alice/purge`, { method: 'POST', headers: { 'x-internal-key': INTERNAL_KEY } });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          ok: true,
          data: { done: true, removed: { cancelledListings: 1, auctionDaily: 0, auctionBids: 0, closedListings: 1 } },
        });
      } finally { close(); }
    });
  });
});
