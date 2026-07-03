// commercial internal client (S5-5): meta calls commercial via internal HTTP (X-Internal-Key) to
// handle coin deduction / gacha draws / bookkeeping. Contract: SERVER_API.md §9 / COMMERCIAL_DESIGN §5. meta is the sole caller of commercial.
import { internalHeaders, type Rarity, type LimitedPoolConfig, type CustomPoolConfig } from '@nw/shared';

export interface GachaResultEntry {
  itemId: string;
  rarity: Rarity;
}

export interface UndeliveredOrder {
  _id: string;
  accountId: string;
  // 'fate'/'starter' deliver items like a gacha order (skins/materials/equipment/cards); see economy.deliverOrder.
  kind: 'shop' | 'gacha' | 'fate' | 'starter';
  result: { itemId?: string; results?: GachaResultEntry[]; poolId?: string };
}

/** Wallet view mirrored into SaveData (coins/pity + monetization state §5–§7). */
export interface WalletView {
  coins: number;
  pity: Record<string, number>;
  fatePoints: number;
  subscriptionExpiry: number;
  starterUsed: string[];
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
  getWallet(accountId: string): Promise<WalletView | null>;
  shopCharge(args: {
    accountId: string;
    itemId: string;
    cost: number;
    orderId: string;
  }): Promise<Body<{ orderId: string; coinsAfter: number; status: string }>>;
  gachaDraw(args: {
    accountId: string;
    poolId: string;
    count: number;
    orderId: string;
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
  createLimitedPool(args: {
    config: LimitedPoolConfig;
    createdBy: string;
  }): Promise<Body<{ id: string }>>;
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
  }): Promise<Body<{ orderId: string; itemId: string; coinsAfter: number; fatePointsAfter: number }>>;
  monthlyCardBuy(args: {
    accountId: string;
    orderId: string;
  }): Promise<Body<{ coinsAfter: number; subscriptionExpiry: number }>>;
  yearCardBuy(args: {
    accountId: string;
    orderId: string;
  }): Promise<Body<{ coinsAfter: number; subscriptionExpiry: number }>>;
  monthlyCardClaim(args: {
    accountId: string;
    dayKey: string;
  }): Promise<Body<{ coinsAfter: number; claimed: number; subscriptionExpiry: number }>>;
  starterBuy(args: {
    accountId: string;
    productId: string;
    orderId: string;
  }): Promise<Body<{ coinsAfter: number; subscriptionExpiry: number; results: GachaResultEntry[] }>>;
  spend(args: {
    accountId: string;
    amount: number;
    reason: string;
    orderId: string;
  }): Promise<Body<{ coinsAfter: number }>>;
  /** Pure coin grant (mail attachment claim S6-3), orderId is idempotent. amount=0 only reserves the idempotency slot without adding coins. */
  grant(args: {
    accountId: string;
    amount: number;
    reason: string;
    orderId: string;
  }): Promise<Body<{ coinsAfter: number }>>;
  orderDelivered(args: { orderId: string; refundCoins?: number }): Promise<Body<{}>>;
  undeliveredOrders(accountId: string): Promise<UndeliveredOrder[]>;
  rechargeVerify(args: {
    accountId: string;
    platform: string;
    receipt: string;
    receiptId: string;
  }): Promise<Body<{ coinsAfter: number; coinsGranted: number }>>;
  adsCredit(args: {
    accountId: string;
    amount: number;
    dayKey: string;
  }): Promise<Body<{ coinsAfter: number }>>;
  victoryCredit(args: {
    accountId: string;
    amount: number;
    dayKey: string;
  }): Promise<Body<{ coinsAfter: number; credited: number; capped: boolean }>>;
  promoRedeem(args: {
    accountId: string;
    code: string;
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
  }): Promise<Body<{ coinsAfter: number; coinsGranted: number }>>;
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

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...internalHeaders('meta', this.internalKey) };
  }

  private async post<T>(path: string, body: unknown): Promise<Body<T>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    return (await res.json()) as Body<T>;
  }

  async getWallet(accountId: string): Promise<WalletView | null> {
    if (!this.baseUrl) return null;
    const res = await fetch(
      `${this.baseUrl}/internal/wallet?accountId=${encodeURIComponent(accountId)}`,
      { headers: this.headers() },
    );
    const b = (await res.json()) as Body<WalletView>;
    return b.ok
      ? {
          coins: b.coins,
          pity: b.pity,
          fatePoints: b.fatePoints ?? 0,
          subscriptionExpiry: b.subscriptionExpiry ?? 0,
          starterUsed: b.starterUsed ?? [],
        }
      : null;
  }

  shopCharge(args: { accountId: string; itemId: string; cost: number; orderId: string }) {
    return this.post<{ orderId: string; coinsAfter: number; status: string }>(
      '/internal/shop/charge',
      args,
    );
  }

  gachaDraw(args: { accountId: string; poolId: string; count: number; orderId: string }) {
    return this.post<{
      orderId: string;
      coinsAfter: number;
      pityAfter: number;
      results: GachaResultEntry[];
      fateGained: number;
      fatePointsAfter: number;
    }>('/internal/gacha/draw', args);
  }

  createLimitedPool(args: { config: LimitedPoolConfig; createdBy: string }) {
    return this.post<{ id: string }>('/internal/gacha/pool', args);
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
    const res = await fetch(`${this.baseUrl}/internal/gacha/pools${q}`, { headers: this.headers() });
    const b = (await res.json()) as Body<{ pools: GachaPoolView[] }>;
    return b.ok ? b.pools : [];
  }

  listLimitedPools(): Promise<GachaPoolView[]> {
    return this.listPools(false);
  }

  listActiveLimitedPools(now: number): Promise<GachaPoolView[]> {
    return this.listPools(true, now);
  }

  redeemFate(args: { accountId: string; itemId: string; orderId: string }) {
    return this.post<{ orderId: string; itemId: string; coinsAfter: number; fatePointsAfter: number }>(
      '/internal/fate/redeem',
      args,
    );
  }

  monthlyCardBuy(args: { accountId: string; orderId: string }) {
    return this.post<{ coinsAfter: number; subscriptionExpiry: number }>(
      '/internal/monthly-card/buy',
      args,
    );
  }

  yearCardBuy(args: { accountId: string; orderId: string }) {
    return this.post<{ coinsAfter: number; subscriptionExpiry: number }>(
      '/internal/year-card/buy',
      args,
    );
  }

  monthlyCardClaim(args: { accountId: string; dayKey: string }) {
    return this.post<{ coinsAfter: number; claimed: number; subscriptionExpiry: number }>(
      '/internal/monthly-card/claim',
      args,
    );
  }

  starterBuy(args: { accountId: string; productId: string; orderId: string }) {
    return this.post<{ coinsAfter: number; subscriptionExpiry: number; results: GachaResultEntry[] }>(
      '/internal/starter/buy',
      args,
    );
  }

  spend(args: { accountId: string; amount: number; reason: string; orderId: string }) {
    return this.post<{ coinsAfter: number }>('/internal/spend', args);
  }

  grant(args: { accountId: string; amount: number; reason: string; orderId: string }) {
    return this.post<{ coinsAfter: number }>('/internal/grant', args);
  }

  orderDelivered(args: { orderId: string; refundCoins?: number }) {
    return this.post<{}>('/internal/order/delivered', args);
  }

  async undeliveredOrders(accountId: string): Promise<UndeliveredOrder[]> {
    if (!this.baseUrl) return [];
    const res = await fetch(
      `${this.baseUrl}/internal/orders/undelivered?accountId=${encodeURIComponent(accountId)}`,
      { headers: this.headers() },
    );
    const b = (await res.json()) as Body<{ orders: UndeliveredOrder[] }>;
    return b.ok ? b.orders : [];
  }

  rechargeVerify(args: { accountId: string; platform: string; receipt: string; receiptId: string }) {
    return this.post<{ coinsAfter: number; coinsGranted: number }>(
      '/internal/recharge/verify',
      args,
    );
  }

  adsCredit(args: { accountId: string; amount: number; dayKey: string }) {
    return this.post<{ coinsAfter: number }>('/internal/ads/credit', args);
  }

  victoryCredit(args: { accountId: string; amount: number; dayKey: string }) {
    return this.post<{ coinsAfter: number; credited: number; capped: boolean }>(
      '/internal/victory/credit',
      args,
    );
  }

  promoRedeem(args: { accountId: string; code: string }) {
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
    const res = await fetch(`${this.baseUrl}/internal/promo/codes`, { headers: this.headers() });
    const b = (await res.json()) as Body<{ codes: PromoCodeView[] }>;
    return b.ok ? b.codes : [];
  }

  paddleComplete(args: { accountId: string; transactionId: string; coins: number }) {
    return this.post<{ coinsAfter: number; coinsGranted: number }>(
      '/internal/paddle/complete',
      args,
    );
  }
}
