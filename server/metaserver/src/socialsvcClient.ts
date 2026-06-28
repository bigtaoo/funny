// metaserver → socialsvc 内部客户端（P2）。
// 用于：好友/私聊/邮件路由代理（透传 JWT） + 邮件领取（内部 atomic claim）。
import { internalHeaders } from '@nw/shared';
import type { MailDoc } from '@nw/shared';

export interface MetaSocialsvcClient {
  readonly available: boolean;
  /** 透传玩家 JWT，代理到 socialsvc /social/* 端点。返回 status + JSON body。 */
  proxy(method: string, path: string, body: unknown, authorization: string): Promise<{ status: number; data: unknown }>;
  /** 邮件原子标记领取（socialsvc /internal/mail/:id/claim）。返回 mail doc 或错误。 */
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
