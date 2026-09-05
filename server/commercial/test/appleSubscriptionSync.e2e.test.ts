// Apple auto-renewable subscription sync (IOS_RELEASE.md §4.1b) — the renewal path, end to end
// against real Mongo, plus the receipt reader that feeds it.
//
// Two things here are worth a test rather than a read-through, and they pull in opposite directions:
//
//   • A renewal MUST be allowed to extend a card that is still running. Apple bills roughly a day
//     before the period ends, on purpose, so the subscription never lapses — which means every single
//     renewal arrives while the previous one is still active. The single-slot ALREADY_ACTIVE gate,
//     which is exactly right for a player tapping "buy" twice, would reject all of them: money taken,
//     nothing granted, and the player has no way to tell us because nothing visibly failed.
//   • The sync runs on EVERY cold start, unprompted. So the same receipt, re-read tomorrow and next
//     week and after a reinstall, must grant the same period exactly once. If that slips, the bug is
//     a player minting subscription time by relaunching the app.
//
// The gate-bypass and the idempotency are therefore tested together and against each other, along with
// the case that proves the bypass did not simply delete the rule for everyone else (a plain buy is
// still ALREADY_ACTIVE while a card runs).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommercialMongo, type CommercialMongo } from '../src/db';
import { CommercialService } from '../src/service';
import { appleSubscriptionTransactions } from '../src/iap/apple';
import type { AppleSubscriptionTx } from '../src/iap';
import type { RandInt } from '../src/gacha';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_commercial_applesub_test';

async function tryConnect(): Promise<CommercialMongo | null> {
  try {
    return await createCommercialMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[commercial.applesub.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);
}

const zero: RandInt = () => 0;
let t = 1_700_000_000_000;
const now = () => t++;

const DAY = 86_400_000;

/** A monthly period as the receipt reader would report it. */
function monthly(id: string, purchasedMs = 1): AppleSubscriptionTx {
  return { transactionId: id, product: 'monthly_card', purchasedMs };
}

describe.skipIf(!mongo)('apple auto-renewable subscription sync (e2e)', () => {
  const m = mongo!;
  /** What the fake receipt reader answers with; each test sets it. */
  let periods: AppleSubscriptionTx[];
  let svc: CommercialService;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    periods = [];
    svc = new CommercialService({
      cols: m.collections,
      now,
      rng: zero,
      verifyAppleSubscriptions: async () => periods,
    });
  });

  afterAll(async () => {
    if (m) {
      await m.db.dropDatabase();
      await m.close();
    }
  });

  it('grants a period once, and re-syncing the same receipt grants nothing', async () => {
    periods = [monthly('tx-1')];
    const first = await svc.subscriptionSyncApple({ accountId: 'a', receipt: 'r', clientPlatform: 'ios' });
    expect(first.ok && first.granted).toBe(1);
    const expiry = first.ok ? first.subscriptionExpiry : 0;
    expect(expiry).toBeGreaterThan(now());

    // The cold start after that, and the one after that. Same receipt, same transaction id.
    const second = await svc.subscriptionSyncApple({ accountId: 'a', receipt: 'r', clientPlatform: 'ios' });
    const third = await svc.subscriptionSyncApple({ accountId: 'a', receipt: 'r', clientPlatform: 'ios' });
    expect(second.ok && second.granted).toBe(0);
    expect(third.ok && third.granted).toBe(0);
    expect(third.ok && third.subscriptionExpiry).toBe(expiry);   // not one millisecond further out
    const w = await svc.getWallet('a', 'ios');
    expect(w.coins).toBe(600);                                    // the immediate grant, exactly once
  });

  it('REGRESSION: a renewal extends a card that is still active, instead of ALREADY_ACTIVE', async () => {
    periods = [monthly('tx-1', 1)];
    const first = await svc.subscriptionSyncApple({ accountId: 'b', receipt: 'r', clientPlatform: 'ios' });
    const firstExpiry = first.ok ? first.subscriptionExpiry : 0;

    // Apple renews ~a day early, so the card is still running when the new transaction shows up.
    periods = [monthly('tx-1', 1), monthly('tx-2', 2)];
    const second = await svc.subscriptionSyncApple({ accountId: 'b', receipt: 'r2', clientPlatform: 'ios' });
    expect(second.ok && second.granted).toBe(1);                  // only the new one
    const secondExpiry = second.ok ? second.subscriptionExpiry : 0;
    // Stacked onto the running period rather than restarting from today: ~30 more days on top.
    expect(secondExpiry - firstExpiry).toBe(30 * DAY);
    const w = await svc.getWallet('b', 'ios');
    expect(w.coins).toBe(1200);                                   // 600 per period, two periods
  });

  it('the single-slot gate is untouched for an ordinary buy while a card is running', async () => {
    periods = [monthly('tx-1')];
    await svc.subscriptionSyncApple({ accountId: 'c', receipt: 'r', clientPlatform: 'ios' });
    // A player tapping "buy" on a second card is still refused — that is what the gate is for, and
    // the renewal bypass must not have turned it off for everyone.
    const buy = await svc.monthlyCardBuy({ accountId: 'c', orderId: 'manual-1', clientPlatform: 'ios' });
    expect(buy).toEqual({ ok: false, error: 'ALREADY_ACTIVE' });
  });

  it('a year period grants 365 days, and periods apply in purchase order', async () => {
    periods = [
      { transactionId: 'y-1', product: 'year_card', purchasedMs: 2 },
      monthly('m-1', 1),      // deliberately out of order in the array
    ];
    const r = await svc.subscriptionSyncApple({ accountId: 'd', receipt: 'r', clientPlatform: 'ios' });
    expect(r.ok && r.granted).toBe(2);
    const w = await svc.getWallet('d', 'ios');
    // 30 + 365 days of subscription, and one immediate grant per period.
    expect(r.ok && r.subscriptionExpiry).toBeGreaterThan(now() + 394 * DAY);
    expect(w.coins).toBe(1200);
  });

  it('the coins land in the apple bucket, not the free pool (ADR-020)', async () => {
    periods = [monthly('tx-1')];
    await svc.subscriptionSyncApple({ accountId: 'e', receipt: 'r', clientPlatform: 'ios' });
    // Same money, asked for as a web session: the subscription is visible, the coins are not.
    expect((await svc.getWallet('e', 'ios')).coins).toBe(600);
    expect((await svc.getWallet('e', 'web')).coins).toBe(0);
  });

  it('grants nothing when Apple is unconfigured, and reports the wallet as it stands', async () => {
    // No verifyAppleSubscriptions in deps at all — what a deployment without NW_APPLE_PASSWORD gets.
    const unconfigured = new CommercialService({ cols: m.collections, now, rng: zero });
    const r = await unconfigured.subscriptionSyncApple({ accountId: 'f', receipt: 'r', clientPlatform: 'ios' });
    expect(r).toMatchObject({ ok: true, granted: 0, subscriptionExpiry: 0 });
  });

  it("one player's receipt cannot grant a second account", async () => {
    // A receipt is a file on a device; it can be copied, shared, or replayed by a modified client.
    // The orderId is `apple:<transactionId>` and orders carry an accountId, so the first account to
    // claim a period owns it — a second account submitting the same receipt must be refused rather
    // than handed a free month. (subscriptionCardBuy's ownership check, 2026-08-04; this is the
    // first caller that can reach it with an attacker-supplied key.)
    periods = [monthly('tx-shared')];
    const mine = await svc.subscriptionSyncApple({ accountId: 'owner', receipt: 'r', clientPlatform: 'ios' });
    expect(mine.ok && mine.granted).toBe(1);

    const theirs = await svc.subscriptionSyncApple({ accountId: 'thief', receipt: 'r', clientPlatform: 'ios' });
    expect(theirs.ok && theirs.granted).toBe(0);
    const w = await svc.getWallet('thief', 'ios');
    expect(w.subscriptionExpiry).toBe(0);
    expect(w.coins).toBe(0);
  });

  it('caps how many periods one sync applies, keeping the newest', async () => {
    // Apple keeps every renewal in the receipt forever, so a long-lived subscriber's receipt grows
    // without bound and all but the newest entries are already-granted no-ops. MAX_SYNC_PERIODS
    // bounds the per-cold-start work; what must not happen is the cap silently eating the NEW ones.
    periods = Array.from({ length: 70 }, (_, i) => monthly(`tx-${i}`, i + 1));
    const r = await svc.subscriptionSyncApple({ accountId: 'h', receipt: 'r', clientPlatform: 'ios' });
    expect(r.ok && r.granted).toBe(60);

    // The 10 dropped ones are the OLDEST. Proof: re-syncing the same receipt now grants nothing —
    // if the cap had kept the oldest 60, the 10 newest would still be ungranted and land here.
    const again = await svc.subscriptionSyncApple({ accountId: 'h', receipt: 'r', clientPlatform: 'ios' });
    expect(again.ok && again.granted).toBe(0);
  });

  it('a reader that throws is a non-event, not a failed request', async () => {
    // Apple unreachable mid-boot. Nobody asked for this call, so there is nobody to show an error to.
    const flaky = new CommercialService({
      cols: m.collections,
      now,
      rng: zero,
      verifyAppleSubscriptions: async () => { throw new Error('ETIMEDOUT'); },
    });
    const r = await flaky.subscriptionSyncApple({ accountId: 'g', receipt: 'r', clientPlatform: 'ios' });
    expect(r).toMatchObject({ ok: true, granted: 0 });
  });
});

// ── The reader itself: what gets pulled out of Apple's verifyReceipt response ───────────────────
describe('appleSubscriptionTransactions', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** Stub `fetch` with one response per call, in order (prod first, then sandbox on a 21007 retry). */
  function stubApple(...responses: object[]): { bodies: unknown[] } {
    const bodies: unknown[] = [];
    let i = 0;
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => responses[Math.min(i++, responses.length - 1)] };
    });
    return { bodies };
  }

  const row = (o: Record<string, string>) => ({
    product_id: 'com.nw.sub.monthly', transaction_id: 'tx', purchase_date_ms: '1', ...o,
  });

  it('asks for the FULL history, not just the newest transaction', async () => {
    // The distinguishing detail vs appleVerify: a player who has not opened the app in three months
    // has three ungranted renewals sitting in the receipt, and excluding old transactions would drop
    // two of them silently.
    const { bodies } = stubApple({ status: 0, latest_receipt_info: [] });
    await appleSubscriptionTransactions('r', 'pw');
    expect(bodies[0]).not.toHaveProperty('exclude-old-transactions');
  });

  it('returns every subscription period, oldest first', async () => {
    stubApple({
      status: 0,
      latest_receipt_info: [
        row({ transaction_id: 'b', purchase_date_ms: '200' }),
        row({ transaction_id: 'a', purchase_date_ms: '100' }),
        row({ transaction_id: 'y', product_id: 'com.nw.sub.year', purchase_date_ms: '150' }),
      ],
    });
    expect(await appleSubscriptionTransactions('r', 'pw')).toEqual([
      { transactionId: 'a', product: 'monthly_card', purchasedMs: 100 },
      { transactionId: 'y', product: 'year_card', purchasedMs: 150 },
      { transactionId: 'b', product: 'monthly_card', purchasedMs: 200 },
    ]);
  });

  it('drops refunded periods — Apple took the money back', async () => {
    stubApple({
      status: 0,
      latest_receipt_info: [
        row({ transaction_id: 'kept' }),
        row({ transaction_id: 'refunded', cancellation_date_ms: '999' }),
      ],
    });
    const got = await appleSubscriptionTransactions('r', 'pw');
    expect(got.map((p) => p.transactionId)).toEqual(['kept']);
  });

  it('ignores coin tiers and starter packs sharing the receipt', async () => {
    stubApple({
      status: 0,
      latest_receipt_info: [
        row({ transaction_id: 'coins', product_id: 'com.nw.coins.t499' }),
        row({ transaction_id: 'starter', product_id: 'com.nw.starter.draw' }),
        row({ transaction_id: 'sub' }),
      ],
    });
    const got = await appleSubscriptionTransactions('r', 'pw');
    expect(got.map((p) => p.transactionId)).toEqual(['sub']);
  });

  it('retries against sandbox on 21007, like appleVerify does', async () => {
    const { bodies } = stubApple({ status: 21007 }, { status: 0, latest_receipt_info: [row({})] });
    const got = await appleSubscriptionTransactions('r', 'pw');
    expect(bodies).toHaveLength(2);
    expect(got).toHaveLength(1);
  });

  it('fails closed on a rejected receipt', async () => {
    stubApple({ status: 21002, latest_receipt_info: [row({})] });
    expect(await appleSubscriptionTransactions('r', 'pw')).toEqual([]);
  });
});
