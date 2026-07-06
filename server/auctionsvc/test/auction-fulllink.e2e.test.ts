// Auction full-link E2E (client → server): drives the REAL client network layer
// (client/src/net/WorldApiClient — the exact code the browser/wechat build ships)
// against a REAL auctionsvc HTTP server (startHttpApi) backed by mongodb-memory-server.
// Only the downstream services (commercial coins / meta materials / system mail) are
// stubbed — same seam the AuctionService unit e2e already stubs. This closes the gap
// the service-layer e2e (auction.e2e.test.ts, calls AuctionService directly) and the
// client UI unit test (client/test/ui/auctionScene.ui.ts, mocks WorldApiClient) both
// leave open: nobody exercises the real client HTTP client → real HTTP → real service.
//
// What it proves round-trips through the whole seam:
//   • JWT auth (client Bearer header → auctionsvc verifyToken → accountId)
//   • the ApiResp { ok, data } envelope (client unwraps data / maps { ok:false } → WorldApiError)
//   • the generated openapi-auction DTO contract (AuctionView shape survives the wire)
//   • create / list / mine / buy / bid+buyout / cancel + a couple of error-code mappings
//
// Requires Mongo (globalSetup spins up a standalone mongod; falls back + skips if down).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUCTION_DURATIONS_SEC,
  AUCTION_TAX_RATE,
  SlgError,
  signToken,
  type EquipmentInstance,
  type CardInstance,
} from '@nw/shared';
import { createAuctionMongo, type AuctionMongo } from '../src/db';
import { AuctionService } from '../src/auctionService';
import { startHttpApi } from '../src/httpApi';
import type { AuctionCommercialClient } from '../src/commercialClient';
import type { AuctionMetaClient } from '../src/metaClient';
import type { AuctionMailClient, AuctionMailContent } from '../src/mailClient';
// The REAL client network layer — imported straight from the client package source.
// WorldApiClient's only runtime dependency is ./config (pure fns); DTO types are
// type-only, so this pulls in no PIXI / no @nw/shared at runtime.
import { WorldApiClient, WorldApiError } from '../../../client/src/net/WorldApiClient';
import type { IStorage } from '../../../client/src/platform/IPlatform';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_auction_fulllink_e2e_test';
const SECRET = 'fulllink-test-secret';
const DUR = AUCTION_DURATIONS_SEC[0]!;

async function tryConnect(): Promise<AuctionMongo | null> {
  try {
    return await createAuctionMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[auctionsvc.auction-fulllink.e2e] Mongo unreachable (${URI}) — skipping.`);
}

describe.skipIf(!mongo)('Auction full-link E2E (real WorldApiClient → real auctionsvc HTTP)', () => {
  // ── Downstream stubs (coins / materials / mail), tracked for assertions ──
  const spends: Array<{ account: string; amount: number; orderId: string }> = [];
  const grants: Array<{ account: string; amount: number; orderId: string }> = [];
  const materialDeducts: Array<{ account: string; material: string; qty: number }> = [];
  const mails: Array<{ account: string; dispatchKey: string; content: AuctionMailContent }> = [];

  const commercial: AuctionCommercialClient = {
    available: true,
    async spend(accountId, amount, orderId) { spends.push({ account: accountId, amount, orderId }); },
    async grant(accountId, amount, orderId) { grants.push({ account: accountId, amount, orderId }); },
  };

  const notNeeded = (what: string): never => { throw new SlgError('BAD_REQUEST', `${what} not exercised by full-link test`); };
  const meta: AuctionMetaClient = {
    available: true,
    async deductMaterial(accountId, material, qty) { materialDeducts.push({ account: accountId, material, qty }); },
    async grantMaterial() { /* material delivery goes through mail (escrow-out), not direct grant */ },
    async escrowEquipment(): Promise<EquipmentInstance> { return notNeeded('escrowEquipment'); },
    async grantEquipment() { notNeeded('grantEquipment'); },
    async escrowCard(): Promise<CardInstance> { return notNeeded('escrowCard'); },
    async grantCard() { notNeeded('grantCard'); },
    async escrowSkin(): Promise<string> { return notNeeded('escrowSkin'); },
    async grantSkin() { notNeeded('grantSkin'); },
  };

  const mail: AuctionMailClient = {
    available: true,
    async sendSystemMail(accountId, dispatchKey, content) { mails.push({ account: accountId, dispatchKey, content }); },
  };

  let server: import('http').Server;
  let base = '';

  /** A real WorldApiClient whose storage returns a signed JWT for the given account. */
  const clientFor = (accountId: string): WorldApiClient => {
    const token = signToken(accountId, { secret: SECRET });
    const storage: IStorage = { getItem: (k) => (k === 'nw_token' ? token : null), setItem() {}, removeItem() {} };
    return new WorldApiClient(storage);
  };

  beforeAll(async () => {
    const svc = new AuctionService({ cols: mongo!.collections, commercial, meta, mail, now: () => Date.now() });
    server = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: 'test-internal-key' }, svc);
    if (!server.listening) await new Promise<void>((r) => server.once('listening', () => r()));
    const port = (server.address() as import('net').AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    // getWorldBaseUrl() reads this global; the client's /auction/* calls resolve here.
    (globalThis as { __NW_WORLD_BASE__?: string }).__NW_WORLD_BASE__ = base;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await mongo?.close();
    delete (globalThis as { __NW_WORLD_BASE__?: string }).__NW_WORLD_BASE__;
  });

  beforeEach(async () => {
    await mongo!.collections.auctions.deleteMany({});
    await mongo!.collections.auctionDaily.deleteMany({});
    await mongo!.collections.auctionPrices.deleteMany({});
    spends.length = 0;
    grants.length = 0;
    materialDeducts.length = 0;
    mails.length = 0;
  });

  it('fixed listing round-trips create → list → mine → buy across the wire', async () => {
    const seller = clientFor('seller1');
    const buyer = clientFor('buyer1');

    // create (scrap static ref=10 → guardrail band [5,20]; unit price 10 × qty 2 = 20)
    const view = await seller.createAuction('material', { material: 'scrap' }, 2, DUR, { price: 10 });
    expect(view.auctionId).toBeTruthy();
    expect(view.status).toBe('open');
    expect(view.itemType).toBe('material');
    expect(view.qty).toBe(2);
    expect(view.totalPrice).toBe(20);
    expect(view.saleMode).toBe('fixed');
    expect(view.currency).toBe('coins');
    // seller's materials were deducted server-side (client → HTTP → service → meta stub)
    expect(materialDeducts).toContainEqual({ account: 'seller1', material: 'scrap', qty: 2 });

    // list (public marketplace) + mine (owner view) both see it over the wire
    const list = await buyer.listAuctions({ itemType: 'material' });
    expect(list.some((a) => a.auctionId === view.auctionId)).toBe(true);
    expect((await seller.getMyListings()).map((a) => a.auctionId)).toEqual([view.auctionId]);
    expect(await buyer.getMyListings()).toHaveLength(0);

    // buy: buyer charged, seller paid net of 10% tax, item delivered to buyer via mail
    await buyer.buyAuction(view.auctionId);
    expect(spends).toContainEqual(expect.objectContaining({ account: 'buyer1', amount: 20 }));
    const tax = Math.floor(20 * AUCTION_TAX_RATE);
    expect(grants).toContainEqual(expect.objectContaining({ account: 'seller1', amount: 20 - tax }));
    expect(mails.some((m) => m.account === 'buyer1' && m.dispatchKey.startsWith('auction_buy:'))).toBe(true);

    // and it's gone from the open market
    expect((await buyer.listAuctions()).some((a) => a.auctionId === view.auctionId)).toBe(false);
  });

  it('auction mode: bid raises the top bid, buyout closes it immediately (over the wire)', async () => {
    const seller = clientFor('seller1');
    const bidder = clientFor('buyer1');
    const sniper = clientFor('buyer2');

    const view = await seller.createAuction('material', { material: 'scrap' }, 1, DUR, {
      saleMode: 'auction', startPrice: 10, buyoutPrice: 18,
    });
    expect(view.saleMode).toBe('auction');

    const afterBid = await bidder.placeBid(view.auctionId, 12);
    expect(afterBid.topBid).toMatchObject({ bidderId: 'buyer1', amount: 12 });
    expect(spends).toContainEqual(expect.objectContaining({ account: 'buyer1', amount: 12 })); // escrowed

    // reaching buyoutPrice closes the auction to the sniper; the prior bidder is refunded
    const closed = await sniper.placeBid(view.auctionId, 18);
    expect(closed.status).toBe('sold');
    expect(closed.buyerId).toBe('buyer2');
    expect(grants).toContainEqual(expect.objectContaining({ account: 'buyer1', amount: 12 })); // refund
    expect(mails.some((m) => m.account === 'buyer2' && m.dispatchKey.startsWith('auction_settle:'))).toBe(true);
  });

  it('seller cancels a fixed listing → item mailed back over the wire', async () => {
    const seller = clientFor('seller1');
    const view = await seller.createAuction('material', { material: 'scrap' }, 3, DUR, { price: 5 });
    await seller.cancelAuction(view.auctionId);
    expect(mails.some((m) => m.account === 'seller1' && m.dispatchKey.startsWith('auction_cancel:'))).toBe(true);
    expect((await seller.listAuctions()).some((a) => a.auctionId === view.auctionId)).toBe(false);
  });

  it('server error codes surface as WorldApiError on the client', async () => {
    const seller = clientFor('seller1');
    const view = await seller.createAuction('material', { material: 'scrap' }, 1, DUR, { price: 10 });

    // buying your own listing → BAD_REQUEST, mapped from the { ok:false } envelope
    await expect(seller.buyAuction(view.auctionId)).rejects.toMatchObject({
      name: 'WorldApiError', code: 'BAD_REQUEST',
    });
    // over-ceiling price → PRICE_OUT_OF_RANGE (guardrail band [5,20] for scrap)
    await expect(
      seller.createAuction('material', { material: 'scrap' }, 1, DUR, { price: 999 }),
    ).rejects.toMatchObject({ name: 'WorldApiError', code: 'PRICE_OUT_OF_RANGE' });
  });

  it('a request without a JWT is rejected as UNAUTHENTICATED', async () => {
    const anon = new WorldApiClient({ getItem: () => null, setItem() {}, removeItem() {} });
    const e = await anon.listAuctions().then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(WorldApiError);
    expect((e as WorldApiError).code).toBe('UNAUTHENTICATED');
  });
});
