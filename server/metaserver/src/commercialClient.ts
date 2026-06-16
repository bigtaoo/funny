// commercial 内部客户端（S5-5）：meta 经内部 HTTP（X-Internal-Key）调 commercial 完成
// 扣币/随机/记账。契约见 SERVER_API.md §9 / COMMERCIAL_DESIGN §5。meta 是 commercial 唯一调用方。
import type { Rarity } from '@nw/shared';

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

/** meta 侧 commercial 客户端接口（便于单测注入假实现）。 */
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
  /** 纯金币发放（邮件附件领取 S6-3），orderId 幂等。amount=0 仅占幂等订单不加币。 */
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
}

/** 真实 HTTP 实现。baseUrl 为 null（未配 commercial）→ available=false，经济端点回 503。 */
export class HttpCommercialClient implements CommercialClient {
  readonly available: boolean;
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {
    this.available = !!baseUrl;
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'X-Internal-Key': this.internalKey };
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
}
