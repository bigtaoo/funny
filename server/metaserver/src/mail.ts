// After P2, only splitAttachments / insertSystemMail / bulkInsertSystemMail remain here.
// Full mail CRUD (getMail/readMail/deleteMail/claimMailAtomic) has been migrated to socialsvc.
import type { Collections, MailDoc, MailAttachmentDoc, EquipmentInstance, CardInstance } from '@nw/shared';
import { MAIL_DEFAULT_TTL_SEC } from '@nw/shared';

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

export interface SystemMailContent {
  subject: string;
  body: string;
  attachments?: MailAttachmentDoc[];
  expireDays: number;
}

function buildSystemMail(
  dispatchKey: string,
  to: string,
  content: SystemMailContent,
  now: number,
): { mailId: string; hasAttachment: boolean; setOnInsert: MailDoc } {
  const mailId = `${dispatchKey}:${to}`;
  const expireSec = content.expireDays > 0 ? content.expireDays * 86400 : MAIL_DEFAULT_TTL_SEC;
  const hasAttachment = !!content.attachments && content.attachments.length > 0;
  return {
    mailId,
    hasAttachment,
    setOnInsert: {
      _id: mailId,
      to,
      from: 'system',
      fromName: 'System',
      subject: content.subject,
      body: content.body,
      ...(hasAttachment ? { attachments: content.attachments } : {}),
      createdAt: now,
      expireAt: new Date(now + expireSec * 1000),
    },
  };
}

/**
 * Write a system mail (operator compensation / event reward). dispatchKey is idempotent: _id = `${dispatchKey}:${to}`,
 * upsert $setOnInsert prevents duplicate execution. Returns whether it was newly inserted (used to decide whether to push a notification).
 */
export async function insertSystemMail(
  cols: Collections,
  dispatchKey: string,
  to: string,
  content: SystemMailContent,
  now: number,
): Promise<{ mailId: string; inserted: boolean; hasAttachment: boolean }> {
  const { mailId, hasAttachment, setOnInsert } = buildSystemMail(dispatchKey, to, content, now);
  const res = await cols.mail.updateOne({ _id: mailId }, { $setOnInsert: setOnInsert }, { upsert: true });
  return { mailId, inserted: res.upsertedCount > 0, hasAttachment };
}

/**
 * Bulk system mail write (server-wide fan-out in batches). Same dispatchKey idempotency as insertSystemMail.
 * Returns the list of accountIds newly inserted this call, so the caller only pushes red-dot notifications to new recipients.
 */
export async function bulkInsertSystemMail(
  cols: Collections,
  dispatchKey: string,
  accountIds: string[],
  content: SystemMailContent,
  now: number,
): Promise<{ insertedAccountIds: string[]; hasAttachment: boolean }> {
  const hasAttachment = !!content.attachments && content.attachments.length > 0;
  if (accountIds.length === 0) return { insertedAccountIds: [], hasAttachment };
  const ops = accountIds.map((to) => ({
    updateOne: {
      filter: { _id: `${dispatchKey}:${to}` },
      update: { $setOnInsert: buildSystemMail(dispatchKey, to, content, now).setOnInsert },
      upsert: true,
    },
  }));
  const res = await cols.mail.bulkWrite(ops, { ordered: false });
  const insertedAccountIds = Object.keys(res.upsertedIds ?? {})
    .map((idx) => accountIds[Number(idx)])
    .filter((id): id is string => id !== undefined);
  return { insertedAccountIds, hasAttachment };
}
