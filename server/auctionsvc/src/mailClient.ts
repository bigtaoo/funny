// auctionsvc → meta system mail (auction task 4): item delivery/return goes through system mail (escrow-out model).
// Reuses the OPS compensation system mail infrastructure (dispatchKey idempotency + attachment types: material/equipment/card/skin).
// Direct delivery by accountId (meta single-send branch skips publicId resolution when accountId is provided).
// NW_META_INTERNAL_URL not configured → available=false → delivery/return does not send mail (best-effort; does not block settlement).
// Migrated from server/worldsvc/src/mailClient.ts (caller name updated to 'auctionsvc').
//
// 2026-08-24 (U13 close-out): a CONFIGURED client now THROWS on a failed send. It used to log and return,
// which meant one meta 500 silently destroyed a seller's proceeds or a buyer's item — the likeliest asset
// loss in production, needing no crash at all. The caller (journalSteps.ts → journal.ts) records the step
// as still-owed and the scheduler sweep retries it until it lands. The null client below stays a silent
// no-op: with meta unconfigured there is nothing to retry, and the design's stated degradation is that
// mail delivery does not block settlement.

import { fetchInternalJson, type EquipmentInstance, type CardInstance } from '@nw/shared';

export interface AuctionMailAttachment {
  // 'material' → SaveData.materials unified progression pool; 'skin' → inventory.skins array.
  // 'equipment'/'card' → auction escrow-out delivery/return: carries the full instance snapshot, written back to
  //   equipmentInv/cardInv by instance.id when the recipient claims the mail (AUCTION_DESIGN escrow-out model).
  // 'coins' → sale proceeds / escrow refunds; credited via commercial.grant at claim time (metaserver claimMail).
  kind: 'material' | 'equipment' | 'card' | 'skin' | 'coins';
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
  /**
   * System mail (dispatchKey idempotency, attachments: material/equipment/card/skin).
   * Throws on a failed send when the client is configured, so the journal can record the hand-over as
   * still owed and retry it; the null (unconfigured) client is a silent no-op.
   */
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
    const res = await fetchInternalJson<{ ok?: boolean; error?: string }>(`${this.baseUrl}/internal/mail/system/send`, {
      caller: 'auctionsvc',
      key: this.internalKey,
      method: 'POST',
      body: {
        dispatchKey,
        accountId,
        subject: content.subject,
        body: content.body,
        attachments: content.attachments ?? [],
        expireDays: content.expireDays ?? 0,
      },
      timeoutMs: 5000,
      label: '/internal/mail/system/send',
    });
    if (!res.ok) {
      throw new Error(`mail.sendSystemMail failed: ${res.error ?? `status ${res.status}`}`);
    }
    if (res.body?.ok === false) {
      // meta answers HTTP 200 with {ok:false} when the recipient is unknown or socialsvc persistence failed —
      // HTTP status alone can't detect a dropped mail, so this has to be inspected explicitly and raised too.
      throw new Error(`mail.sendSystemMail rejected: ${res.body.error ?? 'unknown'}`);
    }
  }
}

export const nullAuctionMailClient: AuctionMailClient = {
  available: false,
  async sendSystemMail() { /* no-op */ },
};
