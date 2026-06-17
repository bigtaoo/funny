// worldsvc → meta 内部调用（S8-5）：拍卖场材料扣除 / 发放。
// meta 内部 HTTP（/internal/materials/deduct · /internal/materials/grant），X-Internal-Key 鉴权。
// 未配置 NW_META_INTERNAL_URL → available=false → 拍卖材料交易不可用。

export interface WorldMetaClient {
  readonly available: boolean;
  /** 扣除材料（挂拍卖 / 取消返还的逆操作）。insufficient → 抛含 INSUFFICIENT_RESOURCES 的 Error。 */
  deductMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void>;
  /** 发放材料（拍卖成交给买家 / 取消/过期返还给卖家）。best-effort，失败 log 不回滚。 */
  grantMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void>;
}

export class HttpWorldMetaClient implements WorldMetaClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async deductMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void> {
    if (!this.baseUrl) throw new Error('meta service not configured');
    const res = await fetch(`${this.baseUrl}/internal/materials/deduct`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Internal-Key': this.internalKey },
      body: JSON.stringify({ accountId, material, qty, orderId }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `deductMaterial failed: ${res.status}`);
    }
  }

  async grantMaterial(accountId: string, material: string, qty: number, orderId: string): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/internal/materials/grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Internal-Key': this.internalKey },
        body: JSON.stringify({ accountId, material, qty, orderId }),
      });
    } catch (e) {
      console.error('[worldsvc] meta.grantMaterial failed', { accountId, material, qty, orderId, err: (e as Error).message });
    }
  }
}

export const nullWorldMetaClient: WorldMetaClient = {
  available: false,
  async deductMaterial() { throw new Error('meta service not configured'); },
  async grantMaterial() { /* no-op */ },
};
