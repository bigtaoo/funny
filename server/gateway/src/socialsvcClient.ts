// gateway → socialsvc internal client (P3, SOCIAL_SVC_DESIGN §6 P3).
// Notifies socialsvc on gateway connect/disconnect for friend online/offline fan-out (presence push chain).
// socialsvc not configured → no-op; gateway falls back to broadcasting via meta (compatible degradation).
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
