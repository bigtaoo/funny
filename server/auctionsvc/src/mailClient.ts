// auctionsvc → meta system mail (auction task 4): item delivery/return goes through system mail (escrow-out model).
// Reuses the OPS compensation system mail infrastructure (dispatchKey idempotency + attachment types: material/equipment/card/skin).
// Direct delivery by accountId (meta single-send branch skips publicId resolution when accountId is provided).
// NW_META_INTERNAL_URL not configured → available=false → delivery/return does not send mail (best-effort; does not block settlement).
// Migrated from server/worldsvc/src/mailClient.ts (caller name updated to 'auctionsvc').

import { internalHeaders, type EquipmentInstance, type CardInstance } from '@nw/shared';

export interface AuctionMailAttachment {
  // 'material' → SaveData.materials unified progression pool; 'skin' → inventory.skins array.
  // 'equipment'/'card' → auction escrow-out delivery/return: carries the full instance snapshot, written back to
  //   equipmentInv/cardInv by instance.id when the recipient claims the mail (AUCTION_DESIGN escrow-out model).
  kind: 'material' | 'equipment' | 'card' | 'skin';
  id?: string;
  count?: number;
  instance?: EquipmentInstance | CardInstance;
}

export interface AuctionMailContent {
  subject: string;
  body: string;
  attachments?: AuctionMailAttachment[];
  expireDays?: number;
}

export interface AuctionMailClient {
  readonly available: boolean;
  /** System mail (dispatchKey idempotency, attachments: material/equipment/card/skin). Best-effort; failures are logged and do not block settlement. */
  sendSystemMail(accountId: string, dispatchKey: string, content: AuctionMailContent): Promise<void>;
}

export class HttpAuctionMailClient implements AuctionMailClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly internalKey: string,
  ) {}

  get available(): boolean {
    return this.baseUrl !== null;
  }

  async sendSystemMail(accountId: string, dispatchKey: string, content: AuctionMailContent): Promise<void> {
    if (!this.baseUrl) return;
    try {
      const res = await fetch(`${this.baseUrl}/internal/mail/system/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...internalHeaders('auctionsvc', this.internalKey) },
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
        console.error('[auctionsvc] mail.sendSystemMail non-ok', { accountId, dispatchKey, status: res.status });
      }
    } catch (e) {
      console.error('[auctionsvc] mail.sendSystemMail failed', { accountId, dispatchKey, err: (e as Error).message });
    }
  }
}

export const nullAuctionMailClient: AuctionMailClient = {
  available: false,
  async sendSystemMail() { /* no-op */ },
};
