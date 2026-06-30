// worldsvc → commercial internal calls (S8-5): auction buyer deducts coins / seller receives coins.
// commercial internal HTTP (/internal/spend · /internal/grant) mirrors meta shape, X-Internal-Key auth.
// NW_COMMERCIAL_INTERNAL_URL not configured → available=false → auction coin transactions unavailable (graceful degradation notice to player).

import { internalHeaders } from '@nw/shared';

export interface WorldCommercialClient {
  readonly available: boolean;
  /** Deduct coins from buyer (purchasing an auction item). Insufficient funds → throws an Error containing INSUFFICIENT_FUNDS. */
  spend(accountId: string, amount: number, orderId: string): Promise<void>;
  /** Credit coins to seller (auction item sold, post-tax). Best-effort; logs failure but does not roll back a completed buyer transaction. */
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
      headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
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
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
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
