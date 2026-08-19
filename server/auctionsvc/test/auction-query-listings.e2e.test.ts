// AuctionService.queryListings + getMyListings end-to-end (previously entirely uncovered — this is the
// auctionsvc-side counterpart of admin's slgAudit.slgQueryAuctionListings ops lookup, GET /internal/audit/
// listings; httpApi-routes.test.ts covers the HTTP route wiring with a mocked queryListings, but the real
// implementation in auctionService/listing.ts + its docToAdminView mapping in auctionService/base.ts had
// no coverage of their own: filter-by-sellerId/itemType/status at the DB level, the itemName in-memory
// substring filter over a QUERY_FETCH_CAP-capped fetch, limit clamping, and the derived itemName per
// itemType (material/equipment/card/skin)). Seeds AuctionDoc rows directly (bypassing daily limits/payment
// flows), same convention as auction-audit.e2e.test.ts.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createAuctionMongo, type AuctionMongo, type AuctionDoc } from '../src/db';
import { AuctionService } from '../src/auctionService';
import type { AuctionCommercialClient } from '../src/commercialClient';
import type { AuctionMetaClient } from '../src/metaClient';
import type { AuctionMailClient } from '../src/mailClient';
import type { EquipmentInstance, CardInstance } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_auction_query_listings_e2e_test';

async function tryConnect(): Promise<AuctionMongo | null> {
  try {
    return await createAuctionMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[auctionsvc.query-listings.e2e] Mongo unreachable (${URI}) — skipping.`);

const stubCommercial: AuctionCommercialClient = { available: true, async spend() {} };
const stubMeta: AuctionMetaClient = {
  available: true,
  async deductMaterial() {}, async grantMaterial() {},
  async escrowEquipment() { throw new Error('unused'); }, async grantEquipment() {},
  async escrowCard() { throw new Error('unused'); }, async grantCard() {},
  async escrowSkin() { throw new Error('unused'); }, async grantSkin() {},
};
const stubMail: AuctionMailClient = { available: true, async sendSystemMail() {} };

const EQUIP: EquipmentInstance = { id: 'e1', defId: 'wp_marker', rarity: 'rare', level: 3, affixes: [] };
const CARD: CardInstance = { id: 'c1', defId: 'lichuang', level: 1, gear: {}, locked: false };

function baseDoc(over: Partial<AuctionDoc>): AuctionDoc {
  return {
    _id: `a:${over.sellerId ?? 's'}:1:${Math.random()}`,
    sellerId: 's1', itemType: 'material', item: { material: 'paper' },
    qty: 1, price: 10, currency: 'coins', expireAt: Date.now() + 3600_000, status: 'open', rev: 1,
    ...over,
  };
}

describe.skipIf(!mongo)('AuctionService.queryListings / getMyListings e2e', () => {
  const m = mongo!;
  let svc: AuctionService;

  beforeEach(async () => {
    await m.collections.auctions.deleteMany({});
    svc = new AuctionService({ cols: m.collections, commercial: stubCommercial, meta: stubMeta, mail: stubMail, now: () => Date.now() });
  });
  afterAll(async () => { await m.close(); });

  it('no filters -> returns every doc, mapped through docToAdminView', async () => {
    await m.collections.auctions.insertMany([
      baseDoc({ _id: 'a1', sellerId: 's1', expireAt: 3000 }),
      baseDoc({ _id: 'a2', sellerId: 's2', expireAt: 4000 }),
    ]);
    const views = await svc.queryListings({});
    expect(views.map((v) => v.auctionId).sort()).toEqual(['a1', 'a2']);
  });

  it('sellerId/itemType/status filters are applied at the DB level', async () => {
    await m.collections.auctions.insertMany([
      baseDoc({ _id: 'a1', sellerId: 's1', itemType: 'material', status: 'open' }),
      baseDoc({ _id: 'a2', sellerId: 's2', itemType: 'material', status: 'open' }),
      baseDoc({ _id: 'a3', sellerId: 's1', itemType: 'equipment', item: { instance: EQUIP }, status: 'sold' }),
    ]);
    expect((await svc.queryListings({ sellerId: 's1' })).map((v) => v.auctionId).sort()).toEqual(['a1', 'a3']);
    expect((await svc.queryListings({ itemType: 'equipment' })).map((v) => v.auctionId)).toEqual(['a3']);
    expect((await svc.queryListings({ status: 'sold' })).map((v) => v.auctionId)).toEqual(['a3']);
  });

  it('itemName filters in-memory by the derived display name (case-insensitive substring)', async () => {
    await m.collections.auctions.insertMany([
      baseDoc({ _id: 'a1', itemType: 'material', item: { material: 'paper' } }),
      baseDoc({ _id: 'a2', itemType: 'equipment', item: { instance: EQUIP } }), // defId 'wp_marker'
      baseDoc({ _id: 'a3', itemType: 'card', item: { instance: CARD } }), // defId 'lichuang'
      baseDoc({ _id: 'a4', itemType: 'skin', item: { skinId: 'skin_shop_e1' } }),
    ]);
    expect((await svc.queryListings({ itemName: 'PAPER' })).map((v) => v.auctionId)).toEqual(['a1']);
    expect((await svc.queryListings({ itemName: 'marker' })).map((v) => v.auctionId)).toEqual(['a2']);
    expect((await svc.queryListings({ itemName: 'lichuang' })).map((v) => v.auctionId)).toEqual(['a3']);
    expect((await svc.queryListings({ itemName: 'skin_shop' })).map((v) => v.auctionId)).toEqual(['a4']);
    expect(await svc.queryListings({ itemName: 'nonexistent-item' })).toEqual([]);
  });

  it('limit is clamped to [1, 200]', async () => {
    await m.collections.auctions.insertMany(Array.from({ length: 5 }, (_, i) => baseDoc({ _id: `a${i}`, expireAt: i })));
    expect(await svc.queryListings({ limit: 0 })).toHaveLength(1); // clamped up to the 1 floor
    expect(await svc.queryListings({ limit: 3 })).toHaveLength(3);
    expect(await svc.queryListings({ limit: 9999 })).toHaveLength(5); // clamped down to 200, but only 5 exist
  });

  it('docToAdminView includes optional fields only when present, derives itemName per itemType', async () => {
    await m.collections.auctions.insertMany([
      baseDoc({
        _id: 'a1', itemType: 'equipment', item: { instance: EQUIP }, designatedBuyerId: 'buyer1',
        buyerId: 'buyer1', soldAt: 100, closedAt: 100, status: 'sold', saleMode: 'auction',
        startPrice: 5, buyoutPrice: 50, topBid: { bidderId: 'buyer1', amount: 20, ts: 99 },
      }),
    ]);
    const [view] = await svc.queryListings({});
    expect(view).toMatchObject({
      auctionId: 'a1', itemName: 'wp_marker', designatedBuyerId: 'buyer1', buyerId: 'buyer1',
      soldAt: 100, closedAt: 100, saleMode: 'auction', startPrice: 5, buyoutPrice: 50,
      topBid: { bidderId: 'buyer1', amount: 20, ts: 99 },
    });
  });

  it('docToAdminView omits saleMode-specific/optional fields for a plain fixed-sale listing (defaults saleMode to fixed)', async () => {
    await m.collections.auctions.insertMany([baseDoc({ _id: 'a1' })]);
    const [view] = await svc.queryListings({});
    expect(view!.saleMode).toBe('fixed');
    expect(view).not.toHaveProperty('designatedBuyerId');
    expect(view).not.toHaveProperty('buyerId');
    expect(view).not.toHaveProperty('startPrice');
    expect(view).not.toHaveProperty('topBid');
  });

  it('getMyListings returns only the given seller\'s docs, newest expireAt first', async () => {
    await m.collections.auctions.insertMany([
      baseDoc({ _id: 'a1', sellerId: 's1', expireAt: 1000 }),
      baseDoc({ _id: 'a2', sellerId: 's1', expireAt: 3000 }),
      baseDoc({ _id: 'a3', sellerId: 's2', expireAt: 5000 }),
    ]);
    const mine = await svc.getMyListings('s1');
    expect(mine.map((v) => v.auctionId)).toEqual(['a2', 'a1']);
  });
});
