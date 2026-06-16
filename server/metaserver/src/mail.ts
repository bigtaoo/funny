// 邮件服务（S6-3，SOCIAL_DESIGN §3.3 / §5.3）。meta = 数据权威：邮件落 `mail` 集合（每收件人
// 一份，TTL 到期回收）。附件领取经 commercial 发金币 + meta 发 inventory（物品/皮肤），claimOrderId
// 幂等（同 economy 发货约定）。这里是纯 DB 部分；领取的 commercial/inventory 编排在 service.ts。
import { randomUUID } from 'node:crypto';
import type { Collections, MailDoc, MailAttachmentDoc, MailView, ProfileView } from '@nw/shared';
import { MAIL_DEFAULT_TTL_SEC, MAIL_SUBJECT_MAX, MAIL_BODY_MAX } from '@nw/shared';
import { resolveByPublicId } from './social.js';

/** MailDoc → MailView（expireAt Date→number，read/claimed 由时间戳派生）。 */
export function toMailView(d: MailDoc): MailView {
  return {
    mailId: d._id,
    from: d.from,
    ...(d.fromName ? { fromName: d.fromName } : {}),
    subject: d.subject,
    body: d.body,
    ...(d.attachments && d.attachments.length ? { attachments: d.attachments } : {}),
    createdAt: d.createdAt,
    expireAt: d.expireAt instanceof Date ? d.expireAt.getTime() : Number(d.expireAt),
    read: d.readAt !== undefined,
    claimed: d.claimedAt !== undefined,
  };
}

/** 收件箱（未过期邮件，按时间倒序）+ 未读数。TTL 可能未即时清理，故读出时再过滤 expireAt。 */
export async function getMail(
  cols: Collections,
  me: string,
  now: number,
): Promise<{ mail: MailView[]; unread: number }> {
  const docs = await cols.mail
    .find({ to: me, expireAt: { $gt: new Date(now) } })
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
  const mail = docs.map(toMailView);
  const unread = mail.filter((m) => !m.read).length;
  return { mail, unread };
}

/** 标记已读（仅收件人）。 */
export async function readMail(cols: Collections, me: string, mailId: string, now: number): Promise<boolean> {
  const res = await cols.mail.updateOne(
    { _id: mailId, to: me, readAt: { $exists: false } },
    { $set: { readAt: now } },
  );
  // 已读过也算成功（幂等）；不存在/非本人 → matched 0 且未改 → 视为未命中。
  return res.matchedCount > 0 || (await cols.mail.countDocuments({ _id: mailId, to: me })) > 0;
}

/** 删邮件（仅收件人）。 */
export async function deleteMail(cols: Collections, me: string, mailId: string): Promise<void> {
  await cols.mail.deleteOne({ _id: mailId, to: me });
}

export type ClaimErr = 'NOT_FOUND' | 'NO_ATTACHMENT' | 'ALREADY_CLAIMED';

/**
 * 原子领取：标记 claimedAt + claimOrderId（防并发重复领取）。返回被领取的 mail 文档供 service
 * 发放附件；无附件 / 已领 / 不存在 → 错误码。已读未读不影响领取（领取顺带标已读）。
 */
export async function claimMailAtomic(
  cols: Collections,
  me: string,
  mailId: string,
  orderId: string,
  now: number,
): Promise<{ doc: MailDoc } | { error: ClaimErr }> {
  const doc = await cols.mail.findOne({ _id: mailId, to: me });
  if (!doc) return { error: 'NOT_FOUND' };
  if (!doc.attachments || doc.attachments.length === 0) return { error: 'NO_ATTACHMENT' };
  if (doc.claimedAt !== undefined) return { error: 'ALREADY_CLAIMED' };
  const claimed = await cols.mail.findOneAndUpdate(
    { _id: mailId, to: me, claimedAt: { $exists: false } },
    { $set: { claimedAt: now, claimOrderId: orderId, ...(doc.readAt === undefined ? { readAt: now } : {}) } },
    { returnDocument: 'after' },
  );
  if (!claimed) return { error: 'ALREADY_CLAIMED' }; // 并发竞态：他人先领
  return { doc: claimed };
}

/** 把附件按类型拆开（金币求和 / 皮肤 id / 物品 id→数量），供 service 发货。 */
export function splitAttachments(attachments: MailAttachmentDoc[]): {
  coins: number;
  skins: string[];
  items: Record<string, number>;
} {
  let coins = 0;
  const skins: string[] = [];
  const items: Record<string, number> = {};
  for (const a of attachments) {
    const n = Math.max(0, Math.floor(a.count ?? (a.kind === 'coins' ? 0 : 1)));
    if (a.kind === 'coins') coins += n;
    else if (a.kind === 'skin' && a.id) skins.push(a.id);
    else if (a.kind === 'item' && a.id) items[a.id] = (items[a.id] ?? 0) + n;
  }
  return { coins, skins, items };
}

export type SendMailErr = 'NOT_FOUND' | 'NOT_FRIEND' | 'BAD_REQUEST';
export type SendMailResult =
  | { kind: 'ok'; mailId: string; to: string }
  | { kind: 'error'; error: SendMailErr };

/** 玩家间发邮件（门控为好友，无附件——玩家不能凭空发奖励）。 */
export async function sendPlayerMail(
  cols: Collections,
  me: string,
  fromProfile: ProfileView,
  toPublicId: string,
  subject: string,
  body: string,
  now: number,
): Promise<SendMailResult> {
  const target = await resolveByPublicId(cols, toPublicId);
  if (!target) return { kind: 'error', error: 'NOT_FOUND' };
  const to = target.accountId;
  if (to === me) return { kind: 'error', error: 'BAD_REQUEST' };
  const subj = (subject ?? '').trim();
  const bd = (body ?? '').trim();
  if (!subj || subj.length > MAIL_SUBJECT_MAX || bd.length > MAIL_BODY_MAX) {
    return { kind: 'error', error: 'BAD_REQUEST' };
  }
  // 门控：须互为好友。
  if (!(await cols.friendEdges.findOne({ _id: `${me}:${to}` }))) {
    return { kind: 'error', error: 'NOT_FRIEND' };
  }
  const mailId = randomUUID();
  await cols.mail.insertOne({
    _id: mailId,
    to,
    from: fromProfile.publicId,
    fromName: fromProfile.displayName,
    subject: subj,
    body: bd,
    createdAt: now,
    expireAt: new Date(now + MAIL_DEFAULT_TTL_SEC * 1000),
  });
  return { kind: 'ok', mailId, to };
}

/**
 * 系统邮件写入（运营补偿 / 活动奖励，OPS_DESIGN §3.3）。dispatchKey 幂等：_id = `${dispatchKey}:${to}`，
 * upsert $setOnInsert 防重复执行（admin 工单重试同 dispatchKey 不重复发）。返回是否新插入（供 push 判定）。
 */
export async function insertSystemMail(
  cols: Collections,
  dispatchKey: string,
  to: string,
  content: { subject: string; body: string; attachments?: MailAttachmentDoc[]; expireDays: number },
  now: number,
): Promise<{ mailId: string; inserted: boolean; hasAttachment: boolean }> {
  const mailId = `${dispatchKey}:${to}`;
  const expireSec = content.expireDays > 0 ? content.expireDays * 86400 : MAIL_DEFAULT_TTL_SEC;
  const hasAttachment = !!content.attachments && content.attachments.length > 0;
  const res = await cols.mail.updateOne(
    { _id: mailId },
    {
      $setOnInsert: {
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
    },
    { upsert: true },
  );
  return { mailId, inserted: res.upsertedCount > 0, hasAttachment };
}
