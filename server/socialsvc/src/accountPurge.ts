// Account-deletion purge (socialsvc slice). metaserver soft-deletes an account (accounts.deletedAt) and,
// after the 7-day grace period, its purge job calls POST /internal/accounts/:accountId/purge on every
// service; this module is socialsvc's half. The job retries until every service reports done, so every
// step here is idempotent on its own: a second call after full success removes nothing and reports zero
// counts, and a call that died half-way can simply be re-run — each step either keys off data that only
// exists until that step completes, or is a guarded write that can't apply twice.
//
// Call order matters: socialsvc runs BEFORE worldsvc, and worldsvc re-reads family state from here to fix
// up sect leadership. So the family step must leave the family consistent (exactly one leader row that
// matches families.leaderId, memberCount matching the roster) before anything else happens.
//
// Coverage — every account-keyed collection in db.ts (socialsvc holds no Redis state):
//   families / familyMembers / familyMessages / familyJoinRequests   (family step + own join requests/messages)
//   friendEdges / friendCounts / friendRequests / blockList          (friend graph, both directions)
//   conversations / chatMessages                                     (private chat, both parties' copies)
//   mails                                                            (inbox + player mail this account sent)
//   reports                                                          (against: deleted; filed: anonymized)
import type { FamilyMemberDoc, SocialCollections } from './db';
import type { SocialGatewayClient } from './gatewayClient';
import type { SocialMetaClient } from './metaClient';
import { releaseFriendSlot } from './friend/shared';

/** Placeholder written where a deleted account's id must be kept structurally but no longer identify anyone. */
export const DELETED_ACCOUNT_ID = 'deleted-account';

export interface AccountPurgeDeps {
  cols: SocialCollections;
  now: () => number;
  /** Best-effort friend-cache invalidation for the surviving side of each removed friendship. */
  gateway?: SocialGatewayClient;
  /** accountId → publicId lookup, needed only to find player mail this account sent (see purgeMail). */
  meta?: SocialMetaClient;
}

export type FamilyPurgeOutcome =
  | { familyId: string; outcome: 'left' }
  | { familyId: string; outcome: 'transferred'; newLeaderId: string }
  | { familyId: string; outcome: 'dissolved' };

export interface AccountPurgeResult {
  done: true;
  /** Short label → number of documents deleted/modified by THIS call (all zero on a repeat call). */
  removed: Record<string, number>;
  /** Present only if the account was still in a family when this call ran. */
  family?: FamilyPurgeOutcome;
}

/** Successor preference when a leader is purged: lower = preferred. */
const ROLE_RANK: Record<FamilyMemberDoc['role'], number> = { leader: 0, elder: 1, member: 2 };

export class AccountPurgeService {
  constructor(private readonly deps: AccountPurgeDeps) {}

  /**
   * Remove every piece of socialsvc data owned by / pointing at accountId.
   * `hint.publicId` lets the caller supply the account's publicId directly (metaserver knows it); without
   * it we ask metaserver, which still has the soft-deleted account doc at this point in its job.
   */
  async purge(accountId: string, hint: { publicId?: string } = {}): Promise<AccountPurgeResult> {
    const removed: Record<string, number> = {};
    const add = (label: string, n: number): void => {
      removed[label] = (removed[label] ?? 0) + n;
    };

    // Family first: worldsvc (called after us) reads the resulting leadership.
    const family = await this.purgeFamily(accountId, add);
    await this.purgeFriends(accountId, add);
    await this.purgeChat(accountId, add);
    await this.purgeMail(accountId, hint.publicId, add);
    await this.purgeReports(accountId, add);

    return { done: true, removed, ...(family ? { family } : {}) };
  }

  // ── Family ────────────────────────────────────────────────────────────────

  /**
   * Leaders are handed over automatically: a deleted account can't transfer leadership itself,
   * leaveFamily forbids a leader leaving, and there is no transfer endpoint — without this the family
   * would be stuck with a leaderId nobody can act as (no kicks, no role changes, no dissolve, and
   * worldsvc's sect leadership keyed off it). The sole-member case dissolves instead.
   */
  private async purgeFamily(accountId: string, add: (l: string, n: number) => void): Promise<FamilyPurgeOutcome | undefined> {
    const cols = this.deps.cols;

    // Own join requests (pending or historical) and own family-channel messages, wherever they are —
    // chat content is personal data even though it would TTL out within FAMILY_MSG_RETENTION_SEC.
    add('familyJoinRequests', (await cols.familyJoinRequests.deleteMany({ accountId })).deletedCount);
    add('familyMessages', (await cols.familyMessages.deleteMany({ senderId: accountId })).deletedCount);

    const mem = await cols.familyMembers.findOne({ _id: accountId });
    if (!mem) return undefined;
    const familyId = mem.familyId;
    const fam = await cols.families.findOne({ _id: familyId });

    // Family doc already gone but our row survived → a previous dissolve crashed part-way; finish it.
    if (!fam) {
      await this.dissolve(familyId, add);
      return { familyId, outcome: 'dissolved' };
    }

    // A plain member/elder — or a leader row whose leadership a previous (crashed) purge call already
    // handed over (families.leaderId moved on) — just leaves.
    if (mem.role !== 'leader' || fam.leaderId !== accountId) {
      await this.removeMemberRow(accountId, familyId, add);
      if (mem.role === 'leader') return { familyId, outcome: 'transferred', newLeaderId: fam.leaderId };
      return { familyId, outcome: 'left' };
    }

    const others = await cols.familyMembers
      .find({ familyId, _id: { $ne: accountId } })
      .sort({ joinedAt: 1, _id: 1 })
      .toArray();
    if (others.length === 0) {
      await this.dissolve(familyId, add);
      return { familyId, outcome: 'dissolved' };
    }

    // Successor: an elder, else a member; earliest joinedAt then _id breaks ties (the sort above plus a
    // stable pick). An OTHER row already at role 'leader' ranks above both — that is a successor a
    // previous call promoted before crashing ahead of the families.leaderId write, and re-using it is what
    // stops a retry from minting a second leader.
    let successor = others[0]!;
    for (const o of others) if (ROLE_RANK[o.role] < ROLE_RANK[successor.role]) successor = o;

    await cols.familyMembers.updateOne({ _id: successor._id, familyId }, { $set: { role: 'leader' } });
    // CAS on the old leader so a concurrent/duplicate call can't overwrite a handover that already happened.
    await cols.families.updateOne({ _id: familyId, leaderId: accountId }, { $set: { leaderId: successor._id } });
    await this.removeMemberRow(accountId, familyId, add);
    return { familyId, outcome: 'transferred', newLeaderId: successor._id };
  }

  /** Same guard as leaveFamily: only decrement memberCount if this call actually removed the row. */
  private async removeMemberRow(accountId: string, familyId: string, add: (l: string, n: number) => void): Promise<void> {
    const cols = this.deps.cols;
    const deleted = await cols.familyMembers.deleteOne({ _id: accountId });
    add('familyMember', deleted.deletedCount);
    if (deleted.deletedCount > 0) {
      await cols.families.updateOne({ _id: familyId }, { $inc: { memberCount: -1 } });
    }
  }

  /**
   * dissolveFamily's cleanup plus the family's join requests (which dissolveFamily leaves orphaned).
   * Member rows go LAST: the purged account's own row is what routes a retry back here, so if anything
   * before it fails, the next call re-enters this same branch and finishes the job.
   */
  private async dissolve(familyId: string, add: (l: string, n: number) => void): Promise<void> {
    const cols = this.deps.cols;
    add('familyJoinRequests', (await cols.familyJoinRequests.deleteMany({ familyId })).deletedCount);
    add('familyMessages', (await cols.familyMessages.deleteMany({ familyId })).deletedCount);
    add('families', (await cols.families.deleteOne({ _id: familyId })).deletedCount);
    add('familyMember', (await cols.familyMembers.deleteMany({ familyId })).deletedCount);
  }

  // ── Friends / requests / blocks ──────────────────────────────────────────

  private async purgeFriends(accountId: string, add: (l: string, n: number) => void): Promise<void> {
    const cols = this.deps.cols;
    const edges = await cols.friendEdges
      .find({ $or: [{ owner: accountId }, { friend: accountId }] }, { projection: { _id: 1, owner: 1 } })
      .toArray();
    const affected = new Set<string>();
    let edgeCount = 0;
    // One by one, releasing the other side's slot only for an edge THIS call deleted — so a retry (or a
    // concurrent removeFriend by the other player) can't release the same slot twice.
    for (const e of edges) {
      const d = await cols.friendEdges.deleteOne({ _id: e._id });
      if (d.deletedCount === 0) continue;
      edgeCount++;
      if (e.owner !== accountId) {
        await releaseFriendSlot(cols, e.owner);
        affected.add(e.owner);
      }
    }
    add('friendEdges', edgeCount);
    add('friendCounts', (await cols.friendCounts.deleteOne({ _id: accountId })).deletedCount);
    add('friendRequests', (await cols.friendRequests.deleteMany({ $or: [{ from: accountId }, { to: accountId }] })).deletedCount);
    add('blockList', (await cols.blockList.deleteMany({ $or: [{ owner: accountId }, { target: accountId }] })).deletedCount);

    const gw = this.deps.gateway;
    if (gw) for (const other of affected) void gw.invalidateFriends(other).catch(() => {});
  }

  // ── Private chat ─────────────────────────────────────────────────────────

  /**
   * Conversations are deleted for BOTH parties — the counterpart no longer exists, and every message in
   * it is either the deleted user's text or a reply addressed to them.
   */
  private async purgeChat(accountId: string, add: (l: string, n: number) => void): Promise<void> {
    const cols = this.deps.cols;
    // Collect convIds before the conversations go, or their messages become unfindable.
    const convs = await cols.conversations.find({ members: accountId }, { projection: { _id: 1 } }).toArray();
    const convIds = convs.map((c) => c._id);
    let msgs = 0;
    if (convIds.length > 0) msgs += (await cols.chatMessages.deleteMany({ convId: { $in: convIds } })).deletedCount;
    // Retry-safety: if a previous call deleted the conversations but died before their messages, the
    // convIds are gone — the deleted user's own messages are still reachable by `from`.
    msgs += (await cols.chatMessages.deleteMany({ from: accountId })).deletedCount;
    add('chatMessages', msgs);
    add('conversations', convIds.length > 0 ? (await cols.conversations.deleteMany({ _id: { $in: convIds } })).deletedCount : 0);
  }

  // ── Mail ─────────────────────────────────────────────────────────────────

  /**
   * Inbox: all of it. Sent player mail: MailService.sendPlayerMail is the only writer of player→player
   * mail, and it stores the SENDER'S publicId (not accountId) in `from` plus their displayName in
   * `fromName` and their own subject/body text — all personal data of the deleted user, so it is deleted
   * from the recipients' inboxes. Player mail never carries attachments today; should one ever have an
   * unclaimed attachment, deleting it would destroy the recipient's goods, so that mail is kept and only
   * de-identified (from → DELETED_ACCOUNT_ID, fromName blanked) instead. `from: accountId` is matched too
   * in case a future writer keys it by accountId.
   *
   * The publicId comes from `hintPublicId` or metaserver. If neither yields one (meta unreachable, or
   * the account doc already gone) sent mail is skipped rather than blocking the purge — it expires on its
   * own within MAIL_DEFAULT_TTL_SEC — and a warning is logged.
   */
  private async purgeMail(accountId: string, hintPublicId: string | undefined, add: (l: string, n: number) => void): Promise<void> {
    const cols = this.deps.cols;
    add('mailsReceived', (await cols.mails.deleteMany({ to: accountId })).deletedCount);

    let publicId = hintPublicId;
    if (!publicId && this.deps.meta?.available) {
      publicId = (await this.deps.meta.batchProfiles([accountId])).get(accountId)?.publicId;
    }
    if (!publicId) {
      console.warn(`[socialsvc] account purge ${accountId}: publicId unresolved — sent player mail left to TTL`);
    }
    const senders = publicId ? [accountId, publicId] : [accountId];
    // Never touch system mail, whatever an id happens to collide with.
    const fromFilter = { from: { $in: senders.filter((s) => s !== 'system') } };
    const hasUnclaimedAttachment = { 'attachments.0': { $exists: true }, claimedAt: { $exists: false } };

    add('mailsSent', (await cols.mails.deleteMany({ ...fromFilter, $nor: [hasUnclaimedAttachment] })).deletedCount);
    add(
      'mailsSentAnonymized',
      (await cols.mails.updateMany({ ...fromFilter, ...hasUnclaimedAttachment }, { $set: { from: DELETED_ACCOUNT_ID, fromName: '' } })).modifiedCount,
    );
  }

  // ── Reports ──────────────────────────────────────────────────────────────

  /**
   * Reports AGAINST the account: deleted — there is nothing left to moderate. Reports it FILED: kept,
   * they concern another (still existing) player and stay actionable; only the reporter is anonymized.
   * `resolvedBy` is an admin id, not a player, so it is left alone.
   */
  private async purgeReports(accountId: string, add: (l: string, n: number) => void): Promise<void> {
    const cols = this.deps.cols;
    add('reportsAgainst', (await cols.reports.deleteMany({ targetId: accountId })).deletedCount);
    add('reportsFiledAnonymized', (await cols.reports.updateMany({ reporterId: accountId }, { $set: { reporterId: DELETED_ACCOUNT_ID } })).modifiedCount);
  }
}
