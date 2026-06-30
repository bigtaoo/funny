// commercial service end-to-end (S5-2~4): uses a dedicated real Mongo database. Entire suite skips if Mongo is unreachable.
//   Wallet defaults / credit / debit guards, shop/gacha orderId idempotency, concurrent overspend protection, recharge receiptId idempotency, ads credit.
// Requires `cd server && docker compose up -d`.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';
import type { RandInt } from '../src/gacha';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_test';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[commercial.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

const zero: RandInt = () => 0;
let t = 1000;
const now = () => t++;

describe.skipIf(!mongo)('commercial service e2e', () => {
  const m = mongo!;
  let svc: CommercialService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    svc = new CommercialService({ cols: m.collections, now, rng: zero });
  });

  afterAll(async () => {
    if (m) {
      await m.db.dropDatabase();
      await m.close();
    }
  });

  it('wallet defaults to 0 / empty pity', async () => {
    expect(await svc.getWallet('a')).toEqual({ coins: 0, pity: {} });
  });

  it('recharge adds coins + receiptId idempotency', async () => {
    const r1 = await svc.rechargeVerify({ accountId: 'a', platform: 'web', receipt: 'tier:mid', receiptId: 'rc1' });
    expect(r1).toMatchObject({ ok: true, coinsGranted: 3300, coinsAfter: 3300 });
    // Replaying the same receiptId: no duplicate credit, returns the original result.
    const r2 = await svc.rechargeVerify({ accountId: 'a', platform: 'web', receipt: 'tier:mid', receiptId: 'rc1' });
    expect(r2).toMatchObject({ ok: true, coinsGranted: 3300, coinsAfter: 3300 });
    expect((await svc.getWallet('a')).coins).toBe(3300);
  });

  it('same receiptId already used by another account → rejected (prevents cross-account balance leak)', async () => {
    // a tops up first with rcShared (balance 3300).
    const r1 = await svc.rechargeVerify({ accountId: 'a', platform: 'web', receipt: 'tier:mid', receiptId: 'rcShared' });
    expect(r1).toMatchObject({ ok: true, coinsGranted: 3300, coinsAfter: 3300 });
    // b reuses the same receiptId: must be rejected, must never replay a's balance.
    const r2 = await svc.rechargeVerify({ accountId: 'b', platform: 'web', receipt: 'tier:mid', receiptId: 'rcShared' });
    expect(r2).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
    // b's wallet is unaffected.
    expect((await svc.getWallet('b')).coins).toBe(0);
    // a replaying the same receiptId still works correctly (returns this account's balance).
    const r3 = await svc.rechargeVerify({ accountId: 'a', platform: 'web', receipt: 'tier:mid', receiptId: 'rcShared' });
    expect(r3).toMatchObject({ ok: true, coinsGranted: 3300, coinsAfter: 3300 });
  });

  it('insufficient balance rejects deduction', async () => {
    const r = await svc.shopCharge({ accountId: 'b', itemId: 'skin_shop_c1', cost: 300, orderId: 'o1' });
    expect(r).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
  });

  it('shop deduction + orderId idempotent replay', async () => {
    await svc.rechargeVerify({ accountId: 'c', platform: 'web', receipt: 'tier:small', receiptId: 'rcc' }); // 600
    const r1 = await svc.shopCharge({ accountId: 'c', itemId: 'skin_shop_c1', cost: 300, orderId: 'o2' });
    expect(r1).toMatchObject({ ok: true, coinsAfter: 300, status: 'charged' });
    // Replaying the same orderId: no duplicate deduction, returns the original result.
    const r2 = await svc.shopCharge({ accountId: 'c', itemId: 'skin_shop_c1', cost: 300, orderId: 'o2' });
    expect(r2).toMatchObject({ ok: true, coinsAfter: 300 });
    expect((await svc.getWallet('c')).coins).toBe(300);
  });

  it('gacha: single draw costs 150, pity+1, orderId idempotent', async () => {
    await svc.rechargeVerify({ accountId: 'e', platform: 'web', receipt: 'tier:small', receiptId: 'rce' }); // 600
    const r1 = await svc.gachaDraw({ accountId: 'e', poolId: 'standard', count: 1, orderId: 'g1' });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.coinsAfter).toBe(450);
      expect(r1.results).toHaveLength(1);
      expect(r1.pityAfter).toBe(1);
    }
    const hist = await m.collections.gachaHistory.find({ accountId: 'e' }).toArray();
    expect(hist).toHaveLength(1);
    // Replay idempotency
    const r2 = await svc.gachaDraw({ accountId: 'e', poolId: 'standard', count: 1, orderId: 'g1' });
    expect(r2.ok && r2.coinsAfter).toBe(450);
    expect((await svc.getWallet('e')).coins).toBe(450);
    expect((await svc.getWallet('e')).pity.standard).toBe(1);
  });

  it('concurrent deductions do not overspend (10 concurrent single draws, balance only covers 3)', async () => {
    await svc.rechargeVerify({ accountId: 'f', platform: 'web', receipt: 'tier:small', receiptId: 'rcf2' }); // 600
    // Balance 600 / single draw 150 → at most 4 draws. Fire 10 concurrent calls with distinct orderIds.
    const calls = Array.from({ length: 10 }, (_, i) =>
      svc.gachaDraw({ accountId: 'f', poolId: 'standard', count: 1, orderId: `c${i}` }),
    );
    const res = await Promise.all(calls);
    const okCount = res.filter((r) => r.ok).length;
    expect(okCount).toBe(4);
    expect((await svc.getWallet('f')).coins).toBe(0);
  });

  it('order fulfillment closed loop: delivered marker + refundCoins credit idempotent', async () => {
    await svc.rechargeVerify({ accountId: 'g', platform: 'web', receipt: 'tier:small', receiptId: 'rcg' }); // 600
    await svc.shopCharge({ accountId: 'g', itemId: 'skin_shop_c1', cost: 300, orderId: 'od1' }); // remaining 300
    const d1 = await svc.orderDelivered({ orderId: 'od1', refundCoins: 50 });
    expect(d1.ok).toBe(true);
    expect((await svc.getWallet('g')).coins).toBe(350); // refunded 50
    // Replaying delivered: no duplicate refund.
    await svc.orderDelivered({ orderId: 'od1', refundCoins: 50 });
    expect((await svc.getWallet('g')).coins).toBe(350);
    // Reconciliation: delivered orders no longer appear in the undelivered list.
    expect(await svc.undeliveredOrders('g')).toHaveLength(0);
  });

  it('unverified receipt does not credit coins (empty receipt → INVALID_RECEIPT)', async () => {
    const r = await svc.rechargeVerify({ accountId: 'h', platform: 'web', receipt: '', receiptId: 'rch' });
    expect(r).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
  });

  it('ads credit', async () => {
    const r = await svc.adsCredit({ accountId: 'i', amount: 50, dayKey: '2026-06-14' });
    expect(r).toMatchObject({ ok: true, coinsAfter: 50 });
  });

  it('victory coins: credited within daily cap, capped when exceeded, resets on new day', async () => {
    // 10 wins per day cap (VICTORY_DAILY_WIN_CAP), 5 coins each → 50 total.
    let last = 0;
    for (let i = 0; i < 10; i++) {
      const r = await svc.victoryCredit({ accountId: 'v', amount: 5, dayKey: '2026-06-14' });
      expect(r).toMatchObject({ ok: true, credited: 5, capped: false });
      if (r.ok) last = r.coinsAfter;
    }
    expect(last).toBe(50);
    // 11th win: cap exceeded, no coins credited.
    const over = await svc.victoryCredit({ accountId: 'v', amount: 5, dayKey: '2026-06-14' });
    expect(over).toMatchObject({ ok: true, credited: 0, capped: true });
    expect((await svc.getWallet('v')).coins).toBe(50);
    // Cross-day reset: a new dayKey allows credits again.
    const nextDay = await svc.victoryCredit({ accountId: 'v', amount: 5, dayKey: '2026-06-15' });
    expect(nextDay).toMatchObject({ ok: true, credited: 5, capped: false });
    expect((await svc.getWallet('v')).coins).toBe(55);
  });

  it('spend (renamed sink): deducts coins + orderId idempotent + rejects insufficient balance + not picked up by reconciliation', async () => {
    await svc.rechargeVerify({ accountId: 'j', platform: 'web', receipt: 'tier:small', receiptId: 'rcj' }); // 600
    const r1 = await svc.spend({ accountId: 'j', amount: 500, reason: 'rename', orderId: 'sp1' });
    expect(r1).toMatchObject({ ok: true, coinsAfter: 100 });
    // orderId idempotency: replay does not deduct again.
    const r2 = await svc.spend({ accountId: 'j', amount: 500, reason: 'rename', orderId: 'sp1' });
    expect(r2).toMatchObject({ ok: true, coinsAfter: 100 });
    expect((await svc.getWallet('j')).coins).toBe(100);
    // Insufficient balance is rejected.
    const r3 = await svc.spend({ accountId: 'j', amount: 500, reason: 'rename', orderId: 'sp2' });
    expect(r3).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
    // sink writes as delivered immediately → not picked up by reconciliation.
    expect(await svc.undeliveredOrders('j')).toHaveLength(0);
  });

  it('grant (mail attachment coin credit): adds coins + orderId idempotent + amount=0 only reserves slot + not picked up by reconciliation', async () => {
    const r1 = await svc.grant({ accountId: 'g', amount: 500, reason: 'mail', orderId: 'gr1' });
    expect(r1).toMatchObject({ ok: true, coinsAfter: 500 });
    // orderId idempotency: replay does not credit again.
    const r2 = await svc.grant({ accountId: 'g', amount: 500, reason: 'mail', orderId: 'gr1' });
    expect(r2).toMatchObject({ ok: true, coinsAfter: 500 });
    expect((await svc.getWallet('g')).coins).toBe(500);
    // amount=0 (item/skin-only attachment) only reserves the idempotency order slot, no coins credited.
    const r3 = await svc.grant({ accountId: 'g', amount: 0, reason: 'mail', orderId: 'gr2' });
    expect(r3).toMatchObject({ ok: true, coinsAfter: 500 });
    // grant writes as delivered immediately → not picked up by reconciliation.
    expect(await svc.undeliveredOrders('g')).toHaveLength(0);
  });
});
