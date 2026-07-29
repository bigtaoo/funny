// Shared foundation for the CommercialService mixin chain (see ../service.ts assembly).
// CommercialServiceBase holds `deps` (unpacked into protected fields, so domain mixin method bodies keep
// referencing `this.cols` / `this.now` / `this.rng` / `this.verifyReceipt` verbatim) + the genuinely
// cross-cutting helpers used by more than one domain mixin: ensureWallet / credit (recharge/ads/shop/…),
// resolvePool (gachaDraw/redeemFate/starterBuy), applySubscription / subscriptionCardBuy (monthly/year card
// buys AND starterBuy's growth path). Each business domain lives in its own sibling file as an `XMixin(Base)`
// and is chained together into the final CommercialService. Domain-local helpers stay in their own mixin file.
//
// Money-invariant correctness is priority #1: this is a pure mechanical split — method bodies were moved
// verbatim. Do NOT change, reorder, or "improve" any logic here.
import {
  findGachaPool,
  isLimitedPoolActive,
  IAP_TIERS,
  DEV_STUB_DEFAULT_TIER,
  usdCentsForTier,
  buildLimitedPool,
  type Rarity,
  type GachaPoolDef,
  type CustomPoolConfig,
  type LimitedPoolConfig,
  type RedisLike,
} from '@nw/shared';
import type {
  CommercialCollections,
  GachaPoolDoc,
  CustomGachaPoolDoc,
  WalletDoc,
} from '../db';
import { isCustomPoolDoc } from '../db';
import type { RandInt } from '../gacha';
import { displayChannelOf, effectiveCoins, type RechargeChannel } from '../spendChannel';
import type { IapProductKind } from '../iap';

/** A resolved, drawable pool: either a derived/static GachaPoolDef or an ops-authored custom config (§12). */
export type ResolvedPool = { kind: 'derived'; pool: GachaPoolDef } | { kind: 'custom'; cfg: CustomPoolConfig };

export type ServiceErr =
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_RECEIPT'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'PROMO_NOT_FOUND'
  | 'PROMO_EXPIRED'
  | 'PROMO_EXHAUSTED'
  | 'PROMO_ALREADY_USED'
  | 'POOL_UNAVAILABLE'
  | 'FATE_INSUFFICIENT'
  | 'FATE_INVALID_ITEM'
  | 'ALREADY_PURCHASED'
  | 'ALREADY_ACTIVE';

/** Wallet view returned to meta (mirrored into SaveData). Includes monetization state (§5–§7). */
export interface WalletView {
  coins: number;
  pity: Record<string, number>;
  fatePoints: number;
  subscriptionExpiry: number; // 0 = no active subscription
  subscriptionLastClaimDay?: string; // UTC day (YYYY-MM-DD) of the last daily-coin claim; absent = never claimed
  starterUsed: string[];
  firstPurchaseUsed: boolean; // true once the first-purchase 2× bonus has been claimed; gates the "首充双倍" shop badge
  totalRechargeCents: number; // lifetime cumulative real-money spend (usdCents), GACHA_DESIGN §13
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: ServiceErr };

export interface CommercialDeps {
  cols: CommercialCollections;
  now: () => number;
  /** RNG source for gacha draws (default: crypto true-random; tests inject a fixed seed to reproduce pity). */
  rng?: RandInt;
  /**
   * Receipt verification function for recharge (S4-1) and non-coin SKUs (verifyNonCoinReceipt).
   * Supports async (WeChat/Stripe require network requests); falls back to the built-in dev stub when omitted.
   * Dev stub: receipt is formatted as `tier:<tierId>` (e.g. `tier:t499`) and grants the corresponding coin tier;
   * `product:<kind>` (e.g. `product:monthly_card`) resolves a non-coin SKU instead (coins:0, product set);
   * any other non-empty value grants the default dev-stub tier (DEV_STUB_DEFAULT_TIER).
   * `usdCents` (GACHA_DESIGN §13): the real USD price of the tier, used to bump totalRechargeCents; absent/0 = not tracked.
   */
  verifyReceipt?: (
    platform: string,
    receipt: string,
  ) =>
    | Promise<{ ok: boolean; coins: number; usdCents?: number; product?: IapProductKind }>
    | { ok: boolean; coins: number; usdCents?: number; product?: IapProductKind };
  /** victoryDaily counter backend (2026-07-27, moved off Mongo — shared/src/dailyCounter.ts). null (the
   *  default in every test in this package) = correct-for-single-instance in-process counter, not a disabled cap. */
  redis?: RedisLike | null;
}

const NON_COIN_KINDS_BASE: readonly IapProductKind[] = [
  'monthly_card', 'year_card', 'starter_draw', 'starter_growth',
];

/** Dev stub (used only in unit tests / when no real payment channel is configured). */
export function devVerifyReceipt(
  _platform: string,
  receipt: string,
): { ok: boolean; coins: number; usdCents: number; product?: IapProductKind } {
  if (!receipt) return { ok: false, coins: 0, usdCents: 0 };
  if (receipt.startsWith('product:')) {
    const kind = receipt.slice(8);
    if ((NON_COIN_KINDS_BASE as readonly string[]).includes(kind)) {
      return { ok: true, coins: 0, usdCents: 0, product: kind as IapProductKind };
    }
    return { ok: false, coins: 0, usdCents: 0 };
  }
  const tier = receipt.startsWith('tier:') ? receipt.slice(5) : DEV_STUB_DEFAULT_TIER;
  const coins = IAP_TIERS[tier] ?? IAP_TIERS[DEV_STUB_DEFAULT_TIER]!;
  return { ok: true, coins, usdCents: usdCentsForTier(IAP_TIERS[tier] ? tier : DEV_STUB_DEFAULT_TIER) };
}

/**
 * Project a wallet document into the meta-facing view (defaults for lazily-absent monetization fields).
 * `coins` is the EFFECTIVE balance for `clientPlatform` (free pool + that platform's recharged bucket, ADR-020
 * spendChannel.ts) — not the raw `WalletDoc.coins` field. Omitting `clientPlatform` defaults to the 'web'
 * bucket (today's behavior for every currently-live client).
 */
export function walletView(w: WalletDoc | null, clientPlatform?: string, fundedChannel?: RechargeChannel): WalletView {
  return {
    coins: effectiveCoins(w, displayChannelOf(fundedChannel, clientPlatform)),
    pity: w?.gacha.pity ?? {},
    fatePoints: w?.fatePoints ?? 0,
    subscriptionExpiry: w?.subscription?.expiry ?? 0,
    subscriptionLastClaimDay: w?.subscription?.lastClaimDayKey,
    starterUsed: w?.starterUsed ?? [],
    firstPurchaseUsed: w?.firstPurchasedAt != null,
    totalRechargeCents: w?.totalRechargeCents ?? 0,
  };
}

/** Strip the mongo/audit fields off a derived GachaPoolDoc back to a plain LimitedPoolConfig. */
export function limitedConfigFromDoc(doc: Exclude<GachaPoolDoc, CustomGachaPoolDoc>): LimitedPoolConfig {
  return {
    id: doc.id,
    name: doc.name,
    featuredLegendary: doc.featuredLegendary,
    startAt: doc.startAt,
    endAt: doc.endAt,
    ...(doc.fillerLegendaries ? { fillerLegendaries: doc.fillerLegendaries } : {}),
  };
}

/** Strip the mongo/audit fields off a custom GachaPoolDoc back to a plain CustomPoolConfig (§12). */
export function customConfigFromDoc(doc: CustomGachaPoolDoc): CustomPoolConfig {
  return {
    id: doc.id,
    name: doc.name,
    costSingle: doc.costSingle,
    ...(doc.costTen != null ? { costTen: doc.costTen } : {}),
    startAt: doc.startAt,
    endAt: doc.endAt,
    categories: doc.categories,
  };
}

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type CommercialBaseCtor = Constructor<CommercialServiceBase>;

export class CommercialServiceBase {
  protected readonly deps: CommercialDeps;
  // Deps unpacked into protected fields so domain-mixin method bodies keep referencing them verbatim (this.cols, this.now, …).
  protected readonly cols: CommercialCollections;
  protected readonly now: () => number;
  protected readonly rng?: RandInt;
  protected readonly redis: RedisLike | null;
  protected readonly verifyReceipt: (
    platform: string,
    receipt: string,
  ) => Promise<{ ok: boolean; coins: number; usdCents?: number; product?: IapProductKind }>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...args: any[]) {
    const deps = args[0] as CommercialDeps;
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
  protected static readonly REPLAY_HEAL_GRACE_MS = 15000;

  protected isStaleClaim(claimedAtMs: number): boolean {
    return this.now() - claimedAtMs > CommercialServiceBase.REPLAY_HEAL_GRACE_MS;
  }

  /** Fetch or create the wallet (upserts coins:0 rev:0 on first access). */
  protected async ensureWallet(accountId: string): Promise<WalletDoc> {
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
  protected async resolvePool(poolId: string, now: number): Promise<ResolvedPool | null> {
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
  protected async credit(
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
  protected async debitEffective(
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
  protected async applySubscription(
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
   * Atomic CAS guard for resuming a stale 'charged' order (subscriptionCardBuy/starterBuy growth-pack resume
   * branches, both past isStaleClaim): only the caller whose findOneAndUpdate matches (healClaimedAt still
   * absent) may proceed to finishSubscriptionCardBuy/finishStarterGrowth. Without this, two concurrent
   * stale-claim resumers racing the SAME orderId would both pass isStaleClaim (no ledger check exists here —
   * applySubscription itself doesn't check-before-crediting) and both run applySubscription, double-crediting
   * coins and double-extending the subscription. The loser reads the current wallet snapshot instead, same
   * as the non-stale "still likely in-flight" branch already does.
   */
  protected async claimOrderResume(orderId: string): Promise<boolean> {
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
  protected async subscriptionCardBuy(args: {
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
    // Single-slot gate: refuse a distinct purchase while a card is still active (buy → use up → rebuy). Roll back the
    // claimed slot so the account isn't left with a phantom grant order and a later (post-expiry) retry works.
    const wallet = await this.ensureWallet(args.accountId);
    if ((wallet.subscription?.expiry ?? 0) > now) {
      await this.cols.orders.deleteOne({ _id: args.orderId });
      return { ok: false, error: 'ALREADY_ACTIVE' };
    }
    const applied = await this.applySubscription(
      args.accountId,
      args.days,
      args.immediateCoins,
      now,
      { orderId: args.orderId, channel: args.channel, clientPlatform: args.clientPlatform },
    );
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
