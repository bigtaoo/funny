// Guard/rejection paths across the domain services, against a real Mongo.
//
// The existing e2e files buy, draw, recharge and refund successfully; what they never send is a
// malformed argument or a second attempt at something already done, so most of the "refuse" and
// "already handled" halves were unexecuted (gachaPool 69.56%, orders 76.92%, starter 72%,
// subscription 75%, rewards 81.81% branches — claudedocs/server-testing-coverage.md).
//
// Three groups, all of them money-relevant:
//   • non-finite amounts. Every credit path guards `Number.isFinite` BEFORE flooring, because
//     Math.floor(Infinity) === Infinity would sail through an `=== 0` check straight into an
//     unconditional wallet `$inc` and corrupt the balance into NaN — unrecoverable without hand-editing
//     Mongo, since every later `$inc` keeps it NaN.
//   • the refund/delivery heal path in orders.ts, which decides whether a duplicate delivery callback
//     credits a second refund. Its four guards (no refund recorded / refund ≤ 0 / claim still fresh /
//     ledger row already there) are the only thing between Paddle-style at-least-once callbacks and
//     paying a duplicate refund twice.
//   • admin pool CRUD validation, where the "refuse" side keeps a pool config from shadowing a static
//     pool id or opening a window that never closes.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GROWTH_PACK_CARD_DAYS,
  GROWTH_PACK_COINS,
  MONTHLY_CARD_DAYS,
  MONTHLY_CARD_IMMEDIATE_COINS,
  PRODUCT_STARTER_DRAW,
  PRODUCT_STARTER_GROWTH,
  YEAR_CARD_DAYS,
} from '@nw/shared';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_guards_test';
const DAY = 86_400_000;

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[serviceGuards.e2e] Mongo unreachable (${URI}) — skipping.`);

let t = 2_000_000;
const now = () => t;

describe.skipIf(!mongo)('commercial service guards', () => {
  const m = mongo!;
  let svc: CommercialService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    t = 2_000_000;
    svc = new CommercialService({ cols: m.collections, now, rng: () => 0 });
  });

  afterAll(async () => {
    await m.close();
  });

  /** Fund a wallet through the dev-stub recharge path (t499 tier, no channel restriction). */
  async function fund(accountId: string, receiptId: string): Promise<number> {
    const r = await svc.rechargeVerify({ accountId, platform: 'dev', receipt: 'tier:t9999', receiptId });
    expect(r.ok).toBe(true);
    return r.ok ? r.coinsAfter : 0;
  }

  // ── non-finite amounts ─────────────────────────────────────────────────────
  describe('non-finite amounts are refused before they reach a $inc', () => {
    it.each([Infinity, -Infinity, NaN])('adsCredit(%p) → BAD_REQUEST, wallet untouched', async (amount) => {
      const r = await svc.adsCredit({ accountId: 'nf-ads', amount, dayKey: '2026-09-03' });
      expect(r).toEqual({ ok: false, error: 'BAD_REQUEST' });
      expect(await m.collections.wallets.countDocuments({ _id: 'nf-ads' })).toBe(0);
    });

    it.each([Infinity, NaN])('victoryCredit(%p) → BAD_REQUEST without consuming a daily win slot', async (amount) => {
      const r = await svc.victoryCredit({ accountId: 'nf-vic', amount, dayKey: '2026-09-03' });
      expect(r).toEqual({ ok: false, error: 'BAD_REQUEST' });
      expect(await m.collections.wallets.countDocuments({ _id: 'nf-vic' })).toBe(0);
    });

    it('spend(Infinity) → BAD_REQUEST and claims no order slot', async () => {
      const r = await svc.spend({ accountId: 'nf-spend', amount: Infinity, reason: 'rename', orderId: 'nf-sp-1' });
      expect(r).toEqual({ ok: false, error: 'BAD_REQUEST' });
      expect(await m.collections.orders.countDocuments({ _id: 'nf-sp-1' })).toBe(0);
    });

    // grant() deliberately accepts amount 0 (pure item/skin mail attachments claim an order slot with no
    // coins), so a non-finite amount collapses to 0 rather than being rejected: the slot is claimed, the
    // attachment is delivered by meta, and no coins move.
    it('grant(Infinity) claims the order slot but credits nothing', async () => {
      const r = await svc.grant({ accountId: 'nf-grant', amount: Infinity, reason: 'attachment', orderId: 'nf-gr-1' });
      expect(r).toEqual({ ok: true, coinsAfter: 0 });
      expect((await m.collections.orders.findOne({ _id: 'nf-gr-1' }))?.status).toBe('delivered');
      expect((await m.collections.wallets.findOne({ _id: 'nf-grant' }))?.coins).toBe(0);
      expect(await m.collections.ledger.countDocuments({ accountId: 'nf-grant' })).toBe(0);
    });
  });

  // ── orders.ts: duplicate delivery callbacks ────────────────────────────────
  describe('orderDelivered / refund heal', () => {
    async function chargedOrder(id: string, accountId = 'del-a'): Promise<void> {
      await fund(accountId, `rx-${id}`);
      const r = await svc.shopCharge({ accountId, itemId: 'skin_shop_c1', cost: 300, orderId: id });
      expect(r.ok).toBe(true);
    }

    it('a non-finite refundCoins is recorded as 0 rather than NaN', async () => {
      await chargedOrder('del-inf');
      expect(await svc.orderDelivered({ orderId: 'del-inf', refundCoins: Infinity })).toEqual({ ok: true });
      expect((await m.collections.orders.findOne({ _id: 'del-inf' }))?.refundCoins).toBe(0);
      expect(await m.collections.ledger.countDocuments({ reason: 'gacha_refund' })).toBe(0);
    });

    it('a fractional refundCoins is floored', async () => {
      await chargedOrder('del-frac');
      expect(await svc.orderDelivered({ orderId: 'del-frac', refundCoins: 12.9 })).toEqual({ ok: true });
      expect((await m.collections.orders.findOne({ _id: 'del-frac' }))?.refundCoins).toBe(12);
    });

    it('a negative refundCoins is clamped to 0 (a delivery never debits)', async () => {
      await chargedOrder('del-neg');
      expect(await svc.orderDelivered({ orderId: 'del-neg', refundCoins: -500 })).toEqual({ ok: true });
      expect((await m.collections.orders.findOne({ _id: 'del-neg' }))?.refundCoins).toBe(0);
    });

    it('an unknown orderId is NOT_FOUND', async () => {
      expect(await svc.orderDelivered({ orderId: 'nope' })).toEqual({ ok: false, error: 'NOT_FOUND' });
    });

    it('a duplicate callback on an order that recorded no refund is a plain ok', async () => {
      await chargedOrder('del-norefund');
      await svc.orderDelivered({ orderId: 'del-norefund' });
      // Strip refundCoins entirely, standing in for an order delivered before the field existed.
      await m.collections.orders.updateOne({ _id: 'del-norefund' }, { $unset: { refundCoins: '' } });
      t += 60_000; // well past the heal grace window
      expect(await svc.orderDelivered({ orderId: 'del-norefund' })).toEqual({ ok: true });
      expect(await m.collections.ledger.countDocuments({ reason: 'gacha_refund' })).toBe(0);
    });

    it('a duplicate callback within the grace window does not re-credit the refund', async () => {
      await chargedOrder('del-fresh');
      await svc.orderDelivered({ orderId: 'del-fresh', refundCoins: 40 });
      const after = await m.collections.wallets.findOne({ _id: 'del-a' });
      // Same millisecond: the winner's own credit may still be in flight, so healing here would race it.
      expect(await svc.orderDelivered({ orderId: 'del-fresh', refundCoins: 40 })).toEqual({ ok: true });
      expect((await m.collections.wallets.findOne({ _id: 'del-a' }))?.coins).toBe(after?.coins);
      expect(await m.collections.ledger.countDocuments({ orderId: 'del-fresh', reason: 'gacha_refund' })).toBe(1);
    });

    // The heal's "did the credit already land" probe reads `ledger.findOne({accountId, orderId})`, so it
    // can only tell refund-landed from refund-missing on an order that has NO other ledger row under the
    // same orderId. Starter-pack orders are exactly that shape (cost 0, inserted 'charged' with no ledger
    // row, items delivered by meta afterwards — so meta's duplicate-refund callback applies to them),
    // which is what these two use. See claudedocs/server-testing-coverage.md: for shop/gacha orders the
    // debit row already carries the same orderId and masks the probe, leaving the heal inert there.
    async function starterOrder(accountId: string, orderId: string): Promise<void> {
      const r = await svc.starterBuy({ accountId, productId: PRODUCT_STARTER_DRAW, orderId });
      expect(r.ok).toBe(true);
    }

    it('a stale duplicate callback does not re-credit a refund that already landed in the ledger', async () => {
      await starterOrder('del-landed-a', 'del-landed');
      await svc.orderDelivered({ orderId: 'del-landed', refundCoins: 40 });
      const coins = (await m.collections.wallets.findOne({ _id: 'del-landed-a' }))?.coins;
      expect(coins).toBe(40);
      t += 60_000; // past the grace window: healing is allowed, but the ledger row proves it isn't needed
      expect(await svc.orderDelivered({ orderId: 'del-landed', refundCoins: 40 })).toEqual({ ok: true });
      expect((await m.collections.wallets.findOne({ _id: 'del-landed-a' }))?.coins).toBe(40);
      expect(await m.collections.ledger.countDocuments({ orderId: 'del-landed', reason: 'gacha_refund' })).toBe(1);
    });

    // The crash this heal exists for: the status flip landed, the credit() call never ran. Simulated by
    // stamping the order delivered by hand (no deliveredAt either, so the staleness check falls back to
    // the order's own ts — an older row shape).
    it('heals a refund dropped by a crash between the status flip and the credit', async () => {
      await starterOrder('del-crash-a', 'del-crash');
      await m.collections.orders.updateOne(
        { _id: 'del-crash' },
        { $set: { status: 'delivered', refundCoins: 75 }, $unset: { deliveredAt: '' } },
      );
      t += 60_000;
      expect(await svc.orderDelivered({ orderId: 'del-crash', refundCoins: 75 })).toEqual({ ok: true });
      expect(await m.collections.ledger.countDocuments({ orderId: 'del-crash', reason: 'gacha_refund' })).toBe(1);
      expect((await m.collections.wallets.findOne({ _id: 'del-crash-a' }))?.coins).toBe(75);
      // And only once: the healClaimedAt CAS is now stamped, so a third callback is a no-op.
      expect(await svc.orderDelivered({ orderId: 'del-crash', refundCoins: 75 })).toEqual({ ok: true });
      expect(await m.collections.ledger.countDocuments({ orderId: 'del-crash', reason: 'gacha_refund' })).toBe(1);
    });
  });

  // ── recharge.ts ────────────────────────────────────────────────────────────
  describe('recharge guards', () => {
    it('a verifier that reports no usdCents leaves totalRechargeCents at 0', async () => {
      // Only real-money channels report a price; a verifier without one must not bump the lifetime
      // recharge counter (which drives reward tiers) with `undefined`.
      const noPrice = new CommercialService({
        cols: m.collections,
        now,
        verifyReceipt: () => ({ ok: true, coins: 500 }),
      });
      const r = await noPrice.rechargeVerify({ accountId: 'rc-nousd', platform: 'apple', receipt: 'x', receiptId: 'rc-nousd-1' });
      expect(r).toMatchObject({ ok: true, coinsGranted: 1000 }); // 500 × first-purchase bonus
      const w = await m.collections.wallets.findOne({ _id: 'rc-nousd' });
      expect(w?.totalRechargeCents ?? 0).toBe(0);
      expect((await m.collections.recharges.findOne({ _id: 'rc-nousd-1' }))?.usdCents).toBe(0);
    });

    it('a non-coin receipt already consumed by another account is refused', async () => {
      const first = await svc.verifyNonCoinReceipt({
        accountId: 'nc-owner', platform: 'apple', receipt: 'product:monthly_card', receiptId: 'nc-shared',
        expectedProduct: 'monthly_card',
      });
      expect(first).toEqual({ ok: true, product: 'monthly_card' });
      const stolen = await svc.verifyNonCoinReceipt({
        accountId: 'nc-thief', platform: 'apple', receipt: 'product:monthly_card', receiptId: 'nc-shared',
        expectedProduct: 'monthly_card',
      });
      expect(stolen).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
    });

    it('a receipt resolving to a different product than the caller expects is refused', async () => {
      // The fresh (no prior row) side of the cross-product guard: the dev stub resolves this receipt to
      // monthly_card, so a caller claiming a year card must be refused before anything is recorded.
      const r = await svc.verifyNonCoinReceipt({
        accountId: 'nc-mismatch', platform: 'apple', receipt: 'product:monthly_card', receiptId: 'nc-mismatch-1',
        expectedProduct: 'year_card',
      });
      expect(r).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
      expect(await m.collections.recharges.countDocuments({ _id: 'nc-mismatch-1' })).toBe(0);
    });

    it('a receipt that fails verification outright is refused', async () => {
      const r = await svc.verifyNonCoinReceipt({
        accountId: 'nc-bad', platform: 'apple', receipt: '', receiptId: 'nc-bad-1',
        expectedProduct: 'monthly_card',
      });
      expect(r).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
    });

    it('a receipt resolving to a coin tier cannot be claimed as a non-coin SKU', async () => {
      const r = await svc.verifyNonCoinReceipt({
        accountId: 'nc-coins', platform: 'apple', receipt: 'tier:t499', receiptId: 'nc-coins-1',
        expectedProduct: 'monthly_card',
      });
      expect(r).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
    });

    it('replaying a non-coin receipt for the same account and product is idempotent ok', async () => {
      // The two-step shape (verify, then grant) means meta re-verifies on a retry; the second call must
      // confirm the same SKU rather than refusing, or a retried card purchase can never complete.
      const args = {
        accountId: 'nc-same', platform: 'apple' as const, receipt: 'product:monthly_card', receiptId: 'nc-same-1',
        expectedProduct: 'monthly_card' as const,
      };
      expect(await svc.verifyNonCoinReceipt(args)).toEqual({ ok: true, product: 'monthly_card' });
      expect(await svc.verifyNonCoinReceipt(args)).toEqual({ ok: true, product: 'monthly_card' });
      expect(await m.collections.recharges.countDocuments({ _id: 'nc-same-1' })).toBe(1);
    });

    it('a non-coin receipt cannot be replayed for a different product', async () => {
      await svc.verifyNonCoinReceipt({
        accountId: 'nc-b', platform: 'apple', receipt: 'product:monthly_card', receiptId: 'nc-cross',
        expectedProduct: 'monthly_card',
      });
      const crossProduct = await svc.verifyNonCoinReceipt({
        accountId: 'nc-b', platform: 'apple', receipt: 'product:monthly_card', receiptId: 'nc-cross',
        expectedProduct: 'year_card',
      });
      expect(crossProduct).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
    });

    describe('paddleRefund', () => {
      it('an unknown transaction decrements nothing', async () => {
        expect(await svc.paddleRefund({ transactionId: 'txn_unknown' })).toEqual({ ok: true, decrementedCents: 0 });
      });

      it('a transaction recorded with no usdCents decrements nothing', async () => {
        await svc.paddleComplete({ accountId: 'pr-a', transactionId: 'txn_free', coins: 100 });
        expect(await svc.paddleRefund({ transactionId: 'txn_free' })).toEqual({ ok: true, decrementedCents: 0 });
      });

      it('decrements once, then treats the redelivered refund event as a no-op', async () => {
        await svc.paddleComplete({ accountId: 'pr-b', transactionId: 'txn_paid', coins: 550, usdCents: 499 });
        expect((await m.collections.wallets.findOne({ _id: 'pr-b' }))?.totalRechargeCents).toBe(499);
        expect(await svc.paddleRefund({ transactionId: 'txn_paid' })).toEqual({ ok: true, decrementedCents: 499 });
        expect((await m.collections.wallets.findOne({ _id: 'pr-b' }))?.totalRechargeCents).toBe(0);
        // Paddle delivers webhooks at least once.
        expect(await svc.paddleRefund({ transactionId: 'txn_paid' })).toEqual({ ok: true, decrementedCents: 0 });
        expect((await m.collections.wallets.findOne({ _id: 'pr-b' }))?.totalRechargeCents).toBe(0);
      });
    });
  });

  // ── subscription.ts / starter.ts channel routing ───────────────────────────
  describe('verified recharge platform decides which wallet bucket is funded (ADR-020)', () => {
    it('monthlyCardBuy from an apple receipt funds recharged.apple, not the free pool', async () => {
      const r = await svc.monthlyCardBuy({ accountId: 'ch-apple', orderId: 'ch-1', rechargePlatform: 'apple', clientPlatform: 'ios' });
      expect(r).toMatchObject({ ok: true, coinsAfter: MONTHLY_CARD_IMMEDIATE_COINS });
      const w = await m.collections.wallets.findOne({ _id: 'ch-apple' });
      expect(w?.coins).toBe(0);
      expect(w?.recharged?.apple).toBe(MONTHLY_CARD_IMMEDIATE_COINS);
      expect(w?.subscription?.expiry).toBe(t + MONTHLY_CARD_DAYS * DAY);
    });

    it('yearCardBuy from a paddle receipt funds recharged.web', async () => {
      const r = await svc.yearCardBuy({ accountId: 'ch-web', orderId: 'ch-2', rechargePlatform: 'paddle' });
      expect(r).toMatchObject({ ok: true });
      const w = await m.collections.wallets.findOne({ _id: 'ch-web' });
      expect(w?.recharged?.web).toBe(MONTHLY_CARD_IMMEDIATE_COINS);
      expect(w?.subscription?.expiry).toBe(t + YEAR_CARD_DAYS * DAY);
    });

    // rechargeChannelOf returns null for anything it doesn't recognize (the dev stub's platform strings),
    // which must fall back to the always-spendable free pool — the behaviour from before channels existed.
    it('an unrecognized recharge platform falls back to the free coins pool', async () => {
      await svc.monthlyCardBuy({ accountId: 'ch-dev', orderId: 'ch-3', rechargePlatform: 'dev-stub' });
      const w = await m.collections.wallets.findOne({ _id: 'ch-dev' });
      expect(w?.coins).toBe(MONTHLY_CARD_IMMEDIATE_COINS);
      expect(w?.recharged).toBeUndefined();
    });

    it('the growth starter pack funds the verified channel and stamps the 7-day card', async () => {
      const r = await svc.starterBuy({
        accountId: 'st-apple', productId: PRODUCT_STARTER_GROWTH, orderId: 'st-1', rechargePlatform: 'apple', clientPlatform: 'ios',
      });
      expect(r).toMatchObject({ ok: true, coinsAfter: GROWTH_PACK_COINS, subscriptionExpiry: t + GROWTH_PACK_CARD_DAYS * DAY });
      const w = await m.collections.wallets.findOne({ _id: 'st-apple' });
      expect(w?.recharged?.apple).toBe(GROWTH_PACK_COINS);
      expect(w?.coins).toBe(0);
      expect(await m.collections.ledger.countDocuments({ accountId: 'st-apple', reason: 'starter_growth' })).toBe(1);
    });

    it('the growth pack from an unrecognized platform funds the free pool', async () => {
      // rechargePlatform present but unmapped (the dev stub's platform strings) — the `?? undefined`
      // half, distinct from omitting the field entirely below.
      await svc.starterBuy({ accountId: 'st-dev', productId: PRODUCT_STARTER_GROWTH, orderId: 'st-2', rechargePlatform: 'dev-stub' });
      const w = await m.collections.wallets.findOne({ _id: 'st-dev' });
      expect(w?.coins).toBe(GROWTH_PACK_COINS);
      expect(w?.recharged).toBeUndefined();
    });

    it('the growth pack with no rechargePlatform at all funds the free pool', async () => {
      await svc.starterBuy({ accountId: 'st-none', productId: PRODUCT_STARTER_GROWTH, orderId: 'st-3' });
      const w = await m.collections.wallets.findOne({ _id: 'st-none' });
      expect(w?.coins).toBe(GROWTH_PACK_COINS);
      expect(w?.recharged).toBeUndefined();
    });

    it('yearCardBuy from an unrecognized platform funds the free pool', async () => {
      await svc.yearCardBuy({ accountId: 'ch-year-dev', orderId: 'ch-5', rechargePlatform: 'dev-stub' });
      const w = await m.collections.wallets.findOne({ _id: 'ch-year-dev' });
      expect(w?.coins).toBe(MONTHLY_CARD_IMMEDIATE_COINS);
      expect(w?.recharged).toBeUndefined();
    });

    it('yearCardBuy with no rechargePlatform funds the free pool', async () => {
      await svc.yearCardBuy({ accountId: 'ch-year-free', orderId: 'ch-4' });
      const w = await m.collections.wallets.findOne({ _id: 'ch-year-free' });
      expect(w?.coins).toBe(MONTHLY_CARD_IMMEDIATE_COINS);
      expect(w?.recharged).toBeUndefined();
      expect(w?.subscription?.expiry).toBe(t + YEAR_CARD_DAYS * DAY);
    });
  });

  // ── starter.ts replay / rejection branches ────────────────────────────────
  describe('starterBuy', () => {
    it('refuses a productId that is neither starter SKU', async () => {
      const r = await svc.starterBuy({ accountId: 'st-bad', productId: 'starter_deluxe', orderId: 'st-bad-1' });
      expect(r).toEqual({ ok: false, error: 'BAD_REQUEST' });
      expect(await m.collections.orders.countDocuments({})).toBe(0);
    });

    it('reports the active subscription expiry when the draw pack is bought during a card', async () => {
      await svc.monthlyCardBuy({ accountId: 'st-sub', orderId: 'st-sub-card' });
      const r = await svc.starterBuy({ accountId: 'st-sub', productId: PRODUCT_STARTER_DRAW, orderId: 'st-sub-draw' });
      expect(r).toMatchObject({ ok: true, subscriptionExpiry: t + MONTHLY_CARD_DAYS * DAY });
      expect(r.ok && r.results).toHaveLength(10);
    });

    it('replaying a draw-pack orderId returns the recorded results, not a fresh roll', async () => {
      const first = await svc.starterBuy({ accountId: 'st-replay', productId: PRODUCT_STARTER_DRAW, orderId: 'st-replay-1' });
      expect(first.ok).toBe(true);
      const replay = await svc.starterBuy({ accountId: 'st-replay', productId: PRODUCT_STARTER_DRAW, orderId: 'st-replay-1' });
      expect(replay.ok && replay.results).toEqual(first.ok && first.results);
      expect(await m.collections.orders.countDocuments({ accountId: 'st-replay' })).toBe(1);
    });

    it('replaying a delivered growth orderId returns an empty result list and the granted expiry', async () => {
      await svc.starterBuy({ accountId: 'st-gr', productId: PRODUCT_STARTER_GROWTH, orderId: 'st-gr-1' });
      const replay = await svc.starterBuy({ accountId: 'st-gr', productId: PRODUCT_STARTER_GROWTH, orderId: 'st-gr-1' });
      expect(replay).toMatchObject({ ok: true, results: [], subscriptionExpiry: t + GROWTH_PACK_CARD_DAYS * DAY });
    });

    it('a still-fresh charged growth claim reports a snapshot instead of re-granting', async () => {
      // Hand-reserved slot, as the real path leaves it between the insert and applySubscription.
      await m.collections.wallets.insertOne({
        _id: 'st-fresh', coins: 10, rev: 0, gacha: { pity: {} }, subscription: { expiry: t + 5 * DAY }, updatedAt: t,
      });
      await m.collections.orders.insertOne({
        _id: 'st-fresh-1', accountId: 'st-fresh', kind: 'grant', cost: 0, status: 'charged', coinsAfter: 0, result: {}, ts: t,
      });
      const r = await svc.starterBuy({ accountId: 'st-fresh', productId: PRODUCT_STARTER_GROWTH, orderId: 'st-fresh-1' });
      expect(r).toMatchObject({ ok: true, coinsAfter: 10, subscriptionExpiry: t + 5 * DAY, results: [] });
      expect(await m.collections.ledger.countDocuments({ accountId: 'st-fresh' })).toBe(0);
    });

    it('resumes a stale charged growth claim (the original attempt crashed)', async () => {
      await m.collections.orders.insertOne({
        _id: 'st-stale-1', accountId: 'st-stale', kind: 'grant', cost: 0, status: 'charged', coinsAfter: 0, result: {}, ts: t,
      });
      t += 60_000;
      const r = await svc.starterBuy({ accountId: 'st-stale', productId: PRODUCT_STARTER_GROWTH, orderId: 'st-stale-1' });
      expect(r).toMatchObject({ ok: true, coinsAfter: GROWTH_PACK_COINS });
      expect((await m.collections.orders.findOne({ _id: 'st-stale-1' }))?.status).toBe('delivered');
    });

    it('refuses another account\'s orderId', async () => {
      await svc.starterBuy({ accountId: 'st-own', productId: PRODUCT_STARTER_DRAW, orderId: 'st-own-1' });
      const r = await svc.starterBuy({ accountId: 'st-other', productId: PRODUCT_STARTER_DRAW, orderId: 'st-own-1' });
      expect(r).toEqual({ ok: false, error: 'BAD_REQUEST' });
    });
  });

  // ── gachaPool.ts admin CRUD ───────────────────────────────────────────────
  describe('limited/custom pool CRUD validation', () => {
    const validLimited = { id: 'lp_ok', name: 'Spring', featuredLegendary: 'skin_l1', startAt: 1000, endAt: 2000 };

    it('accepts a well-formed limited pool and stores fillerLegendaries when given', async () => {
      const r = await svc.createLimitedPool({ config: { ...validLimited, fillerLegendaries: ['max', 'lena'] }, createdBy: 'admin1' });
      expect(r).toEqual({ ok: true, id: 'lp_ok' });
      expect(await m.collections.gachaPools.findOne({ _id: 'lp_ok' })).toMatchObject({
        featuredLegendary: 'skin_l1',
        fillerLegendaries: ['max', 'lena'],
        createdBy: 'admin1',
      });
    });

    it('omits fillerLegendaries entirely when the config has none', async () => {
      await svc.createLimitedPool({ config: validLimited, createdBy: 'admin1' });
      const doc = await m.collections.gachaPools.findOne({ _id: 'lp_ok' });
      expect(Object.keys(doc!)).not.toContain('fillerLegendaries');
    });

    it.each([
      ['no id', { ...validLimited, id: '' }],
      ['no name', { ...validLimited, name: '' }],
      ['no featured legendary', { ...validLimited, featuredLegendary: '' }],
      ['endAt equal to startAt', { ...validLimited, endAt: validLimited.startAt }],
      ['endAt before startAt', { ...validLimited, endAt: validLimited.startAt - 1 }],
    ])('refuses a limited pool with %s', async (_label, config) => {
      const r = await svc.createLimitedPool({ config, createdBy: 'admin1' });
      expect(r).toEqual({ ok: false, error: 'BAD_REQUEST' });
      expect(await m.collections.gachaPools.countDocuments({})).toBe(0);
    });

    // A stored pool that shadows a static id would never be reachable (resolvePool checks the static
    // table first), so the config would look saved while never taking effect.
    it('refuses a limited pool that shadows a static pool id', async () => {
      const r = await svc.createLimitedPool({ config: { ...validLimited, id: 'standard' }, createdBy: 'admin1' });
      expect(r).toEqual({ ok: false, error: 'BAD_REQUEST' });
    });

    it('refuses a custom pool that shadows a static pool id', async () => {
      const r = await svc.createCustomPool({
        config: {
          id: 'standard', name: 'Shadow', costSingle: 100, startAt: 0, endAt: 10,
          categories: [{ category: 'material', weight: 1, items: [{ itemId: 'mat_scrap', weight: 1 }] }],
        },
        createdBy: 'admin1',
      });
      expect(r).toEqual({ ok: false, error: 'BAD_REQUEST' });
    });

    // Editing a pool re-writes the whole document (replaceOne), so createdBy/createdAt have to be carried
    // over from the previous version or the audit trail would name the last editor as the author.
    it('preserves the original createdBy/createdAt when a custom pool is edited', async () => {
      const config = {
        id: 'cp_edit', name: 'Festival', costSingle: 100, startAt: 0, endAt: 99_999,
        categories: [{ category: 'material' as const, weight: 1, items: [{ itemId: 'mat_scrap', weight: 1 }] }],
      };
      await svc.createCustomPool({ config, createdBy: 'author' });
      const original = await m.collections.gachaPools.findOne({ _id: 'cp_edit' });
      t += 5000;
      await svc.createCustomPool({ config: { ...config, name: 'Festival v2', costTen: 900 }, createdBy: 'editor' });
      const edited = await m.collections.gachaPools.findOne({ _id: 'cp_edit' });
      expect(edited).toMatchObject({ name: 'Festival v2', costTen: 900, createdBy: 'author', createdAt: original!.createdAt });
    });

    it('closing an unknown pool id is NOT_FOUND', async () => {
      expect(await svc.closeLimitedPool({ id: 'lp_ghost' })).toEqual({ ok: false, error: 'NOT_FOUND' });
    });

    it('closing a pool clamps endAt to now and stamps closedAt', async () => {
      await svc.createLimitedPool({ config: { ...validLimited, endAt: t + 100_000 }, createdBy: 'admin1' });
      expect(await svc.closeLimitedPool({ id: 'lp_ok' })).toEqual({ ok: true, id: 'lp_ok' });
      const doc = await m.collections.gachaPools.findOne({ _id: 'lp_ok' });
      expect(doc).toMatchObject({ endAt: t, closedAt: t });
      // Retained (not deleted) so its featured legendary stays Fate-redeemable.
      expect(await svc.listLimitedPools()).toHaveLength(1);
      expect(await svc.listActiveLimitedPools(t + 1)).toHaveLength(0);
    });
  });
});
