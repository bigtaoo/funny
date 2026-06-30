// metaserver → socialsvc internal client (P2).
// Used for: friend / private-chat / mail route proxying (pass-through JWT) + mail claim (internal atomic claim).
import { internalHeaders } from '@nw/shared';
import type { MailDoc } from '@nw/shared';

export interface MetaSocialsvcClient {
  readonly available: boolean;
  /** Pass through the player JWT and proxy to the socialsvc /social/* endpoint. Returns status + JSON body. */
  proxy(method: string, path: string, body: unknown, authorization: string): Promise<{ status: number; data: unknown }>;
  /** Atomic mail claim (socialsvc /internal/mail/:id/claim). Returns the mail doc or an error. */
  claimMail(mailId: string, accountId: string, orderId: string): Promise<{ doc: MailDoc } | { error: 'NOT_FOUND' | 'NO_ATTACHMENT' | 'ALREADY_CLAIMED' }>;
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
}

export const nullMetaSocialsvcClient: MetaSocialsvcClient = {
  available: false,
  async proxy() { return { status: 503, data: { ok: false, error: 'socialsvc unavailable' } }; },
  async claimMail() { return { error: 'NOT_FOUND' }; },
};
