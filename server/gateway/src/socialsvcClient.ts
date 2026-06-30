// gateway → socialsvc internal client (P3, SOCIAL_SVC_DESIGN §6 P3).
// Notifies socialsvc on gateway connect/disconnect for friend online/offline fan-out (presence push chain).
// socialsvc not configured → no-op; gateway falls back to broadcasting via meta (compatible degradation).
import { postInternal } from '@nw/shared';

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
    // Fires on every (dis)connect — a 20-client login burst hits this 20× at once,
    // exactly the unconsumed-body pool-wedge scenario. Self-healing (presence re-derives)
    // → retries=0; the fix is body-drain + timeout.
    await postInternal(`${this.baseUrl}/internal/presence/${event}`, { accountId }, {
      caller: 'gateway',
      key: this.internalKey,
      label: `/internal/presence/${event}`,
    });
  }
}
