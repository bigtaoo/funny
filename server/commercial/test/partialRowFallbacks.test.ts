// The `?? fallback` half of every replay/snapshot read: what these methods report when the document
// they read back does not carry the field they want.
//
// Each of these fallbacks guards a document that a running deployment can genuinely produce, but that a
// green-field e2e run never does, which is why they were unexecuted (base.ts 89.87%, gachaDraw 95.89%,
// subscription 75% branches — claudedocs/server-testing-coverage.md):
//   • rows written before a field existed — `orders.pityAfter` (added with §7's Fate points) and
//     `orders.coinsAfter` back-fills are both younger than the collection they live in, and an
//     idempotent replay of an old order must report 0 rather than `undefined`;
//   • the optional halves of a shared primitive's `ref` argument — applySubscription's `reason`/`orderId`
//     are only passed by some callers, and the defaults decide what the LEDGER row says;
//   • a wallet or order that vanished/changed between two reads of the same request.
// A `undefined` leaking out of any of them is not cosmetic: these values are serialized into the wallet
// view meta mirrors into SaveData (`coins: undefined` blanks the client's balance) and into ledger rows,
// which are the audit trail for every coin in the game.
//
// Fake collections (test/helpers/fakeCols.ts) because these shapes are unreachable through a real
// mongod: a `$inc` always creates the field it increments, so no real update can return a document
// missing it — the only writers that can are an older release and a hand-repaired document.
import { describe, expect, it } from 'vitest';
import { MONTHLY_CARD_DAILY_COINS, findGachaPool, gachaCost } from '@nw/shared';
import { CommercialService } from '../src/service';
import { WalletCore, type CommercialDeps } from '../src/service/base';
import type { CommercialCollections, LedgerDoc } from '../src/db';
import { dupKey, ok, order, replies, stubCols, throws, wallet } from './helpers/fakeCols';

const NOW = 7_000_000;
const DAY = 86_400_000;

function svc(cols: CommercialCollections, deps: Partial<CommercialDeps> = {}): CommercialService {
  return new CommercialService({ cols, now: () => NOW, ...deps } as CommercialDeps);
}

/** Collects the ledger rows a call writes, so the defaults can be asserted where they actually land. */
function ledgerSink(): { rows: LedgerDoc[]; stub: { insertOne: (d: LedgerDoc) => Promise<unknown> } } {
  const rows: LedgerDoc[] = [];
  return { rows, stub: { insertOne: (d) => (rows.push(d), Promise.resolve({ acknowledged: true })) } };
}

// ── WalletCore.applySubscription / applySubscriptionIfInactive ───────────────
describe('applySubscription — the optional halves of its ref argument', () => {
  it('defaults the ledger reason to monthly_card and writes no orderId when the caller passes neither', async () => {
    const sink = ledgerSink();
    const core = new WalletCore({
      cols: stubCols({ wallets: { findOneAndUpdate: replies(wallet(), wallet({ coins: 600 })) }, ledger: sink.stub }),
      now: () => NOW,
    } as CommercialDeps);

    const r = await core.applySubscription('acc', 30, 600, NOW, {});

    expect(r.coinsAfter).toBe(600);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]).toMatchObject({ accountId: 'acc', delta: 600, reason: 'monthly_card', ts: NOW });
    expect(Object.keys(sink.rows[0]!)).not.toContain('orderId');
  });

  // The returned expiry feeds the client's card countdown. A wallet document that came back without the
  // subscription subtree (a pre-§5 wallet, or a repaired one) must yield the expiry this call just
  // granted, not `undefined`.
  it('derives the expiry from now + days when the updated wallet carries no subscription subtree', async () => {
    const sink = ledgerSink();
    const core = new WalletCore({
      cols: stubCols({ wallets: { findOneAndUpdate: replies(wallet(), wallet({ coins: 600 })) }, ledger: sink.stub }),
      now: () => NOW,
    } as CommercialDeps);

    const r = await core.applySubscription('acc', 30, 600, NOW, {});
    expect(r.expiry).toBe(NOW + 30 * DAY);
  });

  it('writes no ledger row at all when there are no immediate coins', async () => {
    const sink = ledgerSink();
    const core = new WalletCore({
      cols: stubCols({ wallets: { findOneAndUpdate: replies(wallet(), wallet()) }, ledger: sink.stub }),
      now: () => NOW,
    } as CommercialDeps);

    await core.applySubscription('acc', 7, 0, NOW, { reason: 'starter_growth' });
    expect(sink.rows).toHaveLength(0);
  });
});

describe('applySubscriptionIfInactive — same defaults on the guarded variant', () => {
  it('defaults reason/orderId and derives the expiry when the wallet has no subscription subtree', async () => {
    const sink = ledgerSink();
    const core = new WalletCore({
      cols: stubCols({ wallets: { findOneAndUpdate: replies(wallet({ coins: 600 })) }, ledger: sink.stub }),
      now: () => NOW,
    } as CommercialDeps);

    const r = await core.applySubscriptionIfInactive('acc', 365, 600, NOW, {});

    expect(r).not.toBeNull();
    expect(r!.expiry).toBe(NOW + 365 * DAY);
    expect(sink.rows[0]).toMatchObject({ reason: 'monthly_card', delta: 600 });
    expect(Object.keys(sink.rows[0]!)).not.toContain('orderId');
  });

  it('writes no ledger row when there are no immediate coins', async () => {
    const sink = ledgerSink();
    const core = new WalletCore({
      cols: stubCols({ wallets: { findOneAndUpdate: replies(wallet()) }, ledger: sink.stub }),
      now: () => NOW,
    } as CommercialDeps);

    await core.applySubscriptionIfInactive('acc', 7, 0, NOW, { orderId: 'o1' });
    expect(sink.rows).toHaveLength(0);
  });
});

// ── subscriptionCardBuy's two snapshot branches ─────────────────────────────
describe('subscriptionCardBuy — snapshot of a wallet that DOES have a subscription', () => {
  // Mirror image of the null-wallet cases in dupKeyReplay.test.ts: the snapshot must report the expiry
  // the winner already granted, since that is what the client renders as the card's remaining time.
  const active = wallet({ coins: 600, subscription: { expiry: NOW + 30 * DAY } });

  it('reports the winner\'s expiry for an existing fresh claim', async () => {
    const r = await svc(
      stubCols({
        orders: { findOne: replies(order({ kind: 'grant', status: 'charged', ts: NOW })) },
        wallets: { findOne: replies(active) },
      }),
    ).monthlyCardBuy({ accountId: 'acc', orderId: 'ord' });
    expect(r).toMatchObject({ ok: true, coinsAfter: 600, subscriptionExpiry: NOW + 30 * DAY });
  });

  it('reports the winner\'s expiry after losing the insert race to an already-delivered order', async () => {
    const r = await svc(
      stubCols({
        orders: { findOne: replies(null, order({ kind: 'grant', status: 'delivered' })), insertOne: throws(dupKey()) },
        wallets: { findOne: replies(active) },
      }),
    ).monthlyCardBuy({ accountId: 'acc', orderId: 'ord' });
    expect(r).toMatchObject({ ok: true, coinsAfter: 600, subscriptionExpiry: NOW + 30 * DAY });
  });
});

// ── monthlyCardClaim ────────────────────────────────────────────────────────
describe('monthlyCardClaim — claimed wallet with no subscription subtree', () => {
  it('still credits the daily coins and reports expiry 0 rather than undefined', async () => {
    const sink = ledgerSink();
    const r = await svc(
      stubCols({
        wallets: { findOneAndUpdate: replies(wallet(), wallet({ coins: MONTHLY_CARD_DAILY_COINS })) },
        ledger: sink.stub,
      }),
    ).monthlyCardClaim({ accountId: 'acc', dayKey: '2026-09-03' });

    expect(r).toMatchObject({ ok: true, claimed: MONTHLY_CARD_DAILY_COINS, subscriptionExpiry: 0 });
    expect(sink.rows[0]).toMatchObject({ reason: 'monthly_card_daily', delta: MONTHLY_CARD_DAILY_COINS });
  });
});

// ── gachaDraw / redeemFate replays of older rows ────────────────────────────
describe('gachaDraw — replaying an order row that predates a field', () => {
  const STD = findGachaPool('standard')!;
  const COST = gachaCost(STD, 1);
  const results = [{ itemId: 'mat_scrap', rarity: 'common' as const }];

  it('reports pity 0 when the recorded order has no pityAfter map at all', async () => {
    const r = await svc(
      stubCols({
        orders: { findOne: replies(order({ kind: 'gacha', cost: COST, coinsAfter: 300, result: { results, poolId: 'standard' } })) },
        // gachaDraw runs its three independent reads concurrently, so ensureWallet fires even on a replay.
        wallets: { findOneAndUpdate: replies(wallet()), findOne: replies(wallet({ fatePoints: 3 })) },
      }),
      { rng: () => 0 },
    ).gachaDraw({ accountId: 'acc', poolId: 'standard', count: 1, orderId: 'ord' });

    expect(r).toMatchObject({ ok: true, coinsAfter: 300, pityAfter: 0, fateGained: 0, fatePointsAfter: 3 });
  });

  it('reports pity 0 when the recorded order has a pityAfter map without this pool\'s key', async () => {
    const r = await svc(
      stubCols({
        orders: {
          findOne: replies(
            order({ kind: 'gacha', cost: COST, coinsAfter: 300, result: { results, poolId: 'standard' }, pityAfter: { some_limited_pool: 12 } }),
          ),
        },
        wallets: { findOneAndUpdate: replies(wallet()), findOne: replies(wallet()) },
      }),
      { rng: () => 0 },
    ).gachaDraw({ accountId: 'acc', poolId: 'standard', count: 1, orderId: 'ord' });

    expect(r).toMatchObject({ ok: true, pityAfter: 0 });
  });

  it('reports 0 coins when the winner\'s row has no back-filled coinsAfter yet', async () => {
    // The winner reserves the slot with coinsAfter absent and back-fills it only after the debit lands,
    // so a loser reading in between sees a row with no balance on it.
    const winner = { ...order({ kind: 'gacha', cost: COST, result: { results, poolId: 'standard' } }), coinsAfter: undefined };
    const r = await svc(
      stubCols({
        orders: { findOne: replies(null, winner), insertOne: throws(dupKey()) },
        wallets: { findOneAndUpdate: replies(wallet({ coins: 1000 })), findOne: replies(wallet()) },
      }),
      { rng: () => 0 },
    ).gachaDraw({ accountId: 'acc', poolId: 'standard', count: 1, orderId: 'ord' });

    expect(r).toMatchObject({ ok: true, coinsAfter: 0 });
  });
});

describe('redeemFate — wallet with no fatePoints field after the decrement', () => {
  it('reports 0 remaining points instead of undefined', async () => {
    const r = await svc(
      stubCols({
        orders: { findOne: replies(null), insertOne: ok(), updateOne: ok() },
        gachaPools: { findOne: replies(order()) }, // any non-null doc: only existence is checked
        wallets: { findOneAndUpdate: replies(wallet(), wallet({ coins: 10 })) },
      }),
    ).redeemFate({ accountId: 'acc', itemId: 'skin_l1', orderId: 'ord' });

    expect(r).toEqual({ ok: true, orderId: 'ord', itemId: 'skin_l1', coinsAfter: 10, fatePointsAfter: 0 });
  });
});

// ── orderDelivered / promoRedeem: the row changed between two reads ──────────
describe('orderDelivered — the order disappears between the status CAS and the re-read', () => {
  it('reports ok without healing anything', async () => {
    // Losing the `status:'charged'` CAS normally means another caller delivered it, and the re-read
    // finds the winner's row to heal from. If even that read comes back empty (the order was rolled
    // back concurrently), there is nothing to refund and nothing to report but success.
    const r = await svc(
      stubCols({
        orders: {
          findOne: replies(order({ kind: 'shop', status: 'charged', refundCoins: 50 }), null),
          updateOne: () => Promise.resolve({ matchedCount: 0 }),
        },
      }),
    ).orderDelivered({ orderId: 'ord', refundCoins: 50 });

    expect(r).toEqual({ ok: true });
  });
});

describe('promoRedeem — the winner\'s redemption row is readable and fresh', () => {
  it('reports PROMO_ALREADY_USED without touching the wallet', async () => {
    const r = await svc(
      stubCols({
        promoCodes: { findOne: replies({ _id: 'FRESH', coins: 250, redeemed: 0, createdBy: 'admin', createdAt: 0 }) },
        promoRedemptions: {
          findOne: replies(null, { _id: 'acc:FRESH', accountId: 'acc', code: 'FRESH', coinsGranted: 250, ts: NOW }),
          insertOne: throws(dupKey('promoRedemptions')),
        },
      }),
    ).promoRedeem({ accountId: 'acc', code: 'FRESH' });

    expect(r).toEqual({ ok: false, error: 'PROMO_ALREADY_USED' });
  });
});
