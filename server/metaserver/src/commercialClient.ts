// commercial internal client (S5-5): meta calls commercial via internal HTTP (X-Internal-Key) to
// handle coin deduction / gacha draws / bookkeeping. Contract: SERVER_API.md §9 / COMMERCIAL_DESIGN §5. meta is the sole caller of commercial.
import { internalHeaders, type Rarity } from '@nw/shared';

export interface GachaResultEntry {
  itemId: string;
  rarity: Rarity;
}

export interface UndeliveredOrder {
  _id: string;
  accountId: string;
  kind: 'shop' | 'gacha';
  result: { itemId?: string; results?: GachaResultEntry[]; poolId?: string };
}

type Body<T> = ({ ok: true } & T) | { ok: false; error: string };

/** meta-side commercial client interface (allows injecting a fake implementation in unit tests). */
export interface CommercialClient {
  readonly available: boolean;
  getWallet(accountId: string): Promise<{ coins: number; pity: Record<string, number> } | null>;
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
    Body<{ orderId: string; coinsAfter: number; pityAfter: number; results: GachaResultEntry[] }>
  >;
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

  async getWallet(
    accountId: string,
  ): Promise<{ coins: number; pity: Record<string, number> } | null> {
    if (!this.baseUrl) return null;
    const res = await fetch(
      `${this.baseUrl}/internal/wallet?accountId=${encodeURIComponent(accountId)}`,
      { headers: this.headers() },
    );
    const b = (await res.json()) as Body<{ coins: number; pity: Record<string, number> }>;
    return b.ok ? { coins: b.coins, pity: b.pity } : null;
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
    }>('/internal/gacha/draw', args);
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
}
