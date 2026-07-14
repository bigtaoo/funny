// Payment-tier simulation (BOTSVC_DESIGN §5, B6): calls commercial's EXISTING internal endpoints
// (the same ones meta uses after a real IAP verify) — botsvc adds no payment code of its own, just
// drives the internal-only path with a bot-generated idempotency key.
import { internalHeaders, PRODUCT_STARTER_GROWTH } from '@nw/shared';

export class CommercialClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalKey: string,
  ) {}

  private async post(path: string, body: Record<string, unknown>): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...internalHeaders('botsvc', this.internalKey),
      },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { ok: boolean };
  }

  /** Idempotent: repeated calls with the same orderId are a no-op on commercial's side. */
  async buyMonthlyCard(accountId: string, orderId: string): Promise<{ ok: boolean }> {
    return this.post('/internal/monthly-card/buy', { accountId, orderId });
  }

  async buyStarterGrowth(accountId: string, orderId: string): Promise<{ ok: boolean }> {
    return this.post('/internal/starter/buy', {
      accountId,
      productId: PRODUCT_STARTER_GROWTH,
      orderId,
    });
  }
}
