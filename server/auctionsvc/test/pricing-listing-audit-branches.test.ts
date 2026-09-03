// pricing.ts / listing.ts / audit.ts branch-coverage gap-fill (2026-09-03 branch-gate pass).
// All three files were at 100% lines; what had never run is the same three shapes as everywhere else in
// this pass — an absent-field fallback, a category with no reference price at all, and the legacy
// document the fallback exists for.
import { describe, expect, it } from 'vitest';
import { AUCTION_TAX_RATE, AUDIT_WINDOW_SEC } from '@nw/shared';
import { AuctionServicePricing } from '../src/auctionService/pricing';
import type { AuctionDoc } from '../src/db';
import { mkAuction, NOW, stubDeps } from './stubDeps';

describe('pricing.refPrice: equipment categories that resolve to no reference price', () => {
  it('an equipment category with an empty defId is unguarded (never priced as `equip::0`)', async () => {
    const { svc } = stubDeps({ cols: { auctionPrices: { findOne: async () => null } } });
    expect(await svc.getRefBand('equip::0')).toBeNull();
  });

  it('an equipment category with no level segment reads as level 0 rather than NaN', async () => {
    // `equip:{defId}` (no `:level`) is what a pre-bucketing category string looks like; Number(undefined)
    // would be NaN, which would poison the enhancement-cost term and hence the whole band.
    const { svc } = stubDeps({ cols: { auctionPrices: { findOne: async () => null } } });
    const withoutLevel = await svc.getRefBand('equip:wp_marker');
    const withLevelZero = await svc.getRefBand('equip:wp_marker:0');
    expect(withoutLevel).not.toBeNull();
    expect(withoutLevel).toEqual(withLevelZero);
  });
});

describe('pricing.checkPriceGuard: a category with no reference price passes anything through', () => {
  it('a material with neither a price window nor a static reference price is not rejected', async () => {
    // Cold-start pass-through (AUCTION_DESIGN §4.G): the guardrail can only compare against a reference
    // it actually has, and refusing every unpriced category would make those items untradeable.
    const { deps } = stubDeps({ cols: { auctionPrices: { findOne: async () => null } } });
    await expect(new AuctionServicePricing(deps).checkPriceGuard('material:mystery', 1_000_000)).resolves.toBeUndefined();
  });
});

describe('pricing.bumpDaily: an upsert that answers with no document', () => {
  it('assumes this is the first use of the day rather than treating it as over cap', async () => {
    const { deps } = stubDeps({ cols: { auctionDaily: { findOneAndUpdate: async () => null, updateOne: async () => ({ acknowledged: true }) } } });
    await expect(new AuctionServicePricing(deps).bumpDaily('acc-1', 'buys', 5)).resolves.toBeUndefined();
  });
});

describe('listAuctions: pinning listings designated to the caller', () => {
  it('a listing designated to me sorts ahead of an undesignated one, whatever the DB order was', async () => {
    const undesignated = mkAuction({ _id: 'a:seller-1:1:1', price: 10 });
    const mine = mkAuction({ _id: 'a:seller-2:1:2', sellerId: 'seller-2', price: 90, designatedBuyerId: 'buyer-1' });
    const { svc } = stubDeps({
      cols: {
        auctions: {
          find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [undesignated, mine] }) }) }),
        },
      },
    });
    const views = await svc.listAuctions(undefined, 20, 'buyer-1');
    expect(views.map((v) => v.auctionId)).toEqual(['a:seller-2:1:2', 'a:seller-1:1:1']);
  });

  it('an already-pinned order is left alone (the comparator is stable, not a re-shuffle)', async () => {
    const mine = mkAuction({ _id: 'a:seller-2:1:2', sellerId: 'seller-2', price: 90, designatedBuyerId: 'buyer-1' });
    const undesignated = mkAuction({ _id: 'a:seller-1:1:1', price: 10 });
    const { svc } = stubDeps({
      cols: {
        auctions: {
          find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [mine, undesignated] }) }) }),
        },
      },
    });
    const views = await svc.listAuctions(undefined, 20, 'buyer-1');
    expect(views.map((v) => v.auctionId)).toEqual(['a:seller-2:1:2', 'a:seller-1:1:1']);
  });
});

describe('purgeClosedListings: a delete that reports no count', () => {
  it('reports 0 purged rather than undefined', async () => {
    const { svc } = stubDeps({ cols: { auctions: { deleteMany: async () => ({ acknowledged: true }) } } });
    expect(await svc.purgeClosedListings()).toBe(0);
  });
});

describe('scanAnomalies: the sold documents it has to make sense of', () => {
  const sold = (over: Partial<AuctionDoc>): AuctionDoc =>
    mkAuction({ status: 'sold', soldAt: NOW - 1000, buyerId: 'buyer-1', ...over });

  const withDocs = (docs: AuctionDoc[]) =>
    stubDeps({
      cols: { auctions: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => docs }) }) }) } },
    });

  it('a sold document with no buyerId is skipped — a trade needs two sides to be a pair', async () => {
    const { svc } = withDocs([sold({ buyerId: undefined })]);
    expect(await svc.scanAnomalies(AUDIT_WINDOW_SEC, { minTrades: 1, minCoins: 1 })).toEqual([]);
  });

  it('a legacy document with no soldAt and no timestamp in its id windows out instead of counting as epoch-recent', async () => {
    // soldTs() parses `a:{sellerId}:{ts}:{seq}`; an id that carries no parsable ts yields 0, which is
    // outside every window — the conservative answer for a record whose age is unknown.
    const { svc } = withDocs([sold({ _id: 'legacy-listing', soldAt: undefined })]);
    expect(await svc.scanAnomalies(AUDIT_WINDOW_SEC, { minTrades: 1, minCoins: 1 })).toEqual([]);
  });

  it('an auction-mode sale is valued at its winning top bid, not at the startPrice it opened at', async () => {
    const { svc } = withDocs([sold({ saleMode: 'auction', qty: 2, startPrice: 10, price: 10, topBid: { bidderId: 'buyer-1', amount: 500, ts: NOW - 1000 } })]);
    const [anomaly] = await svc.scanAnomalies(AUDIT_WINDOW_SEC, { minTrades: 1, minCoins: 1 });
    expect(anomaly!.totalCoins).toBe(1000); // 500 × 2, gross (pre-tax) — see AUCTION_TAX_RATE
    expect(AUCTION_TAX_RATE).toBeGreaterThan(0);
  });

  it('an auction-mode sale that never recorded a topBid falls back to startPrice', async () => {
    const { svc } = withDocs([sold({ saleMode: 'auction', qty: 1, startPrice: 30, price: 10 })]);
    const [anomaly] = await svc.scanAnomalies(AUDIT_WINDOW_SEC, { minTrades: 1, minCoins: 1 });
    expect(anomaly!.totalCoins).toBe(30);
  });

  it('an auction-mode sale with neither a topBid nor a startPrice falls back to `price`', async () => {
    const { svc } = withDocs([sold({ saleMode: 'auction', qty: 2, price: 25 })]);
    const [anomaly] = await svc.scanAnomalies(AUDIT_WINDOW_SEC, { minTrades: 1, minCoins: 1 });
    expect(anomaly!.totalCoins).toBe(50);
  });

  it('a legacy sale with no saleMode is valued at its `price` field', async () => {
    const doc = sold({ qty: 3, price: 40 });
    expect(doc.saleMode).toBeUndefined();
    const { svc } = withDocs([doc]);
    const [anomaly] = await svc.scanAnomalies(AUDIT_WINDOW_SEC, { minTrades: 1, minCoins: 1 });
    expect(anomaly!.totalCoins).toBe(120);
  });
});
