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
//   2. AuctionServiceTrade really calls the INJECTED pricing AND journal instances.
//   3. The top-level AuctionService facade shares exactly one AuctionServicePricing / one
//      AuctionOrderJournal across every sibling that needs them (identity check) — the concrete
//      bug class this guards against: a future edit passing `new AuctionServicePricing(deps)` at two
//      different call sites in the assembly shell instead of reusing the one field.
//
// 2026-08-24 (U13 close-out): the injected dependency create.ts/trade.ts reach for is now
// AuctionOrderJournal rather than AuctionServiceDelivery — delivery.ts moved behind journalSteps.ts, so
// the facade no longer holds it at all. The journal is the sharing-sensitive one now: two instances would
// each build their own step runner, which is harmless in itself, but they would also both drive the same
// rows, and the `claimedAt` CAS that keeps resumers from colliding is per-row, not per-instance.
// No Mongo: everything here uses hand-built collection/client fakes, same style as
// get-teams-card-lookup.test.ts / occupation-battle.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { AUCTION_DURATIONS_SEC } from '@nw/shared';
import { AuctionServicePricing } from '../src/auctionService/pricing';
import { AuctionOrderJournal } from '../src/auctionService/journal';
import { AuctionServiceCreate } from '../src/auctionService/create';
import { AuctionServiceTrade } from '../src/auctionService/trade';
import { AuctionService } from '../src/auctionService';
import type { AuctionServiceDeps } from '../src/auctionService/base';
import type { AuctionDoc } from '../src/db';

/** Assign through a dotted path (`done.spend`), the shape the journal's point-path progress writes use. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof cur[part] !== 'object' || cur[part] === null) cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = value;
}

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
        // The journal stamps `settledAt` here once a listing-closing flow completes.
        updateOne: vi.fn(async (q: { _id: string }, u: { $set: Partial<AuctionDoc> }) => {
          const doc = auctions.get(q._id);
          if (doc) auctions.set(q._id, { ...doc, ...u.$set });
          return {};
        }),
      },
      auctionDaily: {
        findOneAndUpdate: vi.fn(async () => ({ lists: 1, buys: 1 })),
        updateOne: vi.fn(async () => ({})),
      },
      auctionPrices: {
        findOne: vi.fn(async () => null), // cold-start pass-through — checkPriceGuard/refPrice always no-op
        updateOne: vi.fn(async () => ({})),
      },
      // Settlement journal: an in-memory stand-in good enough for one row per flow (insert-first plus
      // point-path progress writes). No unique-index simulation — these tests exercise wiring, not the
      // dedupe itself, which journal-atomicity.e2e.test.ts covers against real Mongo.
      auctionOrders: (() => {
        const orders = new Map<string, Record<string, unknown>>();
        return {
          insertOne: vi.fn(async (doc: { _id: string }) => { orders.set(doc._id, { ...doc }); return { insertedId: doc._id }; }),
          findOne: vi.fn(async (q: { _id: string }) => orders.get(q._id) ?? null),
          updateOne: vi.fn(async (q: { _id: string }, u: Record<string, Record<string, unknown>>) => {
            const row = orders.get(q._id);
            if (row) for (const [k, v] of Object.entries(u['$set'] ?? {})) setPath(row, k, v);
            return {};
          }),
          findOneAndUpdate: vi.fn(async () => null),
        };
      })(),
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
    const create = new AuctionServiceCreate(deps, pricing, new AuctionOrderJournal(deps));

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

  it('AuctionServiceTrade.buyAuction reaches the INJECTED pricing AND journal instances', async () => {
    const deps = fakeDeps();
    const pricing = new AuctionServicePricing(deps);
    const journal = new AuctionOrderJournal(deps);
    const bumpDailySpy = vi.spyOn(pricing, 'bumpDaily');
    const recordSoldPriceSpy = vi.spyOn(pricing, 'recordSoldPrice');
    const beginSpy = vi.spyOn(journal, 'begin');
    const finalizeSpy = vi.spyOn(journal, 'finalize');

    // Seed one open listing directly (bypasses createAuction — this test targets trade.ts's wiring, not create.ts's).
    const doc: AuctionDoc = {
      _id: 'a:seller-1:1:1', sellerId: 'seller-1', itemType: 'material', item: { material: 'scrap' },
      qty: 5, price: 10, currency: 'coins', expireAt: 2_000_000, status: 'open', saleMode: 'fixed', rev: 0,
    };
    await deps.cols.auctions.insertOne(doc);
    const trade = new AuctionServiceTrade(deps, pricing, journal);

    await trade.buyAuction('buyer-1', doc._id);

    expect(bumpDailySpy).toHaveBeenCalledWith('buyer-1', 'buys', expect.any(Number));
    // The purchase key must carry the buyer, not just the listing: `auction_buy:{id}` alone made two
    // racing buyers collide on commercial's per-orderId account binding.
    expect(beginSpy).toHaveBeenCalledWith(
      expect.stringContaining(doc._id + ':buyer-1'), 'buy', doc._id, 'buyer-1', expect.any(Function),
    );
    expect(finalizeSpy).toHaveBeenCalled();
    // The hand-overs are journal steps now, so assert the plan the journal was handed carries both.
    const plan = beginSpy.mock.calls[0]![4](0);
    expect(plan.steps.map((st) => st.op)).toEqual(['spend', 'mailItem', 'mailCoins']);
    expect(plan.compensation.map((st) => st.op)).toEqual(['unclaim']);
    expect(recordSoldPriceSpy).toHaveBeenCalledWith('material:scrap', 10);
  });

  it('the AuctionService facade shares exactly one pricing/journal instance across every sibling that needs it', () => {
    const svc = new AuctionService(fakeDeps());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = svc as any;
    // create.ts and trade.ts must both hold the SAME pricing instance the facade itself holds — not
    // two independently-constructed ones (which would silently split the daily-cap/price-window state).
    expect(s.create.pricing).toBe(s.pricing);
    expect(s.trade.pricing).toBe(s.pricing);
    // Same for the journal: create, trade and the sweep must all drive rows through one instance.
    expect(s.create.journal).toBe(s.journal);
    expect(s.trade.journal).toBe(s.journal);
    expect(s.journalSweep.journal).toBe(s.journal);
  });
});
