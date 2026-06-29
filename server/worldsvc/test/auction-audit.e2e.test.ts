// worldsvc AuctionService.scanAnomalies end-to-end (D/G7 anti-RMT, SLG_DESIGN §17.7): real Mongo dedicated database.
// Seeds sold auction documents directly (bypassing daily limits and payment flows) and asserts seller→buyer pair anomaly detection:
//   repeated wash trades (trades≥threshold) / targeted dumping (designated≥threshold) / large transfer (coins≥threshold) / out-of-window trades excluded / soldAt missing falls back to parsing _id.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_PAIR_MIN_TRADES,
  AUDIT_PAIR_MIN_DESIGNATED,
  AUDIT_PAIR_MIN_COINS,
  AUDIT_WINDOW_SEC,
  auctionId,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo, type AuctionDoc } from '../src/db';
import { AuctionService } from '../src/auctionService';
import type { WorldCommercialClient } from '../src/commercialClient';
import type { WorldMetaClient } from '../src/metaClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_audit_test';
const W = 'audit-test';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.audit.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

describe.skipIf(!mongo)('AuctionService.scanAnomalies e2e', () => {
  const stubCommercial: WorldCommercialClient = {
    available: true,
    async spend() {},
    async grant() {},
  };
  const stubMeta: WorldMetaClient = {
    available: true,
    async deductMaterial() {},
    async grantMaterial() {},
    async getProfile() { return null; },
    async escrowEquipment() { throw new Error('unused'); },
    async grantEquipment() {},
  };

  let svc: AuctionService;
  let nowMs = Date.now();
  let seq = 0;

  beforeEach(async () => {
    await mongo!.collections.auctions.deleteMany({});
    nowMs = Date.now();
    seq = 0;
    svc = new AuctionService({ cols: mongo!.collections, commercial: stubCommercial, meta: stubMeta, now: () => nowMs });
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
      _id: auctionId(W, opts.seller, ts, ++seq),
      worldId: W,
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

  it('反复对敲：同配对成交达 minTrades → 检出 repeated', async () => {
    for (let i = 0; i < AUDIT_PAIR_MIN_TRADES; i++) {
      await seedSold({ seller: 'A', buyer: 'B', unitPrice: 10 });
    }
    const anomalies = await svc.scanAnomalies(W);
    expect(anomalies).toHaveLength(1);
    const a = anomalies[0]!;
    expect(a.sellerId).toBe('A');
    expect(a.buyerId).toBe('B');
    expect(a.trades).toBe(AUDIT_PAIR_MIN_TRADES);
    expect(a.reasons).toContain('repeated');
    expect(a.severity).toBe('medium'); // only repeated → medium
  });

  it('定向倒货 + 大额 → 检出 designated + high_value，severity=high', async () => {
    // Place minDesignated designated bids with a unit price high enough to meet minCoins (kept within a reasonable range — price guardrails apply at order time, not here where we only read sold records).
    const unit = Math.ceil(AUDIT_PAIR_MIN_COINS / AUDIT_PAIR_MIN_DESIGNATED) + 1;
    for (let i = 0; i < AUDIT_PAIR_MIN_DESIGNATED; i++) {
      await seedSold({ seller: 'rich', buyer: 'mule', unitPrice: unit, designated: true });
    }
    const anomalies = await svc.scanAnomalies(W);
    expect(anomalies).toHaveLength(1);
    const a = anomalies[0]!;
    expect(a.designatedTrades).toBe(AUDIT_PAIR_MIN_DESIGNATED);
    expect(a.reasons).toEqual(expect.arrayContaining(['designated', 'high_value']));
    expect(a.severity).toBe('high');
    expect(a.totalCoins).toBeGreaterThanOrEqual(AUDIT_PAIR_MIN_COINS);
  });

  it('正常零散交易（低于所有阈值）→ 无异常', async () => {
    await seedSold({ seller: 'A', buyer: 'B', unitPrice: 10 });
    await seedSold({ seller: 'C', buyer: 'D', unitPrice: 20 });
    const anomalies = await svc.scanAnomalies(W);
    expect(anomalies).toHaveLength(0);
  });

  it('窗口外的旧成交不计入', async () => {
    const old = nowMs - (AUDIT_WINDOW_SEC * 1000 + 60_000); // 1 minute outside the audit window
    for (let i = 0; i < AUDIT_PAIR_MIN_TRADES; i++) {
      await seedSold({ seller: 'A', buyer: 'B', unitPrice: 10, soldAt: old });
    }
    const anomalies = await svc.scanAnomalies(W);
    expect(anomalies).toHaveLength(0);
  });

  it('soldAt 缺省 → 回退解析 _id 内挂单 ts（窗口内仍检出）', async () => {
    for (let i = 0; i < AUDIT_PAIR_MIN_TRADES; i++) {
      await seedSold({ seller: 'A', buyer: 'B', unitPrice: 10, setSoldAt: false });
    }
    const anomalies = await svc.scanAnomalies(W);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.trades).toBe(AUDIT_PAIR_MIN_TRADES);
  });

  it('方向区分：A→B 与 B→A 是不同配对，各自独立计数', async () => {
    for (let i = 0; i < AUDIT_PAIR_MIN_TRADES; i++) await seedSold({ seller: 'A', buyer: 'B', unitPrice: 10 });
    await seedSold({ seller: 'B', buyer: 'A', unitPrice: 10 }); // reverse direction: only 1 trade, does not trigger
    const anomalies = await svc.scanAnomalies(W);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.sellerId).toBe('A');
  });
});
