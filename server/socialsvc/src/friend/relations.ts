// Friend + private-chat service — friend list/requests/block/reports (SOCIAL_SVC_DESIGN §3.2 P2).
// Split out of friendService.ts (see ../friendService.ts for the composing facade). Logic aligned
// with metaserver/src/social.ts; data layer uses the nw_social collections; publicId reverse-lookup
// goes through SocialMetaClient (no direct connection to the accounts database).
import { randomUUID } from 'node:crypto';
import type { ReportDoc } from '../db';
import type { ProfileView, FriendView, FriendRequestView, SocialBadges } from '@nw/shared';
import { FRIEND_CAP, friendEdgeId, blockId, REPORT_REASON_MAX } from '@nw/shared';
import type { FriendServiceDeps, SocialError } from './types';
import { hasBlock, isFriend } from './shared';

export class FriendRelationsService {
  constructor(private readonly deps: FriendServiceDeps) {}

  // ── Friends ──────────────────────────────────────────────────────────────────

  /**
   * Lazily bootstrap a friend counter row seeded with the REAL current count (2026-08-04 fix, FRIEND_CAP
   * soft-overrun race — see FriendCountDoc's doc comment in db.ts). No migration script needed: an account
   * with real friendEdges predating this counter's existence gets an accurate seed the first time this
   * runs for it. Concurrent bootstraps for the same account race harmlessly — only the first insert wins,
   * the rest hit E11000 and no-op (whichever won already reflects an accurate-enough count from ~the same
   * instant; this is a one-time seeding race, not a recurring cap-bypass — see the fix's design doc note).
   */
  private async ensureFriendCounter(accountId: string): Promise<void> {
    try {
      const count = await this.deps.cols.friendEdges.countDocuments({ owner: accountId });
      await this.deps.cols.friendCounts.insertOne({ _id: accountId, count });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }

  /** Current friend count for the soft "you're already at your cap" pre-check in requestFriend (not the
   *  authoritative gate — see tryClaimFriendSlot for that). */
  private async getFriendCount(accountId: string): Promise<number> {
    await this.ensureFriendCounter(accountId);
    const doc = await this.deps.cols.friendCounts.findOne({ _id: accountId });
    return doc?.count ?? 0;
  }

  /**
   * Atomically claim one friend slot for accountId (2026-08-04 fix): the previous FRIEND_CAP gate in
   * respondFriend was a plain `countDocuments(friendEdges)` read followed by a SEPARATE edge-insert write,
   * with nothing atomic between them — two concurrent respondFriend calls accepting DIFFERENT incoming
   * requests for the SAME account could both read a count under FRIEND_CAP before either write landed,
   * overrunning the cap. Folding the check into the update's query filter means only a caller that
   * observes `count < FRIEND_CAP` at the moment of the atomic increment can ever succeed — mirrors the
   * family system's memberCount CAS (familyService.ts's joinFamily).
   */
  private async tryClaimFriendSlot(accountId: string): Promise<boolean> {
    await this.ensureFriendCounter(accountId);
    const res = await this.deps.cols.friendCounts.updateOne(
      { _id: accountId, count: { $lt: FRIEND_CAP } },
      { $inc: { count: 1 } },
    );
    return res.matchedCount > 0;
  }

  /** Release a previously-claimed slot (removeFriend, or rolling back a claim whose PEER slot claim then
   *  failed). No-op if the counter row doesn't exist yet or is already at 0 — a future ensureFriendCounter
   *  bootstrap recomputes the correct count from scratch regardless, so there's nothing to under-flow. */
  private async releaseFriendSlot(accountId: string): Promise<void> {
    await this.deps.cols.friendCounts.updateOne({ _id: accountId, count: { $gt: 0 } }, { $inc: { count: -1 } });
  }

  /** Fetch only the accountId list (for presence fan-out; no profile data needed). */
  async getFriendAccountIds(accountId: string): Promise<string[]> {
    const edges = await this.deps.cols.friendEdges.find({ owner: accountId }, { projection: { friend: 1 } }).toArray();
    return edges.map((e) => e.friend);
  }

  /** Batch accountId → publicId lookup (for presence fan-out). Missing accountIds are silently skipped. */
  async batchPublicIds(accountIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (accountIds.length === 0) return out;
    const profiles = await this.deps.meta.batchProfiles(accountIds);
    for (const [id, p] of profiles) {
      if (p.publicId) out.set(id, p.publicId);
    }
    return out;
  }

  async getFriends(accountId: string): Promise<FriendView[]> {
    const edges = await this.deps.cols.friendEdges.find({ owner: accountId }).sort({ since: -1 }).toArray();
    if (edges.length === 0) return [];
    const friendIds = edges.map((e) => e.friend);
    const profiles = await this.deps.meta.batchProfiles(friendIds);

    // online presence
    const presence = this.deps.gateway.available ? await this.deps.gateway.presence(friendIds) : {};

    const out: FriendView[] = [];
    for (const e of edges) {
      const p = profiles.get(e.friend);
      if (!p) continue;
      out.push({
        publicId: p.publicId,
        displayName: p.displayName,
        online: presence[e.friend] ?? false,
        ...(p.rank ? { rank: p.rank } : {}),
        ...(e.alias ? { alias: e.alias } : {}),
        ...(p.avatarId ? { avatarId: p.avatarId } : {}),
      });
    }
    return out;
  }

  async listRequests(accountId: string): Promise<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }> {
    const [incomingDocs, outgoingDocs] = await Promise.all([
      this.deps.cols.friendRequests.find({ to: accountId, status: 'pending' }).sort({ createdAt: -1 }).toArray(),
      this.deps.cols.friendRequests.find({ from: accountId, status: 'pending' }).sort({ createdAt: -1 }).toArray(),
    ]);
    const allIds = [...new Set([...incomingDocs.map((d) => d.from), ...incomingDocs.map((d) => d.to), ...outgoingDocs.map((d) => d.from), ...outgoingDocs.map((d) => d.to)])];
    const profiles = await this.deps.meta.batchProfiles(allIds);

    const toView = (d: { _id: string; from: string; to: string; message?: string; createdAt: number }): FriendRequestView | null => {
      const fromP = profiles.get(d.from);
      const toP = profiles.get(d.to);
      if (!fromP || !toP) return null;
      return {
        requestId: d._id,
        fromPublicId: fromP.publicId,
        fromName: fromP.displayName,
        toPublicId: toP.publicId,
        ...(d.message ? { message: d.message } : {}),
        createdAt: d.createdAt,
      };
    };

    return {
      incoming: incomingDocs.map(toView).filter((v): v is FriendRequestView => v !== null),
      outgoing: outgoingDocs.map(toView).filter((v): v is FriendRequestView => v !== null),
    };
  }

  /** Combined badge counts (friend requests + unread chat + unread mail). Chat/mail counts are read
   *  directly off shared collections rather than delegating to FriendChatService — there's no chat-specific
   *  logic here, just a projection, so a cross-class call would add an interface for no behavioral gain. */
  async getSocialBadges(accountId: string): Promise<SocialBadges> {
    const now = this.deps.now();
    const [friendRequests, chat, mail] = await Promise.all([
      this.deps.cols.friendRequests.countDocuments({ to: accountId, status: 'pending' }),
      this.deps.cols.conversations.countDocuments({ members: accountId, [`unread.${accountId}`]: { $gt: 0 } }),
      this.deps.cols.mails.countDocuments({ to: accountId, readAt: { $exists: false }, expireAt: { $gt: new Date(now) } }),
    ]);
    return { friendRequests, chat, mail, total: friendRequests + chat + mail };
  }

  async searchFriend(publicId: string): Promise<{ profile: ProfileView } | null> {
    const found = await this.deps.meta.resolveByPublicId(publicId);
    if (!found) return null;
    return { profile: found.profile };
  }

  async requestFriend(
    accountId: string,
    publicId: string,
    message: string | undefined,
  ): Promise<{ kind: 'ok'; requestId: string; to: string; fromProfile: ProfileView; message?: string } | { kind: 'error'; error: SocialError }> {
    const target = await this.deps.meta.resolveByPublicId(publicId);
    if (!target) return { kind: 'error', error: 'NOT_FOUND' };
    const to = target.accountId;
    if (to === accountId) return { kind: 'error', error: 'BAD_REQUEST' };
    if (await isFriend(this.deps.cols, accountId, to)) return { kind: 'error', error: 'ALREADY_FRIEND' };
    if ((await hasBlock(this.deps.cols, to, accountId)) || (await hasBlock(this.deps.cols, accountId, to))) {
      return { kind: 'error', error: 'BLOCKED' };
    }
    const myFriendCount = await this.getFriendCount(accountId);
    if (myFriendCount >= FRIEND_CAP) return { kind: 'error', error: 'FRIEND_CAP_REACHED' };

    const fromProfile = await this.deps.meta.batchProfiles([accountId]).then((m) => m.get(accountId) ?? null);
    if (!fromProfile) return { kind: 'error', error: 'BAD_REQUEST' };

    const existing = await this.deps.cols.friendRequests.findOne({ from: accountId, to, status: 'pending' });
    if (existing) {
      return { kind: 'ok', requestId: existing._id, to, fromProfile, message: existing.message };
    }
    const requestId = randomUUID();
    const now = this.deps.now();
    await this.deps.cols.friendRequests.insertOne({
      _id: requestId,
      from: accountId,
      to,
      status: 'pending',
      ...(message ? { message } : {}),
      createdAt: now,
    });
    void this.deps.gateway.push(to, {
      kind: 'friend_request',
      requestId,
      fromPublicId: fromProfile.publicId,
      fromName: fromProfile.displayName,
      message: message ?? '',
    });
    return { kind: 'ok', requestId, to, fromProfile, message };
  }

  async respondFriend(
    accountId: string,
    requestId: string,
    accept: boolean,
  ): Promise<{ kind: 'ok'; accepted: boolean } | { kind: 'error'; error: SocialError }> {
    const reqDoc = await this.deps.cols.friendRequests.findOne({ _id: requestId });
    if (!reqDoc || reqDoc.to !== accountId || reqDoc.status !== 'pending') {
      return { kind: 'error', error: 'NOT_FOUND' };
    }
    const other = reqDoc.from;
    const now = this.deps.now();
    const claimed = await this.deps.cols.friendRequests.findOneAndUpdate(
      { _id: requestId, status: 'pending' },
      { $set: { status: accept ? 'accepted' : 'rejected', resolvedAt: now } },
    );
    if (!claimed) return { kind: 'error', error: 'NOT_FOUND' };

    if (accept) {
      // Atomic per-account slot claims (2026-08-04 fix — see tryClaimFriendSlot's doc comment for the
      // race this closes). Claimed in sequence, not Promise.all: if accountId's own claim fails there's
      // nothing to roll back; if it succeeds but `other`'s claim then fails, accountId's claim must be
      // released so it isn't left permanently occupying a slot for a friendship that never happened.
      const meOk = await this.tryClaimFriendSlot(accountId);
      if (!meOk) {
        // Restore the request to pending instead of leaving it stuck 'accepted' with no friendship ever
        // created (2026-08-04 fix, adjacent bug: the status flip above is an exclusivity claim on
        // PROCESSING this request, not a statement that acceptance actually succeeded) — the accepter can
        // retry once a slot frees up (e.g. after removing another friend).
        await this.deps.cols.friendRequests.updateOne({ _id: requestId }, { $set: { status: 'pending' }, $unset: { resolvedAt: '' } });
        return { kind: 'error', error: 'FRIEND_CAP_REACHED' };
      }
      const otherOk = await this.tryClaimFriendSlot(other);
      if (!otherOk) {
        await this.releaseFriendSlot(accountId);
        await this.deps.cols.friendRequests.updateOne({ _id: requestId }, { $set: { status: 'pending' }, $unset: { resolvedAt: '' } });
        return { kind: 'error', error: 'FRIEND_CAP_REACHED' };
      }
      await Promise.all([
        this.deps.cols.friendEdges.updateOne(
          { _id: friendEdgeId(accountId, other) },
          { $setOnInsert: { _id: friendEdgeId(accountId, other), owner: accountId, friend: other, since: now } },
          { upsert: true },
        ),
        this.deps.cols.friendEdges.updateOne(
          { _id: friendEdgeId(other, accountId) },
          { $setOnInsert: { _id: friendEdgeId(other, accountId), owner: other, friend: accountId, since: now } },
          { upsert: true },
        ),
      ]);
      // Friend relationship changed → invalidate gateway presence cache + bidirectional push
      void this.deps.gateway.invalidateFriends(accountId);
      void this.deps.gateway.invalidateFriends(other);
      const profiles = await this.deps.meta.batchProfiles([accountId, other]);
      const meProfile = profiles.get(accountId);
      const otherProfile = profiles.get(other);
      if (meProfile && otherProfile) {
        void this.deps.gateway.push(other, { kind: 'friend_update', publicId: meProfile.publicId, added: true });
        void this.deps.gateway.push(accountId, { kind: 'friend_update', publicId: otherProfile.publicId, added: true });
      }
    }
    return { kind: 'ok', accepted: accept };
  }

  async removeFriend(accountId: string, publicId: string): Promise<boolean> {
    const target = await this.deps.meta.resolveByPublicId(publicId);
    if (!target) return false;
    const other = target.accountId;
    const [d1, d2] = await Promise.all([
      this.deps.cols.friendEdges.deleteOne({ _id: friendEdgeId(accountId, other) }),
      this.deps.cols.friendEdges.deleteOne({ _id: friendEdgeId(other, accountId) }),
    ]);
    // Release the freed slots (2026-08-04 fix, pairs with tryClaimFriendSlot) — gated on the edge having
    // actually existed, so a redundant/no-op removeFriend call (already-removed friend) doesn't decrement
    // a counter for a slot nothing was occupying.
    await Promise.all([
      d1.deletedCount > 0 ? this.releaseFriendSlot(accountId) : Promise.resolve(),
      d2.deletedCount > 0 ? this.releaseFriendSlot(other) : Promise.resolve(),
    ]);
    void this.deps.gateway.invalidateFriends(accountId);
    void this.deps.gateway.invalidateFriends(other);
    const meProfile = await this.deps.meta.batchProfiles([accountId]).then((m) => m.get(accountId));
    if (meProfile) {
      void this.deps.gateway.push(other, { kind: 'friend_update', publicId: meProfile.publicId, added: false });
    }
    return true;
  }

  async blockUser(accountId: string, publicId: string): Promise<boolean> {
    const target = await this.deps.meta.resolveByPublicId(publicId);
    if (!target || target.accountId === accountId) return false;
    const other = target.accountId;
    const now = this.deps.now();
    await Promise.all([
      this.deps.cols.friendEdges.deleteOne({ _id: friendEdgeId(accountId, other) }),
      this.deps.cols.friendEdges.deleteOne({ _id: friendEdgeId(other, accountId) }),
      this.deps.cols.friendRequests.updateMany(
        { $or: [{ from: accountId, to: other, status: 'pending' }, { from: other, to: accountId, status: 'pending' }] },
        { $set: { status: 'cancelled', resolvedAt: now } },
      ),
      this.deps.cols.blockList.updateOne(
        { _id: blockId(accountId, other) },
        { $setOnInsert: { _id: blockId(accountId, other), owner: accountId, target: other, ts: now } },
        { upsert: true },
      ),
    ]);
    void this.deps.gateway.invalidateFriends(accountId);
    void this.deps.gateway.invalidateFriends(other);
    const meProfile = await this.deps.meta.batchProfiles([accountId]).then((m) => m.get(accountId));
    if (meProfile) {
      void this.deps.gateway.push(other, { kind: 'friend_update', publicId: meProfile.publicId, added: false });
    }
    return true;
  }

  async unblockUser(accountId: string, publicId: string): Promise<boolean> {
    const target = await this.deps.meta.resolveByPublicId(publicId);
    if (!target) return false;
    await this.deps.cols.blockList.deleteOne({ _id: blockId(accountId, target.accountId) });
    return true;
  }

  /**
   * File a UGC report against another player (design-doc-audit-2026-07, COMPLIANCE_GLOBAL.md §7 "测试期最低线"
   * — pairs with the existing blockUser above). Deliberately minimal: just captures the report for later admin
   * review (`status` stays 'open'; no auto-block, no notification pipeline — those are follow-ups, not part of
   * the pre-launch minimum bar). Reporting yourself is rejected the same way blocking yourself would be.
   */
  async reportUser(accountId: string, publicId: string, reason: string): Promise<boolean> {
    const target = await this.deps.meta.resolveByPublicId(publicId);
    if (!target || target.accountId === accountId) return false;
    const trimmed = reason.trim().slice(0, REPORT_REASON_MAX);
    await this.deps.cols.reports.insertOne({
      _id: randomUUID(),
      reporterId: accountId,
      targetId: target.accountId,
      reason: trimmed,
      ts: this.deps.now(),
      status: 'open',
    });
    return true;
  }

  /** Reports queue for ops/admin review (CONTENT_MODERATION_DESIGN.md CM11), oldest first. Defaults to 'open'. */
  async listReports(status: ReportDoc['status'] = 'open', limit = 200): Promise<ReportDoc[]> {
    return this.deps.cols.reports.find({ status }).sort({ ts: 1 }).limit(limit).toArray();
  }

  /**
   * Resolve a report (CM9): only flips this doc's own `status` — the reputation-score penalty on 'upheld'
   * is a separate admin→metaserver call (CM7's single enforcement path), deliberately not performed here so
   * socialsvc never has to know about `AccountDoc.flags`/reputation thresholds. Returns false if the report
   * doesn't exist or is not currently 'open' (resolving twice is rejected, not silently idempotent, so admin
   * can surface "already resolved by X" instead of double-counting a penalty call).
   */
  async resolveReport(id: string, resolution: 'dismissed' | 'upheld', resolvedBy: string): Promise<boolean> {
    const res = await this.deps.cols.reports.updateOne(
      { _id: id, status: 'open' },
      { $set: { status: resolution, resolvedBy, resolvedAt: this.deps.now() } },
    );
    return res.matchedCount > 0;
  }
}
