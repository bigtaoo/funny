// gateway → socialsvc 内部客户端（P3，SOCIAL_SVC_DESIGN §6 P3）。
// gateway 连接/断连时通知 socialsvc 做好友在线/下线扇出（presence 推送链）。
// socialsvc 未配置 → no-op，gateway 退回直接用 meta 广播（兼容降级）。
import { internalHeaders } from '@nw/shared';

export class SocialsvcClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async notifyOnline(accountId: string): Promise<void> {
    await this.notify('online', accountId);
  }

  async notifyOffline(accountId: string): Promise<void> {
    await this.notify('offline', accountId);
  }

  private async notify(event: 'online' | 'offline', accountId: string): Promise<void> {
    if (!this.baseUrl) return;
    try {
      await fetch(`${this.baseUrl}/internal/presence/${event}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('gateway', this.internalKey) },
        body: JSON.stringify({ accountId }),
      });
    } catch {
      // best-effort
    }
  }
}
