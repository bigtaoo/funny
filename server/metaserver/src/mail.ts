// After P2, only splitAttachments / insertSystemMail / bulkInsertSystemMail remain here.
// Full mail CRUD (getMail/readMail/deleteMail/claimMailAtomic) has been migrated to socialsvc — including
// system mail *storage*: insertSystemMail/bulkInsertSystemMail below are thin wrappers that delegate the
// actual write to socialsvc (GET /mail reads socialsvc's `mails` collection, so writes must land there too;
// meta no longer touches its own long-dead `mail` collection).
import type { MailAttachmentDoc, EquipmentInstance, CardInstance } from '@nw/shared';
import type { MetaSocialsvcClient, SystemMailContent } from './socialsvcClient.js';

export type { SystemMailContent } from './socialsvcClient.js';

/**
 * Split attachments by type for delivery by the service:
 * sum coins / skin id / item id→quantity / material id→quantity, plus equipment/card instance snapshots
 * (auction escrow-out delivery — written back to equipmentInv/cardInv by instance.id on claim).
 */
export function splitAttachments(attachments: MailAttachmentDoc[]): {
  coins: number;
  skins: string[];
  items: Record<string, number>;
  materials: Record<string, number>;
  equipment: EquipmentInstance[];
  cards: CardInstance[];
} {
  let coins = 0;
  const skins: string[] = [];
  const items: Record<string, number> = {};
  const materials: Record<string, number> = {};
  const equipment: EquipmentInstance[] = [];
  const cards: CardInstance[] = [];
  for (const a of attachments) {
    const n = Math.max(0, Math.floor(a.count ?? (a.kind === 'coins' ? 0 : 1)));
    if (a.kind === 'coins') coins += n;
    else if (a.kind === 'skin' && a.id) skins.push(a.id);
    else if (a.kind === 'item' && a.id) items[a.id] = (items[a.id] ?? 0) + n;
    else if (a.kind === 'material' && a.id) materials[a.id] = (materials[a.id] ?? 0) + n;
    else if (a.kind === 'equipment' && a.instance) equipment.push(a.instance as EquipmentInstance);
    else if (a.kind === 'card' && a.instance) cards.push(a.instance as CardInstance);
  }
  return { coins, skins, items, materials, equipment, cards };
}

/**
 * Write a system mail (operator compensation / event reward) via socialsvc. dispatchKey is idempotent:
 * socialsvc upserts on `${dispatchKey}:${to}`, so retries never duplicate. Returns whether it was newly
 * inserted (used to decide whether to push a notification). Throws if socialsvc is unreachable/unconfigured
 * — callers on a best-effort delivery path (season/event rewards) should catch and log; callers on the
 * admin comp-ticket path (internal.ts) should surface the failure as `{ok:false}` so the ticket is retryable.
 */
export async function insertSystemMail(
  socialsvc: MetaSocialsvcClient,
  dispatchKey: string,
  to: string,
  content: SystemMailContent,
): Promise<{ mailId: string; inserted: boolean; hasAttachment: boolean }> {
  return socialsvc.insertSystemMail(dispatchKey, to, content);
}

/**
 * Bulk system mail fan-out via socialsvc. Same dispatchKey idempotency as insertSystemMail. Returns the
 * list of accountIds newly inserted this call (socialsvc already pushes mail_new to them itself). Throws
 * if socialsvc is unreachable/unconfigured — see insertSystemMail for caller-side handling guidance.
 */
export async function bulkInsertSystemMail(
  socialsvc: MetaSocialsvcClient,
  dispatchKey: string,
  accountIds: string[],
  content: SystemMailContent,
): Promise<{ insertedAccountIds: string[]; hasAttachment: boolean }> {
  const hasAttachment = !!content.attachments && content.attachments.length > 0;
  if (accountIds.length === 0) return { insertedAccountIds: [], hasAttachment };
  return socialsvc.bulkInsertSystemMail(dispatchKey, accountIds, content);
}
