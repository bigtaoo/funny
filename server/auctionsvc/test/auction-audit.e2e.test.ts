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
  } catch {
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

  it('direction matters: A→B and B→A are different pairs, counted independently', async () => {
    for (let i = 0; i < AUDIT_PAIR_MIN_TRADES; i++) await seedSold({ seller: 'A', buyer: 'B', unitPrice: 10 });
    await seedSold({ seller: 'B', buyer: 'A', unitPrice: 10 }); // reverse direction: only 1 trade, does not trigger
    const anomalies = await svc.scanAnomalies();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.sellerId).toBe('A');
  });
});
