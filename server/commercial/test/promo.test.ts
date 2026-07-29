// B-PROMO promo code redemption end-to-end tests (real Mongo, requires docker compose up -d).
// Coverage: create / list / case normalization / duplicate code / coins<=0 / first redemption / deduplication / expiry / total limit / different players / ledger.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_promo_test';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[promo.test] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

let t = 1_000_000;
const now = () => t++;

describe.skipIf(!mongo)('promo code system', () => {
  const m = mongo!;
  let svc: CommercialService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    svc = new CommercialService({ cols: m.collections, now });
    t = 1_000_000;
  });

  afterAll(async () => {
    await m.close();
  });

  // ── createPromoCode ─────────────────────────────────────────
  it('create succeeds, code normalized to uppercase', async () => {
    const r = await svc.createPromoCode({ code: 'hello2025', coins: 100, createdBy: 'admin1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).toBe('HELLO2025');
  });

  it('listPromoCodes returns created codes', async () => {
    await svc.createPromoCode({ code: 'A', coins: 50, createdBy: 'admin1' });
    await svc.createPromoCode({ code: 'B', coins: 200, note: 'summer', createdBy: 'admin1' });
    const codes = await svc.listPromoCodes();
    expect(codes).toHaveLength(2);
    const b = codes.find((c) => c._id === 'B');
    expect(b?.note).toBe('summer');
    expect(b?.redeemed).toBe(0);
  });

  it('duplicate code returns BAD_REQUEST', async () => {
    await svc.createPromoCode({ code: 'DUP', coins: 50, createdBy: 'admin1' });
    const r2 = await svc.createPromoCode({ code: 'dup', coins: 100, createdBy: 'admin1' });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toBe('BAD_REQUEST');
  });

  it('coins<=0 rejected', async () => {
    const r = await svc.createPromoCode({ code: 'NEG', coins: 0, createdBy: 'admin1' });
    expect(r.ok).toBe(false);
  });

  // ── promoRedeem ─────────────────────────────────────────────
  it('first redemption succeeds, coins added to wallet', async () => {
    await svc.createPromoCode({ code: 'PROMO2025', coins: 200, createdBy: 'admin1' });
    const r = await svc.promoRedeem({ accountId: 'acc1', code: 'promo2025' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.coinsGranted).toBe(200);
    expect(r.coinsAfter).toBe(200);
  });

  it('redeemed counter increments after redemption', async () => {
    await svc.createPromoCode({ code: 'PROMO2025', coins: 200, createdBy: 'admin1' });
    await svc.promoRedeem({ accountId: 'acc1', code: 'PROMO2025' });
    const code = await m.collections.promoCodes.findOne({ _id: 'PROMO2025' });
    expect(code?.redeemed).toBe(1);
  });

  it('same player redeeming same code a second time → PROMO_ALREADY_USED', async () => {
    await svc.createPromoCode({ code: 'PROMO2025', coins: 200, createdBy: 'admin1' });
    await svc.promoRedeem({ accountId: 'acc1', code: 'PROMO2025' });
    const r2 = await svc.promoRedeem({ accountId: 'acc1', code: 'PROMO2025' });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toBe('PROMO_ALREADY_USED');
  });

  it('different players can each redeem the same code', async () => {
    await svc.createPromoCode({ code: 'PROMO2025', coins: 200, createdBy: 'admin1' });
    const r1 = await svc.promoRedeem({ accountId: 'acc1', code: 'PROMO2025' });
    const r2 = await svc.promoRedeem({ accountId: 'acc2', code: 'PROMO2025' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('code does not exist → PROMO_NOT_FOUND', async () => {
    const r = await svc.promoRedeem({ accountId: 'acc1', code: 'NOEXIST' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('PROMO_NOT_FOUND');
  });

  it('expired code → PROMO_EXPIRED', async () => {
    await svc.createPromoCode({ code: 'EXPIRED', coins: 100, expiresAt: t - 1000, createdBy: 'admin1' });
    const r = await svc.promoRedeem({ accountId: 'acc1', code: 'EXPIRED' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('PROMO_EXPIRED');
  });

  it('non-expired code (expiresAt in the future) redeems successfully', async () => {
    await svc.createPromoCode({ code: 'FUTURE', coins: 50, expiresAt: t + 99999, createdBy: 'admin1' });
    const r = await svc.promoRedeem({ accountId: 'acc1', code: 'FUTURE' });
    expect(r.ok).toBe(true);
  });

  it('totalLimit=1 second player redemption → PROMO_EXHAUSTED', async () => {
    await svc.createPromoCode({ code: 'LIMITED', coins: 100, totalLimit: 1, createdBy: 'admin1' });
    await svc.promoRedeem({ accountId: 'acc1', code: 'LIMITED' });
    const r = await svc.promoRedeem({ accountId: 'acc2', code: 'LIMITED' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('PROMO_EXHAUSTED');
  });

  // Regression for the 2026-07-29 audit fix: the promoRedemptions slot is reserved BEFORE credit() runs,
  // so a crash between the two used to stamp the code "used" forever with the coins never granted.
  // Simulate that crash (hand-insert the reserved redemption, skip credit) and verify a LATER redeem call
  // (past the isStaleClaim grace window) heals the missing credit instead of just erroring
  // PROMO_ALREADY_USED with the coins gone for good.
  it('heals a credit dropped by a crash between reserve and credit (stale claim)', async () => {
    await svc.createPromoCode({ code: 'CRASHED', coins: 300, createdBy: 'admin1' });
    await m.collections.promoRedemptions.insertOne({
      _id: 'acc1:CRASHED',
      accountId: 'acc1',
      code: 'CRASHED',
      coinsGranted: 300,
      ts: t,
    });
    t += 20000; // past REPLAY_HEAL_GRACE_MS
    const r = await svc.promoRedeem({ accountId: 'acc1', code: 'CRASHED' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.coinsGranted).toBe(300);
    expect((await m.collections.wallets.findOne({ _id: 'acc1' }))?.coins).toBe(300);
    expect(await m.collections.ledger.countDocuments({ accountId: 'acc1', reason: 'promo' })).toBe(1);

    // A second replay must not heal again.
    const r2 = await svc.promoRedeem({ accountId: 'acc1', code: 'CRASHED' });
    expect(r2.ok).toBe(false);
    expect((await m.collections.wallets.findOne({ _id: 'acc1' }))?.coins).toBe(300);
  });

  it('does NOT heal a redemption still within the grace window', async () => {
    await svc.createPromoCode({ code: 'FRESH', coins: 300, createdBy: 'admin1' });
    await m.collections.promoRedemptions.insertOne({
      _id: 'acc2:FRESH',
      accountId: 'acc2',
      code: 'FRESH',
      coinsGranted: 300,
      ts: t, // claimed "just now"
    });
    const r = await svc.promoRedeem({ accountId: 'acc2', code: 'FRESH' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('PROMO_ALREADY_USED');
    expect(await m.collections.ledger.countDocuments({ accountId: 'acc2', reason: 'promo' })).toBe(0);
  });

  it('redemption writes a ledger entry with reason=promo', async () => {
    await svc.createPromoCode({ code: 'PROMO2025', coins: 200, createdBy: 'admin1' });
    await svc.promoRedeem({ accountId: 'acc1', code: 'PROMO2025' });
    const entry = await m.collections.ledger.findOne({ accountId: 'acc1', reason: 'promo' });
    expect(entry).toBeTruthy();
    expect(entry?.delta).toBe(200);
  });
});
