// Mail service (SOCIAL_SVC_DESIGN §3.3 P2).
// Pure data operations (getMail / readMail / deleteMail / atomicClaim); attachment delivery logic stays in metaserver (commercial + inventory).
// System mail writes (insertSystemMail / bulkInsertSystemMail) are written to this DB by metaserver's internal endpoints (P2-phase internal API calls).
import { randomUUID } from 'node:crypto';
import type { SocialCollections } from './db';
import type { SocialGatewayClient } from './gatewayClient';
import type { SocialMetaClient } from './metaClient';
import type { MailDoc, MailView, MailAttachmentDoc, ProfileView } from '@nw/shared';
import {
  MAIL_DEFAULT_TTL_SEC,
  MAIL_SUBJECT_MAX,
  MAIL_BODY_MAX,
  friendEdgeId,
} from '@nw/shared';

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

export type ClaimErr = 'NOT_FOUND' | 'NO_ATTACHMENT' | 'ALREADY_CLAIMED';

interface Deps {
  cols: SocialCollections;
  gateway: SocialGatewayClient;
  meta: SocialMetaClient;
  now: () => number;
}

export class MailService {
  private readonly cols: SocialCollections;
  private readonly gateway: SocialGatewayClient;
  private readonly meta: SocialMetaClient;
  private readonly now: () => number;

  constructor(deps: Deps) {
    this.cols = deps.cols;
    this.gateway = deps.gateway;
    this.meta = deps.meta;
    this.now = deps.now;
  }

  async getMail(accountId: string): Promise<{ mail: MailView[]; unread: number }> {
    const now = this.now();
    const docs = await this.cols.mails
      .find({ to: accountId, expireAt: { $gt: new Date(now) } })
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();
    const mail = docs.map(toMailView);
    return { mail, unread: mail.filter((m) => !m.read).length };
  }

  async readMail(accountId: string, mailId: string): Promise<boolean> {
    const now = this.now();
    const res = await this.cols.mails.updateOne(
      { _id: mailId, to: accountId, readAt: { $exists: false } },
      { $set: { readAt: now } },
    );
    return res.matchedCount > 0 || (await this.cols.mails.countDocuments({ _id: mailId, to: accountId })) > 0;
  }

  async deleteMail(accountId: string, mailId: string): Promise<{ ok: true } | { error: 'HAS_UNCLAIMED_ATTACHMENT' }> {
    const doc = await this.cols.mails.findOne({ _id: mailId, to: accountId });
    if (doc && doc.attachments && doc.attachments.length > 0 && doc.claimedAt === undefined) {
      return { error: 'HAS_UNCLAIMED_ATTACHMENT' };
    }
    await this.cols.mails.deleteOne({ _id: mailId, to: accountId });
    return { ok: true };
  }

  /**
   * Atomic claim: mark claimedAt + claimOrderId and return the document for metaserver to deliver.
   * metaserver calls this method via POST /internal/mail/:id/claim.
   */
  async claimMailAtomic(
    accountId: string,
    mailId: string,
    orderId: string,
  ): Promise<{ doc: MailDoc } | { error: ClaimErr }> {
    const now = this.now();
    const doc = await this.cols.mails.findOne({ _id: mailId, to: accountId });
    if (!doc) return { error: 'NOT_FOUND' };
    if (!doc.attachments || doc.attachments.length === 0) return { error: 'NO_ATTACHMENT' };
    if (doc.claimedAt !== undefined) return { error: 'ALREADY_CLAIMED' };
    const claimed = await this.cols.mails.findOneAndUpdate(
      { _id: mailId, to: accountId, claimedAt: { $exists: false } },
      { $set: { claimedAt: now, claimOrderId: orderId, ...(doc.readAt === undefined ? { readAt: now } : {}) } },
      { returnDocument: 'after' },
    );
    if (!claimed) return { error: 'ALREADY_CLAIMED' };
    return { doc: claimed };
  }

  /** Send mail between players (must be mutual friends; no attachments). */
  async sendPlayerMail(
    accountId: string,
    toPublicId: string,
    subject: string,
    body: string,
  ): Promise<{ kind: 'ok'; mailId: string } | { kind: 'error'; error: 'NOT_FOUND' | 'NOT_FRIEND' | 'BAD_REQUEST' }> {
    const target = await this.meta.resolveByPublicId(toPublicId);
    if (!target) return { kind: 'error', error: 'NOT_FOUND' };
    const to = target.accountId;
    if (to === accountId) return { kind: 'error', error: 'BAD_REQUEST' };
    const subj = (subject ?? '').trim();
    const bd = (body ?? '').trim();
    if (!subj || subj.length > MAIL_SUBJECT_MAX || bd.length > MAIL_BODY_MAX) {
      return { kind: 'error', error: 'BAD_REQUEST' };
    }
    if (!(await this.cols.friendEdges.findOne({ _id: friendEdgeId(accountId, to) }))) {
      return { kind: 'error', error: 'NOT_FRIEND' };
    }
    const fromProfile = await this.meta.batchProfiles([accountId]).then((m) => m.get(accountId) as ProfileView | undefined);
    if (!fromProfile) return { kind: 'error', error: 'BAD_REQUEST' };

    const mailId = randomUUID();
    const now = this.now();
    await this.cols.mails.insertOne({
      _id: mailId,
      to,
      from: fromProfile.publicId,
      fromName: fromProfile.displayName,
      subject: subj,
      body: bd,
      createdAt: now,
      expireAt: new Date(now + MAIL_DEFAULT_TTL_SEC * 1000),
    });
    void this.gateway.push(to, { kind: 'mail_new', mailId, hasAttachment: false });
    return { kind: 'ok', mailId };
  }

  /** Write a system mail (idempotent upsert; dispatchKey:to is the _id). Returns whether it was newly inserted (used to decide whether to push a notification). */
  async insertSystemMail(
    dispatchKey: string,
    to: string,
    content: { subject: string; body: string; attachments?: MailAttachmentDoc[]; expireDays: number },
  ): Promise<{ mailId: string; inserted: boolean; hasAttachment: boolean }> {
    const now = this.now();
    const mailId = `${dispatchKey}:${to}`;
    const expireSec = content.expireDays > 0 ? content.expireDays * 86400 : MAIL_DEFAULT_TTL_SEC;
    const hasAttachment = !!content.attachments?.length;
    const setOnInsert: MailDoc = {
      _id: mailId,
      to,
      from: 'system',
      fromName: 'System',
      subject: content.subject,
      body: content.body,
      ...(hasAttachment ? { attachments: content.attachments } : {}),
      createdAt: now,
      expireAt: new Date(now + expireSec * 1000),
    };
    const res = await this.cols.mails.updateOne({ _id: mailId }, { $setOnInsert: setOnInsert }, { upsert: true });
    return { mailId, inserted: res.upsertedCount > 0, hasAttachment };
  }

  /** Bulk system mail write (bulkWrite upsert, idempotent). Returns the list of accountIds newly inserted this call. */
  async bulkInsertSystemMail(
    dispatchKey: string,
    accountIds: string[],
    content: { subject: string; body: string; attachments?: MailAttachmentDoc[]; expireDays: number },
  ): Promise<{ insertedAccountIds: string[]; hasAttachment: boolean }> {
    const hasAttachment = !!content.attachments?.length;
    if (accountIds.length === 0) return { insertedAccountIds: [], hasAttachment };
    const now = this.now();
    const expireSec = content.expireDays > 0 ? content.expireDays * 86400 : MAIL_DEFAULT_TTL_SEC;
    const ops = accountIds.map((to) => {
      const mailId = `${dispatchKey}:${to}`;
      const setOnInsert: MailDoc = {
        _id: mailId, to, from: 'system', fromName: 'System',
        subject: content.subject, body: content.body,
        ...(hasAttachment ? { attachments: content.attachments } : {}),
        createdAt: now, expireAt: new Date(now + expireSec * 1000),
      };
      return { updateOne: { filter: { _id: mailId }, update: { $setOnInsert: setOnInsert }, upsert: true } };
    });
    const res = await this.cols.mails.bulkWrite(ops, { ordered: false });
    const insertedAccountIds = Object.keys(res.upsertedIds ?? {})
      .map((idx) => accountIds[Number(idx)])
      .filter((id): id is string => id !== undefined);
    return { insertedAccountIds, hasAttachment };
  }
}
