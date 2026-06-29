// P2 后仅保留 splitAttachments / insertSystemMail / bulkInsertSystemMail。
// 完整邮件 CRUD（getMail/readMail/deleteMail/claimMailAtomic）已迁至 socialsvc。
import type { Collections, MailDoc, MailAttachmentDoc } from '@nw/shared';
import { MAIL_DEFAULT_TTL_SEC } from '@nw/shared';

/**
 * 把附件按类型拆开（金币求和 / 皮肤 id / 物品 id→数量 / 材料 id→数量），供 service 发货。
 */
export function splitAttachments(attachments: MailAttachmentDoc[]): {
  coins: number;
  skins: string[];
  items: Record<string, number>;
  materials: Record<string, number>;
} {
  let coins = 0;
  const skins: string[] = [];
  const items: Record<string, number> = {};
  const materials: Record<string, number> = {};
  for (const a of attachments) {
    const n = Math.max(0, Math.floor(a.count ?? (a.kind === 'coins' ? 0 : 1)));
    if (a.kind === 'coins') coins += n;
    else if (a.kind === 'skin' && a.id) skins.push(a.id);
    else if (a.kind === 'item' && a.id) items[a.id] = (items[a.id] ?? 0) + n;
    else if (a.kind === 'material' && a.id) materials[a.id] = (materials[a.id] ?? 0) + n;
  }
  return { coins, skins, items, materials };
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
 * 系统邮件写入（运营补偿 / 活动奖励）。dispatchKey 幂等：_id = `${dispatchKey}:${to}`，
 * upsert $setOnInsert 防重复执行。返回是否新插入（供 push 判定）。
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
 * 批量系统邮件写入（全服 fan-out 分批）。同 insertSystemMail 的 dispatchKey 幂等。
 * 返回本次新插入的 accountId 列表，供调用方只对新收件人推红点。
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
