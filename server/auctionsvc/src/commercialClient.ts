// auctionsvc → commercial internal calls (auction task 4): buyer deducts coins / seller receives coins.
// commercial internal HTTP (/internal/spend · /internal/grant), X-Internal-Key auth.
// NW_COMMERCIAL_INTERNAL_URL not configured → available=false → coin trading unavailable (graceful degradation notice to player).
// Migrated verbatim from server/worldsvc/src/commercialClient.ts (caller name updated to 'auctionsvc').

import { internalHeaders } from '@nw/shared';

export interface AuctionCommercialClient {
  readonly available: boolean;
  /** Deduct coins from buyer (purchasing an auction item). Insufficient funds → throws an Error containing INSUFFICIENT_FUNDS. */
  spend(accountId: string, amount: number, orderId: string): Promise<void>;
  /** Credit coins to seller (auction item sold, post-tax). Best-effort; logs failure but does not roll back a completed buyer transaction. */
  grant(accountId: string, amount: number, orderId: string): Promise<void>;
}

export class HttpAuctionCommercialClient implements AuctionCommercialClient {
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
      headers: { 'content-type': 'application/json', ...internalHeaders('auctionsvc', this.internalKey) },
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
        headers: { 'content-type': 'application/json', ...internalHeaders('auctionsvc', this.internalKey) },
        body: JSON.stringify({ accountId, amount, orderId }),
      });
    } catch (e) {
      console.error('[auctionsvc] commercial.grant failed', { accountId, amount, orderId, err: (e as Error).message });
    }
  }
}

export const nullAuctionCommercialClient: AuctionCommercialClient = {
  available: false,
  async spend() { throw new Error('commercial service not configured'); },
  async grant() { /* no-op */ },
};
