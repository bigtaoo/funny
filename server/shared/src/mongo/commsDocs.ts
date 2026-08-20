// Split 2026-08-10 out of shared/src/mongo.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Player-comms domain: free-text feedback + system mail (friend/private-chat collections already
// migrated to socialsvc, P2 — metaserver only retains mail for system messages).
import type { Collection } from 'mongodb';
import type { EquipmentInstance, CardInstance } from '../types';

/**
 * Player free-text feedback (UI_DESIGN.md §4.1.1 lobby entry / SERVER_API.md §2.13). Ops-review-only via
 * `GET /internal/feedback` (feedback.view) — still no status machine, no verdict: unlike AppealDoc/ReportDoc
 * there is no dismiss/uphold outcome. There is a lightweight triage trail so a growing backlog stays
 * trackable (feedback.action, `POST /internal/feedback/:id/review`): `readAt` is stamped on the first
 * review call and never overwritten after, so unread ⟺ `!readAt`; `readBy`/`note` are last-write-wins.
 * Not run through censorChat for the same reason as AppealDoc.reason.
 */
export interface FeedbackDoc {
  _id: string; // uuid
  accountId: string;
  text: string;
  clientPlatform?: string;
  createdAt: number;
  /** First-review timestamp — set once, never overwritten; its absence is the "unread" marker. */
  readAt?: number;
  /** adminId of whoever last reviewed this row (last-write-wins). */
  readBy?: string;
  /** Ops-authored triage note, last-write-wins; absent means no note has been left. */
  note?: string;
}

export interface MailAttachmentDoc {
  // 'material' → SaveData.materials unified progression pool (SLG8); 'item' → inventory.items general-purpose bucket.
  // 'equipment'/'card' → auction escrow-out return/delivery: carries the full instance snapshot (affixes/level/gear are
  //   an inseparable part of the instance), written back to equipmentInv/cardInv by instance.id on claim (AUCTION_DESIGN escrow-out).
  kind: 'coins' | 'item' | 'skin' | 'material' | 'equipment' | 'card';
  id?: string;
  count?: number;
  // Present (required) only for kind 'equipment' | 'card': the traded instance snapshot.
  instance?: EquipmentInstance | CardInstance;
}

/** Mail (SOC5): one document per recipient; attachment claiming goes through commercial idempotency (claimOrderId). */
export interface MailDoc {
  _id: string; // uuid
  to: string; // accountId (recipient)
  from: 'system' | string; // 'system' or sender accountId
  fromName?: string;
  subject: string;
  body: string;
  attachments?: MailAttachmentDoc[];
  createdAt: number;
  // BSON Date (not an epoch number): Mongo TTL only expires Date fields, absolute expiry time (expireAfterSeconds:0).
  // Writers store new Date(createdAt + MAIL_DEFAULT_TTL_SEC*1000); readers convert to number when building MailView.
  expireAt: Date;
  readAt?: number;
  claimedAt?: number;
  claimOrderId?: string; // claim idempotency key (commercial orderId)
}

/** Player-comms-domain indexes. */
export async function ensureCommsIndexes(
  feedback: Collection<FeedbackDoc>,
  mail: Collection<MailDoc>,
): Promise<void> {
  // —— player feedback (UI_DESIGN.md §4.1.1): admin listing is newest-first, no per-account queue ——
  await feedback.createIndex({ createdAt: -1 });
  // mail (friend/private-chat collections migrated to socialsvc; metaserver only retains mail for system messages)
  // inbox (reverse chronological order).
  await mail.createIndex({ to: 1, createdAt: -1 });
  // mail TTL auto-expiry (expireAt is an absolute expiry timestamp → expireAfterSeconds:0, SOC5).
  await mail.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
}
