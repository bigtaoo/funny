// commercial internal client (S5-5): meta calls commercial via internal HTTP (X-Internal-Key) to
// handle coin deduction / gacha draws / bookkeeping. Contract: SERVER_API.md §9 / COMMERCIAL_DESIGN §5. meta is the sole caller of commercial.
//
// The contract itself (the CommercialClient interface and the view types) lives in
// commercialContract.ts and is re-exported below, so importers keep using this module either way.
import { fetchInternalJson } from '@nw/shared';
import type {
  Body,
  CoinGainRow,
  CommercialClient,
  GachaPoolView,
  GachaResultEntry,
  PaddleEventView,
  PromoCodeView,
  UndeliveredOrder,
  WalletView,
} from './commercialContract.js';
import type { CustomPoolConfig } from '@nw/shared';

export * from './commercialContract.js';

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

  subscriptionSyncApple(args: { accountId: string; receipt: string; clientPlatform?: string }) {
    return this.post<{ coinsAfter: number; subscriptionExpiry: number; granted: number; wallet?: WalletView }>(
      '/internal/subscription/sync-apple',
      args,
    );
  }

  appleNotification(args: { signedPayload: string }) {
    return this.post<{ outcome: string }>('/internal/apple/notification', args);
  }

  appleAccountToken(args: { accountId: string }) {
    return this.post<{ token: string }>('/internal/apple/account-token', args);
  }

  appleConsumptionConsent(args: { accountId: string; consented: boolean }) {
    return this.post<{ consented: boolean }>('/internal/apple/consumption-consent', args);
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
