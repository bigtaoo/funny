// metaserver → every other data-owning service, for the C5-b account purge (accountPurge.ts).
// Each service exposes the same idempotent `POST /internal/accounts/:accountId/purge` (X-Internal-Key) and
// answers `ok({ done, removed, ... })`; `done:false` means "nothing failed, but I can't finish yet" (today
// only auctionsvc, while a counterparty's settlement is still in flight). One client for all five keeps the
// wire handling in one place — the per-service clients (commercialClient/socialsvcClient) are typed around
// their domain calls and would each grow an identical method.
import { fetchInternalJson } from '@nw/shared';
import type { AccountPurgeStep } from '@nw/shared';

/** The purge steps that live in another service (`meta` is local). */
export type RemotePurgeStep = Exclude<AccountPurgeStep, 'meta'>;

export type PurgeCallResult =
  | { ok: true; done: boolean; data: Record<string, unknown> }
  | { ok: false; error: string };

export interface AccountPurgeClient {
  purge(step: RemotePurgeStep, accountId: string, body: Record<string, unknown>): Promise<PurgeCallResult>;
}

interface Envelope {
  ok?: boolean;
  data?: { done?: unknown } & Record<string, unknown>;
  error?: { code?: string; message?: string } | string;
}

export class HttpAccountPurgeClient implements AccountPurgeClient {
  constructor(
    private readonly urls: Record<RemotePurgeStep, string | null>,
    private readonly internalKey: string,
  ) {}

  async purge(step: RemotePurgeStep, accountId: string, body: Record<string, unknown>): Promise<PurgeCallResult> {
    const base = this.urls[step];
    // Fail closed: a deployment that never wired the URL must not report the account as erased.
    if (!base) return { ok: false, error: `${step}: internal URL not configured` };
    const r = await fetchInternalJson<Envelope>(`${base}/internal/accounts/${encodeURIComponent(accountId)}/purge`, {
      caller: 'meta',
      key: this.internalKey,
      method: 'POST',
      body,
      // A purge can touch a few thousand documents (chat history, tiles) — well above the 5s default.
      timeoutMs: 30_000,
      // Safe: every purge endpoint is idempotent by contract.
      retries: 1,
      label: `/internal/accounts/:id/purge (${step})`,
    });
    const env = r.body;
    if (!r.ok || !env?.ok || !env.data || typeof env.data.done !== 'boolean') {
      const e = env?.error;
      const detail = typeof e === 'string' ? e : e?.code ? `${e.code}${e.message ? `: ${e.message}` : ''}` : (r.error ?? '');
      return { ok: false, error: `${step}: ${r.status} ${detail}`.trim() };
    }
    return { ok: true, done: env.data.done, data: env.data };
  }
}
