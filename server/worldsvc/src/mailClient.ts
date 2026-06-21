// worldsvc → meta 系统邮件（§17.5，C1）：赛季结算发奖走 meta `/internal/mail/system/send`。
// 复用 OPS 补偿用的系统邮件基建（dispatchKey 幂等 + coins/skin/item 三类附件）。
// 内部直投 accountId（meta 单发分支按 accountId 跳过 publicId 解析，见 internal.ts §17.5）。
// 未配置 NW_META_INTERNAL_URL → available=false → 结算不发奖（best-effort，不阻断结算）。

import { internalHeaders } from '@nw/shared';

export interface WorldMailAttachment {
  // 'material' → SaveData.materials 养成统一池（SLG8 赛季奖励）；'item' → inventory.items 泛用桶。
  kind: 'coins' | 'skin' | 'item' | 'material';
  id?: string;
  count?: number;
}

export interface WorldMailContent {
  subject: string;
  body: string;
  attachments?: WorldMailAttachment[];
  expireDays?: number;
}

export interface WorldMailClient {
  readonly available: boolean;
  /** 系统邮件（dispatchKey 幂等，附件 coins/skin/item）。best-effort，失败 log 不阻断结算。 */
  sendSystemMail(accountId: string, dispatchKey: string, content: WorldMailContent): Promise<void>;
}

export class HttpWorldMailClient implements WorldMailClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async sendSystemMail(accountId: string, dispatchKey: string, content: WorldMailContent): Promise<void> {
    if (!this.baseUrl) return;
    try {
      const res = await fetch(`${this.baseUrl}/internal/mail/system/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('worldsvc', this.internalKey) },
        body: JSON.stringify({
          dispatchKey,
          accountId,
          subject: content.subject,
          body: content.body,
          attachments: content.attachments ?? [],
          expireDays: content.expireDays ?? 0,
        }),
      });
      if (!res.ok) {
        console.error('[worldsvc] mail.sendSystemMail non-ok', { accountId, dispatchKey, status: res.status });
      }
    } catch (e) {
      console.error('[worldsvc] mail.sendSystemMail failed', { accountId, dispatchKey, err: (e as Error).message });
    }
  }
}

export const nullWorldMailClient: WorldMailClient = {
  available: false,
  async sendSystemMail() { /* no-op */ },
};
