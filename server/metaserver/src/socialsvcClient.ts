// metaserver → socialsvc internal client (P2).
// Used for: friend / private-chat / mail route proxying (pass-through JWT) + mail claim (internal atomic claim)
// + system mail write (socialsvc is the sole mail authority since P2 — GET /mail reads socialsvc's `mails`
// collection, so system mail must be written there too, not into meta's own long-dead `mail` collection).
import { internalHeaders } from '@nw/shared';
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
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization,
        },
        ...(body !== null && method !== 'GET' && method !== 'DELETE' ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    } catch {
      return { status: 503, data: { ok: false, error: 'socialsvc unavailable' } };
    }
  }

  async claimMail(mailId: string, accountId: string, orderId: string): Promise<{ doc: MailDoc } | { error: 'NOT_FOUND' | 'NO_ATTACHMENT' | 'ALREADY_CLAIMED' }> {
    try {
      const res = await fetch(`${this.baseUrl}/internal/mail/${encodeURIComponent(mailId)}/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('meta', this.internalKey) },
        body: JSON.stringify({ accountId, orderId }),
      });
      const data = await res.json() as { ok?: boolean; data?: { doc: MailDoc }; error?: string };
      if (!res.ok || !data.ok) {
        const e = data.error as string;
        if (e === 'NOT_FOUND' || e === 'NO_ATTACHMENT' || e === 'ALREADY_CLAIMED') return { error: e };
        return { error: 'NOT_FOUND' };
      }
      return { doc: data.data!.doc };
    } catch {
      return { error: 'NOT_FOUND' };
    }
  }

  async insertSystemMail(
    dispatchKey: string,
    to: string,
    content: SystemMailContent,
  ): Promise<{ mailId: string; inserted: boolean; hasAttachment: boolean }> {
    const res = await fetch(`${this.baseUrl}/internal/mail/system`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('meta', this.internalKey) },
      body: JSON.stringify({ dispatchKey, to, content }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: { mailId: string; inserted: boolean; hasAttachment: boolean }; error?: string };
    if (!res.ok || !data.ok || !data.data) {
      throw new Error(`socialsvc insertSystemMail failed: ${res.status} ${data.error ?? ''}`.trim());
    }
    return data.data;
  }

  async bulkInsertSystemMail(
    dispatchKey: string,
    accountIds: string[],
    content: SystemMailContent,
  ): Promise<{ insertedAccountIds: string[]; hasAttachment: boolean }> {
    const res = await fetch(`${this.baseUrl}/internal/mail/system/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...internalHeaders('meta', this.internalKey) },
      body: JSON.stringify({ dispatchKey, accountIds, content }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; data?: { insertedAccountIds: string[]; hasAttachment: boolean }; error?: string };
    if (!res.ok || !data.ok || !data.data) {
      throw new Error(`socialsvc bulkInsertSystemMail failed: ${res.status} ${data.error ?? ''}`.trim());
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
