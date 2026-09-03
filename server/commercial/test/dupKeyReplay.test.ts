// What the LOSER of an idempotency-key race reports back — the E11000 catch blocks and their `??`
// fallbacks, plus the non-duplicate rethrow beside each one.
//
// Nine call sites in this package reserve their idempotency key with an insert BEFORE the costly side of
// the operation (shop.ts's shopCharge/spend/grant, gachaDraw.ts's gachaDraw/redeemFate, recharge.ts's
// rechargeVerify/verifyNonCoinReceipt/paddleComplete, promo.ts's promoRedeem, base.ts's
// subscriptionCardBuy). Each pairs a pre-check read with a `catch (e) { if (code === 11000) … }` for the
// case where a concurrent caller claimed the same key in between. The e2e suites drive the pre-check side
// heavily (an already-existing row) but reaching the catch needs two callers inside the same few
// milliseconds, so the whole block — and with it every decision about what the loser tells the player —
// was unexecuted (see test/helpers/fakeCols.ts's header, and claudedocs/server-testing-coverage.md).
//
// Three things are pinned here, and all three are player-visible:
//   • the loser must report the WINNER's outcome, not its own locally-computed one (the coins the winner
//     actually charged, the results the winner actually rolled, the status the winner actually reached);
//   • when the winner's row is already gone (every one of these call sites deletes its reserved slot when
//     the debit then fails, see e.g. shop.ts's INSUFFICIENT_FUNDS rollback), the loser must fall back to a
//     harmless neutral answer rather than crash on the missing document;
//   • a driver error that is NOT a duplicate key must propagate. Swallowing it would turn "the database is
//     unreachable" into "ok: true, your purchase already went through" — the worst possible lie for a
//     wallet, and the reason every one of these blocks rethrows instead of catching broadly.
import { describe, expect, it } from 'vitest';
import {
  IAP_TIERS,
  MONTHLY_CARD_DAYS,
  MONTHLY_CARD_IMMEDIATE_COINS,
  findGachaPool,
  findShopItem,
  gachaCost,
} from '@nw/shared';
import { CommercialService } from '../src/service';
import type { CommercialDeps } from '../src/service/base';
import type { CommercialCollections } from '../src/db';
import { dupKey, ok, order, recharge, replies, stubCols, throws, wallet } from './helpers/fakeCols';

const NOW = 5_000_000;
/** Older than WalletCore.REPLAY_HEAL_GRACE_MS (15s) before NOW — a claim whose owner is presumed dead. */
const STALE_TS = NOW - 60_000;

function svc(cols: CommercialCollections, deps: Partial<CommercialDeps> = {}): CommercialService {
  return new CommercialService({ cols, now: () => NOW, ...deps } as CommercialDeps);
}

const DRIVER_DOWN = new Error('connection 4 to 127.0.0.1:27017 closed');

const SHOP_ITEM = findShopItem('skin_shop_c1')!;

// ── shop.ts: shopCharge / spend / grant ──────────────────────────────────────
describe('shopCharge — lost the orderId insert race', () => {
  const charge = (cols: CommercialCollections) =>
    svc(cols).shopCharge({ accountId: 'acc', itemId: SHOP_ITEM.id, cost: SHOP_ITEM.cost, orderId: 'ord' });

  it('reports the winner\'s balance and status, not its own', async () => {
    const r = await charge(
      stubCols({
        orders: {
          findOne: replies(null, order({ accountId: 'acc', coinsAfter: 700, status: 'delivered' })),
          insertOne: throws(dupKey()),
        },
        wallets: { findOneAndUpdate: replies(wallet()) },
      }),
    );
    expect(r).toEqual({ ok: true, orderId: 'ord', coinsAfter: 700, status: 'delivered' });
  });

  it('rejects when the winner of the same orderId is a DIFFERENT account (no cross-account balance leak)', async () => {
    const r = await charge(
      stubCols({
        orders: { findOne: replies(null, order({ accountId: 'someone-else' })), insertOne: throws(dupKey()) },
        wallets: { findOneAndUpdate: replies(wallet()) },
      }),
    );
    expect(r).toEqual({ ok: false, error: 'BAD_REQUEST' });
  });

  // The winner's own debit can fail (raced drain) — it then deletes the slot it reserved. A loser whose
  // re-read lands after that deletion has no row to report: neutral 0 / 'charged', never a crash.
  it('falls back to a neutral answer when the winner already rolled its slot back', async () => {
    const r = await charge(
      stubCols({
        orders: { findOne: replies(null, null), insertOne: throws(dupKey()) },
        wallets: { findOneAndUpdate: replies(wallet()) },
      }),
    );
    expect(r).toEqual({ ok: true, orderId: 'ord', coinsAfter: 0, status: 'charged' });
  });

  it('propagates a non-duplicate insert failure instead of reporting a replay', async () => {
    await expect(
      charge(
        stubCols({
          orders: { findOne: replies(null), insertOne: throws(DRIVER_DOWN) },
          wallets: { findOneAndUpdate: replies(wallet()) },
        }),
      ),
    ).rejects.toThrow(DRIVER_DOWN);
  });
});

describe('spend — lost the orderId insert race', () => {
  const spend = (cols: CommercialCollections) =>
    svc(cols).spend({ accountId: 'acc', amount: 50, reason: 'rename', orderId: 'ord' });

  it('reports the winner\'s balance', async () => {
    const r = await spend(
      stubCols({
        orders: { findOne: replies(null, order({ kind: 'sink', coinsAfter: 275 })), insertOne: throws(dupKey()) },
        wallets: { findOneAndUpdate: replies(wallet()) },
      }),
    );
    expect(r).toEqual({ ok: true, coinsAfter: 275 });
  });

  it('rejects a different account\'s orderId', async () => {
    const r = await spend(
      stubCols({
        orders: { findOne: replies(null, order({ accountId: 'someone-else' })), insertOne: throws(dupKey()) },
        wallets: { findOneAndUpdate: replies(wallet()) },
      }),
    );
    expect(r).toEqual({ ok: false, error: 'BAD_REQUEST' });
  });

  it('falls back to 0 when the winner already rolled its slot back', async () => {
    const r = await spend(
      stubCols({
        orders: { findOne: replies(null, null), insertOne: throws(dupKey()) },
        wallets: { findOneAndUpdate: replies(wallet()) },
      }),
    );
    expect(r).toEqual({ ok: true, coinsAfter: 0 });
  });

  it('propagates a non-duplicate insert failure', async () => {
    await expect(
      spend(
        stubCols({
          orders: { findOne: replies(null), insertOne: throws(DRIVER_DOWN) },
          wallets: { findOneAndUpdate: replies(wallet()) },
        }),
      ),
    ).rejects.toThrow(DRIVER_DOWN);
  });
});

describe('grant — lost the orderId insert race', () => {
  const grant = (cols: CommercialCollections) =>
    svc(cols).grant({ accountId: 'acc', amount: 100, reason: 'mail_attachment', orderId: 'ord' });

  it('reports the winner\'s balance (the attachment is granted once, not twice)', async () => {
    const r = await grant(
      stubCols({
        orders: { findOne: replies(null, order({ kind: 'grant', status: 'delivered', coinsAfter: 100 })), insertOne: throws(dupKey()) },
      }),
    );
    expect(r).toEqual({ ok: true, coinsAfter: 100 });
  });

  it('rejects a different account\'s orderId', async () => {
    const r = await grant(
      stubCols({ orders: { findOne: replies(null, order({ accountId: 'someone-else' })), insertOne: throws(dupKey()) } }),
    );
    expect(r).toEqual({ ok: false, error: 'BAD_REQUEST' });
  });

  it('falls back to 0 when the winner\'s row is gone', async () => {
    const r = await grant(stubCols({ orders: { findOne: replies(null, null), insertOne: throws(dupKey()) } }));
    expect(r).toEqual({ ok: true, coinsAfter: 0 });
  });

  it('propagates a non-duplicate insert failure', async () => {
    await expect(
      grant(stubCols({ orders: { findOne: replies(null), insertOne: throws(DRIVER_DOWN) } })),
    ).rejects.toThrow(DRIVER_DOWN);
  });
});

// ── gachaDraw.ts: gachaDraw / redeemFate ─────────────────────────────────────
describe('gachaDraw — lost the orderId insert race', () => {
  const STD = findGachaPool('standard')!;
  const COST = gachaCost(STD, 1);
  const draw = (cols: CommercialCollections) =>
    svc(cols, { rng: () => 0 }).gachaDraw({ accountId: 'acc', poolId: 'standard', count: 1, orderId: 'ord' });

  it('replays the winner\'s results/pity/balance and credits NO extra fate points', async () => {
    const winner = order({
      kind: 'gacha',
      cost: COST,
      coinsAfter: 850,
      result: { results: [{ itemId: 'skin_l1', rarity: 'legendary' }], poolId: 'standard' },
      pityAfter: { standard: 0 },
    });
    const r = await draw(
      stubCols({
        orders: { findOne: replies(null, winner), insertOne: throws(dupKey()) },
        wallets: { findOneAndUpdate: replies(wallet({ coins: 1000 })), findOne: replies(wallet({ coins: 850, fatePoints: 4 })) },
      }),
    );
    expect(r).toEqual({
      ok: true,
      orderId: 'ord',
      coinsAfter: 850,
      pityAfter: 0,
      results: [{ itemId: 'skin_l1', rarity: 'legendary' }],
      fateGained: 0,
      fatePointsAfter: 4,
    });
  });

  // A pre-§7 order row carries no pityAfter map and no results: the loser then has nothing to replay and
  // falls back to the values it computed itself, which is why those `??` fallbacks exist at all.
  it('falls back to its own rolled results and pity when the winner\'s row carries neither', async () => {
    const r = await draw(
      stubCols({
        orders: { findOne: replies(null, order({ kind: 'gacha', cost: COST, coinsAfter: 0 })), insertOne: throws(dupKey()) },
        wallets: { findOneAndUpdate: replies(wallet({ coins: 1000 })), findOne: replies(null) },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results).toHaveLength(1);
    expect(r.pityAfter).toBe(1); // prevPity 0 + this pull, since the winner recorded none
    expect(r.coinsAfter).toBe(0);
    expect(r.fatePointsAfter).toBe(0);
    expect(r.fateGained).toBe(0);
  });

  it('propagates a non-duplicate insert failure', async () => {
    await expect(
      draw(
        stubCols({
          orders: { findOne: replies(null), insertOne: throws(DRIVER_DOWN) },
          wallets: { findOneAndUpdate: replies(wallet({ coins: 1000 })) },
        }),
      ),
    ).rejects.toThrow(DRIVER_DOWN);
  });
});

describe('redeemFate — lost the orderId insert race', () => {
  const redeem = (cols: CommercialCollections) =>
    svc(cols).redeemFate({ accountId: 'acc', itemId: 'skin_l1', orderId: 'ord' });
  // Fresh stub per test — a shared one would carry its call count across tests (see replies()).
  const poolKnowsItem = () => ({ findOne: replies(order()) }); // any non-null doc: only existence is checked

  it('replays the winner\'s item and balance', async () => {
    const r = await redeem(
      stubCols({
        orders: { findOne: replies(null, order({ kind: 'fate', coinsAfter: 90, result: { itemId: 'skin_l1' } })), insertOne: throws(dupKey()) },
        gachaPools: poolKnowsItem(),
        wallets: { findOneAndUpdate: replies(wallet()), findOne: replies(wallet({ fatePoints: 2 })) },
      }),
    );
    expect(r).toEqual({ ok: true, orderId: 'ord', itemId: 'skin_l1', coinsAfter: 90, fatePointsAfter: 2 });
  });

  it('falls back to the requested item and 0 when the winner\'s row is gone', async () => {
    const r = await redeem(
      stubCols({
        orders: { findOne: replies(null, null), insertOne: throws(dupKey()) },
        gachaPools: poolKnowsItem(),
        wallets: { findOneAndUpdate: replies(wallet()), findOne: replies(null) },
      }),
    );
    expect(r).toEqual({ ok: true, orderId: 'ord', itemId: 'skin_l1', coinsAfter: 0, fatePointsAfter: 0 });
  });

  it('propagates a non-duplicate insert failure', async () => {
    await expect(
      redeem(
        stubCols({
          orders: { findOne: replies(null), insertOne: throws(DRIVER_DOWN) },
          gachaPools: poolKnowsItem(),
          wallets: { findOneAndUpdate: replies(wallet()) },
        }),
      ),
    ).rejects.toThrow(DRIVER_DOWN);
  });

  // Not a race: an order row written before §7.1 recorded the itemId (result:{}) still replays, and the
  // item reported is the one the caller asked for rather than `undefined`.
  it('replays an existing order that never recorded an itemId', async () => {
    const r = await svc(
      stubCols({
        orders: { findOne: replies(order({ kind: 'fate', coinsAfter: 30 })) },
        wallets: { findOne: replies(null) },
      }),
    ).redeemFate({ accountId: 'acc', itemId: 'max', orderId: 'ord' });
    expect(r).toEqual({ ok: true, orderId: 'ord', itemId: 'max', coinsAfter: 30, fatePointsAfter: 0 });
  });
});

// ── recharge.ts: rechargeVerify / verifyNonCoinReceipt / paddleComplete ──────
describe('rechargeVerify — lost the receiptId insert race', () => {
  const verify = (cols: CommercialCollections) =>
    svc(cols).rechargeVerify({ accountId: 'acc', platform: 'apple', receipt: 'tier:t099', receiptId: 'rcp' });

  it('reports the coins the WINNER granted, not the pre-bonus amount this caller verified', async () => {
    // The winner claimed the first-purchase 2× bonus and back-filled coinsGranted; the loser must echo
    // that, otherwise the client shows half the coins the wallet actually received.
    const r = await verify(
      stubCols({
        recharges: {
          findOne: replies(null, recharge({ coinsGranted: IAP_TIERS.t099! * 2, ts: NOW })),
          insertOne: throws(dupKey('recharges')),
        },
        wallets: { findOne: replies(wallet({ coins: IAP_TIERS.t099! * 2 })) },
      }),
    );
    expect(r).toEqual({ ok: true, coinsAfter: IAP_TIERS.t099! * 2, coinsGranted: IAP_TIERS.t099! * 2 });
  });

  it('falls back to its own verified coin count when the winner\'s receipt row is unreadable', async () => {
    const r = await verify(
      stubCols({
        recharges: { findOne: replies(null, null), insertOne: throws(dupKey('recharges')) },
        wallets: { findOne: replies(wallet({ coins: 40 })) },
      }),
    );
    expect(r).toEqual({ ok: true, coinsAfter: 40, coinsGranted: IAP_TIERS.t099 });
  });

  it('propagates a non-duplicate insert failure instead of claiming the receipt was already consumed', async () => {
    await expect(
      verify(stubCols({ recharges: { findOne: replies(null), insertOne: throws(DRIVER_DOWN) } })),
    ).rejects.toThrow(DRIVER_DOWN);
  });
});

describe('verifyNonCoinReceipt — lost the receiptId insert race', () => {
  const verify = (cols: CommercialCollections, expected: 'monthly_card' | 'year_card' = 'monthly_card') =>
    svc(cols).verifyNonCoinReceipt({
      accountId: 'acc',
      platform: 'apple',
      receipt: 'product:monthly_card',
      receiptId: 'rcp',
      expectedProduct: expected,
    });

  it('accepts the replay when the winner consumed the receipt for the SAME account and product', async () => {
    const r = await verify(
      stubCols({
        recharges: { findOne: replies(null, recharge({ product: 'monthly_card' })), insertOne: throws(dupKey('recharges')) },
      }),
    );
    expect(r).toEqual({ ok: true, product: 'monthly_card' });
  });

  it('rejects when the winner consumed it for a different account', async () => {
    const r = await verify(
      stubCols({
        recharges: {
          findOne: replies(null, recharge({ accountId: 'someone-else', product: 'monthly_card' })),
          insertOne: throws(dupKey('recharges')),
        },
      }),
    );
    expect(r).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
  });

  it('rejects when the winner\'s row is unreadable (nothing proves this receipt paid for anything)', async () => {
    const r = await verify(
      stubCols({ recharges: { findOne: replies(null, null), insertOne: throws(dupKey('recharges')) } }),
    );
    expect(r).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
  });

  it('propagates a non-duplicate insert failure', async () => {
    await expect(
      verify(stubCols({ recharges: { findOne: replies(null), insertOne: throws(DRIVER_DOWN) } })),
    ).rejects.toThrow(DRIVER_DOWN);
  });
});

describe('paddleComplete — lost the transactionId insert race', () => {
  const complete = (cols: CommercialCollections) =>
    svc(cols).paddleComplete({ accountId: 'acc', transactionId: 'txn_1', coins: 500, usdCents: 499 });

  it('reports the winner\'s granted amount', async () => {
    const r = await complete(
      stubCols({
        recharges: { findOne: replies(null, recharge({ platform: 'paddle', coinsGranted: 1000, ts: NOW })), insertOne: throws(dupKey('recharges')) },
        wallets: { findOne: replies(wallet({ recharged: { web: 1000 } })) },
      }),
    );
    expect(r).toEqual({ ok: true, coinsAfter: 1000, coinsGranted: 1000 });
  });

  it('rejects when the same transaction was already credited to a different account', async () => {
    const r = await complete(
      stubCols({
        recharges: { findOne: replies(null, recharge({ accountId: 'someone-else' })), insertOne: throws(dupKey('recharges')) },
      }),
    );
    expect(r).toEqual({ ok: false, error: 'INVALID_RECEIPT' });
  });

  it('falls back to the webhook\'s own coin count when the winner\'s row is unreadable', async () => {
    const r = await complete(
      stubCols({
        recharges: { findOne: replies(null, null), insertOne: throws(dupKey('recharges')) },
        wallets: { findOne: replies(wallet({ coins: 20 })) },
      }),
    );
    expect(r).toEqual({ ok: true, coinsAfter: 20, coinsGranted: 500 });
  });

  it('propagates a non-duplicate insert failure', async () => {
    await expect(
      complete(stubCols({ recharges: { findOne: replies(null), insertOne: throws(DRIVER_DOWN) } })),
    ).rejects.toThrow(DRIVER_DOWN);
  });
});

// ── promo.ts: promoRedeem / createPromoCode ──────────────────────────────────
describe('promoRedeem — lost the redemption insert race', () => {
  const codeDoc = { _id: 'RACE', coins: 250, redeemed: 0, createdBy: 'admin', createdAt: 0 };

  it('reports PROMO_ALREADY_USED when the winner\'s redemption row is unreadable', async () => {
    const r = await svc(
      stubCols({
        promoCodes: { findOne: replies(codeDoc) },
        promoRedemptions: { findOne: replies(null, null), insertOne: throws(dupKey('promoRedemptions')) },
      }),
    ).promoRedeem({ accountId: 'acc', code: 'race' });
    expect(r).toEqual({ ok: false, error: 'PROMO_ALREADY_USED' });
  });

  it('propagates a non-duplicate insert failure', async () => {
    await expect(
      svc(
        stubCols({
          promoCodes: { findOne: replies(codeDoc) },
          promoRedemptions: { findOne: replies(null), insertOne: throws(DRIVER_DOWN) },
        }),
      ).promoRedeem({ accountId: 'acc', code: 'RACE' }),
    ).rejects.toThrow(DRIVER_DOWN);
  });
});

describe('createPromoCode — insert failure', () => {
  it('propagates a non-duplicate insert failure instead of reporting BAD_REQUEST (which reads as "code taken")', async () => {
    await expect(
      svc(stubCols({ promoCodes: { insertOne: throws(DRIVER_DOWN) } })).createPromoCode({
        code: 'NEW',
        coins: 50,
        createdBy: 'admin',
      }),
    ).rejects.toThrow(DRIVER_DOWN);
  });
});

// ── base.ts: subscriptionCardBuy ─────────────────────────────────────────────
describe('subscriptionCardBuy — lost the orderId insert race', () => {
  const buy = (cols: CommercialCollections) =>
    svc(cols).monthlyCardBuy({ accountId: 'acc', orderId: 'ord', rechargePlatform: 'apple' });

  it('rejects when the winner of the same orderId is a different account', async () => {
    const r = await buy(
      stubCols({ orders: { findOne: replies(null, order({ accountId: 'someone-else' })), insertOne: throws(dupKey()) } }),
    );
    expect(r).toEqual({ ok: false, error: 'BAD_REQUEST' });
  });

  // The winner claimed the slot moments ago and is still finishing applySubscription: the loser must NOT
  // redo the grant (that is the double-credit this whole gate exists to prevent) — it reads a snapshot.
  it('returns a wallet snapshot while the winner\'s claim is still fresh', async () => {
    const r = await buy(
      stubCols({
        orders: { findOne: replies(null, order({ kind: 'grant', status: 'charged', ts: NOW })), insertOne: throws(dupKey()) },
        wallets: { findOne: replies(null) },
      }),
    );
    expect(r).toEqual({ ok: true, coinsAfter: 0, subscriptionExpiry: 0, wallet: expect.objectContaining({ coins: 0, subscriptionExpiry: 0 }) });
  });

  // Past the grace window the claim is presumed dead, so resuming is allowed — but only for the one caller
  // that wins the healClaimedAt CAS. This is the loser of THAT race: snapshot again, no second grant.
  it('returns a snapshot when it loses the stale-claim resume CAS', async () => {
    const r = await buy(
      stubCols({
        orders: {
          findOne: replies(null, order({ kind: 'grant', status: 'charged', ts: STALE_TS })),
          insertOne: throws(dupKey()),
          findOneAndUpdate: replies(null), // another resumer already stamped healClaimedAt
        },
        wallets: { findOne: replies(wallet({ coins: 600, subscription: { expiry: NOW + 1000 } })) },
      }),
    );
    expect(r).toEqual({
      ok: true,
      coinsAfter: 600,
      subscriptionExpiry: NOW + 1000,
      wallet: expect.objectContaining({ coins: 600 }),
    });
  });

  it('resumes the abandoned grant when it WINS the stale-claim resume CAS', async () => {
    const applied = wallet({ coins: MONTHLY_CARD_IMMEDIATE_COINS, subscription: { expiry: NOW + MONTHLY_CARD_DAYS * 86400000 } });
    const r = await buy(
      stubCols({
        orders: {
          findOne: replies(null, order({ kind: 'grant', status: 'charged', ts: STALE_TS })),
          insertOne: throws(dupKey()),
          findOneAndUpdate: replies(order()), // won the healClaimedAt CAS
          updateOne: ok(),
        },
        // ensureWallet, then applySubscriptionIfInactive's guarded extend-and-credit
        wallets: { findOneAndUpdate: replies(wallet(), applied) },
        ledger: { insertOne: ok() },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.subscriptionExpiry).toBe(NOW + MONTHLY_CARD_DAYS * 86400000);
  });

  it('returns a snapshot when the winner already finished (status delivered)', async () => {
    const r = await buy(
      stubCols({
        orders: { findOne: replies(null, order({ kind: 'grant', status: 'delivered' })), insertOne: throws(dupKey()) },
        wallets: { findOne: replies(null) },
      }),
    );
    expect(r).toEqual({ ok: true, coinsAfter: 0, subscriptionExpiry: 0, wallet: expect.objectContaining({ coins: 0 }) });
  });

  it('propagates a non-duplicate insert failure', async () => {
    await expect(
      buy(stubCols({ orders: { findOne: replies(null), insertOne: throws(DRIVER_DOWN) } })),
    ).rejects.toThrow(DRIVER_DOWN);
  });

  // The pre-check (non-race) side of the same two branches: an existing 'charged'/'delivered' row whose
  // wallet no longer exists must report expiry 0 rather than reading through a null.
  it('reports expiry 0 for an existing fresh claim whose wallet is missing', async () => {
    const r = await buy(
      stubCols({
        orders: { findOne: replies(order({ kind: 'grant', status: 'charged', ts: NOW })) },
        wallets: { findOne: replies(null) },
      }),
    );
    expect(r).toEqual({ ok: true, coinsAfter: 0, subscriptionExpiry: 0, wallet: expect.objectContaining({ coins: 0 }) });
  });

  it('reports expiry 0 for an existing delivered order whose wallet is missing', async () => {
    const r = await buy(
      stubCols({
        orders: { findOne: replies(order({ kind: 'grant', status: 'delivered' })) },
        wallets: { findOne: replies(null) },
      }),
    );
    expect(r).toEqual({ ok: true, coinsAfter: 0, subscriptionExpiry: 0, wallet: expect.objectContaining({ coins: 0 }) });
  });
});
