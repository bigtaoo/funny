// FriendChatService branch-coverage gap-fill (2026-09-03 pass): src/friend/chat.ts was 97.56% line /
// 76.47% branch. friend.e2e.test.ts already sends, lists and paginates private chat, but always
// between two accounts that both have a profile, over conversation documents this service wrote
// itself. The 16 branches left over are the ones that only run when that isn't true:
//
//   * the in-process rate limiter's sweep. It is a memory-leak guard (every account that has ever
//     sent a message keeps an entry otherwise), so its only observable effect is the map's contents —
//     asserted directly, same as shared's SlidingRateLimiter test and admin's loginAttempts test.
//   * the `?? ''` / `?? 0` / `d.lastBody ?` fallbacks in getConversations/getMessages. These exist for
//     documents the service did NOT just write: a conversation row with no message in it yet, a
//     counterpart whose account was deleted, a `ts` that is a number rather than a BSON Date. Each
//     fallback is the difference between a rendered conversation list and one row of `undefined`.
//   * the reject paths a client can reach but the happy-path e2e never sends: an unknown recipient, an
//     absent body, a recipient the SENDER has blocked (the far side of the two-way block check), and a
//     sender whose own profile meta cannot resolve.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CHAT_HISTORY_PAGE_MAX, conversationId, friendEdgeId, blockId } from '@nw/shared';
import type { ChatMessageDoc, SocialMongo } from '../src/db';
import { FriendChatService } from '../src/friend/chat';
import { tryConnect, FakeMeta, FakeGateway } from './harness';

const mongo = await tryConnect('nw_social_friendchat_branches_test');
if (!mongo) console.warn('[socialsvc.friendChatBranches.e2e] Mongo unreachable — skipping.');

const WINDOW_MS = 60_000;

describe('FriendChatService.allowChat sweep (in-process only — no DB)', () => {
  /** The rate limiter's backing map; the sweep has no other observable effect. */
  const windows = (svc: FriendChatService) =>
    (svc as unknown as { chatRate: Map<string, number[]> }).chatRate;

  it('drops an account whose entries are all stale and prunes one that is only partly stale', () => {
    // deps are never touched by allowChat — it is pure in-process bookkeeping.
    const svc = new FriendChatService({} as never);

    svc.allowChat('gone', 100_000);      // first call: sweeps an empty map, arms the window
    svc.allowChat('mixed', 100_000);
    svc.allowChat('mixed', 140_000);     // < WINDOW_MS since the last sweep -> no sweep yet
    expect(windows(svc).get('gone')).toEqual([100_000]);
    expect(windows(svc).get('mixed')).toEqual([100_000, 140_000]);

    // 165_000 is > WINDOW_MS past the last sweep, so this call runs one: 'gone' has nothing fresh
    // left and is deleted outright (that entry is the leak), 'mixed' keeps only its fresh timestamp.
    svc.allowChat('fresh', 165_000);
    expect(windows(svc).has('gone')).toBe(false);
    expect(windows(svc).get('mixed')).toEqual([140_000]);
    expect(windows(svc).get('fresh')).toEqual([165_000]);
  });

  it('an account at its per-minute cap is refused until its window rolls over', () => {
    const svc = new FriendChatService({} as never);
    expect(svc.allowChat('a', 1_000, 2)).toBe(true);
    expect(svc.allowChat('a', 1_100, 2)).toBe(true);
    expect(svc.allowChat('a', 1_200, 2)).toBe(false);
    expect(svc.allowChat('a', 1_000 + WINDOW_MS, 2)).toBe(true);
  });
});

describe.skipIf(!mongo)('socialsvc FriendChatService branch gaps', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let meta: FakeMeta;
  let gateway: FakeGateway;
  let svc: FriendChatService;

  beforeEach(async () => {
    await Promise.all([
      m.collections.friendEdges.deleteMany({}),
      m.collections.blockList.deleteMany({}),
      m.collections.conversations.deleteMany({}),
      m.collections.chatMessages.deleteMany({}),
    ]);
    nowMs = 1_000_000;
    meta = new FakeMeta().add('a', 'P-A', 'Alice').add('b', 'P-B', 'Bob');
    gateway = new FakeGateway();
    svc = new FriendChatService({ cols: m.collections, gateway, meta, now });
  });

  afterAll(async () => { await m.close(); });

  /** Mutual friend edges, written directly (the request/accept flow is friend.e2e's subject). */
  async function befriend(x: string, y: string): Promise<void> {
    await m.collections.friendEdges.insertMany([
      { _id: friendEdgeId(x, y), owner: x, friend: y, since: nowMs },
      { _id: friendEdgeId(y, x), owner: y, friend: x, since: nowMs },
    ]);
  }

  // ── sendMessage rejects ──────────────────────────────────────────────────────

  it('sendMessage: an unknown recipient publicId is NOT_FOUND', async () => {
    expect(await svc.sendMessage('a', 'P-NOBODY', 'hi', 'global')).toEqual({ kind: 'error', error: 'NOT_FOUND' });
  });

  it('sendMessage: an absent body is treated as empty and rejected', async () => {
    await befriend('a', 'b');
    // The route coerces a non-string body to null and rejects earlier, but the service is also called
    // directly (tests, future internal callers) — `(bodyRaw ?? '')` is what keeps .trim() from throwing.
    const r = await svc.sendMessage('a', 'P-B', undefined as unknown as string, 'global');
    expect(r).toEqual({ kind: 'error', error: 'BAD_REQUEST' });
    expect(await m.collections.chatMessages.countDocuments({})).toBe(0);
  });

  it('sendMessage: BLOCKED when the SENDER blocked the recipient (the far side of the two-way check)', async () => {
    await befriend('a', 'b');
    // a→b block only: the first check (did b block a?) passes, the second one is what stops this.
    await m.collections.blockList.insertOne({ _id: blockId('a', 'b'), owner: 'a', target: 'b', ts: nowMs });
    expect(await svc.sendMessage('a', 'P-B', 'hi', 'global')).toEqual({ kind: 'error', error: 'BLOCKED' });
  });

  it('sendMessage: a sender whose own profile meta cannot resolve is BAD_REQUEST, and writes nothing', async () => {
    await befriend('ghost', 'b');
    // 'ghost' is a friend of b but has no profile — there is no publicId/displayName to stamp on the
    // push, so the message must not be persisted either.
    expect(await svc.sendMessage('ghost', 'P-B', 'hi', 'global')).toEqual({ kind: 'error', error: 'BAD_REQUEST' });
    expect(await m.collections.chatMessages.countDocuments({})).toBe(0);
    expect(gateway.pushes).toHaveLength(0);
  });

  // ── getConversations fallbacks ───────────────────────────────────────────────

  it('getConversations: no rows -> [] without a profile round trip', async () => {
    expect(await svc.getConversations('a')).toEqual([]);
  });

  it('getConversations: a row with no message yet omits lastBody/lastFrom and reports unread 0', async () => {
    const convId = conversationId('a', 'b');
    // Written by hand: a conversation row can exist ahead of its first message (upsert on read), and
    // `unread` has no entry for an account that has never received anything in it.
    await m.collections.conversations.insertOne({
      _id: convId, members: ['a', 'b'], lastTs: nowMs, unread: {},
    });
    const [conv] = await svc.getConversations('a');
    expect(conv).not.toHaveProperty('lastBody');
    expect(conv).not.toHaveProperty('lastFrom');
    expect(conv).toMatchObject({ convId, unread: 0, peer: { publicId: 'P-B' } });
  });

  it('getConversations: lastFrom is reported as the peer publicId when the peer sent last', async () => {
    await m.collections.conversations.insertOne({
      _id: conversationId('a', 'b'), members: ['a', 'b'], lastBody: 'yo', lastFrom: 'b', lastTs: nowMs, unread: { a: 3 },
    });
    const [conv] = await svc.getConversations('a');
    expect(conv).toMatchObject({ lastBody: 'yo', lastFrom: 'P-B', unread: 3 });
  });

  it('getConversations: my own message shows my publicId, or "" when my profile is unresolvable', async () => {
    await m.collections.conversations.insertOne({
      _id: conversationId('a', 'b'), members: ['a', 'b'], lastBody: 'yo', lastFrom: 'a', lastTs: nowMs, unread: { b: 1 },
    });
    expect((await svc.getConversations('a'))[0]).toMatchObject({ lastFrom: 'P-A' });

    // Same row read by an account meta cannot resolve: the list must still render (the peer is the
    // useful half), with my own id degraded to '' rather than the string "undefined".
    await m.collections.conversations.insertOne({
      _id: conversationId('ghost', 'b'), members: ['b', 'ghost'], lastBody: 'yo', lastFrom: 'ghost', lastTs: nowMs, unread: {},
    });
    expect((await svc.getConversations('ghost'))[0]).toMatchObject({ lastFrom: '', peer: { publicId: 'P-B' } });
  });

  it('getConversations: a row whose peer has no profile is skipped, not rendered blank', async () => {
    await m.collections.conversations.insertMany([
      { _id: conversationId('a', 'deleted'), members: ['a', 'deleted'], lastBody: 'x', lastTs: nowMs, unread: {} },
      { _id: conversationId('a', 'b'), members: ['a', 'b'], lastBody: 'y', lastTs: nowMs + 1, unread: {} },
    ]);
    const out = await svc.getConversations('a');
    expect(out).toHaveLength(1);
    expect(out[0]!.peer.publicId).toBe('P-B');
  });

  // ── getMessages fallbacks ────────────────────────────────────────────────────

  it('getMessages: a nonexistent conversation, and one the caller is not a member of, are both null', async () => {
    await m.collections.conversations.insertOne({
      _id: conversationId('a', 'b'), members: ['a', 'b'], lastTs: nowMs, unread: {},
    });
    expect(await svc.getMessages('a', 'conv:nope', undefined, 30)).toBeNull();
    expect(await svc.getMessages('outsider', conversationId('a', 'b'), undefined, 30)).toBeNull();
  });

  it('getMessages: limit 0 falls back to the 30-message default page', async () => {
    const convId = conversationId('a', 'b');
    await m.collections.conversations.insertOne({ _id: convId, members: ['a', 'b'], lastTs: nowMs, unread: {} });
    await m.collections.chatMessages.insertMany(
      Array.from({ length: 31 }, (_, i) => ({
        _id: `msg-${i}`, convId, from: 'a', body: `m${i}`, kind: 'text' as const, ts: new Date(nowMs + i),
      })),
    );
    expect(await svc.getMessages('a', convId, undefined, 0)).toHaveLength(30);
    // A limit over the page cap is clamped to it, not honoured.
    expect(await svc.getMessages('a', convId, undefined, 1000)).toHaveLength(Math.min(31, CHAT_HISTORY_PAGE_MAX));
  });

  it('getMessages: a sender with no profile yields fromPublicId "", and a numeric ts is converted', async () => {
    const convId = conversationId('deleted', 'b');
    await m.collections.conversations.insertOne({ _id: convId, members: ['b', 'deleted'], lastTs: nowMs, unread: {} });
    await m.collections.chatMessages.insertMany([
      // A message whose sender's account is gone: history must still render for the other party.
      { _id: 'm-ghost', convId, from: 'deleted', body: 'bye', kind: 'text', ts: new Date(nowMs) },
      // A row written before `ts` became a BSON Date — Number() is what keeps it a real timestamp.
      { _id: 'm-legacy', convId, from: 'b', body: 'hi', kind: 'text', ts: nowMs - 1 as unknown as Date } as ChatMessageDoc,
    ]);
    const out = (await svc.getMessages('b', convId, undefined, 30))!;
    expect(out.find((x) => x.messageId === 'm-ghost')).toMatchObject({ fromPublicId: '' });
    expect(out.find((x) => x.messageId === 'm-legacy')).toMatchObject({ fromPublicId: 'P-B', ts: nowMs - 1 });
  });
});
