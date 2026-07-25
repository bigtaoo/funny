// auctionsvc → commercial internal calls (auction task 4): buyer coin deduction only.
// commercial internal HTTP (/internal/spend), X-Internal-Key auth.
// Seller proceeds and escrow refunds go through system mail (see mailClient.ts), not direct grant — only
// real-money recharge credits the wallet directly.
// NW_COMMERCIAL_INTERNAL_URL not configured → available=false → coin trading unavailable (graceful degradation notice to player).
// Migrated verbatim from server/worldsvc/src/commercialClient.ts (caller name updated to 'auctionsvc').

import { internalHeaders } from '@nw/shared';

export interface AuctionCommercialClient {
  readonly available: boolean;
  /** Deduct coins from buyer (purchasing an auction item). Insufficient funds → throws an Error containing INSUFFICIENT_FUNDS. */
  spend(accountId: string, amount: number, orderId: string): Promise<void>;
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
    // commercial's /internal/spend always answers HTTP 200; business failures (e.g. INSUFFICIENT_FUNDS)
    // are carried in the JSON body as {ok:false, error}, not the HTTP status — res.ok alone can't detect them.
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `spend failed: ${res.status}`);
    }
    const body = (await res.json()) as { ok: boolean; error?: string };
    if (!body.ok) throw new Error(body.error ?? 'spend failed');
  }
}

export const nullAuctionCommercialClient: AuctionCommercialClient = {
  available: false,
  async spend() { throw new Error('commercial service not configured'); },
};
