// auctionsvc AuctionService.scanAnomalies end-to-end (auction task 4, migrated from
// server/worldsvc/test/auction-audit.e2e.test.ts). D/G7 anti-RMT, SLG_DESIGN §17.7.
// Seeds sold auction documents directly (bypassing daily limits and payment flows) and asserts seller→buyer pair anomaly detection:
//   repeated wash trades (trades≥threshold) / targeted dumping (designated≥threshold) / large transfer (coins≥threshold) / out-of-window trades excluded / soldAt missing falls back to parsing _id.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_PAIR_MIN_TRADES,
  AUDIT_PAIR_MIN_DESIGNATED,
  AUDIT_PAIR_MIN_COINS,
  AUDIT_WINDOW_SEC,
} from '@nw/shared';
import { createAuctionMongo, type AuctionMongo, type AuctionDoc } from '../src/db';
import { AuctionService } from '../src/auctionService';
import type { AuctionCommercialClient } from '../src/commercialClient';
import type { AuctionMetaClient } from '../src/metaClient';
import type { AuctionMailClient } from '../src/mailClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_auction_audit_e2e_test';

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
  console.warn(`[auctionsvc.audit.e2e] Mongo unreachable (${URI}) — skipping.`);
}

describe.skipIf(!mongo)('AuctionService.scanAnomalies e2e', () => {
  const stubCommercial: AuctionCommercialClient = {
    available: true,
    async spend() {},
  };
  const stubMeta: AuctionMetaClient = {
    available: true,
    async deductMaterial() {},
    async grantMaterial() {},
    async escrowEquipment() { throw new Error('unused'); },
    async grantEquipment() {},
    async escrowCard() { throw new Error('unused'); },
    async grantCard() {},
    async escrowSkin() { throw new Error('unused'); },
    async grantSkin() {},
  };
  const stubMail: AuctionMailClient = { available: true, async sendSystemMail() {} };

  let svc: AuctionService;
  let nowMs = Date.now();
  let seq = 0;

  beforeEach(async () => {
    await mongo!.collections.auctions.deleteMany({});
    nowMs = Date.now();
    seq = 0;
    svc = new AuctionService({ cols: mongo!.collections, commercial: stubCommercial, meta: stubMeta, mail: stubMail, now: () => nowMs });
  });

  afterAll(async () => {
    await mongo?.close();
  });

  /** Directly seed a sold auction document (bypassing payment/limit flows). */
  async function seedSold(opts: {
    seller: string; buyer: string; unitPrice: number; qty?: number;
    designated?: boolean; soldAt?: number; setSoldAt?: boolean;
  }): Promise<void> {
    const qty = opts.qty ?? 1;
    const ts = opts.soldAt ?? nowMs;
    const doc: AuctionDoc = {
      _id: `a:${opts.seller}:${ts}:${++seq}`,
      sellerId: opts.seller,
      itemType: 'material',
      item: { material: 'scrap' },
      qty,
      price: opts.unitPrice,
      currency: 'coins',
      ...(opts.designated ? { designatedBuyerId: opts.buyer } : {}),
      expireAt: ts,
      status: 'sold',
      buyerId: opts.buyer,
      ...(opts.setSoldAt === false ? {} : { soldAt: ts }),
      saleMode: 'fixed',
      rev: 2,
    };
    await mongo!.collections.auctions.insertOne(doc);
  }

  it('repeated wash trades: same pair reaches minTrades → detects repeated', async () => {
    for (let i = 0; i < AUDIT_PAIR_MIN_TRADES; i++) {
      await seedSold({ seller: 'A', buyer: 'B', unitPrice: 10 });
    }
    const anomalies = await svc.scanAnomalies();
    expect(anomalies).toHaveLength(1);
    const a = anomalies[0]!;
    expect(a.sellerId).toBe('A');
    expect(a.buyerId).toBe('B');
    expect(a.trades).toBe(AUDIT_PAIR_MIN_TRADES);
    expect(a.reasons).toContain('repeated');
    expect(a.severity).toBe('medium'); // only repeated → medium
  });

  it('targeted dumping + large amount → detects designated + high_value, severity=high', async () => {
    // Place minDesignated designated bids with a unit price high enough to meet minCoins (kept within a reasonable range — price guardrails apply at order time, not here where we only read sold records).
    const unit = Math.ceil(AUDIT_PAIR_MIN_COINS / AUDIT_PAIR_MIN_DESIGNATED) + 1;
    for (let i = 0; i < AUDIT_PAIR_MIN_DESIGNATED; i++) {
      await seedSold({ seller: 'rich', buyer: 'mule', unitPrice: unit, designated: true });
    }
    const anomalies = await svc.scanAnomalies();
    expect(anomalies).toHaveLength(1);
    const a = anomalies[0]!;
    expect(a.designatedTrades).toBe(AUDIT_PAIR_MIN_DESIGNATED);
    expect(a.reasons).toEqual(expect.arrayContaining(['designated', 'high_value']));
    expect(a.severity).toBe('high');
    expect(a.totalCoins).toBeGreaterThanOrEqual(AUDIT_PAIR_MIN_COINS);
  });

  it('normal sparse trades (below all thresholds) → no anomalies', async () => {
    await seedSold({ seller: 'A', buyer: 'B', unitPrice: 10 });
    await seedSold({ seller: 'C', buyer: 'D', unitPrice: 20 });
    const anomalies = await svc.scanAnomalies();
    expect(anomalies).toHaveLength(0);
  });

  it('trades outside the audit window are excluded', async () => {
    const old = nowMs - (AUDIT_WINDOW_SEC * 1000 + 60_000); // 1 minute outside the audit window
    for (let i = 0; i < AUDIT_PAIR_MIN_TRADES; i++) {
      await seedSold({ seller: 'A', buyer: 'B', unitPrice: 10, soldAt: old });
    }
    const anomalies = await svc.scanAnomalies();
    expect(anomalies).toHaveLength(0);
  });

  it('soldAt missing → falls back to parsing listing ts from _id (still detected within window)', async () => {
    for (let i = 0; i < AUDIT_PAIR_MIN_TRADES; i++) {
      await seedSold({ seller: 'A', buyer: 'B', unitPrice: 10, setSoldAt: false });
    }
    const anomalies = await svc.scanAnomalies();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.trades).toBe(AUDIT_PAIR_MIN_TRADES);
  });

  // Regression for the 2026-07-29 audit fix: scanAnomalies used to `find({status:'sold'}).limit(5000)`
  // with no sort, so once total sold volume exceeds the cap, whichever 5000 docs Mongo's natural order
  // happens to return first could silently exclude the most recent trades from the anti-RMT audit window
  // entirely — sorting desc by soldAt now guarantees the cap drops the OLDEST docs first, not the newest.
  it('when sold volume exceeds the 5000-doc cap, recent trades are still detected (oldest docs dropped first)', async () => {
    // Bulk-insert 5001 old, unrelated sold docs (outside the audit window, different seller/buyer pairs)
    // so they can never trigger detection themselves — they exist purely to exceed the cap.
    const oldTs = nowMs - (AUDIT_WINDOW_SEC * 1000 + 3600_000);
    const filler = Array.from({ length: 5001 }, (_, i) => ({
      _id: `a:filler${i}:${oldTs}:${i}`,
      sellerId: `filler-seller-${i}`,
      itemType: 'material' as const,
      item: { material: 'scrap' as const },
      qty: 1,
      price: 1,
      currency: 'coins' as const,
      expireAt: oldTs,
      status: 'sold' as const,
      buyerId: `filler-buyer-${i}`,
      soldAt: oldTs,
      saleMode: 'fixed' as const,
      rev: 2,
    }));
    await mongo!.collections.auctions.insertMany(filler);

    // Recent, real anomaly — inserted last (highest soldAt), must survive the cap.
    for (let i = 0; i < AUDIT_PAIR_MIN_TRADES; i++) {
      await seedSold({ seller: 'A', buyer: 'B', unitPrice: 10 });
    }

    const anomalies = await svc.scanAnomalies();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ sellerId: 'A', buyerId: 'B', trades: AUDIT_PAIR_MIN_TRADES });
  }, 30_000);

  it('unordered pair merge: alternating A→B and B→A trades combine into one anomaly (2026-08-04 fix)', async () => {
    // Each direction alone (3 trades) is below AUDIT_PAIR_MIN_TRADES (5) and would not trigger on its own —
    // this only detects because the unordered-pair aggregation merges both directions into a single bucket.
    const half = Math.ceil(AUDIT_PAIR_MIN_TRADES / 2); // 3 when minTrades=5; half < minTrades, half*2 >= minTrades
    for (let i = 0; i < half; i++) await seedSold({ seller: 'A', buyer: 'B', unitPrice: 10 });
    for (let i = 0; i < half; i++) await seedSold({ seller: 'B', buyer: 'A', unitPrice: 10 });
    const anomalies = await svc.scanAnomalies();
    expect(anomalies).toHaveLength(1);
    // sellerId/buyerId on the result are just a display label (whichever direction landed first in the
    // aggregation) — not asserted here, since it depends on Mongo's tie-break order for same-soldAt docs.
    expect(anomalies[0]!.trades).toBe(half * 2);
    expect(anomalies[0]!.reasons).toContain('repeated');
  });
});
