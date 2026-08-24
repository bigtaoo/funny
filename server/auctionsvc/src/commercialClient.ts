// auctionsvc → commercial internal calls (auction task 4): buyer coin deduction only.
// commercial internal HTTP (/internal/spend), X-Internal-Key auth.
// Seller proceeds and escrow refunds go through system mail (see mailClient.ts), not direct grant — only
// real-money recharge credits the wallet directly.
// NW_COMMERCIAL_INTERNAL_URL not configured → available=false → coin trading unavailable (graceful degradation notice to player).
// Migrated verbatim from server/worldsvc/src/commercialClient.ts (caller name updated to 'auctionsvc').

import { fetchInternalJson, SlgError, ErrorCode } from '@nw/shared';

/**
 * commercial's /internal/spend answers HTTP 200 with `{ok:false, error}` for business failures, where
 * `error` IS the real ErrorCode string (see commercial/src/service/shop.ts `spend()`). Surface known
 * codes as SlgError so httpApi.ts's `instanceof SlgError` catch maps them to the right HTTP status/code
 * instead of falling through to a generic 500 (comm-audit finding,
 * [[business-errors-surface-as-500-2026-08-02]] — a buyer with insufficient coins used to see "internal
 * server error" instead of "not enough coins"). Unrecognized values fall back to a plain Error,
 * preserving the existing generic-500 behavior for genuinely unexpected failures.
 */
function toSpendError(code: string | undefined, fallbackMsg: string): Error {
  if (code && code in ErrorCode) return new SlgError(code as keyof typeof ErrorCode, code);
  return new Error(code ?? fallbackMsg);
}

export interface AuctionCommercialClient {
  readonly available: boolean;
  /**
   * Deduct coins from buyer (purchasing an auction item). Insufficient funds → throws a
   * SlgError(INSUFFICIENT_FUNDS). `clientPlatform` (ADR-020) picks the recharged bucket to spend
   * from; absent → commercial defaults to 'web' (comm-audit-internal-2026-07-28 P0-7).
   */
  spend(accountId: string, amount: number, orderId: string, clientPlatform?: string): Promise<void>;
}

export class HttpAuctionCommercialClient implements AuctionCommercialClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async spend(accountId: string, amount: number, orderId: string, clientPlatform?: string): Promise<void> {
    if (!this.baseUrl) throw new Error('commercial service not configured');
    const res = await fetchInternalJson<{ ok: boolean; error?: string }>(`${this.baseUrl}/internal/spend`, {
      caller: 'auctionsvc',
      key: this.internalKey,
      method: 'POST',
      // `reason` lands in commercial's ledger row. It used to be omitted entirely, so every auction
      // purchase and every escrowed bid showed up in the coin ledger with an empty reason — invisible to
      // any per-sink breakdown. commercial's /internal/spend reads it as `str(b.reason)`.
      body: { accountId, amount, orderId, reason: 'auction', ...(clientPlatform ? { clientPlatform } : {}) },
      timeoutMs: 5000,
      label: '/internal/spend',
    });
    // Money path: a network error / timeout (status 0, body null) must NOT silently pass — throw.
    if (res.body === null) throw new Error(res.error ?? `spend failed: ${res.status}`);
    // commercial's /internal/spend always answers HTTP 200; business failures (e.g. INSUFFICIENT_FUNDS)
    // are carried in the JSON body as {ok:false, error}, not the HTTP status — res.ok alone can't detect them.
    if (!res.ok) throw toSpendError(res.body.error, `spend failed: ${res.status}`);
    if (!res.body.ok) throw toSpendError(res.body.error, 'spend failed');
  }
}

export const nullAuctionCommercialClient: AuctionCommercialClient = {
  available: false,
  async spend() { throw new Error('commercial service not configured'); },
};
