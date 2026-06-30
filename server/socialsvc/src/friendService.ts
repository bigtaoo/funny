// Friend + private-chat service (SOCIAL_SVC_DESIGN §3.2 / §3.3 P2).
// Logic aligned with metaserver/src/social.ts; data layer switched to the nw_social collections;
// publicId reverse-lookup changed to call SocialMetaClient (no direct connection to the accounts database).
import { randomUUID } from 'node:crypto';
import type { SocialCollections } from './db';
import type { SocialGatewayClient } from './gatewayClient';
import type { SocialMetaClient } from './metaClient';
import type { ProfileView, FriendView, FriendRequestView, ConversationView, ChatMessageView, SocialBadges } from '@nw/shared';
import {
  FRIEND_CAP,
  friendEdgeId,
  blockId,
  conversationId,
  CHAT_BODY_MAX,
  CHAT_HISTORY_PAGE_MAX,
  censorChat,
  type ChatRegion,
} from '@nw/shared';

export type SocialError =
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'ALREADY_FRIEND'
  | 'FRIEND_CAP_REACHED'
  | 'NOT_FRIEND'
  | 'BLOCKED';

interface Deps {
  cols: SocialCollections;
  gateway: SocialGatewayClient;
  meta: SocialMetaClient;
  now: () => number;
}

async function hasBlock(cols: SocialCollections, owner: string, target: string): Promise<boolean> {
  return !!(await cols.blockList.findOne({ _id: blockId(owner, target) }));
}

async function isFriend(cols: SocialCollections, owner: string, friend: string): Promise<boolean> {
  return !!(await cols.friendEdges.findOne({ _id: friendEdgeId(owner, friend) }));
}

export class FriendService {
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

  // ── Friends ──────────────────────────────────────────────────────────────────

  /** Fetch only the accountId list (for presence fan-out; no profile data needed). */
  async getFriendAccountIds(accountId: string): Promise<string[]> {
    const edges = await this.cols.friendEdges.find({ owner: accountId }, { projection: { friend: 1 } }).toArray();
    return edges.map((e) => e.friend);
  }

  /** Batch accountId → publicId lookup (for presence fan-out). Missing accountIds are silently skipped. */
  async batchPublicIds(accountIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (accountIds.length === 0) return out;
    const profiles = await this.meta.batchProfiles(accountIds);
    for (const [id, p] of profiles) {
      if (p.publicId) out.set(id, p.publicId);
    }
    return out;
  }

  async getFriends(accountId: string): Promise<FriendView[]> {
    const edges = await this.cols.friendEdges.find({ owner: accountId }).sort({ since: -1 }).toArray();
    if (edges.length === 0) return [];
    const friendIds = edges.map((e) => e.friend);
    const profiles = await this.meta.batchProfiles(friendIds);

    // online presence
    const presence = this.gateway.available ? await this.gateway.presence(friendIds) : {};

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
      });
    }
    return out;
  }

  async listRequests(accountId: string): Promise<{ incoming: FriendRequestView[]; outgoing: FriendRequestView[] }> {
    const [incomingDocs, outgoingDocs] = await Promise.all([
      this.cols.friendRequests.find({ to: accountId, status: 'pending' }).sort({ createdAt: -1 }).toArray(),
      this.cols.friendRequests.find({ from: accountId, status: 'pending' }).sort({ createdAt: -1 }).toArray(),
    ]);
    const allIds = [...new Set([...incomingDocs.map((d) => d.from), ...incomingDocs.map((d) => d.to), ...outgoingDocs.map((d) => d.from), ...outgoingDocs.map((d) => d.to)])];
    const profiles = await this.meta.batchProfiles(allIds);

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

  async getSocialBadges(accountId: string): Promise<SocialBadges> {
    const now = this.now();
    const [friendRequests, chat, mail] = await Promise.all([
      this.cols.friendRequests.countDocuments({ to: accountId, status: 'pending' }),
      this.cols.conversations.countDocuments({ members: accountId, [`unread.${accountId}`]: { $gt: 0 } }),
      this.cols.mails.countDocuments({ to: accountId, readAt: { $exists: false }, expireAt: { $gt: new Date(now) } }),
    ]);
    return { friendRequests, chat, mail, total: friendRequests + chat + mail };
  }

  async searchFriend(publicId: string): Promise<{ profile: ProfileView } | null> {
    const found = await this.meta.resolveByPublicId(publicId);
    if (!found) return null;
    return { profile: found.profile };
  }

  async requestFriend(
    accountId: string,
    publicId: string,
    message: string | undefined,
  ): Promise<{ kind: 'ok'; requestId: string; to: string; fromProfile: ProfileView; message?: string } | { kind: 'error'; error: SocialError }> {
    const target = await this.meta.resolveByPublicId(publicId);
    if (!target) return { kind: 'error', error: 'NOT_FOUND' };
    const to = target.accountId;
    if (to === accountId) return { kind: 'error', error: 'BAD_REQUEST' };
    if (await isFriend(this.cols, accountId, to)) return { kind: 'error', error: 'ALREADY_FRIEND' };
    if ((await hasBlock(this.cols, to, accountId)) || (await hasBlock(this.cols, accountId, to))) {
      return { kind: 'error', error: 'BLOCKED' };
    }
    const myFriendCount = await this.cols.friendEdges.countDocuments({ owner: accountId });
    if (myFriendCount >= FRIEND_CAP) return { kind: 'error', error: 'FRIEND_CAP_REACHED' };

    const fromProfile = await this.meta.batchProfiles([accountId]).then((m) => m.get(accountId) ?? null);
    if (!fromProfile) return { kind: 'error', error: 'BAD_REQUEST' };

    const existing = await this.cols.friendRequests.findOne({ from: accountId, to, status: 'pending' });
    if (existing) {
      return { kind: 'ok', requestId: existing._id, to, fromProfile, message: existing.message };
    }
    const requestId = randomUUID();
    const now = this.now();
    await this.cols.friendRequests.insertOne({
      _id: requestId,
      from: accountId,
      to,
      status: 'pending',
      ...(message ? { message } : {}),
      createdAt: now,
    });
    void this.gateway.push(to, {
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
    const reqDoc = await this.cols.friendRequests.findOne({ _id: requestId });
    if (!reqDoc || reqDoc.to !== accountId || reqDoc.status !== 'pending') {
      return { kind: 'error', error: 'NOT_FOUND' };
    }
    const other = reqDoc.from;
    const now = this.now();
    const claimed = await this.cols.friendRequests.findOneAndUpdate(
      { _id: requestId, status: 'pending' },
      { $set: { status: accept ? 'accepted' : 'rejected', resolvedAt: now } },
    );
    if (!claimed) return { kind: 'error', error: 'NOT_FOUND' };

    if (accept) {
      const [cntMe, cntOther] = await Promise.all([
        this.cols.friendEdges.countDocuments({ owner: accountId }),
        this.cols.friendEdges.countDocuments({ owner: other }),
      ]);
      if (cntMe >= FRIEND_CAP || cntOther >= FRIEND_CAP) {
        return { kind: 'error', error: 'FRIEND_CAP_REACHED' };
      }
      await Promise.all([
        this.cols.friendEdges.updateOne(
          { _id: friendEdgeId(accountId, other) },
          { $setOnInsert: { _id: friendEdgeId(accountId, other), owner: accountId, friend: other, since: now } },
          { upsert: true },
        ),
        this.cols.friendEdges.updateOne(
          { _id: friendEdgeId(other, accountId) },
          { $setOnInsert: { _id: friendEdgeId(other, accountId), owner: other, friend: accountId, since: now } },
          { upsert: true },
        ),
      ]);
      // Friend relationship changed → invalidate gateway presence cache + bidirectional push
      void this.gateway.invalidateFriends(accountId);
      void this.gateway.invalidateFriends(other);
      const profiles = await this.meta.batchProfiles([accountId, other]);
      const meProfile = profiles.get(accountId);
      const otherProfile = profiles.get(other);
      if (meProfile && otherProfile) {
        void this.gateway.push(other, { kind: 'friend_update', publicId: meProfile.publicId, added: true });
        void this.gateway.push(accountId, { kind: 'friend_update', publicId: otherProfile.publicId, added: true });
      }
    }
    return { kind: 'ok', accepted: accept };
  }

  async removeFriend(accountId: string, publicId: string): Promise<boolean> {
    const target = await this.meta.resolveByPublicId(publicId);
    if (!target) return false;
    const other = target.accountId;
    await Promise.all([
      this.cols.friendEdges.deleteOne({ _id: friendEdgeId(accountId, other) }),
      this.cols.friendEdges.deleteOne({ _id: friendEdgeId(other, accountId) }),
    ]);
    void this.gateway.invalidateFriends(accountId);
    void this.gateway.invalidateFriends(other);
    const meProfile = await this.meta.batchProfiles([accountId]).then((m) => m.get(accountId));
    if (meProfile) {
      void this.gateway.push(other, { kind: 'friend_update', publicId: meProfile.publicId, added: false });
    }
    return true;
  }

  async blockUser(accountId: string, publicId: string): Promise<boolean> {
    const target = await this.meta.resolveByPublicId(publicId);
    if (!target || target.accountId === accountId) return false;
    const other = target.accountId;
    const now = this.now();
    await Promise.all([
      this.cols.friendEdges.deleteOne({ _id: friendEdgeId(accountId, other) }),
      this.cols.friendEdges.deleteOne({ _id: friendEdgeId(other, accountId) }),
      this.cols.friendRequests.updateMany(
        { $or: [{ from: accountId, to: other, status: 'pending' }, { from: other, to: accountId, status: 'pending' }] },
        { $set: { status: 'cancelled', resolvedAt: now } },
      ),
      this.cols.blockList.updateOne(
        { _id: blockId(accountId, other) },
        { $setOnInsert: { _id: blockId(accountId, other), owner: accountId, target: other, ts: now } },
        { upsert: true },
      ),
    ]);
    void this.gateway.invalidateFriends(accountId);
    void this.gateway.invalidateFriends(other);
    const meProfile = await this.meta.batchProfiles([accountId]).then((m) => m.get(accountId));
    if (meProfile) {
      void this.gateway.push(other, { kind: 'friend_update', publicId: meProfile.publicId, added: false });
    }
    return true;
  }

  async unblockUser(accountId: string, publicId: string): Promise<boolean> {
    const target = await this.meta.resolveByPublicId(publicId);
    if (!target) return false;
    await this.cols.blockList.deleteOne({ _id: blockId(accountId, target.accountId) });
    return true;
  }

  // ── Private chat ──────────────────────────────────────────────────────────────────

  /** Per-minute message send rate limiter (in-process sliding window). */
  private readonly chatRate = new Map<string, number[]>();

  allowChat(accountId: string, now: number, ratePerMin = 30): boolean {
    const win = this.chatRate.get(accountId)?.filter((t) => now - t < 60_000) ?? [];
    if (win.length >= ratePerMin) return false;
    win.push(now);
    this.chatRate.set(accountId, win);
    return true;
  }

  async sendMessage(
    accountId: string,
    toPublicId: string,
    bodyRaw: string,
    region: ChatRegion,
  ): Promise<{ kind: 'ok'; messageId: string; ts: number } | { kind: 'error'; error: SocialError }> {
    const target = await this.meta.resolveByPublicId(toPublicId);
    if (!target) return { kind: 'error', error: 'NOT_FOUND' };
    const to = target.accountId;
    if (to === accountId) return { kind: 'error', error: 'BAD_REQUEST' };
    const trimmed = (bodyRaw ?? '').trim();
    if (!trimmed || trimmed.length > CHAT_BODY_MAX) return { kind: 'error', error: 'BAD_REQUEST' };
    if ((await hasBlock(this.cols, to, accountId)) || (await hasBlock(this.cols, accountId, to))) {
      return { kind: 'error', error: 'BLOCKED' };
    }
    if (!(await isFriend(this.cols, accountId, to))) return { kind: 'error', error: 'NOT_FRIEND' };

    const fromProfile = await this.meta.batchProfiles([accountId]).then((m) => m.get(accountId) ?? null);
    if (!fromProfile) return { kind: 'error', error: 'BAD_REQUEST' };

    const body = censorChat(trimmed, region).text;
    const convId = conversationId(accountId, to);
    const messageId = randomUUID();
    const now = this.now();
    await this.cols.chatMessages.insertOne({
      _id: messageId,
      convId,
      from: accountId,
      body,
      kind: 'text',
      ts: new Date(now),
    });
    await this.cols.conversations.updateOne(
      { _id: convId },
      {
        $setOnInsert: { _id: convId, members: [accountId < to ? accountId : to, accountId < to ? to : accountId] as [string, string] },
        $set: { lastBody: body, lastFrom: accountId, lastTs: now },
        $inc: { [`unread.${to}`]: 1 },
      },
      { upsert: true },
    );
    void this.gateway.push(to, {
      kind: 'chat_message',
      convId,
      fromPublicId: fromProfile.publicId,
      fromName: fromProfile.displayName,
      body,
      ts: now,
    });
    return { kind: 'ok', messageId, ts: now };
  }

  async getConversations(accountId: string): Promise<ConversationView[]> {
    const docs = await this.cols.conversations.find({ members: accountId }).sort({ lastTs: -1 }).toArray();
    if (docs.length === 0) return [];
    const peerIds = docs.map((d) => (d.members[0] === accountId ? d.members[1] : d.members[0]));
    const allIds = [...new Set([accountId, ...peerIds])];
    const profiles = await this.meta.batchProfiles(allIds);
    const myProfile = profiles.get(accountId);
    const myPid = myProfile?.publicId ?? '';

    const out: ConversationView[] = [];
    for (const d of docs) {
      const peerId = d.members[0] === accountId ? d.members[1] : d.members[0];
      const peer = profiles.get(peerId);
      if (!peer) continue;
      out.push({
        convId: d._id,
        peer,
        ...(d.lastBody ? { lastBody: d.lastBody } : {}),
        ...(d.lastFrom ? { lastFrom: d.lastFrom === accountId ? myPid : peer.publicId } : {}),
        lastTs: d.lastTs,
        unread: (d.unread as Record<string, number> | undefined)?.[accountId] ?? 0,
      });
    }
    return out;
  }

  async getMessages(accountId: string, convId: string, before: number | undefined, limit: number): Promise<ChatMessageView[] | null> {
    const conv = await this.cols.conversations.findOne({ _id: convId });
    if (!conv || !conv.members.includes(accountId)) return null;
    const lim = Math.min(CHAT_HISTORY_PAGE_MAX, Math.max(1, Math.floor(limit) || 30));
    const q: Record<string, unknown> = { convId };
    if (before !== undefined && Number.isFinite(before)) q.ts = { $lt: new Date(before) };
    const docs = await this.cols.chatMessages.find(q).sort({ ts: -1 }).limit(lim).toArray();
    const profiles = await this.meta.batchProfiles([...conv.members]);
    const pid = new Map<string, string>();
    for (const [id, p] of profiles) pid.set(id, p.publicId);
    return docs.map((d) => ({
      messageId: d._id,
      convId: d.convId,
      fromPublicId: pid.get(d.from) ?? '',
      body: d.body,
      kind: d.kind,
      ts: d.ts instanceof Date ? d.ts.getTime() : Number(d.ts),
    }));
  }

  async markConversationRead(accountId: string, convId: string): Promise<void> {
    await this.cols.conversations.updateOne(
      { _id: convId, members: accountId },
      { $set: { [`unread.${accountId}`]: 0 } },
    );
  }
}
