// commercial internal client (S5-5): meta calls commercial via internal HTTP (X-Internal-Key) to
// handle coin deduction / gacha draws / bookkeeping. Contract: SERVER_API.md §9 / COMMERCIAL_DESIGN §5. meta is the sole caller of commercial.
import { fetchInternalJson, type Rarity, type LimitedPoolConfig, type CustomPoolConfig } from '@nw/shared';

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

type Body<T> = ({ ok: true } & T) | { ok: false; error: string };

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

/** Real HTTP implementation. baseUrl is null (commercial not configured) → available=false, economy endpoints return 503. */
export class HttpCommercialClient implements CommercialClient {
  readonly available: boolean;
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {
    this.available = !!baseUrl;
  }

  private async post<T>(path: string, body: unknown): Promise<Body<T>> {
    const r = await fetchInternalJson<Body<T>>(`${this.baseUrl}${path}`, {
      caller: 'meta',
      key: this.internalKey,
      method: 'POST',
      body,
      timeoutMs: 5000,
      label: path,
    });
    // Business errors (402/409 …) come back as parsed JSON in r.body and are returned to the
    // caller unchanged. Only a network error / timeout / non-JSON response leaves body null —
    // keep throwing there so callers' existing catch → 500 behavior is preserved.
    if (r.body === null) throw new Error(`commercial ${path} failed: ${r.error ?? `status ${r.status}`}`);
    return r.body;
  }

  private async getJson<T>(pathAndQuery: string): Promise<Body<T> | null> {
    const r = await fetchInternalJson<Body<T>>(`${this.baseUrl}${pathAndQuery}`, {
      caller: 'meta',
      key: this.internalKey,
      timeoutMs: 5000,
      label: pathAndQuery.split('?')[0]!,
    });
    return r.body;
  }

  async getWallet(accountId: string, clientPlatform?: string): Promise<WalletView | null> {
    if (!this.baseUrl) return null;
    const q = new URLSearchParams({ accountId });
    if (clientPlatform) q.set('clientPlatform', clientPlatform);
    const b = await this.getJson<WalletView>(`/internal/wallet?${q}`);
    return b?.ok
      ? {
          coins: b.coins,
          pity: b.pity,
          fatePoints: b.fatePoints ?? 0,
          subscriptionExpiry: b.subscriptionExpiry ?? 0,
          subscriptionLastClaimDay: b.subscriptionLastClaimDay,
          starterUsed: b.starterUsed ?? [],
          firstPurchaseUsed: b.firstPurchaseUsed ?? false,
          totalRechargeCents: b.totalRechargeCents ?? 0,
        }
      : null;
  }

  shopCharge(args: { accountId: string; itemId: string; cost: number; qty?: number; orderId: string; clientPlatform?: string }) {
    return this.post<{ orderId: string; coinsAfter: number; status: string }>(
      '/internal/shop/charge',
      args,
    );
  }

  gachaDraw(args: { accountId: string; poolId: string; count: number; orderId: string; clientPlatform?: string }) {
    return this.post<{
      orderId: string;
      coinsAfter: number;
      pityAfter: number;
      results: GachaResultEntry[];
      fateGained: number;
      fatePointsAfter: number;
    }>('/internal/gacha/draw', args);
  }

  createCustomPool(args: { config: CustomPoolConfig; createdBy: string }) {
    return this.post<{ id: string }>('/internal/gacha/pool/custom', args);
  }

  closeLimitedPool(args: { id: string }) {
    return this.post<{ id: string }>('/internal/gacha/pool/close', args);
  }

  private async listPools(active: boolean, now?: number): Promise<GachaPoolView[]> {
    if (!this.baseUrl) return [];
    const q = active ? `?active=1&now=${now ?? 0}` : '';
    const b = await this.getJson<{ pools: GachaPoolView[] }>(`/internal/gacha/pools${q}`);
    return b?.ok ? b.pools : [];
  }

  listLimitedPools(): Promise<GachaPoolView[]> {
    return this.listPools(false);
  }

  listActiveLimitedPools(now: number): Promise<GachaPoolView[]> {
    return this.listPools(true, now);
  }

  redeemFate(args: { accountId: string; itemId: string; orderId: string; clientPlatform?: string }) {
    return this.post<{ orderId: string; itemId: string; coinsAfter: number; fatePointsAfter: number }>(
      '/internal/fate/redeem',
      args,
    );
  }

  monthlyCardBuy(args: { accountId: string; orderId: string; rechargePlatform?: string; clientPlatform?: string }) {
    return this.post<{ coinsAfter: number; subscriptionExpiry: number; wallet?: WalletView }>(
      '/internal/monthly-card/buy',
      args,
    );
  }

  yearCardBuy(args: { accountId: string; orderId: string; rechargePlatform?: string; clientPlatform?: string }) {
    return this.post<{ coinsAfter: number; subscriptionExpiry: number; wallet?: WalletView }>(
      '/internal/year-card/buy',
      args,
    );
  }

  monthlyCardClaim(args: { accountId: string; dayKey: string; clientPlatform?: string }) {
    return this.post<{ coinsAfter: number; claimed: number; subscriptionExpiry: number; wallet?: WalletView }>(
      '/internal/monthly-card/claim',
      args,
    );
  }

  starterBuy(args: { accountId: string; productId: string; orderId: string; rechargePlatform?: string; clientPlatform?: string }) {
    return this.post<{ coinsAfter: number; subscriptionExpiry: number; results: GachaResultEntry[]; wallet?: WalletView }>(
      '/internal/starter/buy',
      args,
    );
  }

  spend(args: { accountId: string; amount: number; reason: string; orderId: string; clientPlatform?: string }) {
    return this.post<{ coinsAfter: number }>('/internal/spend', args);
  }

  grant(args: { accountId: string; amount: number; reason: string; orderId: string; clientPlatform?: string }) {
    return this.post<{ coinsAfter: number }>('/internal/grant', args);
  }

  orderDelivered(args: { orderId: string; refundCoins?: number }) {
    return this.post<object>('/internal/order/delivered', args);
  }

  async undeliveredOrders(accountId: string): Promise<UndeliveredOrder[]> {
    if (!this.baseUrl) return [];
    const b = await this.getJson<{ orders: UndeliveredOrder[] }>(
      `/internal/orders/undelivered?accountId=${encodeURIComponent(accountId)}`,
    );
    return b?.ok ? b.orders : [];
  }

  rechargeVerify(args: { accountId: string; platform: string; receipt: string; receiptId: string; clientPlatform?: string }) {
    return this.post<{ coinsAfter: number; coinsGranted: number }>(
      '/internal/recharge/verify',
      args,
    );
  }

  verifyNonCoinReceipt(args: {
    accountId: string;
    platform: string;
    receipt: string;
    receiptId: string;
    expectedProduct: 'monthly_card' | 'year_card' | 'starter_draw' | 'starter_growth';
  }) {
    return this.post<{ product: string }>('/internal/nonCoinReceipt/verify', args);
  }

  adsCredit(args: { accountId: string; amount: number; dayKey: string; clientPlatform?: string }) {
    return this.post<{ coinsAfter: number }>('/internal/ads/credit', args);
  }

  victoryCredit(args: { accountId: string; amount: number; dayKey: string; clientPlatform?: string }) {
    return this.post<{ coinsAfter: number; credited: number; capped: boolean }>(
      '/internal/victory/credit',
      args,
    );
  }

  promoRedeem(args: { accountId: string; code: string; clientPlatform?: string }) {
    return this.post<{ coinsAfter: number; coinsGranted: number }>('/internal/promo/redeem', args);
  }

  createPromoCode(args: {
    code: string;
    coins: number;
    expiresAt?: number;
    totalLimit?: number;
    note?: string;
    createdBy: string;
  }) {
    return this.post<{ code: string }>('/internal/promo/codes', args);
  }

  async listPromoCodes(): Promise<PromoCodeView[]> {
    if (!this.baseUrl) return [];
    const b = await this.getJson<{ codes: PromoCodeView[] }>('/internal/promo/codes');
    return b?.ok ? b.codes : [];
  }

  paddleComplete(args: { accountId: string; transactionId: string; coins: number; usdCents?: number }) {
    return this.post<{ coinsAfter: number; coinsGranted: number }>(
      '/internal/paddle/complete',
      args,
    );
  }

  paddleRefund(args: { transactionId: string }) {
    return this.post<{ decrementedCents: number }>('/internal/paddle/refund', args);
  }

  async recordPaddleEvent(args: {
    transactionId: string;
    eventType: string;
    status?: string;
    accountId?: string;
    rawEvent: string;
  }): Promise<void> {
    if (!this.baseUrl) return;
    await this.post('/internal/paddle/event', args);
  }

  async listPaddleEvents(args: {
    accountId?: string;
    transactionId?: string;
    limit?: number;
  }): Promise<PaddleEventView[]> {
    if (!this.baseUrl) return [];
    const q = new URLSearchParams();
    if (args.accountId) q.set('accountId', args.accountId);
    if (args.transactionId) q.set('transactionId', args.transactionId);
    if (args.limit) q.set('limit', String(args.limit));
    const b = await this.getJson<{ events: PaddleEventView[] }>(`/internal/paddle/events?${q}`);
    return b?.ok ? b.events : [];
  }

  async auditCoinGains(dayKey: string, minGain: number): Promise<CoinGainRow[]> {
    if (!this.baseUrl) return [];
    const q = new URLSearchParams({ dayKey, minGain: String(minGain) });
    const b = await this.getJson<{ accounts: CoinGainRow[] }>(`/internal/audit/coin-gains?${q}`);
    return b?.ok ? b.accounts : [];
  }
}
