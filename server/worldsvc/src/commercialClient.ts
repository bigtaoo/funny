// worldsvc → commercial internal calls: SLG coin sinks (building speedup / sect creation / world chat / card recovery / relocation) deduct or refund coins.
// commercial internal HTTP (/internal/spend · /internal/grant) mirrors meta shape, X-Internal-Key auth.
// NW_COMMERCIAL_INTERNAL_URL not configured → available=false → coin transactions unavailable (graceful degradation notice to player).

import { fetchInternalJson, SlgError, ErrorCode } from '@nw/shared';

/**
 * commercial's /internal/spend answers HTTP 200 with `{ok:false, error}` for business failures, where
 * `error` IS the real ErrorCode string (see commercial/src/service/shop.ts `spend()`: returns
 * `{ok:false, error:'INSUFFICIENT_FUNDS'}` / `{ok:false, error:'BAD_REQUEST'}`). Surface known codes as
 * SlgError so httpApi.ts's `instanceof SlgError` catch maps them to the right HTTP status/code instead
 * of falling through to a generic 500 (comm-audit finding, [[business-errors-surface-as-500-2026-08-02]]
 * — a player with insufficient coins used to see "internal server error" instead of "not enough coins").
 * Unrecognized values fall back to a plain Error, preserving the existing generic-500 behavior for
 * genuinely unexpected failures.
 */
function toSpendError(code: string | undefined, fallbackMsg: string): Error {
  if (code && code in ErrorCode) return new SlgError(code as keyof typeof ErrorCode, code);
  return new Error(code ?? fallbackMsg);
}

export interface WorldCommercialClient {
  readonly available: boolean;
  /**
   * Deduct coins from an account. Insufficient funds → throws a SlgError(INSUFFICIENT_FUNDS).
   * `clientPlatform` (ADR-020, X-NW-Platform) picks which recharged bucket (apple/google/web) to spend
   * from; absent → commercial defaults to 'web' (comm-audit-internal-2026-07-28 P0-7: this used to be
   * unconditional — iOS/Android SLG purchases silently drew from the web bucket).
   */
  spend(accountId: string, amount: number, orderId: string, clientPlatform?: string): Promise<void>;
  /** Credit coins to an account (e.g. refund). Best-effort; logs failure but does not roll back a completed spend. */
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

  async spend(accountId: string, amount: number, orderId: string, clientPlatform?: string): Promise<void> {
    if (!this.baseUrl) throw new Error('commercial service not configured');
    const res = await fetchInternalJson<{ ok: boolean; error?: string }>(`${this.baseUrl}/internal/spend`, {
      caller: 'worldsvc',
      key: this.internalKey,
      method: 'POST',
      body: { accountId, amount, orderId, ...(clientPlatform ? { clientPlatform } : {}) },
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

  async grant(accountId: string, amount: number, orderId: string): Promise<void> {
    if (!this.baseUrl) return; // no-op when not configured
    const res = await fetchInternalJson(`${this.baseUrl}/internal/grant`, {
      caller: 'worldsvc',
      key: this.internalKey,
      method: 'POST',
      body: { accountId, amount, orderId },
      timeoutMs: 5000,
      label: '/internal/grant',
    });
    if (!res.ok) {
      // Best-effort (does not roll back a completed spend), but the loss must be visible.
      console.error('[worldsvc] commercial.grant failed', { accountId, amount, orderId, status: res.status, err: res.error });
    }
  }
}

export const nullWorldCommercialClient: WorldCommercialClient = {
  available: false,
  async spend() { throw new Error('commercial service not configured'); },
  async grant() { /* no-op */ },
};
