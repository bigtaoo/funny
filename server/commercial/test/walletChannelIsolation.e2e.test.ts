// Wallet channel isolation e2e (ADR-020, design/product/deploy-cloudflare.md §7 point 2): coins recharged
// via one payment channel (Paddle/Stripe web vs. Apple/Google native IAP) must not be spendable from a
// client declaring a different platform — otherwise a player could top up cheaply via web/Paddle and spend
// it inside the iOS/Android app, circumventing that store's IAP cut (a real App Review / Play policy risk).
// Uses a dedicated real Mongo database; entire suite skips if Mongo is unreachable (same harness as service.e2e).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';
import type { RandInt } from '../src/gacha';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_channel_test';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[commercial.channel.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

const zero: RandInt = () => 0;
let t = 1000;
const now = () => t++;

describe.skipIf(!mongo)('wallet channel isolation e2e (ADR-020)', () => {
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

  it('apple-recharged coins are visible/spendable on an ios client but invisible on web', async () => {
    // Apple IAP recharge (verified receipt, platform 'apple') funds the apple bucket, not the free pool.
    const r = await svc.rechargeVerify({ accountId: 'a', platform: 'apple', receipt: 'tier:t499', receiptId: 'rc-apple-1' });
    expect(r.ok).toBe(true);
    const granted = r.ok ? r.coinsGranted : 0; // t499 = 550, first-purchase 2x = 1100

    // No clientPlatform (legacy client / back-compat default) → web bucket → apple money invisible.
    expect((await svc.getWallet('a')).coins).toBe(0);
    // Explicit web client → still invisible.
    expect((await svc.getWallet('a', 'web')).coins).toBe(0);
    // ios client → the apple-recharged balance is visible.
    expect((await svc.getWallet('a', 'ios')).coins).toBe(granted);

    // Spending from a web-declared request must fail (no web/free funds at all).
    const spendWeb = await svc.spend({ accountId: 'a', amount: 100, reason: 'test', orderId: 'sp-web', clientPlatform: 'web' });
    expect(spendWeb).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });

    // The same spend from an ios-declared request succeeds, drawing from the apple bucket.
    const spendIos = await svc.spend({ accountId: 'a', amount: 100, reason: 'test', orderId: 'sp-ios', clientPlatform: 'ios' });
    expect(spendIos).toMatchObject({ ok: true, coinsAfter: granted - 100 });
    expect((await svc.getWallet('a', 'ios')).coins).toBe(granted - 100);
    // android must not see or spend it either — cross-store isolation, not just cross-web.
    expect((await svc.getWallet('a', 'android')).coins).toBe(0);
    const spendAndroid = await svc.spend({ accountId: 'a', amount: 1, reason: 'test', orderId: 'sp-android', clientPlatform: 'android' });
    expect(spendAndroid).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
  });

  it('paddle (web) recharge is spendable on web but not on ios/android', async () => {
    const r = await svc.rechargeVerify({ accountId: 'b', platform: 'stripe', receipt: 'tier:t499', receiptId: 'rc-stripe-1' });
    expect(r.ok).toBe(true);
    const granted = r.ok ? r.coinsGranted : 0;

    expect((await svc.getWallet('b', 'web')).coins).toBe(granted);
    expect((await svc.getWallet('b', 'ios')).coins).toBe(0);
    expect((await svc.getWallet('b', 'android')).coins).toBe(0);

    const chargeIos = await svc.shopCharge({ accountId: 'b', itemId: 'skin_shop_c1', cost: 300, orderId: 'sc-ios', clientPlatform: 'ios' });
    expect(chargeIos).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });

    const chargeWeb = await svc.shopCharge({ accountId: 'b', itemId: 'skin_shop_c1', cost: 300, orderId: 'sc-web', clientPlatform: 'web' });
    expect(chargeWeb).toMatchObject({ ok: true, coinsAfter: granted - 300 });
  });

  it('free coins (grant) are spendable from every platform, unaffected by channel restrictions', async () => {
    await svc.grant({ accountId: 'c', amount: 500, reason: 'test_fund', orderId: 'fund-c' });
    expect((await svc.getWallet('c', 'web')).coins).toBe(500);
    expect((await svc.getWallet('c', 'ios')).coins).toBe(500);
    expect((await svc.getWallet('c', 'android')).coins).toBe(500);

    const draw = await svc.gachaDraw({ accountId: 'c', poolId: 'standard', count: 1, orderId: 'g-ios', clientPlatform: 'ios' });
    expect(draw.ok).toBe(true);
    if (draw.ok) expect(draw.coinsAfter).toBe(500 - 150); // standard single draw cost 150
  });

  it('debit drains the free pool before the channel bucket (restricted money preserved as long as possible)', async () => {
    await svc.grant({ accountId: 'd', amount: 100, reason: 'test_fund', orderId: 'fund-d' }); // free = 100
    const r = await svc.rechargeVerify({ accountId: 'd', platform: 'apple', receipt: 'tier:t099', receiptId: 'rc-d' });
    expect(r.ok).toBe(true);
    const appleGranted = r.ok ? r.coinsGranted : 0; // t099 = 100, first-purchase 2x = 200
    // Effective (ios) = 100 free + 200 apple = 300. Spend 250 → free drained to 0, apple drops by 150.
    const spend = await svc.spend({ accountId: 'd', amount: 250, reason: 'test', orderId: 'sp-d', clientPlatform: 'ios' });
    expect(spend).toMatchObject({ ok: true, coinsAfter: 50 });
    const wallet = await m.collections.wallets.findOne({ _id: 'd' });
    expect(wallet?.coins).toBe(0); // free pool fully drained first
    expect(wallet?.recharged?.apple).toBe(appleGranted - 150); // remainder taken from the apple bucket
  });

  it('a Paddle-webhook-style credit (channel funded directly, no receipt) also isolates correctly', async () => {
    const r = await svc.paddleComplete({ accountId: 'e', transactionId: 'tx1', coins: 500 });
    expect(r.ok).toBe(true);
    expect((await svc.getWallet('e', 'web')).coins).toBe(r.ok ? r.coinsGranted : 0);
    expect((await svc.getWallet('e', 'ios')).coins).toBe(0);
  });
});
