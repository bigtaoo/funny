// worldsvc → commercial 内部调用（S8-5）：拍卖场买方扣金币 / 卖方收金币。
// commercial 内部 HTTP（/internal/spend · /internal/grant）与 meta 同形，X-Internal-Key 鉴权。
// 未配置 NW_COMMERCIAL_INTERNAL_URL → available=false → 拍卖金币交易不可用（降级提示玩家）。

export interface WorldCommercialClient {
  readonly available: boolean;
  /** 买方扣金币（购买拍卖品）。insufficient → 抛含 INSUFFICIENT_FUNDS 的 Error。 */
  spend(accountId: string, amount: number, orderId: string): Promise<void>;
  /** 卖方收金币（售出拍卖品，已扣税）。best-effort，失败 log 但不回滚买方已成交。 */
  grant(accountId: string, amount: number, orderId: string): Promise<void>;
}

export class HttpWorldCommercialClient implements WorldCommercialClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async spend(accountId: string, amount: number, orderId: string): Promise<void> {
    if (!this.baseUrl) throw new Error('commercial service not configured');
    const res = await fetch(`${this.baseUrl}/internal/spend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Internal-Key': this.internalKey },
      body: JSON.stringify({ accountId, amount, orderId }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `spend failed: ${res.status}`);
    }
  }

  async grant(accountId: string, amount: number, orderId: string): Promise<void> {
    if (!this.baseUrl) return; // no-op when not configured
    try {
      await fetch(`${this.baseUrl}/internal/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Internal-Key': this.internalKey },
        body: JSON.stringify({ accountId, amount, orderId }),
      });
    } catch (e) {
      console.error('[worldsvc] commercial.grant failed', { accountId, amount, orderId, err: (e as Error).message });
    }
  }
}

export const nullWorldCommercialClient: WorldCommercialClient = {
  available: false,
  async spend() { throw new Error('commercial service not configured'); },
  async grant() { /* no-op */ },
};
