// The contract meta talks to commercial through: the request/response shapes of every internal
// endpoint, plus the views commercial hands back (SERVER_API.md §9 / COMMERCIAL_DESIGN §5).
//
// Split out of commercialClient.ts on 2026-09-07, when adding the two Apple per-account calls
// (ADR-082) pushed that file past the 500-line convention. The split is types-vs-transport rather
// than by domain: there is exactly one implementation and it is a flat list of one-line POSTs, so
// cutting it by domain would fragment a forwarding list, while the interface is what every caller
// and every test double actually reads. `commercialClient.ts` re-exports all of this, so no call
// site had to change.
import type { Rarity, LimitedPoolConfig, CustomPoolConfig } from '@nw/shared';

export interface GachaResultEntry {
  itemId: string;
  rarity: Rarity;
}

export interface UndeliveredOrder {
  _id: string;
  accountId: string;
  // 'fate'/'starter' deliver items like a gacha order (skins/materials/equipment/cards); see economy.deliverOrder.
  kind: 'shop' | 'gacha' | 'fate' | 'starter';
  // qty: units charged together in one shopCharge call (bulk-buy, 2026-08-10); absent/1 for a single-unit
  // shop order and for every non-'shop' kind. deliverOrder's kind==='shop' branch reads this to grant the
  // full quantity on reconciliation, not just 1, when a bulk buy crashed between charge and delivery.
  result: { itemId?: string; results?: GachaResultEntry[]; poolId?: string; qty?: number };
}

/** Wallet view mirrored into SaveData (coins/pity + monetization state §5–§7/§13). */
export interface WalletView {
  coins: number;
  pity: Record<string, number>;
  fatePoints: number;
  subscriptionExpiry: number;
  subscriptionLastClaimDay?: string; // UTC day (YYYY-MM-DD) of last daily-coin claim; absent = never claimed
  starterUsed: string[];
  firstPurchaseUsed: boolean; // true once the first-purchase 2× bonus has been claimed
  totalRechargeCents: number; // lifetime cumulative real-money spend (usdCents), GACHA_DESIGN §13
}

/** Audit fields commercial stamps on every stored pool config. */
interface GachaPoolAudit {
  createdBy: string;
  createdAt: number;
  closedAt?: number;
}

/**
 * A pool config as stored/listed by commercial. Discriminated by `kind` (absent = derived, GACHA_DESIGN §2.2;
 * 'custom' = ops-authored free-form pool, §12). meta.getGachaPools branches on it to build the client view.
 */
export type GachaPoolView =
  | (LimitedPoolConfig & GachaPoolAudit & { kind?: 'derived' })
  | (CustomPoolConfig & GachaPoolAudit & { kind: 'custom' });

export type Body<T> = ({ ok: true } & T) | { ok: false; error: string };

/** meta-side commercial client interface (allows injecting a fake implementation in unit tests). */
export interface CommercialClient {
  readonly available: boolean;
  /** `clientPlatform` (X-NW-Platform, ADR-020): which recharged bucket the returned `coins` should include
   * alongside the free pool — prevents e.g. a Paddle-bought balance leaking into the iOS app's display. */
  getWallet(accountId: string, clientPlatform?: string): Promise<WalletView | null>;
  shopCharge(args: {
    accountId: string;
    itemId: string;
    cost: number;
    /** Units to charge/deliver in this one call (bulk-buy, ×10 button, 2026-08-10). Default 1. */
    qty?: number;
    orderId: string;
    clientPlatform?: string;
  }): Promise<Body<{ orderId: string; coinsAfter: number; status: string }>>;
  gachaDraw(args: {
    accountId: string;
    poolId: string;
    count: number;
    orderId: string;
    clientPlatform?: string;
  }): Promise<
    Body<{
      orderId: string;
      coinsAfter: number;
      pityAfter: number;
      results: GachaResultEntry[];
      fateGained: number;
      fatePointsAfter: number;
    }>
  >;
  // ── Limited pools + monetization (GACHA_DESIGN §2/§5/§6/§7) ──
  createCustomPool(args: {
    config: CustomPoolConfig;
    createdBy: string;
  }): Promise<Body<{ id: string }>>;
  closeLimitedPool(args: { id: string }): Promise<Body<{ id: string }>>;
  listLimitedPools(): Promise<GachaPoolView[]>;
  listActiveLimitedPools(now: number): Promise<GachaPoolView[]>;
  redeemFate(args: {
    accountId: string;
    itemId: string;
    orderId: string;
    clientPlatform?: string;
  }): Promise<Body<{ orderId: string; itemId: string; coinsAfter: number; fatePointsAfter: number }>>;
  monthlyCardBuy(args: {
    accountId: string;
    orderId: string;
    /** The verified recharge platform (apple/google/wechat from verifyNonCoinReceipt, 'paddle' from the
     * webhook) — tags which recharged bucket funds the immediate coins (ADR-020). */
    rechargePlatform?: string;
    clientPlatform?: string;
  }): Promise<Body<{ coinsAfter: number; subscriptionExpiry: number; wallet?: WalletView }>>;
  yearCardBuy(args: {
    accountId: string;
    orderId: string;
    rechargePlatform?: string;
    clientPlatform?: string;
  }): Promise<Body<{ coinsAfter: number; subscriptionExpiry: number; wallet?: WalletView }>>;
  monthlyCardClaim(args: {
    accountId: string;
    dayKey: string;
    clientPlatform?: string;
  }): Promise<Body<{ coinsAfter: number; claimed: number; subscriptionExpiry: number; wallet?: WalletView }>>;
  /** Apply any auto-renewable subscription periods in an Apple receipt that have not been granted yet
   *  (IOS_RELEASE.md §4.1b). Idempotent — the client calls it on every cold start. */
  subscriptionSyncApple(args: {
    accountId: string;
    receipt: string;
    clientPlatform?: string;
  }): Promise<Body<{ coinsAfter: number; subscriptionExpiry: number; granted: number; wallet?: WalletView }>>;
  /**
   * Hand an App Store Server Notification V2 to commercial, which verifies Apple's signature and acts
   * on it. The payload is forwarded verbatim and deliberately not inspected here: the Apple
   * credentials and the pinned root certificates live in commercial, so that is where a payload can
   * be judged genuine (server/commercial/src/service/appleNotifications.ts).
   */
  appleNotification(args: {
    signedPayload: string;
  }): Promise<Body<{ outcome: string }>>;
  /**
   * This account's `appAccountToken` — the UUID the iOS client attaches to a StoreKit 2 purchase so
   * Apple can name the owner on every later notification about it. Allocated on first ask and stable
   * afterwards (server/commercial/src/service/appleAccount.ts).
   */
  appleAccountToken(args: { accountId: string }): Promise<Body<{ token: string }>>;
  /** Store the player's answer to the consumption-data question the app asks (CONSUMPTION_REQUEST). */
  appleConsumptionConsent(args: {
    accountId: string;
    consented: boolean;
  }): Promise<Body<{ consented: boolean }>>;
  starterBuy(args: {
    accountId: string;
    productId: string;
    orderId: string;
    rechargePlatform?: string;
    clientPlatform?: string;
  }): Promise<Body<{ coinsAfter: number; subscriptionExpiry: number; results: GachaResultEntry[]; wallet?: WalletView }>>;
  spend(args: {
    accountId: string;
    amount: number;
    reason: string;
    orderId: string;
    clientPlatform?: string;
  }): Promise<Body<{ coinsAfter: number }>>;
  /** Pure coin grant (mail attachment claim S6-3), orderId is idempotent. amount=0 only reserves the idempotency slot without adding coins. */
  grant(args: {
    accountId: string;
    amount: number;
    reason: string;
    orderId: string;
    clientPlatform?: string;
  }): Promise<Body<{ coinsAfter: number }>>;
  orderDelivered(args: { orderId: string; refundCoins?: number }): Promise<Body<object>>;
  undeliveredOrders(accountId: string): Promise<UndeliveredOrder[]>;
  rechargeVerify(args: {
    accountId: string;
    platform: string;
    receipt: string;
    receiptId: string;
    clientPlatform?: string;
  }): Promise<Body<{ coinsAfter: number; coinsGranted: number }>>;
  /**
   * Verify a receipt resolves to a specific non-coin SKU (monthly/year card, starter pack) before
   * granting it — closes the gap where `/monthly-card/buy` etc. used to grant on a bare authenticated
   * request with no proof of payment (GACHA_DESIGN §5/§6). Does not itself grant anything.
   */
  verifyNonCoinReceipt(args: {
    accountId: string;
    platform: string;
    receipt: string;
    receiptId: string;
    expectedProduct: 'monthly_card' | 'year_card' | 'starter_draw' | 'starter_growth';
  }): Promise<Body<{ product: string }>>;
  adsCredit(args: {
    accountId: string;
    amount: number;
    dayKey: string;
    clientPlatform?: string;
  }): Promise<Body<{ coinsAfter: number }>>;
  victoryCredit(args: {
    accountId: string;
    amount: number;
    dayKey: string;
    clientPlatform?: string;
  }): Promise<Body<{ coinsAfter: number; credited: number; capped: boolean }>>;
  promoRedeem(args: {
    accountId: string;
    code: string;
    clientPlatform?: string;
  }): Promise<Body<{ coinsAfter: number; coinsGranted: number }>>;
  createPromoCode(args: {
    code: string;
    coins: number;
    expiresAt?: number;
    totalLimit?: number;
    note?: string;
    createdBy: string;
  }): Promise<Body<{ code: string }>>;
  listPromoCodes(): Promise<PromoCodeView[]>;
  /** Credit coins from a verified Paddle transaction (signature already checked by metaserver). */
  paddleComplete(args: {
    accountId: string;
    transactionId: string;
    coins: number;
    usdCents?: number;
  }): Promise<Body<{ coinsAfter: number; coinsGranted: number }>>;
  /** Decrement totalRechargeCents for a refunded Paddle transaction (GACHA_DESIGN §13, ADR-045). */
  paddleRefund(args: { transactionId: string }): Promise<Body<{ decrementedCents: number }>>;
  /** Log a non-`transaction.completed` Paddle webhook event for support/CS lookup (ADMIN-facing, COMMERCIAL_DESIGN §10.4). */
  recordPaddleEvent(args: {
    transactionId: string;
    eventType: string;
    status?: string;
    accountId?: string;
    rawEvent: string;
  }): Promise<void>;
  listPaddleEvents(args: { accountId?: string; transactionId?: string; limit?: number }): Promise<PaddleEventView[]>;
  /**
   * Coin-anomaly daily audit (COMMERCIAL_DESIGN §6.6): accounts whose non-recharge ledger gain within the
   * UTC day `dayKey` (YYYY-MM-DD) is >= minGain, sorted by gain descending. Unavailable/error → empty array
   * (best-effort — the caller is an offline review scan, not a request path).
   */
  auditCoinGains(dayKey: string, minGain: number): Promise<CoinGainRow[]>;
}

export interface CoinGainRow {
  accountId: string;
  nonRechargeGain: number;
}

export interface PaddleEventView {
  transactionId: string;
  eventType: string;
  status?: string;
  accountId?: string;
  rawEvent: string;
  ts: number;
}

export interface PromoCodeView {
  code: string;
  coins: number;
  expiresAt?: number;
  totalLimit?: number;
  redeemed: number;
  note?: string;
  createdBy: string;
  createdAt: number;
}
