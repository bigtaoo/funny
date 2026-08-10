// Friend + private-chat service — 1:1 chat (SOCIAL_SVC_DESIGN §3.3 P2). Split out of friendService.ts
// (see ../friendService.ts for the composing facade).
import { randomUUID } from 'node:crypto';
import type { ConversationView, ChatMessageView } from '@nw/shared';
import { CHAT_BODY_MAX, CHAT_HISTORY_PAGE_MAX, censorChat, conversationId, type ChatRegion } from '@nw/shared';
import type { FriendServiceDeps, SocialError } from './types';
import { hasBlock, isFriend } from './shared';

export class FriendChatService {
  /** Per-minute message send rate limiter (in-process sliding window). */
  private readonly chatRate = new Map<string, number[]>();
  private lastChatRateSweepAt = 0;
  private static readonly CHAT_RATE_WINDOW_MS = 60_000;

  constructor(private readonly deps: FriendServiceDeps) {}

  /** Piggyback a full cleanup pass onto normal chat traffic (at most once per window) instead of a
   * background timer — same pattern as metaserver's SlidingRateLimiter.maybeSweep. Without it, every
   * account that has ever sent a chat message keeps a (possibly now-empty) entry in this map forever. */
  private maybeSweepChatRate(now: number): void {
    if (now - this.lastChatRateSweepAt < FriendChatService.CHAT_RATE_WINDOW_MS) return;
    this.lastChatRateSweepAt = now;
    for (const [k, timestamps] of this.chatRate) {
      const fresh = timestamps.filter((t) => now - t < FriendChatService.CHAT_RATE_WINDOW_MS);
      if (fresh.length === 0) this.chatRate.delete(k);
      else if (fresh.length !== timestamps.length) this.chatRate.set(k, fresh);
    }
  }

  allowChat(accountId: string, now: number, ratePerMin = 30): boolean {
    this.maybeSweepChatRate(now);
    const win = this.chatRate.get(accountId)?.filter((t) => now - t < FriendChatService.CHAT_RATE_WINDOW_MS) ?? [];
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
    const target = await this.deps.meta.resolveByPublicId(toPublicId);
    if (!target) return { kind: 'error', error: 'NOT_FOUND' };
    const to = target.accountId;
    if (to === accountId) return { kind: 'error', error: 'BAD_REQUEST' };
    const trimmed = (bodyRaw ?? '').trim();
    if (!trimmed || trimmed.length > CHAT_BODY_MAX) return { kind: 'error', error: 'BAD_REQUEST' };
    if ((await hasBlock(this.deps.cols, to, accountId)) || (await hasBlock(this.deps.cols, accountId, to))) {
      return { kind: 'error', error: 'BLOCKED' };
    }
    if (!(await isFriend(this.deps.cols, accountId, to))) return { kind: 'error', error: 'NOT_FRIEND' };

    const fromProfile = await this.deps.meta.batchProfiles([accountId]).then((m) => m.get(accountId) ?? null);
    if (!fromProfile) return { kind: 'error', error: 'BAD_REQUEST' };
    // CONTENT_MODERATION_DESIGN.md CM7.1: mute check piggybacked on this profile fetch (no extra round trip).
    if (fromProfile.mutedUntil && fromProfile.mutedUntil > this.deps.now()) return { kind: 'error', error: 'MUTED' };

    const body = censorChat(trimmed, region, this.deps.wordlists).text;
    const convId = conversationId(accountId, to);
    const messageId = randomUUID();
    const now = this.deps.now();
    await this.deps.cols.chatMessages.insertOne({
      _id: messageId,
      convId,
      from: accountId,
      body,
      kind: 'text',
      ts: new Date(now),
    });
    await this.deps.cols.conversations.updateOne(
      { _id: convId },
      {
        $setOnInsert: { _id: convId, members: [accountId < to ? accountId : to, accountId < to ? to : accountId] as [string, string] },
        $set: { lastBody: body, lastFrom: accountId, lastTs: now },
        $inc: { [`unread.${to}`]: 1 },
      },
      { upsert: true },
    );
    void this.deps.gateway.push(to, {
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
    const docs = await this.deps.cols.conversations.find({ members: accountId }).sort({ lastTs: -1 }).toArray();
    if (docs.length === 0) return [];
    const peerIds = docs.map((d) => (d.members[0] === accountId ? d.members[1] : d.members[0]));
    const allIds = [...new Set([accountId, ...peerIds])];
    const profiles = await this.deps.meta.batchProfiles(allIds);
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
    const conv = await this.deps.cols.conversations.findOne({ _id: convId });
    if (!conv || !conv.members.includes(accountId)) return null;
    const lim = Math.min(CHAT_HISTORY_PAGE_MAX, Math.max(1, Math.floor(limit) || 30));
    const q: Record<string, unknown> = { convId };
    if (before !== undefined && Number.isFinite(before)) q.ts = { $lt: new Date(before) };
    const docs = await this.deps.cols.chatMessages.find(q).sort({ ts: -1 }).limit(lim).toArray();
    const profiles = await this.deps.meta.batchProfiles([...conv.members]);
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
    await this.deps.cols.conversations.updateOne(
      { _id: convId, members: accountId },
      { $set: { [`unread.${accountId}`]: 0 } },
    );
  }
}
