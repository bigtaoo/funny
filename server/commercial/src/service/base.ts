// Shared foundation for the CommercialService domain classes (see ../service.ts assembly).
// WalletCore holds `deps` (unpacked into public readonly fields, so domain-class method bodies keep
// referencing `this.core.cols` / `this.core.now` / `this.core.rng` / `this.core.verifyReceipt`
// verbatim) + the genuinely cross-cutting wallet primitives used by more than one domain: ensureWallet /
// credit (recharge/ads/shop/…), resolvePool (gachaDraw/redeemFate/starterBuy), applySubscription /
// subscriptionCardBuy (monthly/year card buys AND starterBuy's growth path). Each business domain lives
// in its own sibling file as an independent class taking `(core: WalletCore)` in its constructor
// (2026-08-11 mixin-chain split, claudedocs/server.md's "拆分形态的优先级" 形态②/独立类+组合 —
// WalletCore is exactly the "两边都依赖的更底层类" the priority doc calls for: it was already the root
// of the DAG, not a link in a chain, so converting the 10 domains from mixins to siblings holding a
// WalletCore reference is a direct application of the same pattern, not a new one). Domain-local helpers
// (e.g. recharge.ts's claimFirstPurchaseBonus) stay in their own domain file, not here.
// The stateless DTOs (ServiceErr/Result/CommercialDeps/WalletView/ResolvedPool) and the free functions that
// project/convert them (devVerifyReceipt/walletView/limitedConfigFromDoc/customConfigFromDoc) live in
// ./walletView.ts (2026-08-10 split, kept under 500 lines) — re-exported below so every existing `from
// './base'` import elsewhere keeps working unchanged.
//
// Money-invariant correctness is priority #1: this is a pure mechanical split — method bodies were moved
// verbatim (only their visibility changed from `protected` to public, since sibling classes call them
// through `this.core.X` rather than inheriting them). Do NOT change, reorder, or "improve" any logic here.
import { type Rarity, type RedisLike } from '@nw/shared';
import type { CommercialCollections, WalletDoc } from '../db';
import { isCustomPoolDoc } from '../db';
import type { RandInt } from '../gacha';
import { displayChannelOf, effectiveCoins, type RechargeChannel } from '../spendChannel';
import type { IapProductKind } from '../iap';
import {
  findGachaPool,
  isLimitedPoolActive,
  buildLimitedPool,
  devVerifyReceipt,
  walletView,
  limitedConfigFromDoc,
  customConfigFromDoc,
  type ResolvedPool,
  type ServiceErr,
  type WalletView,
  type Result,
  type CommercialDeps,
} from './walletView';
export {
  devVerifyReceipt,
  walletView,
  limitedConfigFromDoc,
  customConfigFromDoc,
  type ResolvedPool,
  type ServiceErr,
  type WalletView,
  type Result,
  type CommercialDeps,
};

export class WalletCore {
  readonly deps: CommercialDeps;
  // Deps unpacked into public readonly fields so domain-class method bodies keep referencing them
  // verbatim (this.core.cols, this.core.now, …) — no protected-visibility wall to work around since
  // these are now sibling classes, not mixin-chain descendants.
  readonly cols: CommercialCollections;
  readonly now: () => number;
  readonly rng?: RandInt;
  readonly redis: RedisLike | null;
  readonly verifyReceipt: (
    platform: string,
    receipt: string,
  ) => Promise<{ ok: boolean; coins: number; usdCents?: number; product?: IapProductKind }>;

  constructor(deps: CommercialDeps) {
    this.deps = deps;
    this.cols = deps.cols;
    this.now = deps.now;
    this.rng = deps.rng;
    this.redis = deps.redis ?? null;
    const raw = deps.verifyReceipt ?? devVerifyReceipt;
    // Uniformly wrap as async to be compatible with both the synchronous dev stub and async real receipt verifiers.
    this.verifyReceipt = (p, r) => Promise.resolve(raw(p, r));
  }

  /**
   * Grace window before an idempotency-key row reserved but not yet credited/delivered (recharges /
   * promoRedemptions / orders, all claimed via a unique-index insert BEFORE the costly side of the
   * operation runs) is treated as abandoned by a crashed attempt and safe to resume/heal. Concurrent
   * duplicate submissions of the SAME key (the common case — client retries a slow request, or the
   * network duplicates it) lose the unique-insert race within milliseconds while the true winner is
   * still very much alive and about to finish; healing/resuming during that window would race the
   * winner and double-credit. The crash-recovery case this grace period exists for (the winning process
   * died mid-flight) only matters on a MUCH later retry (after a client-visible timeout or restart), so
   * erring long here costs nothing but a slower recovery.
   */
  private static readonly REPLAY_HEAL_GRACE_MS = 15000;

  isStaleClaim(claimedAtMs: number): boolean {
    return this.now() - claimedAtMs > WalletCore.REPLAY_HEAL_GRACE_MS;
  }

  /** Fetch or create the wallet (upserts coins:0 rev:0 on first access). */
  async ensureWallet(accountId: string): Promise<WalletDoc> {
    const res = await this.cols.wallets.findOneAndUpdate(
      { _id: accountId },
      {
        $setOnInsert: {
          _id: accountId,
          coins: 0,
          rev: 0,
          gacha: { pity: {} },
          updatedAt: this.now(),
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    // upsert + returnDocument:after always returns a document.
    return res!;
  }

  /** GET /internal/wallet: returns balance + all pity counters + monetization state (§5–§7). */
  async getWallet(accountId: string, clientPlatform?: string): Promise<WalletView> {
    const w = await this.cols.wallets.findOne({ _id: accountId });
    return walletView(w, clientPlatform);
  }

  /**
   * Resolve a pool id to a full definition (GACHA_DESIGN §2). Static pools (standard/unit cards) come from
   * @nw/shared; limited pools are built from the admin-authored config in `gachaPools` and are only returned
   * while inside their [startAt, endAt) window. Returns null when unknown or a closed/out-of-window limited pool.
   */
  async resolvePool(poolId: string, now: number): Promise<ResolvedPool | null> {
    const stat = findGachaPool(poolId);
    if (stat) return { kind: 'derived', pool: stat };
    const doc = await this.cols.gachaPools.findOne({ _id: poolId });
    if (!doc || !isLimitedPoolActive(doc, now)) return null;
    if (isCustomPoolDoc(doc)) return { kind: 'custom', cfg: customConfigFromDoc(doc) };
    return { kind: 'derived', pool: buildLimitedPool(limitedConfigFromDoc(doc)) };
  }

  /**
   * Credit coins + write ledger entry (shared by recharge/ads/refund). Atomic $inc; returns the new EFFECTIVE
   * balance for `clientPlatform` (ADR-020 spendChannel.ts). `ref.rechargeUsdCents`, when present (real-money
   * recharge callers only), bumps `totalRechargeCents` in the SAME atomic update (GACHA_DESIGN §13) —
   * deliberately the pre-first-purchase-bonus USD amount, since this counter tracks actual money spent, not
   * the (possibly doubled) coins granted.
   * `ref.channel`, when present, funds `recharged.<channel>` instead of the free `coins` pool — set only by
   * genuinely channel-verified real-money credits (recharge/paddleComplete); every other credit reason (ads,
   * victory, promo, refund, grant, subscription daily claim) stays on the free pool, spendable everywhere.
   */
  async credit(
    accountId: string,
    amount: number,
    reason: string,
    ref: { orderId?: string; receiptId?: string; rechargeUsdCents?: number; channel?: RechargeChannel; clientPlatform?: string },
  ): Promise<number> {
    await this.ensureWallet(accountId);
    const inc: Record<string, number> = ref.channel ? { [`recharged.${ref.channel}`]: amount, rev: 1 } : { coins: amount, rev: 1 };
    if (ref.rechargeUsdCents) inc.totalRechargeCents = ref.rechargeUsdCents;
    const res = await this.cols.wallets.findOneAndUpdate(
      { _id: accountId },
      { $inc: inc, $set: { updatedAt: this.now() } },
      { returnDocument: 'after' },
    );
    const coinsAfter = effectiveCoins(res, displayChannelOf(ref.channel, ref.clientPlatform));
    await this.cols.ledger.insertOne({
      accountId,
      delta: amount,
      balanceAfter: coinsAfter,
      reason,
      ...(ref.orderId ? { orderId: ref.orderId } : {}),
      ...(ref.receiptId ? { receiptId: ref.receiptId } : {}),
      ts: this.now(),
    });
    return coinsAfter;
  }

  /**
   * Atomically debit `amount` from a wallet's EFFECTIVE spendable balance for `channel` (free `coins` pool +
   * that channel's `recharged` bucket, ADR-020 spendChannel.ts) — draining `coins` first so a restricted
   * real-money bucket is preserved as long as the free pool can cover the cost. Returns null when the
   * effective balance is insufficient (guard failed, nothing debited) — callers map this to INSUFFICIENT_FUNDS.
   * `extraSet`/`extraSetOnUpdate` let callers (gachaDraw's pity) piggyback extra fields on the SAME atomic op.
   */
  async debitEffective(
    accountId: string,
    amount: number,
    channel: RechargeChannel,
    extraInc: Record<string, number> = {},
    extraSet: Record<string, unknown> = {},
  ): Promise<WalletDoc | null> {
    const rk = `recharged.${channel}`;
    return this.cols.wallets.findOneAndUpdate(
      { _id: accountId, $expr: { $gte: [{ $add: ['$coins', { $ifNull: [`$${rk}`, 0] }] }, amount] } },
      [
        {
          $set: {
            [rk]: { $max: [0, { $add: [{ $ifNull: [`$${rk}`, 0] }, { $min: [0, { $subtract: ['$coins', amount] }] }] }] },
            coins: { $max: [0, { $subtract: ['$coins', amount] }] },
            rev: { $add: ['$rev', 1] },
            updatedAt: this.now(),
            ...Object.fromEntries(Object.entries(extraInc).map(([k, v]) => [k, { $add: [{ $ifNull: [`$${k}`, 0] }, v] }])),
            ...extraSet,
          },
        },
      ],
      { returnDocument: 'after' },
    );
  }

  /**
   * Extend the subscription by `days` (stacking = extend from max(now, current expiry)) + optionally credit
   * `immediateCoins`, in one atomic aggregation-pipeline update. Writes a ledger entry for the immediate coins.
   * Callers gate idempotency upstream (order slot / starterUsed claim) so this never double-applies.
   * `ref.channel`, when present, funds `recharged.<channel>` instead of the free `coins` pool (set only by the
   * Paddle-webhook-verified card purchase, §10.7 — the legacy "treated as authorized" native/WeChat/CrazyGames
   * path passes no channel since it isn't real money yet). Returned `coinsAfter` is the EFFECTIVE balance for
   * `ref.clientPlatform` (defaults to 'web').
   */
  async applySubscription(
    accountId: string,
    days: number,
    immediateCoins: number,
    now: number,
    ref: { orderId?: string; reason?: string; channel?: RechargeChannel; clientPlatform?: string },
  ): Promise<{ coinsAfter: number; expiry: number; wallet: WalletDoc | null }> {
    await this.ensureWallet(accountId);
    const ms = days * 86400000;
    const coinsField = ref.channel ? `recharged.${ref.channel}` : 'coins';
    const res = await this.cols.wallets.findOneAndUpdate(
      { _id: accountId },
      [
        {
          $set: {
            'subscription.expiry': {
              $add: [{ $max: [{ $ifNull: ['$subscription.expiry', now] }, now] }, ms],
            },
            [coinsField]: { $add: [{ $ifNull: [`$${coinsField}`, 0] }, immediateCoins] },
            rev: { $add: ['$rev', 1] },
            updatedAt: now,
          },
        },
      ],
      { returnDocument: 'after' },
    );
    const coinsAfter = effectiveCoins(res, displayChannelOf(ref.channel, ref.clientPlatform));
    if (immediateCoins > 0) {
      await this.cols.ledger.insertOne({
        accountId,
        delta: immediateCoins,
        balanceAfter: coinsAfter,
        reason: ref.reason ?? 'monthly_card',
        ...(ref.orderId ? { orderId: ref.orderId } : {}),
        ts: now,
      });
    }
    return { coinsAfter, expiry: res!.subscription?.expiry ?? now + ms, wallet: res };
  }

  /**
   * Atomic variant of applySubscription that also enforces "no currently-active subscription" as part of
   * the SAME update, instead of a separate read-then-check gate beforehand. A prior version of
   * finishSubscriptionCardBuy read wallet.subscription.expiry, checked it against `now`, and only THEN
   * called applySubscription unconditionally — two concurrent purchase requests with distinct orderIds
   * (e.g. a double-tap or a client retry) could both pass that read-then-check gate before either
   * committed, so both proceeded to applySubscription and both extended the subscription + credited
   * immediateCoins, doubling a single real purchase. Folding the guard into the update's query filter
   * makes MongoDB evaluate "not already active" and "extend + credit" atomically: only one of two
   * concurrent callers can match the filter (the loser observes the winner's already-extended expiry and
   * fails the filter), so this returns null exactly when — and only when — the caller should report
   * ALREADY_ACTIVE instead of applying a partial/double credit.
   */
  async applySubscriptionIfInactive(
    accountId: string,
    days: number,
    immediateCoins: number,
    now: number,
    ref: { orderId?: string; reason?: string; channel?: RechargeChannel; clientPlatform?: string },
  ): Promise<{ coinsAfter: number; expiry: number; wallet: WalletDoc | null } | null> {
    const ms = days * 86400000;
    const coinsField = ref.channel ? `recharged.${ref.channel}` : 'coins';
    const res = await this.cols.wallets.findOneAndUpdate(
      {
        _id: accountId,
        $or: [{ 'subscription.expiry': { $exists: false } }, { 'subscription.expiry': { $lte: now } }],
      },
      [
        {
          $set: {
            'subscription.expiry': { $add: [now, ms] },
            [coinsField]: { $add: [{ $ifNull: [`$${coinsField}`, 0] }, immediateCoins] },
            rev: { $add: ['$rev', 1] },
            updatedAt: now,
          },
        },
      ],
      { returnDocument: 'after' },
    );
    if (!res) return null;
    const coinsAfter = effectiveCoins(res, displayChannelOf(ref.channel, ref.clientPlatform));
    if (immediateCoins > 0) {
      await this.cols.ledger.insertOne({
        accountId,
        delta: immediateCoins,
        balanceAfter: coinsAfter,
        reason: ref.reason ?? 'monthly_card',
        ...(ref.orderId ? { orderId: ref.orderId } : {}),
        ts: now,
      });
    }
    return { coinsAfter, expiry: res.subscription?.expiry ?? now + ms, wallet: res };
  }

  /**
   * Atomic CAS guard for resuming a stale 'charged' order (subscriptionCardBuy/starterBuy growth-pack resume
   * branches, both past isStaleClaim): only the caller whose findOneAndUpdate matches (healClaimedAt still
   * absent) may proceed to finishSubscriptionCardBuy/finishStarterGrowth. Without this, two concurrent
   * stale-claim resumers racing the SAME orderId would both pass isStaleClaim (no ledger check exists here —
   * applySubscription itself doesn't check-before-crediting) and both run applySubscription, double-crediting
   * coins and double-extending the subscription. The loser reads the current wallet snapshot instead, same
   * as the non-stale "still likely in-flight" branch already does.
   */
  async claimOrderResume(orderId: string): Promise<boolean> {
    const res = await this.cols.orders.findOneAndUpdate(
      { _id: orderId, status: 'charged', healClaimedAt: { $exists: false } },
      { $set: { healClaimedAt: this.now() } },
    );
    return res !== null;
  }

  /**
   * Shared monthly/year card activation (GACHA_DESIGN §5). Idempotent by orderId, and globally single-slot:
   * refuses with ALREADY_ACTIVE while any subscription is still running (buy → use up → rebuy), so cards no longer
   * stack open-endedly. Extends the subscription by `days` and grants `immediateCoins` at once. Real receipt
   * verification (native/WeChat: verifyNonCoinReceipt; web: Paddle webhook signature) happens in the caller
   * (meta) BEFORE this is invoked — see monthlyCardBuy/yearCardBuy's `channel` doc.
   */
  async subscriptionCardBuy(args: {
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
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; wallet: WalletView }>> {
    const existing = await this.cols.orders.findOne({ _id: args.orderId });
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
        if (this.isStaleClaim(existing.ts) && (await this.claimOrderResume(args.orderId))) {
          return this.finishSubscriptionCardBuy(args);
        }
        const w = await this.cols.wallets.findOne({ _id: existing.accountId });
        return {
          ok: true,
          coinsAfter: effectiveCoins(w, displayChannelOf(args.channel, args.clientPlatform)),
          subscriptionExpiry: w?.subscription?.expiry ?? 0,
          wallet: walletView(w, args.clientPlatform, args.channel),
        };
      }
      const w = await this.cols.wallets.findOne({ _id: existing.accountId });
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
      await this.cols.orders.insertOne({
        _id: args.orderId,
        accountId: args.accountId,
        kind: 'grant',
        cost: 0,
        status: 'charged',
        coinsAfter: 0,
        result: {},
        ts: this.now(),
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        const r = await this.cols.orders.findOne({ _id: args.orderId });
        if (r && r.accountId !== args.accountId) return { ok: false, error: 'BAD_REQUEST' };
        if (r?.status === 'charged') {
          if (this.isStaleClaim(r.ts) && (await this.claimOrderResume(args.orderId))) {
            return this.finishSubscriptionCardBuy(args);
          }
          const w0 = await this.cols.wallets.findOne({ _id: args.accountId });
          return {
            ok: true,
            coinsAfter: effectiveCoins(w0, displayChannelOf(args.channel, args.clientPlatform)),
            subscriptionExpiry: w0?.subscription?.expiry ?? 0,
            wallet: walletView(w0, args.clientPlatform, args.channel),
          };
        }
        const w = await this.cols.wallets.findOne({ _id: args.accountId });
        return {
          ok: true,
          coinsAfter: effectiveCoins(w, displayChannelOf(args.channel, args.clientPlatform)),
          subscriptionExpiry: w?.subscription?.expiry ?? 0,
          wallet: walletView(w, args.clientPlatform, args.channel),
        };
      }
      throw e;
    }
    return this.finishSubscriptionCardBuy(args);
  }

  /**
   * Runs the single-slot gate + applySubscription + delivery flip for an order slot already claimed as
   * 'charged' (fresh claim or resumed replay — see subscriptionCardBuy). Only ever reaches applySubscription
   * once per orderId: a 'charged' row is a dead giveaway no prior call got far enough to flip it to
   * 'delivered', and the unique orderId insert guarantees at most one caller gets past the claim itself.
   */
  private async finishSubscriptionCardBuy(args: {
    accountId: string;
    orderId: string;
    days: number;
    immediateCoins: number;
    channel?: RechargeChannel;
    clientPlatform?: string;
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; wallet: WalletView }>> {
    const now = this.now();
    await this.ensureWallet(args.accountId);
    // Single-slot gate: refuse a distinct purchase while a card is still active (buy → use up → rebuy),
    // enforced atomically together with the extend-and-credit itself (see applySubscriptionIfInactive) so
    // two concurrent purchases can't both pass a separate check before either commits. Roll back the
    // claimed slot so the account isn't left with a phantom grant order and a later (post-expiry) retry works.
    const applied = await this.applySubscriptionIfInactive(
      args.accountId,
      args.days,
      args.immediateCoins,
      now,
      { orderId: args.orderId, channel: args.channel, clientPlatform: args.clientPlatform },
    );
    if (!applied) {
      await this.cols.orders.deleteOne({ _id: args.orderId });
      return { ok: false, error: 'ALREADY_ACTIVE' };
    }
    await this.cols.orders.updateOne(
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
}

export type { Rarity };
