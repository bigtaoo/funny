// worldsvc → commercial internal calls: SLG coin sinks (building speedup / sect creation / world chat / card recovery / relocation) deduct or refund coins.
// commercial internal HTTP (/internal/spend · /internal/grant) mirrors meta shape, X-Internal-Key auth.
// NW_COMMERCIAL_INTERNAL_URL not configured → available=false → coin transactions unavailable (graceful degradation notice to player).

import { fetchInternalJson } from '@nw/shared';

export interface WorldCommercialClient {
  readonly available: boolean;
  /** Deduct coins from an account. Insufficient funds → throws an Error containing INSUFFICIENT_FUNDS. */
  spend(accountId: string, amount: number, orderId: string): Promise<void>;
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

  async spend(accountId: string, amount: number, orderId: string): Promise<void> {
    if (!this.baseUrl) throw new Error('commercial service not configured');
    const res = await fetchInternalJson<{ ok: boolean; error?: string }>(`${this.baseUrl}/internal/spend`, {
      caller: 'worldsvc',
      key: this.internalKey,
      method: 'POST',
      body: { accountId, amount, orderId },
      timeoutMs: 5000,
      label: '/internal/spend',
    });
    // Money path: a network error / timeout (status 0, body null) must NOT silently pass — throw.
    if (res.body === null) throw new Error(res.error ?? `spend failed: ${res.status}`);
    // commercial's /internal/spend always answers HTTP 200; business failures (e.g. INSUFFICIENT_FUNDS)
    // are carried in the JSON body as {ok:false, error}, not the HTTP status — res.ok alone can't detect them.
    if (!res.ok) throw new Error(res.body.error ?? `spend failed: ${res.status}`);
    if (!res.body.ok) throw new Error(res.body.error ?? 'spend failed');
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
