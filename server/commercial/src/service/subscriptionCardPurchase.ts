// Monthly/year card activation, split out of base.ts on 2026-09-12 when the file crossed 500 lines
// (claudedocs/server.md "拆分形态的优先级" 形态①/独立函数模块: this flow is a self-contained pipeline —
// claim the order slot, gate, apply, flip to delivered — that reaches WalletCore only through its public
// primitives). WalletCore.subscriptionCardBuy stays as a one-line delegate, so every existing
// `this.core.subscriptionCardBuy(...)` call site (subscription.ts, appleNotifications.ts) is unchanged.
//
// Money-invariant correctness is priority #1: this is a pure mechanical move — both bodies are verbatim,
// with `this.` becoming `core.` and the private helper becoming a module-local function. Do NOT change,
// reorder, or "improve" any logic here.
import { displayChannelOf, effectiveCoins, type RechargeChannel } from '../spendChannel';
import type { Result, WalletCore, WalletView } from './base';
import { walletView } from './walletView';

export interface SubscriptionCardBuyArgs {
  accountId: string;
  orderId: string;
  days: number;
  immediateCoins: number;
  /** Funds `recharged.<channel>` instead of the free pool — the caller's verified recharge platform (ADR-020),
   * mapped via spendChannel.ts's rechargeChannelOf. Absent = free pool (should not happen post-gate, but a
   * safe default). Also used as the display bucket for the returned `coinsAfter` unless `clientPlatform`
   * overrides it (see displayChannelOf). */
  channel?: RechargeChannel;
  clientPlatform?: string;
  /**
   * The money for this period is ALREADY in the store's hands — skip the single-slot gate and extend
   * whatever is running instead of refusing. Set ONLY when that is literally true.
   *
   * The gate exists to stop a player buying a second card on top of a running one, and it belongs at
   * the point of SALE, not at the point of grant: by the time a payment processor tells us a
   * transaction completed, refusing does not un-take the money, it only decides whether the player
   * gets anything for it. Rejecting with ALREADY_ACTIVE there is the single worst outcome this file
   * can produce.
   *
   * Two callers, both genuinely post-payment:
   *   · Apple auto-renewals (2026-09-03, IOS_RELEASE.md §4.1b). Apple bills roughly a day BEFORE the
   *     current period ends, precisely so the subscription never lapses, so the card is by definition
   *     still active when its own renewal arrives. This is the case the flag was born for, and why it
   *     used to be called `renewal`.
   *   · Paddle `transaction.completed` for a card (2026-09-12). `/shop/paddle/checkout` already
   *     refuses before charging when a card is active, so this only fires on what that pre-check
   *     cannot see: two checkouts opened before either completed, or a card that became active
   *     between the pre-check and the webhook. Production hit it on 2026-09-12 — charged, granted
   *     nothing, order slot rolled back, one ERROR line for CS to find.
   *
   * Idempotency does not weaken: `orderId` still guards it, and both callers' orderIds
   * (`apple:<transactionId>` / `paddle:<transactionId>`) come straight from a transaction the
   * processor validated, so a redelivery is a no-op. What this flag drops is only the "is one already
   * running" question, which post-payment has no bearing on whether the money was taken.
   *
   * The arithmetic is already right for stacking: {@link WalletCore.applySubscription} extends from
   * `max(expiry, now)`, so a second period lands after the running one rather than truncating it.
   * `subscription.expiry` is a single scalar — the result is one longer card, never two at once.
   */
  alreadyCharged?: boolean;
}

export type SubscriptionCardBuyResult = Result<{
  coinsAfter: number;
  subscriptionExpiry: number;
  wallet: WalletView;
}>;

/**
 * Shared monthly/year card activation (GACHA_DESIGN §5). Idempotent by orderId, and globally single-slot:
 * refuses with ALREADY_ACTIVE while any subscription is still running (buy → use up → rebuy), so cards no longer
 * stack open-endedly. Extends the subscription by `days` and grants `immediateCoins` at once. Real receipt
 * verification (native/WeChat: verifyNonCoinReceipt; web: Paddle webhook signature) happens in the caller
 * (meta) BEFORE this is invoked — see monthlyCardBuy/yearCardBuy's `channel` doc.
 *
 * `alreadyCharged` is the one documented exception to the single-slot rule — see the flag's own comment.
 */
export async function subscriptionCardBuy(
  core: WalletCore,
  args: SubscriptionCardBuyArgs,
): Promise<SubscriptionCardBuyResult> {
  const existing = await core.cols.orders.findOne({ _id: args.orderId });
  if (existing) {
    // Ownership check (2026-08-04 fix) — see shop.ts's shopCharge for the full rationale.
    if (existing.accountId !== args.accountId) return { ok: false, error: 'BAD_REQUEST' };
    // status:'charged' means a prior attempt claimed the slot but hasn't flipped it to 'delivered' yet
    // (see the insert below — it now reserves as 'charged', not 'delivered', so this is observable).
    // Only resume once the claim is stale (base.ts isStaleClaim) — a concurrent duplicate of the SAME
    // orderId landing here milliseconds after the true winner claimed it must NOT redo the gate-check +
    // applySubscription itself (that would double-grant); it just reads a snapshot like the winner will
    // shortly produce. A claim that's still 'charged' well past the grace window means the original
    // attempt crashed and nobody will ever finish it — resume for real then.
    if (existing.status === 'charged') {
      if (core.isStaleClaim(existing.ts) && (await core.claimOrderResume(args.orderId))) {
        return finishSubscriptionCardBuy(core, args);
      }
      const w = await core.cols.wallets.findOne({ _id: existing.accountId });
      return {
        ok: true,
        coinsAfter: effectiveCoins(w, displayChannelOf(args.channel, args.clientPlatform)),
        subscriptionExpiry: w?.subscription?.expiry ?? 0,
        wallet: walletView(w, args.clientPlatform, args.channel),
      };
    }
    const w = await core.cols.wallets.findOne({ _id: existing.accountId });
    return {
      ok: true,
      coinsAfter: effectiveCoins(w, displayChannelOf(args.channel, args.clientPlatform)),
      subscriptionExpiry: w?.subscription?.expiry ?? 0,
      wallet: walletView(w, args.clientPlatform, args.channel),
    };
  }
  // Claim the order slot first (status:'charged' — not yet delivered). Concurrent replays of the SAME
  // orderId race here; only one wins, the rest take the E11000 branch and resume/return the existing
  // grant (idempotent). The single-slot gate is applied AFTER the slot is claimed so it never intercepts
  // an idempotent replay — only the unique winner of this orderId evaluates it.
  try {
    await core.cols.orders.insertOne({
      _id: args.orderId,
      accountId: args.accountId,
      kind: 'grant',
      cost: 0,
      status: 'charged',
      coinsAfter: 0,
      result: {},
      ts: core.now(),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const r = await core.cols.orders.findOne({ _id: args.orderId });
      if (r && r.accountId !== args.accountId) return { ok: false, error: 'BAD_REQUEST' };
      if (r?.status === 'charged') {
        if (core.isStaleClaim(r.ts) && (await core.claimOrderResume(args.orderId))) {
          return finishSubscriptionCardBuy(core, args);
        }
        const w0 = await core.cols.wallets.findOne({ _id: args.accountId });
        return {
          ok: true,
          coinsAfter: effectiveCoins(w0, displayChannelOf(args.channel, args.clientPlatform)),
          subscriptionExpiry: w0?.subscription?.expiry ?? 0,
          wallet: walletView(w0, args.clientPlatform, args.channel),
        };
      }
      const w = await core.cols.wallets.findOne({ _id: args.accountId });
      return {
        ok: true,
        coinsAfter: effectiveCoins(w, displayChannelOf(args.channel, args.clientPlatform)),
        subscriptionExpiry: w?.subscription?.expiry ?? 0,
        wallet: walletView(w, args.clientPlatform, args.channel),
      };
    }
    throw e;
  }
  return finishSubscriptionCardBuy(core, args);
}

/**
 * Runs the single-slot gate + applySubscription + delivery flip for an order slot already claimed as
 * 'charged' (fresh claim or resumed replay — see subscriptionCardBuy). Only ever reaches applySubscription
 * once per orderId: a 'charged' row is a dead giveaway no prior call got far enough to flip it to
 * 'delivered', and the unique orderId insert guarantees at most one caller gets past the claim itself.
 */
async function finishSubscriptionCardBuy(
  core: WalletCore,
  args: SubscriptionCardBuyArgs,
): Promise<SubscriptionCardBuyResult> {
  const now = core.now();
  await core.ensureWallet(args.accountId);
  // Single-slot gate: refuse a distinct purchase while a card is still active (buy → use up → rebuy),
  // enforced atomically together with the extend-and-credit itself (see applySubscriptionIfInactive) so
  // two concurrent purchases can't both pass a separate check before either commits. Roll back the
  // claimed slot so the account isn't left with a phantom grant order and a later (post-expiry) retry works.
  // A post-payment grant skips the gate (and only the gate) — see subscriptionCardBuy's
  // `alreadyCharged` doc. Both paths extend from max(expiry, now), so the arithmetic of stacking onto
  // a running period is already right.
  const ref = { orderId: args.orderId, channel: args.channel, clientPlatform: args.clientPlatform };
  const applied = args.alreadyCharged
    ? await core.applySubscription(args.accountId, args.days, args.immediateCoins, now, ref)
    : await core.applySubscriptionIfInactive(args.accountId, args.days, args.immediateCoins, now, ref);
  if (!applied) {
    await core.cols.orders.deleteOne({ _id: args.orderId });
    return { ok: false, error: 'ALREADY_ACTIVE' };
  }
  await core.cols.orders.updateOne(
    { _id: args.orderId },
    { $set: { status: 'delivered', coinsAfter: applied.coinsAfter, deliveredAt: now } },
  );
  return {
    ok: true,
    coinsAfter: applied.coinsAfter,
    subscriptionExpiry: applied.expiry,
    wallet: walletView(applied.wallet, args.clientPlatform, args.channel),
  };
}
