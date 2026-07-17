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
  buildLimitedPool,
  type Rarity,
  type GachaPoolDef,
  type CustomPoolConfig,
  type LimitedPoolConfig,
} from '@nw/shared';
import type {
  CommercialCollections,
  GachaPoolDoc,
  CustomGachaPoolDoc,
  WalletDoc,
} from '../db';
import { isCustomPoolDoc } from '../db';
import type { RandInt } from '../gacha';

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
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: ServiceErr };

export interface CommercialDeps {
  cols: CommercialCollections;
  now: () => number;
  /** RNG source for gacha draws (default: crypto true-random; tests inject a fixed seed to reproduce pity). */
  rng?: RandInt;
  /**
   * Receipt verification function for recharge (S4-1).
   * Supports async (WeChat/Stripe require network requests); falls back to the built-in dev stub when omitted.
   * Dev stub: receipt is formatted as `tier:<tierId>` (e.g. `tier:t499`) and grants the corresponding coin tier; any other non-empty value grants the default dev-stub tier (DEV_STUB_DEFAULT_TIER).
   */
  verifyReceipt?: (platform: string, receipt: string) => Promise<{ ok: boolean; coins: number }> | { ok: boolean; coins: number };
}

/** Dev stub (used only in unit tests / when no real payment channel is configured). */
export function devVerifyReceipt(_platform: string, receipt: string): { ok: boolean; coins: number } {
  if (!receipt) return { ok: false, coins: 0 };
  const tier = receipt.startsWith('tier:') ? receipt.slice(5) : DEV_STUB_DEFAULT_TIER;
  const coins = IAP_TIERS[tier];
  return coins ? { ok: true, coins } : { ok: true, coins: IAP_TIERS[DEV_STUB_DEFAULT_TIER]! };
}

/** Project a wallet document into the meta-facing view (defaults for lazily-absent monetization fields). */
export function walletView(w: WalletDoc | null): WalletView {
  return {
    coins: w?.coins ?? 0,
    pity: w?.gacha.pity ?? {},
    fatePoints: w?.fatePoints ?? 0,
    subscriptionExpiry: w?.subscription?.expiry ?? 0,
    subscriptionLastClaimDay: w?.subscription?.lastClaimDayKey,
    starterUsed: w?.starterUsed ?? [],
    firstPurchaseUsed: w?.firstPurchasedAt != null,
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
  protected readonly verifyReceipt: (platform: string, receipt: string) => Promise<{ ok: boolean; coins: number }>;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(...args: any[]) {
    const deps = args[0] as CommercialDeps;
    this.deps = deps;
    this.cols = deps.cols;
    this.now = deps.now;
    this.rng = deps.rng;
    const raw = deps.verifyReceipt ?? devVerifyReceipt;
    // Uniformly wrap as async to be compatible with both the synchronous dev stub and async real receipt verifiers.
    this.verifyReceipt = (p, r) => Promise.resolve(raw(p, r));
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
  async getWallet(accountId: string): Promise<WalletView> {
    const w = await this.cols.wallets.findOne({ _id: accountId });
    return walletView(w);
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

  /** Credit coins + write ledger entry (shared by recharge/ads/refund). Atomic $inc; returns the new balance. */
  protected async credit(
    accountId: string,
    amount: number,
    reason: string,
    ref: { orderId?: string; receiptId?: string },
  ): Promise<number> {
    await this.ensureWallet(accountId);
    const res = await this.cols.wallets.findOneAndUpdate(
      { _id: accountId },
      { $inc: { coins: amount, rev: 1 }, $set: { updatedAt: this.now() } },
      { returnDocument: 'after' },
    );
    const coinsAfter = res!.coins;
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
   * Extend the subscription by `days` (stacking = extend from max(now, current expiry)) + optionally credit
   * `immediateCoins`, in one atomic aggregation-pipeline update. Writes a ledger entry for the immediate coins.
   * Callers gate idempotency upstream (order slot / starterUsed claim) so this never double-applies.
   */
  protected async applySubscription(
    accountId: string,
    days: number,
    immediateCoins: number,
    now: number,
    ref: { orderId?: string; reason?: string },
  ): Promise<{ coinsAfter: number; expiry: number }> {
    await this.ensureWallet(accountId);
    const ms = days * 86400000;
    const res = await this.cols.wallets.findOneAndUpdate(
      { _id: accountId },
      [
        {
          $set: {
            'subscription.expiry': {
              $add: [{ $max: [{ $ifNull: ['$subscription.expiry', now] }, now] }, ms],
            },
            coins: { $add: ['$coins', immediateCoins] },
            rev: { $add: ['$rev', 1] },
            updatedAt: now,
          },
        },
      ],
      { returnDocument: 'after' },
    );
    const coinsAfter = res!.coins;
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
    return { coinsAfter, expiry: res!.subscription?.expiry ?? now + ms };
  }

  /**
   * Shared monthly/year card activation (GACHA_DESIGN §5). Idempotent by orderId, and globally single-slot:
   * refuses with ALREADY_ACTIVE while any subscription is still running (buy → use up → rebuy), so cards no longer
   * stack open-endedly. Extends the subscription by `days` and grants `immediateCoins` at once. Real IAP receipt
   * verification is the caller's concern (meta); here it is treated as an already-authorized purchase.
   */
  protected async subscriptionCardBuy(args: {
    accountId: string;
    orderId: string;
    days: number;
    immediateCoins: number;
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number }>> {
    const existing = await this.cols.orders.findOne({ _id: args.orderId });
    if (existing) {
      const w = await this.cols.wallets.findOne({ _id: existing.accountId });
      return { ok: true, coinsAfter: w?.coins ?? 0, subscriptionExpiry: w?.subscription?.expiry ?? 0 };
    }
    const now = this.now();
    // Claim the order slot first. Concurrent replays of the SAME orderId race here; only one wins, the rest take the
    // E11000 branch and return the existing grant (idempotent). The single-slot gate is applied AFTER the slot is
    // claimed so it never intercepts an idempotent replay — only the unique winner of this orderId evaluates it.
    try {
      await this.cols.orders.insertOne({
        _id: args.orderId,
        accountId: args.accountId,
        kind: 'grant',
        cost: 0,
        status: 'delivered',
        coinsAfter: 0,
        result: {},
        deliveredAt: now,
        ts: now,
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        const w = await this.cols.wallets.findOne({ _id: args.accountId });
        return { ok: true, coinsAfter: w?.coins ?? 0, subscriptionExpiry: w?.subscription?.expiry ?? 0 };
      }
      throw e;
    }
    // Single-slot gate: refuse a distinct purchase while a card is still active (buy → use up → rebuy). Roll back the
    // just-claimed slot so the account isn't left with a phantom grant order and a later (post-expiry) retry works.
    const wallet = await this.ensureWallet(args.accountId);
    if ((wallet.subscription?.expiry ?? 0) > now) {
      await this.cols.orders.deleteOne({ _id: args.orderId });
      return { ok: false, error: 'ALREADY_ACTIVE' };
    }
    const { coinsAfter, expiry } = await this.applySubscription(
      args.accountId,
      args.days,
      args.immediateCoins,
      now,
      { orderId: args.orderId },
    );
    await this.cols.orders.updateOne({ _id: args.orderId }, { $set: { coinsAfter } });
    return { ok: true, coinsAfter, subscriptionExpiry: expiry };
  }
}

export type { Rarity };
