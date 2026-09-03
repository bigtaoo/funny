// Pure, stateless surface shared across the CommercialService mixin chain: DTOs (ServiceErr / Result /
// CommercialDeps / WalletView / ResolvedPool) + the free functions that project/convert them, with no
// dependency on CommercialServiceBase's `this`. Split out of base.ts (2026-08-10, same mixin-chain-base
// split as familyService.ts/friendService.ts) purely to keep base.ts's *stateful* class under the 500-line
// convention — every name below is still re-exported from base.ts so no import site elsewhere had to change.
//
// Money-invariant correctness is priority #1: this is a pure mechanical split — moved verbatim, no logic
// changes. Do NOT change, reorder, or "improve" any logic here.
import {
  findGachaPool,
  isLimitedPoolActive,
  IAP_TIERS,
  DEV_STUB_DEFAULT_TIER,
  usdCentsForTier,
  buildLimitedPool,
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
import type { RandInt } from '../gacha';
import { displayChannelOf, effectiveCoins, type RechargeChannel } from '../spendChannel';
import type { AppleSubscriptionTx, IapProductKind } from '../iap';

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
  /**
   * Reads the auto-renewable subscription periods out of an Apple receipt (iap.ts's
   * createAppleSubscriptionReader), for subscriptionSyncApple. Separate from `verifyReceipt` on
   * purpose: it has no dev-stub fallback, because the grants it drives bypass the single-slot gate
   * (see subscriptionCardBuy's `renewal`) and a forgeable receipt there would mint subscription time.
   * Absent/null = Apple unconfigured; the sync then reports nothing to grant instead of granting.
   */
  verifyAppleSubscriptions?: ((receipt: string) => Promise<AppleSubscriptionTx[]>) | null;
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

// Re-exported so base.ts (and everything importing `findGachaPool`/`isLimitedPoolActive`/`buildLimitedPool`
// via it for resolvePool) keeps a single import line; kept private otherwise (not part of the public surface).
export { findGachaPool, isLimitedPoolActive, buildLimitedPool };
