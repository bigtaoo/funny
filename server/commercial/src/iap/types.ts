// Split from iap.ts (2026-08-10, independent function module range 6, part 1/7).
// Shared types + the non-coin product kind list every platform verifier consults.
import type { IAP_TIERS } from '@nw/shared';

export type IapTierMap = typeof IAP_TIERS;

/** Non-coin SKUs (subscriptions + starter packs) resolvable from a receipt, alongside coin tiers. */
export type IapProductKind = 'monthly_card' | 'year_card' | 'starter_draw' | 'starter_growth';

export interface IapVerifyResult {
  ok: boolean;
  coins: number;
  /** Real USD price of the resolved tier (GACHA_DESIGN §13), for the cumulative-recharge counter. */
  usdCents?: number;
  /**
   * Present only when the receipt's product resolves to a non-coin SKU (monthly/year card, starter
   * pack) rather than a coin tier — `coins` is 0 in that case. GACHA_DESIGN §5/§6: these purchases
   * were previously granted with no receipt at all ("treated as authorized"); this field is what lets
   * the caller (commercial's subscription/starter mixins, via metaserver) require real proof of payment.
   */
  product?: IapProductKind;
}

export type VerifyReceipt = (platform: string, receipt: string) => Promise<IapVerifyResult>;

/**
 * One auto-renewable subscription period read out of an Apple receipt
 * (iap/apple.ts's appleSubscriptionTransactions). Apple issues a fresh transaction for every renewal,
 * so this is the unit a launch-time sync grants — one period, once, keyed by `transactionId`.
 */
export interface AppleSubscriptionTx {
  /** Apple's per-transaction id. Becomes the grant's orderId as `apple:<transactionId>`, which is what
   *  makes syncing on every cold start idempotent rather than a monthly-card printing press. */
  transactionId: string;
  /** Which of the two subscription SKUs this period belongs to. */
  product: 'monthly_card' | 'year_card';
  /** purchase_date_ms, used only to grant the periods in the order they were paid for. */
  purchasedMs: number;
}

/** Reads the subscription periods out of an Apple receipt; null when Apple credentials are unconfigured. */
export type VerifyAppleSubscriptions = ((receipt: string) => Promise<AppleSubscriptionTx[]>) | null;

// Same NW_IAP_PRODUCT_MAP convention as resolveCoinsFromProductId (productId:kind pairs), just with a
// reserved kind set instead of a coin-tier lookup — the two never collide since IAP_TIERS keys are all
// t-prefixed (t099, t499, ...) and these kinds are full words.
export const NON_COIN_PRODUCT_KINDS: readonly IapProductKind[] = [
  'monthly_card', 'year_card', 'starter_draw', 'starter_growth',
];
