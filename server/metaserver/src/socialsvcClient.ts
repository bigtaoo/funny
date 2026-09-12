// metaserver → socialsvc internal client (P2).
// Used for: friend / private-chat / mail route proxying (pass-through JWT) + mail claim (internal atomic claim)
// + system mail write (socialsvc is the sole mail authority since P2 — GET /mail reads socialsvc's `mails`
// collection, so system mail must be written there too, not into meta's own long-dead `mail` collection).
import { fetchInternalJson } from '@nw/shared';
import type { MailDoc, MailAttachmentDoc } from '@nw/shared';

/**
 * Shape of every socialsvc JSON reply: `ok(data)` / `err(code, message)` from @nw/shared — note that
 * `error` is an object, not a string. Typing these replies as `{ error?: string }` is what let the
 * mail-claim code below silently mis-read every rejection for months; keep the envelope honest.
 */
interface InternalEnvelope<T> {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

/** The `code` of an err() envelope, or '' when the reply carried no recognizable error object. */
function errorCode(body: InternalEnvelope<unknown> | null): string {
  return body?.error?.code ?? '';
}

/** Human-readable one-liner for a failed internal call (code + message, or the transport error). */
function errorText(body: InternalEnvelope<unknown> | null, transportErr?: string): string {
  const e = body?.error;
  if (e?.code) return e.message ? `${e.code}: ${e.message}` : e.code;
  return transportErr ?? '';
}

export interface SystemMailContent {
  subject: string;
  body: string;
  attachments?: MailAttachmentDoc[];
  expireDays: number;
}

export interface MetaSocialsvcClient {
  readonly available: boolean;
  /** Pass through the player JWT and proxy to the socialsvc /social/* endpoint. Returns status + JSON body. */
  proxy(method: string, path: string, body: unknown, authorization: string): Promise<{ status: number; data: unknown }>;
  /**
   * Atomic mail claim (socialsvc /internal/mail/:id/claim). Returns the mail doc or an error.
   * `SOCIAL_UNAVAILABLE` (comm-audit-internal-2026-07-28 P0-4) is distinct from `NOT_FOUND` — it
   * means the request never got a definite answer from socialsvc (timeout/network/unexpected
   * payload), so the caller must NOT tell the player "mail not found" (the mail may in fact exist
   * and even be claimed already); it should surface as a retryable 503 instead.
   */
  claimMail(
    mailId: string,
    accountId: string,
    orderId: string,
  ): Promise<{ doc: MailDoc } | { error: 'NOT_FOUND' | 'NO_ATTACHMENT' | 'ALREADY_CLAIMED' | 'SOCIAL_UNAVAILABLE' }>;
  /** Roll back a claim this orderId made, after post-claim delivery failed (best-effort; see mailService.unclaimMailAtomic). */
  unclaimMail(mailId: string, accountId: string, orderId: string): Promise<void>;
  /** Write a single system mail (socialsvc /internal/mail/system, idempotent upsert). Throws if socialsvc is unreachable/unconfigured. */
  insertSystemMail(
    dispatchKey: string,
    to: string,
    content: SystemMailContent,
  ): Promise<{ mailId: string; inserted: boolean; hasAttachment: boolean }>;
  /** Bulk system mail fan-out (socialsvc /internal/mail/system/bulk). socialsvc pushes mail_new itself for newly inserted recipients. Throws if unreachable/unconfigured. */
  bulkInsertSystemMail(
    dispatchKey: string,
    accountIds: string[],
    content: SystemMailContent,
  ): Promise<{ insertedAccountIds: string[]; hasAttachment: boolean }>;
}

export class HttpMetaSocialsvcClient implements MetaSocialsvcClient {
  constructor(
    private readonly baseUrl: string,
    private readonly internalKey: string,
  ) {}

  get available(): boolean { return true; }

  async proxy(method: string, path: string, body: unknown, authorization: string): Promise<{ status: number; data: unknown }> {
    // Passes the player JWT through (not X-Internal-Key), so it can't go via fetchInternalJson —
    // bare fetch with an explicit timeout instead (undici fetch has no default timeout).
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization,
        },
        ...(body !== null && method !== 'GET' && method !== 'DELETE' ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(5000),
      });
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        // Drain a non-JSON body so the socket goes back to the pool (see shared/internalFetch.ts header).
        try {
          await res.body?.cancel();
        } catch {
          /* already consumed / closed */
        }
        data = {};
      }
      return { status: res.status, data };
    } catch {
      return { status: 503, data: { ok: false, error: 'socialsvc unavailable' } };
    }
  }

  async claimMail(
    mailId: string,
    accountId: string,
    orderId: string,
  ): Promise<{ doc: MailDoc } | { error: 'NOT_FOUND' | 'NO_ATTACHMENT' | 'ALREADY_CLAIMED' | 'SOCIAL_UNAVAILABLE' }> {
    const r = await fetchInternalJson<InternalEnvelope<{ doc: MailDoc }>>(
      `${this.baseUrl}/internal/mail/${encodeURIComponent(mailId)}/claim`,
      { caller: 'meta', key: this.internalKey, method: 'POST', body: { accountId, orderId }, timeoutMs: 5000, label: '/internal/mail/:id/claim' },
    );
    const data = r.body;
    if (!r.ok || !data?.ok) {
      // `error` is shared's err() envelope — an OBJECT { code, message }, not a bare string
      // (2026-09-12 fix: this used to compare the object itself against the code literals, so it
      // never matched and EVERY socialsvc rejection — including the routine ALREADY_CLAIMED of a
      // double-submitted claim — fell through to SOCIAL_UNAVAILABLE and surfaced to the player as a
      // retryable 503 for a claim that can never succeed. The declared `error?: string` type made
      // the mismatch invisible to tsc).
      const e = errorCode(data);
      if (e === 'NOT_FOUND' || e === 'NO_ATTACHMENT' || e === 'ALREADY_CLAIMED') return { error: e };
      // Network error / timeout / unexpected payload → the mail's actual claim state is unknown
      // (P0-4: it used to be mapped to NOT_FOUND, telling the player a mail that may well exist
      // — and may even now be claimed — "doesn't exist"). Surface as retryable instead.
      return { error: 'SOCIAL_UNAVAILABLE' };
    }
    return { doc: data.data!.doc };
  }

  async unclaimMail(mailId: string, accountId: string, orderId: string): Promise<void> {
    // Best-effort: if this also fails, the mail is stuck claimed-but-undelivered — logged so ops
    // can manually compensate (comp-ticket flow), same posture as other best-effort mirror writes.
    const r = await fetchInternalJson(`${this.baseUrl}/internal/mail/${encodeURIComponent(mailId)}/unclaim`, {
      caller: 'meta',
      key: this.internalKey,
      method: 'POST',
      body: { accountId, orderId },
      timeoutMs: 5000,
      label: '/internal/mail/:id/unclaim',
    });
    if (!r.ok) {
      console.error('[meta] unclaimMail failed — mail may be stuck claimed-but-undelivered', { mailId, accountId, orderId, status: r.status });
    }
  }

  async insertSystemMail(
    dispatchKey: string,
    to: string,
    content: SystemMailContent,
  ): Promise<{ mailId: string; inserted: boolean; hasAttachment: boolean }> {
    const r = await fetchInternalJson<InternalEnvelope<{ mailId: string; inserted: boolean; hasAttachment: boolean }>>(
      `${this.baseUrl}/internal/mail/system`,
      { caller: 'meta', key: this.internalKey, method: 'POST', body: { dispatchKey, to, content }, timeoutMs: 5000, label: '/internal/mail/system' },
    );
    const data = r.body;
    if (!r.ok || !data?.ok || !data.data) {
      throw new Error(`socialsvc insertSystemMail failed: ${r.status} ${errorText(data, r.error)}`.trim());
    }
    return data.data;
  }

  async bulkInsertSystemMail(
    dispatchKey: string,
    accountIds: string[],
    content: SystemMailContent,
  ): Promise<{ insertedAccountIds: string[]; hasAttachment: boolean }> {
    // retries: 1 is safe — the write is idempotent (socialsvc dedups by dispatchKey).
    const r = await fetchInternalJson<InternalEnvelope<{ insertedAccountIds: string[]; hasAttachment: boolean }>>(
      `${this.baseUrl}/internal/mail/system/bulk`,
      { caller: 'meta', key: this.internalKey, method: 'POST', body: { dispatchKey, accountIds, content }, timeoutMs: 5000, retries: 1, label: '/internal/mail/system/bulk' },
    );
    const data = r.body;
    if (!r.ok || !data?.ok || !data.data) {
      throw new Error(`socialsvc bulkInsertSystemMail failed: ${r.status} ${errorText(data, r.error)}`.trim());
    }
    return data.data;
  }
}

export const nullMetaSocialsvcClient: MetaSocialsvcClient = {
  available: false,
  async proxy() { return { status: 503, data: { ok: false, error: 'socialsvc unavailable' } }; },
  async claimMail() { return { error: 'SOCIAL_UNAVAILABLE' as const }; },
  async unclaimMail() { /* nothing was ever claimed via a client that was never available */ },
  async insertSystemMail() { throw new Error('socialsvc not configured'); },
  async bulkInsertSystemMail() { throw new Error('socialsvc not configured'); },
};
