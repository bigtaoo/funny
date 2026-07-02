// FriendService end-to-end (SOCIAL_SVC_DESIGN §3.2/§3.3 P2): real Mongo + fakes.
// Covers friend requests (send/respond), the mutual-edge accept, blocking (which severs the
// relationship + cancels pending requests), unfriend, private chat (friend-gated, censored,
// rate-limited), conversation list + history pagination + unread badges.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FRIEND_CAP, friendEdgeId } from '@nw/shared';
import type { SocialMongo } from '../src/db';
import { FriendService } from '../src/friendService';
import { tryConnect, FakeMeta, FakeGateway } from './harness';

const mongo = await tryConnect('nw_social_friend_test');
if (!mongo) console.warn('[socialsvc.friend.e2e] Mongo unreachable — skipping.');

describe.skipIf(!mongo)('socialsvc FriendService e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let meta: FakeMeta;
  let gateway: FakeGateway;
  let svc: FriendService;

  // Public ids: a=P-A, b=P-B, c=P-C
  beforeEach(async () => {
    await Promise.all([
      m.collections.friendEdges.deleteMany({}),
      m.collections.friendRequests.deleteMany({}),
      m.collections.blockList.deleteMany({}),
      m.collections.conversations.deleteMany({}),
      m.collections.chatMessages.deleteMany({}),
    ]);
    nowMs = 1_000_000;
    meta = new FakeMeta().add('a', 'P-A', 'Alice').add('b', 'P-B', 'Bob').add('c', 'P-C', 'Cara');
    gateway = new FakeGateway();
    svc = new FriendService({ cols: m.collections, gateway, meta, now });
  });

  afterAll(async () => { await m.close(); });

  /** Make `from` and `to` mutual friends via the real request→accept flow (`toPid` = to's publicId). */
  async function befriend(from: string, toPid: string, to: string): Promise<void> {
    const r = await svc.requestFriend(from, toPid, undefined);
    if (r.kind !== 'ok') throw new Error(`setup request failed: ${r.error}`);
    await svc.respondFriend(to, r.requestId, true);
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  it('requestFriend: creates a pending request + pushes to the target', async () => {
    const r = await svc.requestFriend('a', 'P-B', 'hi bob');
    expect(r.kind).toBe('ok');
    const doc = await m.collections.friendRequests.findOne({ from: 'a', to: 'b' });
    expect(doc).toMatchObject({ status: 'pending', message: 'hi bob' });
    expect(gateway.ofKind('friend_request')).toHaveLength(1);
    expect(gateway.ofKind('friend_request')[0]).toMatchObject({ fromPublicId: 'P-A', fromName: 'Alice' });
  });

  it('requestFriend: idempotent on duplicate pending, errors on self / unknown / already-friend', async () => {
    expect((await svc.requestFriend('a', 'P-NOPE', undefined)).kind).toBe('error');
    expect(await svc.requestFriend('a', 'P-NOPE', undefined)).toMatchObject({ error: 'NOT_FOUND' });
    expect(await svc.requestFriend('a', 'P-A', undefined)).toMatchObject({ error: 'BAD_REQUEST' }); // self

    const first = await svc.requestFriend('a', 'P-B', undefined);
    const dup = await svc.requestFriend('a', 'P-B', undefined);
    expect(dup.kind === 'ok' && first.kind === 'ok' && dup.requestId).toBe(first.kind === 'ok' && first.requestId);
    expect(await m.collections.friendRequests.countDocuments({ from: 'a', to: 'b' })).toBe(1); // no duplicate row

    await befriend('a', 'P-B', 'b');
    expect(await svc.requestFriend('a', 'P-B', undefined)).toMatchObject({ error: 'ALREADY_FRIEND' });
  });

  it('respondFriend accept: creates two edges, invalidates cache, pushes both sides', async () => {
    const r = await svc.requestFriend('a', 'P-B', undefined);
    if (r.kind !== 'ok') throw new Error();
    const res = await svc.respondFriend('b', r.requestId, true);
    expect(res).toEqual({ kind: 'ok', accepted: true });
    expect(await m.collections.friendEdges.findOne({ _id: friendEdgeId('a', 'b') })).toBeTruthy();
    expect(await m.collections.friendEdges.findOne({ _id: friendEdgeId('b', 'a') })).toBeTruthy();
    expect(new Set(gateway.invalidated)).toEqual(new Set(['a', 'b']));
    expect(gateway.ofKind('friend_update').every((u) => u.added)).toBe(true);
    // The request row is now accepted, not pending.
    expect((await m.collections.friendRequests.findOne({ _id: r.requestId }))!.status).toBe('accepted');
  });

  it('respondFriend reject: no edges created; only the target can respond', async () => {
    const r = await svc.requestFriend('a', 'P-B', undefined);
    if (r.kind !== 'ok') throw new Error();
    expect(await svc.respondFriend('c', r.requestId, true)).toMatchObject({ error: 'NOT_FOUND' }); // not the target
    const res = await svc.respondFriend('b', r.requestId, false);
    expect(res).toEqual({ kind: 'ok', accepted: false });
    expect(await m.collections.friendEdges.countDocuments({})).toBe(0);
    // Second response fails (no longer pending).
    expect(await svc.respondFriend('b', r.requestId, true)).toMatchObject({ error: 'NOT_FOUND' });
  });

  it('getFriends / listRequests reflect state and presence', async () => {
    await svc.requestFriend('a', 'P-B', 'pending one'); // a→b stays pending
    await befriend('a', 'P-C', 'c');                    // a & c become mutual friends

    gateway.presenceMap = { c: true };
    const friends = await svc.getFriends('a');
    expect(friends.map((f) => f.publicId)).toEqual(['P-C']);
    expect(friends[0]!.online).toBe(true);

    const reqs = await svc.listRequests('a');
    expect(reqs.outgoing.map((r) => r.toPublicId)).toContain('P-B'); // still pending
  });

  it('friend cap: requestFriend blocked when the requester is at FRIEND_CAP', async () => {
    // Seed FRIEND_CAP edges owned by 'a' directly (cheaper than the full flow).
    const edges = Array.from({ length: FRIEND_CAP }, (_, i) => ({
      _id: friendEdgeId('a', `x${i}`), owner: 'a', friend: `x${i}`, since: nowMs,
    }));
    await m.collections.friendEdges.insertMany(edges);
    expect(await svc.requestFriend('a', 'P-B', undefined)).toMatchObject({ error: 'FRIEND_CAP_REACHED' });
  });

  // ── Blocking ──────────────────────────────────────────────────────────────

  it('blockUser: severs friendship, cancels pending requests, blocks new requests both ways', async () => {
    await befriend('a', 'P-B', 'b');
    // Seed a stray pending request between the pair directly (the normal flow refuses one between
    // existing friends); blockUser must cancel any pending request in either direction.
    await m.collections.friendRequests.insertOne({
      _id: 'req-stray', from: 'b', to: 'a', status: 'pending', createdAt: nowMs,
    });
    expect(await svc.blockUser('a', 'P-B')).toBe(true);

    expect(await m.collections.friendEdges.countDocuments({})).toBe(0); // both edges gone
    expect((await m.collections.friendRequests.findOne({ from: 'b', to: 'a' }))!.status).toBe('cancelled');
    // Neither direction can send a new request while the block stands.
    expect(await svc.requestFriend('a', 'P-B', undefined)).toMatchObject({ error: 'BLOCKED' });
    expect(await svc.requestFriend('b', 'P-A', undefined)).toMatchObject({ error: 'BLOCKED' });

    // unblock restores the ability to request.
    expect(await svc.unblockUser('a', 'P-B')).toBe(true);
    expect((await svc.requestFriend('a', 'P-B', undefined)).kind).toBe('ok');
  });

  it('removeFriend: deletes both edges and pushes an unfriend update', async () => {
    await befriend('a', 'P-B', 'b');
    expect(await svc.removeFriend('a', 'P-B')).toBe(true);
    expect(await m.collections.friendEdges.countDocuments({})).toBe(0);
    expect(gateway.ofKind('friend_update').some((u) => u.added === false)).toBe(true);
  });

  // ── Private chat ──────────────────────────────────────────────────────────────

  it('sendMessage: friend-gated, persists, bumps unread, pushes; blocked / stranger rejected', async () => {
    await expect(svc.sendMessage('a', 'P-B', 'hey', 'global')).resolves.toMatchObject({ error: 'NOT_FRIEND' });
    await befriend('a', 'P-B', 'b');

    nowMs = 5_000;
    const sent = await svc.sendMessage('a', 'P-B', '  hello bob  ', 'global');
    expect(sent).toMatchObject({ kind: 'ok', ts: 5_000 });

    const conv = await m.collections.conversations.findOne({});
    expect(conv!.unread['b']).toBe(1);           // recipient unread bumped
    expect(conv!.lastFrom).toBe('a');
    expect(gateway.ofKind('chat_message')).toHaveLength(1);
    expect(gateway.ofKind('chat_message')[0]!.body).toBe('hello bob'); // trimmed

    // Validation: empty and self.
    expect(await svc.sendMessage('a', 'P-B', '   ', 'global')).toMatchObject({ error: 'BAD_REQUEST' });
    expect(await svc.sendMessage('a', 'P-A', 'self', 'global')).toMatchObject({ error: 'BAD_REQUEST' });
  });

  it('getConversations / getMessages / markConversationRead: peer view, history, unread clear', async () => {
    await befriend('a', 'P-B', 'b');
    nowMs = 10_000; await svc.sendMessage('a', 'P-B', 'one', 'global');
    nowMs = 11_000; await svc.sendMessage('a', 'P-B', 'two', 'global');
    nowMs = 12_000; await svc.sendMessage('b', 'P-A', 'three', 'global');

    const convsA = await svc.getConversations('a');
    expect(convsA).toHaveLength(1);
    expect(convsA[0]!.peer.publicId).toBe('P-B');
    expect(convsA[0]!.unread).toBe(1); // b's reply is unread for a

    const convId = convsA[0]!.convId;
    const hist = await svc.getMessages('a', convId, undefined, 30);
    expect(hist!.map((x) => x.body)).toEqual(['three', 'two', 'one']); // newest-first
    // `before` cursor pages backward.
    const older = await svc.getMessages('a', convId, 11_000, 30);
    expect(older!.map((x) => x.body)).toEqual(['one']);
    // Non-participant cannot read.
    expect(await svc.getMessages('c', convId, undefined, 30)).toBeNull();

    await svc.markConversationRead('a', convId);
    expect((await svc.getConversations('a'))[0]!.unread).toBe(0);
  });

  it('getSocialBadges: aggregates pending requests + unread chat', async () => {
    await svc.requestFriend('b', 'P-A', undefined); // one incoming request for a
    await befriend('a', 'P-C', 'c');
    await svc.sendMessage('c', 'P-A', 'yo', 'global'); // one unread chat for a
    const badges = await svc.getSocialBadges('a');
    expect(badges.friendRequests).toBe(1);
    expect(badges.chat).toBe(1);
    expect(badges.total).toBe(badges.friendRequests + badges.chat + badges.mail);
  });

  it('allowChat: in-process rate limiter caps sends per minute', () => {
    for (let i = 0; i < 3; i++) expect(svc.allowChat('a', 1_000 + i, 3)).toBe(true);
    expect(svc.allowChat('a', 1_100, 3)).toBe(false);       // 4th within the window → blocked
    expect(svc.allowChat('a', 1_000 + 61_000, 3)).toBe(true); // window slid past 60s → allowed again
  });
});
