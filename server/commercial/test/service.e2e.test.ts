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

  it('wallet defaults to 0 / empty pity / empty monetization', async () => {
    expect(await svc.getWallet('a')).toEqual({
      coins: 0,
      pity: {},
      fatePoints: 0,
      subscriptionExpiry: 0,
      starterUsed: [],
    });
  });

  it('recharge adds coins + receiptId idempotency', async () => {
    // First recharge on a fresh account gets the first-purchase 2× bonus (t999 = 1150 → 2300).
    const r1 = await svc.rechargeVerify({ accountId: 'a', platform: 'web', receipt: 'tier:t999', receiptId: 'rc1' });
    expect(r1).toMatchObject({ ok: true, coinsGranted: 2300, coinsAfter: 2300 });
    // Replaying the same receiptId: no duplicate credit, returns the original (bonus-inclusive) result.
    const r2 = await svc.rechargeVerify({ accountId: 'a', platform: 'web', receipt: 'tier:t999', receiptId: 'rc1' });
    expect(r2).toMatchObject({ ok: true, coinsGranted: 2300, coinsAfter: 2300 });
    expect((await svc.getWallet('a')).coins).toBe(2300);
  });

  it('same receiptId already used by another account → rejected (prevents cross-account balance leak)', async () => {
    // a tops up first with rcShared (first-purchase 2× bonus → balance 2300).
    const r1 = await svc.rechargeVerify({ accountId: 'a', platform: 'web', receipt: 'tier:t999', receiptId: 'rcShared' });
    expect(r1).toMatchObject({ ok: true, coinsGranted: 2300, coinsAfter: 2300 });
    // b reuses the same receiptId: must be rejected, must never replay a's balance.
    const r2 = await svc.rechargeVerify({ accountId: 'b', platform: 'web', receipt: 'tier:t999', receiptId: 'rcShared' });
    expect(r2).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
    // b's wallet is unaffected.
    expect((await svc.getWallet('b')).coins).toBe(0);
    // a replaying the same receiptId still works correctly (returns this account's balance).
    const r3 = await svc.rechargeVerify({ accountId: 'a', platform: 'web', receipt: 'tier:t999', receiptId: 'rcShared' });
    expect(r3).toMatchObject({ ok: true, coinsGranted: 2300, coinsAfter: 2300 });
  });

  it('insufficient balance rejects deduction', async () => {
    const r = await svc.shopCharge({ accountId: 'b', itemId: 'skin_shop_c1', cost: 300, orderId: 'o1' });
    expect(r).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
  });

  it('shop deduction + orderId idempotent replay', async () => {
    await svc.grant({ accountId: 'c', amount: 550, reason: 'test_fund', orderId: 'fund-c' }); // 550
    const r1 = await svc.shopCharge({ accountId: 'c', itemId: 'skin_shop_c1', cost: 300, orderId: 'o2' });
    expect(r1).toMatchObject({ ok: true, coinsAfter: 250, status: 'charged' });
    // Replaying the same orderId: no duplicate deduction, returns the original result.
    const r2 = await svc.shopCharge({ accountId: 'c', itemId: 'skin_shop_c1', cost: 300, orderId: 'o2' });
    expect(r2).toMatchObject({ ok: true, coinsAfter: 250 });
    expect((await svc.getWallet('c')).coins).toBe(250);
  });

  it('gacha: single draw costs 150, pity+1, orderId idempotent', async () => {
    await svc.grant({ accountId: 'e', amount: 550, reason: 'test_fund', orderId: 'fund-e' }); // 550
    const r1 = await svc.gachaDraw({ accountId: 'e', poolId: 'standard', count: 1, orderId: 'g1' });
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.coinsAfter).toBe(400);
      expect(r1.results).toHaveLength(1);
      expect(r1.pityAfter).toBe(1);
    }
    const hist = await m.collections.gachaHistory.find({ accountId: 'e' }).toArray();
    expect(hist).toHaveLength(1);
    // Replay idempotency
    const r2 = await svc.gachaDraw({ accountId: 'e', poolId: 'standard', count: 1, orderId: 'g1' });
    expect(r2.ok && r2.coinsAfter).toBe(400);
    expect((await svc.getWallet('e')).coins).toBe(400);
    expect((await svc.getWallet('e')).pity.standard).toBe(1);
  });

  it('concurrent deductions do not overspend (10 concurrent single draws, balance only covers 3)', async () => {
    await svc.grant({ accountId: 'f', amount: 550, reason: 'test_fund', orderId: 'fund-f' }); // 550
    // Balance 550 / single draw 150 → at most 3 draws. Fire 10 concurrent calls with distinct orderIds.
    const calls = Array.from({ length: 10 }, (_, i) =>
      svc.gachaDraw({ accountId: 'f', poolId: 'standard', count: 1, orderId: `c${i}` }),
    );
    const res = await Promise.all(calls);
    const okCount = res.filter((r) => r.ok).length;
    expect(okCount).toBe(3);
    expect((await svc.getWallet('f')).coins).toBe(100);
  });

  it('order fulfillment closed loop: delivered marker + refundCoins credit idempotent', async () => {
    await svc.grant({ accountId: 'g', amount: 550, reason: 'test_fund', orderId: 'fund-g' }); // 550
    await svc.shopCharge({ accountId: 'g', itemId: 'skin_shop_c1', cost: 300, orderId: 'od1' }); // remaining 300
    const d1 = await svc.orderDelivered({ orderId: 'od1', refundCoins: 50 });
    expect(d1.ok).toBe(true);
    expect((await svc.getWallet('g')).coins).toBe(300); // refunded 50
    // Replaying delivered: no duplicate refund.
    await svc.orderDelivered({ orderId: 'od1', refundCoins: 50 });
    expect((await svc.getWallet('g')).coins).toBe(300);
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
    await svc.grant({ accountId: 'j', amount: 550, reason: 'test_fund', orderId: 'fund-j' }); // 550
    const r1 = await svc.spend({ accountId: 'j', amount: 500, reason: 'rename', orderId: 'sp1' });
    expect(r1).toMatchObject({ ok: true, coinsAfter: 50 });
    // orderId idempotency: replay does not deduct again.
    const r2 = await svc.spend({ accountId: 'j', amount: 500, reason: 'rename', orderId: 'sp1' });
    expect(r2).toMatchObject({ ok: true, coinsAfter: 50 });
    expect((await svc.getWallet('j')).coins).toBe(50);
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

  // ── Limited pools + Fate Points (GACHA_DESIGN §2.2/§7) ──────────────────────
  it('limited pool: unknown/closed pool → POOL_UNAVAILABLE; active pool draws + off-banner legendary awards Fate Point', async () => {
    // rng that forces a legendary tier then picks an off-banner filler (index 4 in the 8-slot legendary array).
    const offBanner: RandInt = (() => { const v = [995, 4]; let i = 0; return () => v[i++] ?? 0; })();
    const svcLeg = new CommercialService({ cols: m.collections, now, rng: offBanner });
    await svcLeg.rechargeVerify({ accountId: 'lp', platform: 'web', receipt: 'tier:t999', receiptId: 'rclp' }); // 1150

    // Draw before the pool exists → unavailable.
    const miss = await svcLeg.gachaDraw({ accountId: 'lp', poolId: 'lim1', count: 1, orderId: 'lpm' });
    expect(miss).toEqual({ ok: false, error: 'POOL_UNAVAILABLE' });

    await svcLeg.createLimitedPool({
      config: { id: 'lim1', name: 'Banner', featuredLegendary: 'skin_lim1', startAt: 0, endAt: 9_999_999_999_999 },
      createdBy: 'admin',
    });
    const draw = await svcLeg.gachaDraw({ accountId: 'lp', poolId: 'lim1', count: 1, orderId: 'lp1' });
    expect(draw.ok).toBe(true);
    if (draw.ok) {
      expect(draw.results[0]!.rarity).toBe('legendary');
      expect(draw.results[0]!.itemId).not.toBe('skin_lim1'); // off-banner filler
      expect(draw.fateGained).toBe(1);
      expect(draw.fatePointsAfter).toBe(1);
    }
    // Independent pity is tracked under the limited pool id.
    expect((await svcLeg.getWallet('lp')).fatePoints).toBe(1);
  });

  it('fate redeem: insufficient points rejected; with 30 points redeems a featured legendary; invalid item rejected', async () => {
    await svc.createLimitedPool({
      config: { id: 'lim2', name: 'B2', featuredLegendary: 'skin_lim2', startAt: 0, endAt: 9_999_999_999_999 },
      createdBy: 'admin',
    });
    // No points yet → insufficient.
    const poor = await svc.redeemFate({ accountId: 'fr', itemId: 'skin_lim2', orderId: 'fr0' });
    expect(poor).toEqual({ ok: false, error: 'FATE_INSUFFICIENT' });
    // Grant 30 fate points directly, then redeem.
    await svc.getWallet('fr'); // ensure wallet exists
    await m.collections.wallets.updateOne({ _id: 'fr' }, { $set: { fatePoints: 30 } }, { upsert: true });
    const ok1 = await svc.redeemFate({ accountId: 'fr', itemId: 'skin_lim2', orderId: 'fr1' });
    expect(ok1).toMatchObject({ ok: true, itemId: 'skin_lim2', fatePointsAfter: 0 });
    // Replay same orderId → idempotent (no second deduction).
    const ok2 = await svc.redeemFate({ accountId: 'fr', itemId: 'skin_lim2', orderId: 'fr1' });
    expect(ok2).toMatchObject({ ok: true, itemId: 'skin_lim2' });
    // Non-featured item → invalid.
    const bad = await svc.redeemFate({ accountId: 'fr', itemId: 'not_a_banner', orderId: 'fr2' });
    expect(bad).toEqual({ ok: false, error: 'FATE_INVALID_ITEM' });
  });

  // ── Monthly card (GACHA_DESIGN §5) ─────────────────────────────────────────
  it('monthly card: buy grants immediate 600 + activates subscription; daily claim once per day', async () => {
    const buy = await svc.monthlyCardBuy({ accountId: 'mc', orderId: 'mcb' });
    expect(buy.ok).toBe(true);
    if (buy.ok) {
      expect(buy.coinsAfter).toBe(600); // immediate grant
      expect(buy.subscriptionExpiry).toBeGreaterThan(now());
    }
    // Buy idempotency: replaying the same orderId does not double-grant.
    const buy2 = await svc.monthlyCardBuy({ accountId: 'mc', orderId: 'mcb' });
    expect(buy2.ok && buy2.coinsAfter).toBe(600);
    // Daily claim: +120 the first time, 0 the second time same day.
    const c1 = await svc.monthlyCardClaim({ accountId: 'mc', dayKey: '2026-07-02' });
    expect(c1).toMatchObject({ ok: true, claimed: 120 });
    const c2 = await svc.monthlyCardClaim({ accountId: 'mc', dayKey: '2026-07-02' });
    expect(c2).toMatchObject({ ok: true, claimed: 0 });
    expect((await svc.getWallet('mc')).coins).toBe(720); // 600 + 120
    // No active subscription → claim yields 0.
    const none = await svc.monthlyCardClaim({ accountId: 'nosub', dayKey: '2026-07-02' });
    expect(none).toMatchObject({ ok: true, claimed: 0 });
  });

  // ── Starter packs (GACHA_DESIGN §6) ────────────────────────────────────────
  it('starter draw: one rare+ floored 10-pull, once per account', async () => {
    const r = await svc.starterBuy({ accountId: 'sd', productId: 'starter_draw', orderId: 'sdo' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.results).toHaveLength(10);
      expect(r.results.some((x) => x.rarity === 'rare' || x.rarity === 'epic' || x.rarity === 'legendary')).toBe(true);
    }
    expect((await svc.getWallet('sd')).starterUsed).toContain('starter_draw');
    // Second purchase (different orderId) → rejected once-per-account.
    const again = await svc.starterBuy({ accountId: 'sd', productId: 'starter_draw', orderId: 'sdo2' });
    expect(again).toEqual({ ok: false, error: 'ALREADY_PURCHASED' });
  });

  it('starter growth: grants coins + 7-day card, once per account', async () => {
    const r = await svc.starterBuy({ accountId: 'sg', productId: 'starter_growth', orderId: 'sgo' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.coinsAfter).toBe(3300);
      expect(r.subscriptionExpiry).toBeGreaterThan(now());
      expect(r.results).toHaveLength(0);
    }
    const again = await svc.starterBuy({ accountId: 'sg', productId: 'starter_growth', orderId: 'sgo2' });
    expect(again).toEqual({ ok: false, error: 'ALREADY_PURCHASED' });
  });
});
