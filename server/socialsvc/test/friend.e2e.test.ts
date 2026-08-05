// FriendService end-to-end (SOCIAL_SVC_DESIGN §3.2/§3.3 P2): real Mongo + fakes.
// Covers friend requests (send/respond), the mutual-edge accept, blocking (which severs the
// relationship + cancels pending requests), unfriend, private chat (friend-gated, censored,
// rate-limited), conversation list + history pagination + unread badges.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FRIEND_CAP, friendEdgeId, REPORT_REASON_MAX } from '@nw/shared';
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
      m.collections.friendCounts.deleteMany({}),
      m.collections.blockList.deleteMany({}),
      m.collections.conversations.deleteMany({}),
      m.collections.chatMessages.deleteMany({}),
      m.collections.reports.deleteMany({}),
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
    expect(gateway.ofKind('friend_update').length).toBeGreaterThan(0);
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

  // Regression for the 2026-08-04 fix: the old FRIEND_CAP gate in respondFriend was a plain
  // countDocuments(friendEdges) read followed by a SEPARATE edge-insert write, with nothing atomic
  // between them. Two concurrent accepts of DIFFERENT incoming requests for the SAME (one-slot-from-cap)
  // account could both read a count under FRIEND_CAP before either write landed, overrunning the cap.
  it('friend cap: CONCURRENT accepts of two different incoming requests cannot both push the same account past FRIEND_CAP', async () => {
    // Seed 'a' to exactly FRIEND_CAP-1 (one slot remaining).
    const edges = Array.from({ length: FRIEND_CAP - 1 }, (_, i) => ({
      _id: friendEdgeId('a', `x${i}`), owner: 'a', friend: `x${i}`, since: nowMs,
    }));
    await m.collections.friendEdges.insertMany(edges);
    meta.add('p1', 'P-P1', 'P1').add('p2', 'P-P2', 'P2');
    const r1 = await svc.requestFriend('p1', 'P-A', undefined);
    const r2 = await svc.requestFriend('p2', 'P-A', undefined);
    if (r1.kind !== 'ok' || r2.kind !== 'ok') throw new Error('setup failed');

    const [res1, res2] = await Promise.all([
      svc.respondFriend('a', r1.requestId, true),
      svc.respondFriend('a', r2.requestId, true),
    ]);
    const oks = [res1, res2].filter((r) => r.kind === 'ok');
    const errs = [res1, res2].filter((r) => r.kind === 'error');
    expect(oks).toHaveLength(1);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ error: 'FRIEND_CAP_REACHED' });

    // Authoritative check: 'a' must land at EXACTLY FRIEND_CAP real edges, never FRIEND_CAP+1.
    expect(await m.collections.friendEdges.countDocuments({ owner: 'a' })).toBe(FRIEND_CAP);
    expect((await m.collections.friendCounts.findOne({ _id: 'a' }))!.count).toBe(FRIEND_CAP);

    // The loser's request must be restored to 'pending' (not stuck 'accepted' with no friendship ever
    // created — an adjacent bug fixed alongside the race itself), so the requester can retry later.
    const loserReqId = res1.kind === 'error' ? r1.requestId : r2.requestId;
    const winnerReqId = res1.kind === 'error' ? r2.requestId : r1.requestId;
    expect((await m.collections.friendRequests.findOne({ _id: loserReqId }))!.status).toBe('pending');
    expect((await m.collections.friendRequests.findOne({ _id: winnerReqId }))!.status).toBe('accepted');
  });

  it('friend cap: when the PEER is at cap, the accepter\'s own slot claim is rolled back (no orphan increment)', async () => {
    // 'b' (the requester) is already at FRIEND_CAP; 'a' (the accepter) has room.
    const edges = Array.from({ length: FRIEND_CAP }, (_, i) => ({
      _id: friendEdgeId('b', `y${i}`), owner: 'b', friend: `y${i}`, since: nowMs,
    }));
    await m.collections.friendEdges.insertMany(edges);
    // Seed a pending request from b to a directly — simulates a request sent back when b still had room
    // (the normal requestFriend flow would itself now refuse to create a NEW one from an already-full b).
    await m.collections.friendRequests.insertOne({ _id: 'req-peer-full', from: 'b', to: 'a', status: 'pending', createdAt: nowMs });

    const res = await svc.respondFriend('a', 'req-peer-full', true);
    expect(res).toMatchObject({ error: 'FRIEND_CAP_REACHED' });
    expect((await m.collections.friendCounts.findOne({ _id: 'a' }))?.count ?? 0).toBe(0); // rolled back, not left at 1
    expect(await m.collections.friendEdges.countDocuments({ owner: 'a' })).toBe(0);
    expect((await m.collections.friendRequests.findOne({ _id: 'req-peer-full' }))!.status).toBe('pending'); // not lost
  });

  it('removeFriend releases both accounts\' claimed slots so a subsequent accept can succeed again; a redundant call does not decrement below 0', async () => {
    await befriend('a', 'P-B', 'b');
    expect((await m.collections.friendCounts.findOne({ _id: 'a' }))!.count).toBe(1);
    expect((await m.collections.friendCounts.findOne({ _id: 'b' }))!.count).toBe(1);

    expect(await svc.removeFriend('a', 'P-B')).toBe(true);
    expect((await m.collections.friendCounts.findOne({ _id: 'a' }))!.count).toBe(0);
    expect((await m.collections.friendCounts.findOne({ _id: 'b' }))!.count).toBe(0);

    // Redundant removeFriend (already removed, target still resolves) must not decrement past 0.
    expect(await svc.removeFriend('a', 'P-B')).toBe(true);
    expect((await m.collections.friendCounts.findOne({ _id: 'a' }))!.count).toBe(0);

    // The freed slot is real: 'a' can befriend someone new right after.
    await befriend('a', 'P-C', 'c');
    expect((await m.collections.friendCounts.findOne({ _id: 'a' }))!.count).toBe(1);
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

  // ── UGC report (design-doc-audit-2026-07, COMPLIANCE_GLOBAL.md §7) ────────────────────

  it('reportUser: captures the report (open, oldest-first) without touching friendship/block state', async () => {
    await befriend('a', 'P-B', 'b');
    expect(await svc.reportUser('a', 'P-B', 'spamming private chat')).toBe(true);
    nowMs += 1000;
    expect(await svc.reportUser('a', 'P-C', 'harassment')).toBe(true);

    // Friendship (a↔b) is untouched — reporting is not the same action as blocking.
    expect(await m.collections.friendEdges.countDocuments({})).toBe(2);

    const open = await svc.listReports();
    expect(open).toHaveLength(2);
    expect(open[0]).toMatchObject({ reporterId: 'a', targetId: 'b', reason: 'spamming private chat', status: 'open' });
    expect(open[1]).toMatchObject({ reporterId: 'a', targetId: 'c', reason: 'harassment', status: 'open' });
  });

  it('reportUser: rejects reporting yourself or a nonexistent player', async () => {
    expect(await svc.reportUser('a', 'P-A', 'self-report attempt')).toBe(false);
    expect(await svc.reportUser('a', 'P-NOPE', 'ghost')).toBe(false);
    expect(await svc.listReports()).toHaveLength(0);
  });

  it('reportUser: reason is trimmed and capped at REPORT_REASON_MAX', async () => {
    const tooLong = 'x'.repeat(600);
    await svc.reportUser('a', 'P-B', `  ${tooLong}  `);
    const [doc] = await svc.listReports();
    expect(doc!.reason.length).toBe(REPORT_REASON_MAX);
    expect(doc!.reason.startsWith(' ')).toBe(false); // leading/trailing whitespace trimmed first
  });

  // ── Report resolve (CONTENT_MODERATION_DESIGN.md CM9/P4) ────────────────────────────

  it('resolveReport: dismissed/upheld move the report out of the open queue and stamp resolvedBy/resolvedAt', async () => {
    await svc.reportUser('a', 'P-B', 'spamming');
    const [open] = await svc.listReports();
    nowMs += 500;
    expect(await svc.resolveReport(open!._id, 'upheld', 'admin-1')).toBe(true);

    expect(await svc.listReports('open')).toHaveLength(0);
    const [resolved] = await svc.listReports('upheld');
    expect(resolved).toMatchObject({ _id: open!._id, status: 'upheld', resolvedBy: 'admin-1' });
    expect(resolved!.resolvedAt).toBe(nowMs);
  });

  it('resolveReport: returns false for an unknown id or a report that is not open (no double-resolve)', async () => {
    expect(await svc.resolveReport('nonexistent', 'dismissed', 'admin-1')).toBe(false);

    await svc.reportUser('a', 'P-B', 'spamming');
    const [open] = await svc.listReports();
    expect(await svc.resolveReport(open!._id, 'dismissed', 'admin-1')).toBe(true);
    expect(await svc.resolveReport(open!._id, 'upheld', 'admin-2')).toBe(false);
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

  it('sendMessage: rejects delivery while the sender is muted (CONTENT_MODERATION_DESIGN.md CM6/CM7.1)', async () => {
    await befriend('a', 'P-B', 'b');
    meta.mute('a', nowMs + 3600_000); // muted 1h into the future
    await expect(svc.sendMessage('a', 'P-B', 'hey', 'global')).resolves.toMatchObject({ error: 'MUTED' });
    // Once the mute has expired, the same sender can post again.
    nowMs += 3600_001;
    await expect(svc.sendMessage('a', 'P-B', 'hey again', 'global')).resolves.toMatchObject({ kind: 'ok' });
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
