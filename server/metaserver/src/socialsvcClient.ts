// metaserver → socialsvc internal client (P2).
// Used for: friend / private-chat / mail route proxying (pass-through JWT) + mail claim (internal atomic claim)
// + system mail write (socialsvc is the sole mail authority since P2 — GET /mail reads socialsvc's `mails`
// collection, so system mail must be written there too, not into meta's own long-dead `mail` collection).
import { fetchInternalJson } from '@nw/shared';
import type { MailDoc, MailAttachmentDoc } from '@nw/shared';

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
  /** Atomic mail claim (socialsvc /internal/mail/:id/claim). Returns the mail doc or an error. */
  claimMail(mailId: string, accountId: string, orderId: string): Promise<{ doc: MailDoc } | { error: 'NOT_FOUND' | 'NO_ATTACHMENT' | 'ALREADY_CLAIMED' }>;
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

  async claimMail(mailId: string, accountId: string, orderId: string): Promise<{ doc: MailDoc } | { error: 'NOT_FOUND' | 'NO_ATTACHMENT' | 'ALREADY_CLAIMED' }> {
    const r = await fetchInternalJson<{ ok?: boolean; data?: { doc: MailDoc }; error?: string }>(
      `${this.baseUrl}/internal/mail/${encodeURIComponent(mailId)}/claim`,
      { caller: 'meta', key: this.internalKey, method: 'POST', body: { accountId, orderId }, timeoutMs: 5000, label: '/internal/mail/:id/claim' },
    );
    const data = r.body;
    if (!r.ok || !data?.ok) {
      const e = data?.error;
      if (e === 'NOT_FOUND' || e === 'NO_ATTACHMENT' || e === 'ALREADY_CLAIMED') return { error: e };
      // Network error / timeout / unexpected payload → NOT_FOUND, matching the previous catch path.
      return { error: 'NOT_FOUND' };
    }
    return { doc: data.data!.doc };
  }

  async insertSystemMail(
    dispatchKey: string,
    to: string,
    content: SystemMailContent,
  ): Promise<{ mailId: string; inserted: boolean; hasAttachment: boolean }> {
    const r = await fetchInternalJson<{ ok?: boolean; data?: { mailId: string; inserted: boolean; hasAttachment: boolean }; error?: string }>(
      `${this.baseUrl}/internal/mail/system`,
      { caller: 'meta', key: this.internalKey, method: 'POST', body: { dispatchKey, to, content }, timeoutMs: 5000, label: '/internal/mail/system' },
    );
    const data = r.body;
    if (!r.ok || !data?.ok || !data.data) {
      throw new Error(`socialsvc insertSystemMail failed: ${r.status} ${data?.error ?? r.error ?? ''}`.trim());
    }
    return data.data;
  }

  async bulkInsertSystemMail(
    dispatchKey: string,
    accountIds: string[],
    content: SystemMailContent,
  ): Promise<{ insertedAccountIds: string[]; hasAttachment: boolean }> {
    // retries: 1 is safe — the write is idempotent (socialsvc dedups by dispatchKey).
    const r = await fetchInternalJson<{ ok?: boolean; data?: { insertedAccountIds: string[]; hasAttachment: boolean }; error?: string }>(
      `${this.baseUrl}/internal/mail/system/bulk`,
      { caller: 'meta', key: this.internalKey, method: 'POST', body: { dispatchKey, accountIds, content }, timeoutMs: 5000, retries: 1, label: '/internal/mail/system/bulk' },
    );
    const data = r.body;
    if (!r.ok || !data?.ok || !data.data) {
      throw new Error(`socialsvc bulkInsertSystemMail failed: ${r.status} ${data?.error ?? r.error ?? ''}`.trim());
    }
    return data.data;
  }
}

export const nullMetaSocialsvcClient: MetaSocialsvcClient = {
  available: false,
  async proxy() { return { status: 503, data: { ok: false, error: 'socialsvc unavailable' } }; },
  async claimMail() { return { error: 'NOT_FOUND' }; },
  async insertSystemMail() { throw new Error('socialsvc not configured'); },
  async bulkInsertSystemMail() { throw new Error('socialsvc not configured'); },
};
