// Staff content removal (App Store Review Guideline 1.2: "act on objectionable content reports within 24 hours
// by removing the content and ejecting the user who provided the offending content"). Internal-only — reached
// from admin via /internal/moderation/* (X-Internal-Key); the ejection half is the existing metaserver ban.
// Covers the socialsvc-owned stores only; sect/world chat live in worldsvc, which has its own twin endpoints.
import type { SocialCollections } from './db';
import type { SocialMetaClient } from './metaClient';

/** Channels whose content this service can remove (a subset of ReportChannel). */
export type SocialModerationChannel = 'dm' | 'family' | 'announcement';

export interface PurgeAuthorResult {
  dmMessages: number;
  familyMessages: number;
  announcements: number;
  mails: number;
  friendRequestMessages: number;
}

interface Deps {
  cols: SocialCollections;
  meta: SocialMetaClient;
}

export class ModerationService {
  constructor(private readonly deps: Deps) {}

  /**
   * Remove one piece of reported content. `dm`/`family` delete the message by id; `announcement` clears the
   * announcement of the family `targetId` belongs to (announcements have no message id). Returns whether
   * anything was removed — false for an already-expired/deleted message, which admin reports as such.
   */
  async deleteContent(channel: SocialModerationChannel, messageId: string | undefined, targetId: string | undefined): Promise<boolean> {
    const { cols } = this.deps;
    if (channel === 'dm') {
      if (!messageId) return false;
      const msg = await cols.chatMessages.findOneAndDelete({ _id: messageId });
      if (!msg) return false;
      await this.refreshConversationPreview(msg.convId);
      return true;
    }
    if (channel === 'family') {
      if (!messageId) return false;
      return (await cols.familyMessages.deleteOne({ _id: messageId })).deletedCount > 0;
    }
    if (!targetId) return false;
    const mem = await cols.familyMembers.findOne({ _id: targetId });
    if (!mem) return false;
    const res = await cols.families.updateOne(
      { _id: mem.familyId, announcement: { $exists: true } },
      { $unset: { announcement: '', announcementBy: '' } },
    );
    return res.modifiedCount > 0;
  }

  /**
   * Remove everything an account has written into socialsvc's player-visible stores: DMs, family chat,
   * family announcements it authored (only those written since `announcementBy` exists), player mail it sent,
   * and the free-text message on its pending friend requests. Idempotent.
   */
  async purgeAuthor(accountId: string): Promise<PurgeAuthorResult> {
    const { cols, meta } = this.deps;
    const convIds = await cols.chatMessages.distinct('convId', { from: accountId });
    const dm = await cols.chatMessages.deleteMany({ from: accountId });
    for (const convId of convIds) await this.refreshConversationPreview(convId);
    const fam = await cols.familyMessages.deleteMany({ senderId: accountId });
    const ann = await cols.families.updateMany({ announcementBy: accountId }, { $unset: { announcement: '', announcementBy: '' } });
    // MailDoc.from is the sender's publicId (not accountId) — resolve it; meta down = skip mail, not fail.
    let mails = 0;
    const publicId = await meta.batchProfiles([accountId]).then((m) => m.get(accountId)?.publicId).catch(() => undefined);
    if (publicId && publicId !== 'system') {
      mails = (await cols.mails.deleteMany({ from: publicId })).deletedCount;
    }
    const fr = await cols.friendRequests.updateMany(
      { from: accountId, status: 'pending', message: { $exists: true } },
      { $unset: { message: '' } },
    );
    return {
      dmMessages: dm.deletedCount,
      familyMessages: fam.deletedCount,
      announcements: ann.modifiedCount,
      mails,
      friendRequestMessages: fr.modifiedCount,
    };
  }

  /** Re-point a conversation's list preview at its newest remaining message, so a removed body doesn't linger there. */
  private async refreshConversationPreview(convId: string): Promise<void> {
    const { cols } = this.deps;
    const latest = await cols.chatMessages.find({ convId }).sort({ ts: -1 }).limit(1).next();
    if (latest) {
      await cols.conversations.updateOne({ _id: convId }, { $set: { lastBody: latest.body, lastFrom: latest.from } });
    } else {
      await cols.conversations.updateOne({ _id: convId }, { $unset: { lastBody: '', lastFrom: '' } });
    }
  }
}
