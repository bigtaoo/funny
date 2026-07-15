// commercial service idempotency / concurrency / boundary / ledger-consistency (S5-2~4).
//   Complements service.e2e.test.ts (happy-path + basic replay) by exercising the harder guarantees:
//     • order-id / receipt-id conflict branches (the try/catch E11000 concurrent-race paths);
//     • paddleComplete (previously untested end to end);
//     • boundary inputs (amount<=0, fractional, exact-balance, off-catalog cost, bad count);
//     • WalletDoc ↔ ledger consistency (balanceAfter chain, delta sum, rev monotonicity, no phantom entries on replay).
// Same harness as service.e2e.test.ts: a standalone mongod via globalSetup (no Docker). Serial file execution.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';
import type { RandInt } from '../src/gacha';
import { FIRST_PURCHASE_BONUS_MULTIPLIER } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_idem_test';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[commercial.idem.e2e] Mongo unreachable (${URI}) — skipping.`);

const zero: RandInt = () => 0;
let t = 1000;
const now = () => t++;

/** Reset the monotonic clock between tests so subscription-expiry maths are deterministic. */
function resetClock() {
  t = 1000;
}

describe.skipIf(!mongo)('commercial service — idempotency / concurrency / boundaries', () => {
  const m = mongo!;
  let svc: CommercialService;

  /** Top up an account to a known balance via a first-purchase-free grant (keeps recharge/bonus paths out of arrange steps). */
  async function fund(accountId: string, coins: number): Promise<void> {
    await svc.grant({ accountId, amount: coins, reason: 'test_fund', orderId: `fund:${accountId}:${coins}:${t}` });
  }

  /** Ledger rows for an account in insertion (ts) order. */
  async function ledgerOf(accountId: string) {
    return m.collections.ledger.find({ accountId }).sort({ ts: 1 }).toArray();
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    resetClock();
    svc = new CommercialService({ cols: m.collections, now, rng: zero });
  });

  afterAll(async () => {
    if (m) {
      await m.db.dropDatabase();
      await m.close();
    }
  });

  // ── Concurrent order-id conflict: the E11000 try/catch branches ────────────────
  it('grant: N concurrent calls with the same orderId credit exactly once (E11000 branch)', async () => {
    const calls = Array.from({ length: 12 }, () =>
      svc.grant({ accountId: 'gc', amount: 500, reason: 'mail', orderId: 'dup-grant' }),
    );
    const res = await Promise.all(calls);
    // Money guarantee: all calls succeed, coins credited exactly once (never a doubled 1000).
    expect(res.every((r) => r.ok)).toBe(true);
    expect((await svc.getWallet('gc')).coins).toBe(500);
    // Exactly one order + exactly one ledger row survive the race.
    expect(await m.collections.orders.countDocuments({ _id: 'dup-grant' })).toBe(1);
    expect((await ledgerOf('gc')).length).toBe(1);
    // NOTE: losing callers of the race take the E11000 branch and read the order doc before the winner
    // has back-filled coinsAfter, so they may return coinsAfter:0 (a stale value, not a wrong balance).
    // The winner returns the correct 500. Callers must treat grant's return as advisory, not authoritative.
    expect(res.some((r) => r.ok && r.coinsAfter === 500)).toBe(true);
  });

  it('monthlyCardBuy: concurrent calls with the same orderId grant the card exactly once (E11000 branch)', async () => {
    const calls = Array.from({ length: 8 }, () => svc.monthlyCardBuy({ accountId: 'mcx', orderId: 'dup-mc' }));
    const res = await Promise.all(calls);
    expect(res.every((r) => r.ok)).toBe(true);
    // Immediate grant applied once (600), not 8×.
    expect((await svc.getWallet('mcx')).coins).toBe(600);
    expect(await m.collections.orders.countDocuments({ _id: 'dup-mc' })).toBe(1);
    // The immediate-coin ledger row is written once.
    expect((await ledgerOf('mcx')).filter((l) => l.reason === 'monthly_card').length).toBe(1);
  });

  it('shopCharge: SEQUENTIAL duplicate orderId debits exactly once (idempotent replay)', async () => {
    await fund('scs', 1000);
    const first = await svc.shopCharge({ accountId: 'scs', itemId: 'skin_shop_c1', cost: 300, orderId: 'seq-shop' });
    expect(first.ok && first.coinsAfter).toBe(700);
    // Replay after the first has fully committed → short-circuits on the existing order, no second debit.
    const replay = await svc.shopCharge({ accountId: 'scs', itemId: 'skin_shop_c1', cost: 300, orderId: 'seq-shop' });
    expect(replay.ok && replay.coinsAfter).toBe(700);
    expect((await svc.getWallet('scs')).coins).toBe(700);
    expect(await m.collections.orders.countDocuments({ _id: 'seq-shop' })).toBe(1);
    expect((await ledgerOf('scs')).filter((l) => l.reason === 'shop').length).toBe(1);
  });

  // Insert-first idempotency on the debit paths (shopCharge / spend / gachaDraw): the order-id slot is claimed
  // BEFORE the wallet is debited and orders.insertOne's E11000 is caught, so two CONCURRENT calls with the same
  // orderId can no longer both pass the "existing order?" check and double-charge. The loser of the race takes the
  // E11000 branch and returns the existing order's result without a second debit — matching the credit paths
  // (grant / monthlyCardBuy / rechargeVerify / paddleComplete). Fixed in service.ts (see COMMERCIAL_DESIGN §6.5).
  it('shopCharge: concurrent duplicate orderId debits exactly once and never throws', async () => {
    await fund('sc', 1000);
    const calls = Array.from({ length: 6 }, () =>
      svc.shopCharge({ accountId: 'sc', itemId: 'skin_shop_c1', cost: 300, orderId: 'dup-shop' }),
    );
    const res = await Promise.allSettled(calls);
    // No call rejects, wallet debited once, and exactly one order/ledger row survive the race.
    expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await svc.getWallet('sc')).coins).toBe(700);
    expect(await m.collections.orders.countDocuments({ _id: 'dup-shop' })).toBe(1);
    expect((await ledgerOf('sc')).filter((l) => l.reason === 'shop').length).toBe(1);
  });

  it('spend: concurrent duplicate orderId debits exactly once and never throws', async () => {
    await fund('spc', 1000);
    const calls = Array.from({ length: 6 }, () =>
      svc.spend({ accountId: 'spc', amount: 300, reason: 'rename', orderId: 'dup-spend' }),
    );
    const res = await Promise.allSettled(calls);
    expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    expect((await svc.getWallet('spc')).coins).toBe(700);
    expect(await m.collections.orders.countDocuments({ _id: 'dup-spend' })).toBe(1);
    expect((await ledgerOf('spc')).filter((l) => l.reason === 'rename').length).toBe(1);
  });

  it('gachaDraw: concurrent duplicate orderId debits exactly once and never throws', async () => {
    await fund('gcx', 1000);
    const calls = Array.from({ length: 6 }, () =>
      svc.gachaDraw({ accountId: 'gcx', poolId: 'standard', count: 1, orderId: 'dup-gacha' }),
    );
    const res = await Promise.allSettled(calls);
    expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    // Single draw costs 150 → debited once (850), not 6×.
    expect((await svc.getWallet('gcx')).coins).toBe(850);
    expect(await m.collections.orders.countDocuments({ _id: 'dup-gacha' })).toBe(1);
    expect((await ledgerOf('gcx')).filter((l) => l.reason === 'gacha').length).toBe(1);
    expect(await m.collections.gachaHistory.countDocuments({ orderId: 'dup-gacha' })).toBe(1);
  });

  // 2026-07-15 latency fix: gachaDraw's idempotency-check/resolvePool/ensureWallet reads now run via Promise.all
  // instead of serially. Distinct concurrent draws (different orderIds, same account) are NOT deduped by the
  // insert-first orderId slot — each must still debit its own cost exactly once and land its own history row,
  // i.e. the parallel reads must not let one draw's in-flight wallet state leak into another's debit.
  it('gachaDraw: N concurrent DISTINCT draws (different orderIds, same account) each debit exactly once, none lost or double-granted', async () => {
    await fund('gcd', 10 * 150);
    const orderIds = Array.from({ length: 10 }, (_, i) => `distinct-gacha-${i}`);
    const calls = orderIds.map((orderId) =>
      svc.gachaDraw({ accountId: 'gcd', poolId: 'standard', count: 1, orderId }),
    );
    const res = await Promise.all(calls);
    expect(res.every((r) => r.ok)).toBe(true);
    // Exactly 10 draws × 150 coins, no over- or under-charging from racing wallet reads.
    expect((await svc.getWallet('gcd')).coins).toBe(0);
    expect(await m.collections.orders.countDocuments({ accountId: 'gcd', kind: 'gacha' })).toBe(10);
    expect((await ledgerOf('gcd')).filter((l) => l.reason === 'gacha').length).toBe(10);
    expect(await m.collections.gachaHistory.countDocuments({ accountId: 'gcd' })).toBe(10);
  });

  // ── rechargeVerify: receipt-id conflict + cross-account guard under concurrency ──
  it('rechargeVerify: concurrent calls with the same receiptId (same account) credit exactly once', async () => {
    const calls = Array.from({ length: 10 }, () =>
      svc.rechargeVerify({ accountId: 'rc', platform: 'web', receipt: 'tier:t499', receiptId: 'dup-rc' }),
    );
    const res = await Promise.all(calls);
    expect(res.every((r) => r.ok)).toBe(true);
    // t499 = 550. Exactly one recharge doc, coins credited once.
    expect(await m.collections.recharges.countDocuments({ _id: 'dup-rc' })).toBe(1);
    const coins = (await svc.getWallet('rc')).coins;
    // Whether the winner claimed the first-purchase bonus depends on wallet-existence timing; either way it is credited ONCE.
    expect([550, 550 * FIRST_PURCHASE_BONUS_MULTIPLIER]).toContain(coins);
    expect((await ledgerOf('rc')).filter((l) => l.reason === 'recharge').length).toBe(1);
  });

  it('rechargeVerify: concurrent same receiptId from two accounts → one credit, the other rejected (no cross-account leak)', async () => {
    const [a, b] = await Promise.all([
      svc.rechargeVerify({ accountId: 'accA', platform: 'web', receipt: 'tier:t499', receiptId: 'shared-rc' }),
      svc.rechargeVerify({ accountId: 'accB', platform: 'web', receipt: 'tier:t499', receiptId: 'shared-rc' }),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const errs = [a, b].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(errs.length).toBe(1);
    expect(errs[0]).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
    // The loser's wallet is never credited from the other account's receipt.
    const total = (await svc.getWallet('accA')).coins + (await svc.getWallet('accB')).coins;
    expect([550, 550 * FIRST_PURCHASE_BONUS_MULTIPLIER]).toContain(total);
    expect(await m.collections.recharges.countDocuments({ _id: 'shared-rc' })).toBe(1);
  });

  // ── paddleComplete (previously untested) ───────────────────────────────────────
  it('paddleComplete: credits coins with first-purchase 2× bonus + idempotent replay by transactionId', async () => {
    const r1 = await svc.paddleComplete({ accountId: 'pd', transactionId: 'txn-1', coins: 550 });
    expect(r1.ok).toBe(true);
    // paddleComplete ensures the wallet BEFORE claiming the bonus, so a genuine first purchase gets the 2× multiplier.
    if (r1.ok) expect(r1.coinsGranted).toBe(550 * FIRST_PURCHASE_BONUS_MULTIPLIER);
    // Replay same transactionId → no second credit.
    const r2 = await svc.paddleComplete({ accountId: 'pd', transactionId: 'txn-1', coins: 550 });
    expect(r2.ok && r2.coinsAfter).toBe(550 * FIRST_PURCHASE_BONUS_MULTIPLIER);
    expect((await svc.getWallet('pd')).coins).toBe(550 * FIRST_PURCHASE_BONUS_MULTIPLIER);
    expect(await m.collections.recharges.countDocuments({ _id: 'paddle:txn-1' })).toBe(1);
    // A SECOND, distinct purchase gets no bonus (firstPurchasedAt already claimed).
    const r3 = await svc.paddleComplete({ accountId: 'pd', transactionId: 'txn-2', coins: 550 });
    expect(r3.ok && r3.coinsGranted).toBe(550);
  });

  it('paddleComplete: replaying another account’s transactionId is rejected (INVALID_RECEIPT)', async () => {
    await svc.paddleComplete({ accountId: 'owner', transactionId: 'txn-x', coins: 550 });
    const other = await svc.paddleComplete({ accountId: 'thief', transactionId: 'txn-x', coins: 550 });
    expect(other).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
    expect((await svc.getWallet('thief')).coins).toBe(0);
  });

  it('paddleComplete: concurrent same transactionId credit exactly once (E11000 branch)', async () => {
    const calls = Array.from({ length: 10 }, () =>
      svc.paddleComplete({ accountId: 'pdc', transactionId: 'txn-c', coins: 550 }),
    );
    const res = await Promise.all(calls);
    expect(res.every((r) => r.ok)).toBe(true);
    expect((await svc.getWallet('pdc')).coins).toBe(550 * FIRST_PURCHASE_BONUS_MULTIPLIER);
    expect(await m.collections.recharges.countDocuments({ _id: 'paddle:txn-c' })).toBe(1);
    expect((await ledgerOf('pdc')).filter((l) => l.reason === 'recharge').length).toBe(1);
  });

  // ── First-purchase bonus semantics on rechargeVerify ───────────────────────────
  it('rechargeVerify: first-purchase 2× bonus lands on the FIRST recharge; the second gets no bonus', async () => {
    // rechargeVerify now ensures the wallet BEFORE claimFirstPurchaseBonus (§6.5), so the CAS matches on the
    // genuine first purchase and the 2× multiplier is applied to recharge #1 — matching paddleComplete.
    const first = await svc.rechargeVerify({ accountId: 'q', platform: 'web', receipt: 'tier:t499', receiptId: 'q1' });
    expect(first.ok && first.coinsGranted).toBe(550 * FIRST_PURCHASE_BONUS_MULTIPLIER); // 2× on the true first purchase
    const second = await svc.rechargeVerify({ accountId: 'q', platform: 'web', receipt: 'tier:t499', receiptId: 'q2' });
    expect(second.ok && second.coinsGranted).toBe(550); // no bonus on the second purchase
    expect((await svc.getWallet('q')).coins).toBe(550 * FIRST_PURCHASE_BONUS_MULTIPLIER + 550);
  });

  // ── Boundary inputs ────────────────────────────────────────────────────────────
  it('spend: non-positive / fractional-below-one amounts are rejected as BAD_REQUEST', async () => {
    await fund('sp', 1000);
    expect(await svc.spend({ accountId: 'sp', amount: 0, reason: 'x', orderId: 's0' })).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(await svc.spend({ accountId: 'sp', amount: -50, reason: 'x', orderId: 's1' })).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(await svc.spend({ accountId: 'sp', amount: 0.5, reason: 'x', orderId: 's2' })).toEqual({ ok: false, error: 'BAD_REQUEST' });
    // Balance untouched, and no order rows were created for the rejected calls.
    expect((await svc.getWallet('sp')).coins).toBe(1000);
    expect(await m.collections.orders.countDocuments({ _id: { $in: ['s0', 's1', 's2'] } })).toBe(0);
  });

  it('spend: fractional amount is floored before debit', async () => {
    await fund('spf', 1000);
    const r = await svc.spend({ accountId: 'spf', amount: 300.9, reason: 'rename', orderId: 'spf1' });
    expect(r.ok && r.coinsAfter).toBe(700); // floor(300.9) = 300
    expect((await ledgerOf('spf')).filter((l) => l.reason === 'rename')[0]!.delta).toBe(-300);
  });

  it('spend: exact-balance debits to zero; one-over is rejected', async () => {
    await fund('spe', 300);
    const exact = await svc.spend({ accountId: 'spe', amount: 300, reason: 'rename', orderId: 'e1' });
    expect(exact.ok && exact.coinsAfter).toBe(0);
    await fund('spe2', 300);
    const over = await svc.spend({ accountId: 'spe2', amount: 301, reason: 'rename', orderId: 'e2' });
    expect(over).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
    expect((await svc.getWallet('spe2')).coins).toBe(300);
  });

  it('shopCharge: unknown item and price-mismatch both reject as BAD_REQUEST before touching the wallet', async () => {
    await fund('sh', 1000);
    expect(await svc.shopCharge({ accountId: 'sh', itemId: 'no_such_item', cost: 300, orderId: 'x1' })).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(await svc.shopCharge({ accountId: 'sh', itemId: 'skin_shop_c1', cost: 1, orderId: 'x2' })).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect((await svc.getWallet('sh')).coins).toBe(1000);
  });

  it('gachaDraw: invalid count is rejected; exact-cost balance succeeds, one-under fails', async () => {
    // count must be 1 or 10.
    await fund('ga', 1000);
    const bad = await svc.gachaDraw({ accountId: 'ga', poolId: 'standard', count: 5, orderId: 'gab' });
    expect(bad).toEqual({ ok: false, error: 'BAD_REQUEST' });
    // Exact single-draw cost (150): 150 balance → 0; 149 → INSUFFICIENT_FUNDS.
    await m.collections.wallets.deleteOne({ _id: 'gexact' });
    await fund('gexact', 150);
    const ok = await svc.gachaDraw({ accountId: 'gexact', poolId: 'standard', count: 1, orderId: 'gx1' });
    expect(ok.ok && ok.coinsAfter).toBe(0);
    await fund('gunder', 149);
    const under = await svc.gachaDraw({ accountId: 'gunder', poolId: 'standard', count: 1, orderId: 'gu1' });
    expect(under).toEqual({ ok: false, error: 'INSUFFICIENT_FUNDS' });
  });

  it('adsCredit / victoryCredit: non-positive amount rejected as BAD_REQUEST', async () => {
    expect(await svc.adsCredit({ accountId: 'ad', amount: 0, dayKey: 'd' })).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(await svc.adsCredit({ accountId: 'ad', amount: -10, dayKey: 'd' })).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(await svc.victoryCredit({ accountId: 'vi', amount: 0, dayKey: 'd' })).toEqual({ ok: false, error: 'BAD_REQUEST' });
  });

  // ── WalletDoc ↔ ledger consistency ─────────────────────────────────────────────
  it('ledger: every entry chains balanceAfter, deltas sum to the wallet balance, and rev is monotonic', async () => {
    // A mixed sequence of credits and debits.
    await svc.grant({ accountId: 'led', amount: 1000, reason: 'mail', orderId: 'l-grant' });
    await svc.spend({ accountId: 'led', amount: 300, reason: 'rename', orderId: 'l-spend' });
    await svc.shopCharge({ accountId: 'led', itemId: 'skin_shop_c1', cost: 300, orderId: 'l-shop' });
    await svc.adsCredit({ accountId: 'led', amount: 50, dayKey: 'd' });

    const wallet = await m.collections.wallets.findOne({ _id: 'led' });
    const rows = await ledgerOf('led');
    // Deltas: +1000, −300, −300, +50 = 450.
    const sum = rows.reduce((s, r) => s + r.delta, 0);
    expect(sum).toBe(450);
    expect(wallet!.coins).toBe(450);
    // Each ledger row's balanceAfter equals the running total up to and including that row.
    let running = 0;
    for (const r of rows) {
      running += r.delta;
      expect(r.balanceAfter).toBe(running);
    }
    // The final ledger balanceAfter matches the wallet doc.
    expect(rows[rows.length - 1]!.balanceAfter).toBe(wallet!.coins);
    // rev bumped once per mutation (4 successful ops).
    expect(wallet!.rev).toBe(4);
  });

  it('ledger: idempotent replays never write phantom entries', async () => {
    await fund('rp', 1000);
    const baseline = (await ledgerOf('rp')).length;
    // Replay each idempotent op several times.
    for (let i = 0; i < 3; i++) {
      await svc.shopCharge({ accountId: 'rp', itemId: 'skin_shop_c1', cost: 300, orderId: 'rp-shop' });
      await svc.spend({ accountId: 'rp', amount: 100, reason: 'rename', orderId: 'rp-spend' });
      await svc.grant({ accountId: 'rp', amount: 200, reason: 'mail', orderId: 'rp-grant' });
    }
    const rows = await ledgerOf('rp');
    // baseline(fund) + exactly one row per distinct order (shop, spend, grant).
    expect(rows.length).toBe(baseline + 3);
    expect((await svc.getWallet('rp')).coins).toBe(1000 - 300 - 100 + 200);
  });

  it('grant: amount=0 reserves the idempotent order slot but writes no ledger entry', async () => {
    const before = (await ledgerOf('z')).length;
    const r = await svc.grant({ accountId: 'z', amount: 0, reason: 'skin_only', orderId: 'z0' });
    expect(r.ok && r.coinsAfter).toBe(0);
    // Order slot reserved (delivered), but no coin credit → no ledger row.
    expect(await m.collections.orders.countDocuments({ _id: 'z0' })).toBe(1);
    expect((await ledgerOf('z')).length).toBe(before);
  });

  // ── orderDelivered: refund is credited exactly once even under replay ──────────
  it('orderDelivered: refundCoins credited once; replay and unknown order are safe', async () => {
    await fund('od', 1000);
    await svc.shopCharge({ accountId: 'od', itemId: 'skin_shop_c1', cost: 300, orderId: 'od1' }); // 700
    const d1 = await svc.orderDelivered({ orderId: 'od1', refundCoins: 50 });
    expect(d1.ok).toBe(true);
    expect((await svc.getWallet('od')).coins).toBe(750); // refunded once
    // Replay: no second refund.
    await svc.orderDelivered({ orderId: 'od1', refundCoins: 50 });
    expect((await svc.getWallet('od')).coins).toBe(750);
    expect((await ledgerOf('od')).filter((l) => l.reason === 'gacha_refund').length).toBe(1);
    // Unknown order → NOT_FOUND.
    expect(await svc.orderDelivered({ orderId: 'nope' })).toEqual({ ok: false, error: 'NOT_FOUND' });
  });
});
