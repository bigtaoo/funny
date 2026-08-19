// Regression coverage for the 2026-08-11 AuctionService re-audit: converting the linear
// inheritance chain (base→pricing→delivery→listing→create→trade→audit) into composition means
// create.ts/trade.ts now reach pricing.ts/delivery.ts through an INJECTED reference
// (`this.pricing.xxx(...)`/`this.delivery.xxx(...)`) instead of inherited `this.xxx(...)`. That's
// exactly the kind of change existing e2e tests (auction.e2e.test.ts etc.) don't specifically pin —
// they exercise the full business behavior and would still pass if, say, `AuctionService`'s
// constructor accidentally built two independent `AuctionServicePricing` instances instead of
// sharing one (the daily-cap/price-guard state each holds would just look "reset", which the e2e
// suite's own account/day setup mostly hides). These tests target the wiring itself:
//   1. AuctionServiceCreate really calls the INJECTED pricing instance's bumpDaily/checkPriceGuard
//      (not a no-op / detached copy) — proven by asserting the shared instance's own state changed.
//   2. AuctionServiceTrade really calls the INJECTED pricing AND delivery instances.
//   3. The top-level AuctionService facade shares exactly one AuctionServicePricing / one
//      AuctionServiceDelivery across every sibling that needs them (identity check) — the concrete
//      bug class this guards against: a future edit passing `new AuctionServicePricing(deps)` at two
//      different call sites in the assembly shell instead of reusing the one field.
// No Mongo: everything here uses hand-built collection/client fakes, same style as
// get-teams-card-lookup.test.ts / occupation-battle.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { AUCTION_DURATIONS_SEC } from '@nw/shared';
import { AuctionServicePricing } from '../src/auctionService/pricing';
import { AuctionServiceDelivery } from '../src/auctionService/delivery';
import { AuctionServiceCreate } from '../src/auctionService/create';
import { AuctionServiceTrade } from '../src/auctionService/trade';
import { AuctionService } from '../src/auctionService';
import type { AuctionServiceDeps } from '../src/auctionService/base';
import type { AuctionDoc } from '../src/db';

/** Minimal `AuctionServiceDeps` — enough for one createAuction(material) + one buyAuction() call. */
function fakeDeps(overrides: Partial<AuctionServiceDeps> = {}): AuctionServiceDeps {
  const auctions = new Map<string, AuctionDoc>();
  return {
    now: () => 1_000_000,
    cols: {
      auctions: {
        countDocuments: vi.fn(async () => 0),
        insertOne: vi.fn(async (doc: AuctionDoc) => { auctions.set(doc._id, doc); return { insertedId: doc._id }; }),
        findOne: vi.fn(async (q: { _id: string }) => auctions.get(q._id) ?? null),
        findOneAndUpdate: vi.fn(async (q: { _id: string }, update: { $set: Partial<AuctionDoc> }) => {
          const doc = auctions.get(q._id);
          if (!doc) return null;
          const updated = { ...doc, ...update.$set };
          auctions.set(q._id, updated);
          return updated;
        }),
        deleteOne: vi.fn(async (q: { _id: string }) => { auctions.delete(q._id); return { deletedCount: 1 }; }),
      },
      auctionDaily: {
        findOneAndUpdate: vi.fn(async () => ({ lists: 1, buys: 1 })),
        updateOne: vi.fn(async () => ({})),
      },
      auctionPrices: {
        findOne: vi.fn(async () => null), // cold-start pass-through — checkPriceGuard/refPrice always no-op
        updateOne: vi.fn(async () => ({})),
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    commercial: { available: true, spend: vi.fn(async () => {}) },
    meta: {
      available: true,
      deductMaterial: vi.fn(async () => {}),
      grantMaterial: vi.fn(async () => {}),
      escrowEquipment: vi.fn(),
      grantEquipment: vi.fn(async () => {}),
      escrowCard: vi.fn(),
      grantCard: vi.fn(async () => {}),
      escrowSkin: vi.fn(),
      grantSkin: vi.fn(async () => {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    mail: { available: true, sendSystemMail: vi.fn(async () => {}) },
    ...overrides,
  };
}

describe('AuctionService composition wiring (2026-08-11 chain→composition re-audit)', () => {
  it('AuctionServiceCreate.createAuction reaches the INJECTED pricing instance\'s bumpDaily/checkPriceGuard', async () => {
    const deps = fakeDeps();
    const pricing = new AuctionServicePricing(deps);
    const bumpDailySpy = vi.spyOn(pricing, 'bumpDaily');
    const checkPriceGuardSpy = vi.spyOn(pricing, 'checkPriceGuard');
    const create = new AuctionServiceCreate(deps, pricing);

    await create.createAuction({
      sellerId: 'seller-1',
      itemType: 'material',
      item: { material: 'scrap' },
      qty: 5,
      price: 10,
      durationSec: AUCTION_DURATIONS_SEC[0]!,
    });

    expect(bumpDailySpy).toHaveBeenCalledWith('seller-1', 'lists', expect.any(Number));
    expect(checkPriceGuardSpy).toHaveBeenCalledWith('material:scrap', 10);
  });

  it('AuctionServiceTrade.buyAuction reaches the INJECTED pricing AND delivery instances', async () => {
    const deps = fakeDeps();
    const pricing = new AuctionServicePricing(deps);
    const delivery = new AuctionServiceDelivery(deps);
    const bumpDailySpy = vi.spyOn(pricing, 'bumpDaily');
    const recordSoldPriceSpy = vi.spyOn(pricing, 'recordSoldPrice');
    const deliverItemSpy = vi.spyOn(delivery, 'deliverItem');
    const deliverCoinsSpy = vi.spyOn(delivery, 'deliverCoins');

    // Seed one open listing directly (bypasses createAuction — this test targets trade.ts's wiring, not create.ts's).
    const doc: AuctionDoc = {
      _id: 'a:seller-1:1:1', sellerId: 'seller-1', itemType: 'material', item: { material: 'scrap' },
      qty: 5, price: 10, currency: 'coins', expireAt: 2_000_000, status: 'open', saleMode: 'fixed', rev: 0,
    };
    await deps.cols.auctions.insertOne(doc);
    const trade = new AuctionServiceTrade(deps, pricing, delivery);

    await trade.buyAuction('buyer-1', doc._id);

    expect(bumpDailySpy).toHaveBeenCalledWith('buyer-1', 'buys', expect.any(Number));
    expect(deliverItemSpy).toHaveBeenCalledWith('buyer-1', doc, expect.stringContaining(doc._id), 'sold');
    expect(deliverCoinsSpy).toHaveBeenCalledWith(doc.sellerId, expect.any(Number), expect.any(String), 'proceeds');
    expect(recordSoldPriceSpy).toHaveBeenCalledWith('material:scrap', 10);
  });

  it('the AuctionService facade shares exactly one pricing/delivery instance across every sibling that needs it', () => {
    const svc = new AuctionService(fakeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = svc as any;
    // create.ts and trade.ts must both hold the SAME pricing instance the facade itself holds — not
    // two independently-constructed ones (which would silently split the daily-cap/price-window state).
    expect(s.create.pricing).toBe(s.pricing);
    expect(s.trade.pricing).toBe(s.pricing);
    // Only trade.ts needs delivery.ts.
    expect(s.trade.delivery).toBe(s.delivery);
  });
});
