// worldsvc → meta system mail (§17.5, C1): season settlement reward dispatch goes through meta `/internal/mail/system/send`.
// Reuses the OPS compensation system mail infrastructure (dispatchKey idempotency + three attachment types: coins/skin/item).
// Direct delivery by accountId (meta single-send branch skips publicId resolution when accountId is provided, see internal.ts §17.5).
// NW_META_INTERNAL_URL not configured → available=false → settlement does not send rewards (best-effort; does not block settlement).

import { internalHeaders, type EquipmentInstance, type CardInstance } from '@nw/shared';

export interface WorldMailAttachment {
  // 'material' → SaveData.materials unified progression pool (SLG8 season rewards); 'item' → inventory.items general bucket.
  // 'equipment'/'card' → auction escrow-out delivery/return: carries the full instance snapshot, written back to
  //   equipmentInv/cardInv by instance.id when the recipient claims the mail (AUCTION_DESIGN escrow-out model).
  kind: 'coins' | 'skin' | 'item' | 'material' | 'equipment' | 'card';
  id?: string;
  count?: number;
  instance?: EquipmentInstance | CardInstance;
}

export interface WorldMailContent {
  subject: string;
  body: string;
  attachments?: WorldMailAttachment[];
  expireDays?: number;
}

export interface WorldMailClient {
  readonly available: boolean;
  /** System mail (dispatchKey idempotency, attachments: coins/skin/item). Best-effort; failures are logged and do not block settlement. */
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
