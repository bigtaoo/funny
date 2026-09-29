// AccountPurgeService end-to-end (account-deletion purge, socialsvc slice): real Mongo + fake meta/gateway.
// Documents are seeded straight into the collections rather than driven through the services, so each
// case controls exactly the fields the purge keys off (roles, joinedAt ties, half-finished handovers).
// Covers the three family outcomes, friend-slot release, private chat, mail, reports, idempotency of a
// repeat call, re-running after a crash mid-handover, and the HTTP route (incl. the X-Internal-Key gate).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { conversationId, friendEdgeId, blockId, internalHeaders, type FamilyRole } from '@nw/shared';
import { AccountPurgeService, DELETED_ACCOUNT_ID } from '../src/accountPurge';
import { FamilyService } from '../src/familyService';
import { FriendService } from '../src/friendService';
import { MailService } from '../src/mailService';
import { startHttpApi } from '../src/httpApi';
import { tryConnect, FakeMeta, FakeGateway } from './harness';
import { jsonBody } from './jsonBody';

const mongo = await tryConnect('nw_social_account_purge_test');
if (!mongo) console.warn('[socialsvc.accountPurge.e2e] Mongo unreachable — skipping.');

const INTERNAL_KEY = 'test-internal-key';
/** Let fire-and-forget gateway calls settle. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe.skipIf(!mongo)('socialsvc AccountPurgeService e2e', () => {
  const m = mongo!;
  const cols = m.collections;
  let meta: FakeMeta;
  let gateway: FakeGateway;
  let svc: AccountPurgeService;

  async function seedFamily(id: string, leaderId: string, members: { id: string; role: FamilyRole; joinedAt: number }[]): Promise<void> {
    await cols.families.insertOne({
      _id: id, name: id, tag: id.slice(4), leaderId, memberCount: members.length,
      prosperity: 0, prosperityUpdatedAt: 0, activity: 0, createdAt: 0, rev: 1,
    });
    await cols.familyMembers.insertMany(
      members.map((mm) => ({ _id: mm.id, familyId: id, accountId: mm.id, role: mm.role, joinedAt: mm.joinedAt })),
    );
  }

  /** Mutual friendship with both counters already at `count` (as tryClaimFriendSlot would have left them). */
  async function seedFriends(a: string, b: string): Promise<void> {
    await cols.friendEdges.insertMany([
      { _id: friendEdgeId(a, b), owner: a, friend: b, since: 0 },
      { _id: friendEdgeId(b, a), owner: b, friend: a, since: 0 },
    ]);
  }

  const allZero = (removed: Record<string, number>): boolean => Object.values(removed).every((n) => n === 0);

  beforeEach(async () => {
    await Promise.all(Object.values(cols).map((c) => (c as { deleteMany(f: object): Promise<unknown> }).deleteMany({})));
    meta = new FakeMeta().add('acc', 'P-ACC', 'Doomed').add('x', 'P-X').add('y', 'P-Y').add('z', 'P-Z');
    gateway = new FakeGateway();
    svc = new AccountPurgeService({ cols, now: () => 1_000, gateway, meta });
  });

  // The connection is closed by the HTTP-route suite's afterAll below (it runs after this one and shares it).

  // ── Family ────────────────────────────────────────────────────────────────

  it('plain member: leaves, memberCount decremented once, own join requests + messages gone', async () => {
    await seedFamily('fam:AAA', 'x', [
      { id: 'x', role: 'leader', joinedAt: 1 },
      { id: 'acc', role: 'member', joinedAt: 2 },
    ]);
    await cols.familyMessages.insertMany([
      { _id: 'fm1', familyId: 'fam:AAA', senderId: 'acc', senderName: 'Doomed', body: 'hi', ts: new Date() },
      { _id: 'fm2', familyId: 'fam:AAA', senderId: 'x', senderName: 'X', body: 'yo', ts: new Date() },
    ]);
    await cols.familyJoinRequests.insertOne({ _id: 'jr1', familyId: 'fam:BBB', accountId: 'acc', status: 'rejected', createdAt: 0 });

    const r = await svc.purge('acc');
    expect(r.family).toEqual({ familyId: 'fam:AAA', outcome: 'left' });
    expect(r.removed).toMatchObject({ familyMember: 1, familyMessages: 1, familyJoinRequests: 1 });
    expect(await cols.familyMembers.findOne({ _id: 'acc' })).toBeNull();
    expect((await cols.families.findOne({ _id: 'fam:AAA' }))!.memberCount).toBe(1);
    expect(await cols.familyMessages.countDocuments({})).toBe(1); // x's message survives
    expect(await cols.familyJoinRequests.countDocuments({})).toBe(0);
  });

  it('not in a family → no family field', async () => {
    const r = await svc.purge('acc');
    expect(r.done).toBe(true);
    expect(r.family).toBeUndefined();
  });

  it('leader: transfer prefers an elder over an earlier-joined member', async () => {
    await seedFamily('fam:TRF', 'acc', [
      { id: 'acc', role: 'leader', joinedAt: 1 },
      { id: 'x', role: 'member', joinedAt: 2 },
      { id: 'y', role: 'elder', joinedAt: 9 },
    ]);
    const r = await svc.purge('acc');
    expect(r.family).toEqual({ familyId: 'fam:TRF', outcome: 'transferred', newLeaderId: 'y' });
    const fam = await cols.families.findOne({ _id: 'fam:TRF' });
    expect(fam).toMatchObject({ leaderId: 'y', memberCount: 2 });
    expect((await cols.familyMembers.findOne({ _id: 'y' }))!.role).toBe('leader');
    expect((await cols.familyMembers.findOne({ _id: 'x' }))!.role).toBe('member');
    expect(await cols.familyMembers.countDocuments({ familyId: 'fam:TRF', role: 'leader' })).toBe(1);
  });

  it('leader: among same-rank candidates, earliest joinedAt wins, then _id', async () => {
    await seedFamily('fam:TIE', 'acc', [
      { id: 'acc', role: 'leader', joinedAt: 1 },
      { id: 'z', role: 'member', joinedAt: 5 },
      { id: 'y', role: 'member', joinedAt: 3 },
      { id: 'x', role: 'member', joinedAt: 3 },
    ]);
    const r = await svc.purge('acc');
    expect(r.family).toMatchObject({ outcome: 'transferred', newLeaderId: 'x' }); // joinedAt 3 tie → 'x' < 'y'
  });

  it('sole leader: dissolves the family incl. its messages and join requests', async () => {
    await seedFamily('fam:SOLO', 'acc', [{ id: 'acc', role: 'leader', joinedAt: 1 }]);
    await cols.familyMessages.insertOne({ _id: 'fm', familyId: 'fam:SOLO', senderId: 'acc', senderName: 'D', body: 'b', ts: new Date() });
    await cols.familyJoinRequests.insertMany([
      { _id: 'jr1', familyId: 'fam:SOLO', accountId: 'x', status: 'pending', createdAt: 0 },
      { _id: 'jr2', familyId: 'fam:SOLO', accountId: 'y', status: 'rejected', createdAt: 0 },
      { _id: 'jr3', familyId: 'fam:OTHER', accountId: 'z', status: 'pending', createdAt: 0 },
    ]);
    const r = await svc.purge('acc');
    expect(r.family).toEqual({ familyId: 'fam:SOLO', outcome: 'dissolved' });
    expect(r.removed).toMatchObject({ families: 1, familyJoinRequests: 2 });
    expect(await cols.families.findOne({ _id: 'fam:SOLO' })).toBeNull();
    expect(await cols.familyMembers.countDocuments({})).toBe(0);
    expect(await cols.familyMessages.countDocuments({})).toBe(0);
    expect((await cols.familyJoinRequests.find({}).toArray()).map((d) => d._id)).toEqual(['jr3']);
  });

  it('crash mid-handover (successor promoted, families.leaderId not yet moved): retry reuses that successor', async () => {
    // A previous call promoted 'x' (a member) and died; 'y' (an elder) would otherwise outrank it.
    await seedFamily('fam:HALF', 'acc', [
      { id: 'acc', role: 'leader', joinedAt: 1 },
      { id: 'x', role: 'leader', joinedAt: 2 },
      { id: 'y', role: 'elder', joinedAt: 3 },
    ]);
    const r = await svc.purge('acc');
    expect(r.family).toMatchObject({ outcome: 'transferred', newLeaderId: 'x' });
    expect((await cols.families.findOne({ _id: 'fam:HALF' }))).toMatchObject({ leaderId: 'x', memberCount: 2 });
    expect(await cols.familyMembers.countDocuments({ familyId: 'fam:HALF', role: 'leader' })).toBe(1);
  });

  it('crash after handover (leaderId moved, leaver row still present): retry just removes the row, no second promotion', async () => {
    await seedFamily('fam:LATE', 'x', [
      { id: 'acc', role: 'leader', joinedAt: 1 },
      { id: 'x', role: 'leader', joinedAt: 2 },
      { id: 'y', role: 'elder', joinedAt: 3 },
    ]);
    const r = await svc.purge('acc');
    expect(r.family).toEqual({ familyId: 'fam:LATE', outcome: 'transferred', newLeaderId: 'x' });
    expect((await cols.familyMembers.findOne({ _id: 'y' }))!.role).toBe('elder');
    expect(await cols.familyMembers.findOne({ _id: 'acc' })).toBeNull();
    expect((await cols.families.findOne({ _id: 'fam:LATE' }))).toMatchObject({ leaderId: 'x', memberCount: 2 });
  });

  // ── Friends / requests / blocks ──────────────────────────────────────────

  it('friends: edges both ways removed, the other side\'s slot released, own counter deleted, cache invalidated', async () => {
    await seedFriends('acc', 'x');
    await seedFriends('acc', 'y');
    await seedFriends('x', 'y'); // unrelated friendship must survive
    await cols.friendCounts.insertMany([{ _id: 'acc', count: 2 }, { _id: 'x', count: 2 }, { _id: 'y', count: 2 }]);
    await cols.friendRequests.insertMany([
      { _id: 'fr1', from: 'acc', to: 'z', status: 'pending', createdAt: 0 },
      { _id: 'fr2', from: 'z', to: 'acc', status: 'rejected', createdAt: 0 },
      { _id: 'fr3', from: 'x', to: 'z', status: 'pending', createdAt: 0 },
    ]);
    await cols.blockList.insertMany([
      { _id: blockId('acc', 'z'), owner: 'acc', target: 'z', ts: 0 },
      { _id: blockId('z', 'acc'), owner: 'z', target: 'acc', ts: 0 },
      { _id: blockId('x', 'z'), owner: 'x', target: 'z', ts: 0 },
    ]);

    const r = await svc.purge('acc');
    await flush();
    expect(r.removed).toMatchObject({ friendEdges: 4, friendCounts: 1, friendRequests: 2, blockList: 2 });
    expect((await cols.friendEdges.find({}).toArray()).map((e) => e._id).sort()).toEqual(['x:y', 'y:x']);
    expect(await cols.friendCounts.findOne({ _id: 'acc' })).toBeNull();
    expect((await cols.friendCounts.findOne({ _id: 'x' }))!.count).toBe(1);
    expect((await cols.friendCounts.findOne({ _id: 'y' }))!.count).toBe(1);
    expect(await cols.friendRequests.countDocuments({})).toBe(1);
    expect(await cols.blockList.countDocuments({})).toBe(1);
    expect([...gateway.invalidated].sort()).toEqual(['x', 'y']);
  });

  it('friend slot release never drives a counter below zero', async () => {
    await seedFriends('acc', 'x');
    await cols.friendCounts.insertOne({ _id: 'x', count: 0 });
    await svc.purge('acc');
    expect((await cols.friendCounts.findOne({ _id: 'x' }))!.count).toBe(0);
  });

  // ── Private chat ─────────────────────────────────────────────────────────

  it('private chat: conversations containing acc and all their messages removed; others untouched', async () => {
    const cAX = conversationId('acc', 'x');
    const cXY = conversationId('x', 'y');
    await cols.conversations.insertMany([
      { _id: cAX, members: ['acc', 'x'], lastTs: 0, unread: {} },
      { _id: cXY, members: ['x', 'y'], lastTs: 0, unread: {} },
    ]);
    await cols.chatMessages.insertMany([
      { _id: 'm1', convId: cAX, from: 'acc', body: 'a', kind: 'text', ts: new Date() },
      { _id: 'm2', convId: cAX, from: 'x', body: 'b', kind: 'text', ts: new Date() },
      { _id: 'm3', convId: cXY, from: 'x', body: 'c', kind: 'text', ts: new Date() },
      // Orphan from a previous crashed call that already removed its conversation.
      { _id: 'm4', convId: conversationId('acc', 'z'), from: 'acc', body: 'd', kind: 'text', ts: new Date() },
    ]);
    const r = await svc.purge('acc');
    expect(r.removed).toMatchObject({ conversations: 1, chatMessages: 3 });
    expect((await cols.conversations.find({}).toArray()).map((c) => c._id)).toEqual([cXY]);
    expect((await cols.chatMessages.find({}).toArray()).map((c) => c._id)).toEqual(['m3']);
  });

  // ── Mail ─────────────────────────────────────────────────────────────────

  it('mail: inbox deleted; sent player mail (from = publicId) deleted, unclaimed-attachment mail de-identified; system mail untouched', async () => {
    const exp = new Date(Date.now() + 86_400_000);
    await cols.mails.insertMany([
      { _id: 'in1', to: 'acc', from: 'system', fromName: 'System', subject: 's', body: 'b', createdAt: 0, expireAt: exp },
      { _id: 'in2', to: 'acc', from: 'P-X', fromName: 'X', subject: 's', body: 'b', createdAt: 0, expireAt: exp },
      { _id: 'out1', to: 'x', from: 'P-ACC', fromName: 'Doomed', subject: 's', body: 'b', createdAt: 0, expireAt: exp },
      { _id: 'out2', to: 'y', from: 'P-ACC', fromName: 'Doomed', subject: 's', body: 'b', createdAt: 0, expireAt: exp,
        attachments: [{ kind: 'gold', amount: 1 } as never] },
      { _id: 'out3', to: 'y', from: 'P-ACC', fromName: 'Doomed', subject: 's', body: 'b', createdAt: 0, expireAt: exp,
        attachments: [{ kind: 'gold', amount: 1 } as never], claimedAt: 5 },
      { _id: 'sys', to: 'x', from: 'system', fromName: 'System', subject: 's', body: 'b', createdAt: 0, expireAt: exp },
    ]);
    const r = await svc.purge('acc');
    expect(r.removed).toMatchObject({ mailsReceived: 2, mailsSent: 2, mailsSentAnonymized: 1 });
    const left = await cols.mails.find({}).sort({ _id: 1 }).toArray();
    expect(left.map((d) => d._id)).toEqual(['out2', 'sys']);
    expect(left[0]).toMatchObject({ from: DELETED_ACCOUNT_ID, fromName: '' });
  });

  it('mail: explicit publicId hint is used when meta cannot resolve the account', async () => {
    svc = new AccountPurgeService({ cols, now: () => 1_000, gateway, meta: new FakeMeta() });
    const exp = new Date(Date.now() + 86_400_000);
    await cols.mails.insertOne({ _id: 'out', to: 'x', from: 'P-ACC', fromName: 'Doomed', subject: 's', body: 'b', createdAt: 0, expireAt: exp });
    expect((await svc.purge('acc')).removed.mailsSent).toBe(0); // unresolved → left to TTL
    expect((await svc.purge('acc', { publicId: 'P-ACC' })).removed.mailsSent).toBe(1);
  });

  // ── Reports ──────────────────────────────────────────────────────────────

  it('reports: against acc deleted; filed by acc kept with reporter anonymized', async () => {
    await cols.reports.insertMany([
      { _id: 'r1', reporterId: 'x', targetId: 'acc', reason: 'r', ts: 0, status: 'open' },
      { _id: 'r2', reporterId: 'acc', targetId: 'y', reason: 'r', ts: 0, status: 'open' },
      { _id: 'r3', reporterId: 'x', targetId: 'y', reason: 'r', ts: 0, status: 'upheld', resolvedBy: 'admin-1' },
    ]);
    const r = await svc.purge('acc');
    expect(r.removed).toMatchObject({ reportsAgainst: 1, reportsFiledAnonymized: 1 });
    const left = await cols.reports.find({}).sort({ _id: 1 }).toArray();
    expect(left.map((d) => d._id)).toEqual(['r2', 'r3']);
    expect(left[0]).toMatchObject({ reporterId: DELETED_ACCOUNT_ID, targetId: 'y', status: 'open' });
    expect(left[1]).toMatchObject({ reporterId: 'x', resolvedBy: 'admin-1' });
  });

  // ── Idempotency ──────────────────────────────────────────────────────────

  it('second call after full success: done with all-zero counts and no further changes', async () => {
    await seedFamily('fam:IDEM', 'acc', [
      { id: 'acc', role: 'leader', joinedAt: 1 },
      { id: 'x', role: 'member', joinedAt: 2 },
    ]);
    await seedFriends('acc', 'x');
    await cols.friendCounts.insertMany([{ _id: 'acc', count: 1 }, { _id: 'x', count: 3 }]);
    await cols.conversations.insertOne({ _id: conversationId('acc', 'x'), members: ['acc', 'x'], lastTs: 0, unread: {} });
    await cols.reports.insertOne({ _id: 'r', reporterId: 'acc', targetId: 'x', reason: 'r', ts: 0, status: 'open' });

    const first = await svc.purge('acc');
    expect(allZero(first.removed)).toBe(false);
    const snapshot = async () => ({
      fam: await cols.families.findOne({ _id: 'fam:IDEM' }),
      members: await cols.familyMembers.find({}).toArray(),
      counts: await cols.friendCounts.find({}).toArray(),
      reports: await cols.reports.find({}).toArray(),
    });
    const before = await snapshot();
    expect(before.fam).toMatchObject({ leaderId: 'x', memberCount: 1 });
    expect(before.counts).toEqual([{ _id: 'x', count: 2 }]);

    const second = await svc.purge('acc');
    expect(second.done).toBe(true);
    expect(second.family).toBeUndefined();
    expect(allZero(second.removed)).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
});

// ── HTTP route ─────────────────────────────────────────────────────────────

describe.skipIf(!mongo)('socialsvc POST /internal/accounts/:accountId/purge HTTP route', () => {
  const m = mongo!;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const meta = new FakeMeta().add('acc', 'P-ACC').add('x', 'P-X');
    const gateway = new FakeGateway();
    const now = () => 1_000;
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: 'test-jwt-secret', internalKey: INTERNAL_KEY },
      new FamilyService({ cols: m.collections, now, gateway, meta, mail: mailSvc }),
      new FriendService({ cols: m.collections, gateway, meta, now }),
      mailSvc, gateway, meta,
      new AccountPurgeService({ cols: m.collections, now, gateway, meta }),
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => { server.close(); await m.close(); });

  it('without X-Internal-Key → 401, nothing removed', async () => {
    await m.collections.friendRequests.deleteMany({});
    await m.collections.friendRequests.insertOne({ _id: 'fr', from: 'acc', to: 'x', status: 'pending', createdAt: 0 });
    const r = await fetch(`${base}/internal/accounts/acc/purge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(await m.collections.friendRequests.countDocuments({})).toBe(1);
  });

  it('with the key → 200 ok envelope { done, removed, family }', async () => {
    await m.collections.families.deleteMany({});
    await m.collections.familyMembers.deleteMany({});
    await m.collections.families.insertOne({
      _id: 'fam:HTTP', name: 'H', tag: 'HTTP', leaderId: 'x', memberCount: 2,
      prosperity: 0, prosperityUpdatedAt: 0, activity: 0, createdAt: 0, rev: 1,
    });
    await m.collections.familyMembers.insertMany([
      { _id: 'x', familyId: 'fam:HTTP', accountId: 'x', role: 'leader', joinedAt: 1 },
      { _id: 'acc', familyId: 'fam:HTTP', accountId: 'acc', role: 'member', joinedAt: 2 },
    ]);
    const r = await fetch(`${base}/internal/accounts/acc/purge`, {
      method: 'POST',
      headers: { ...internalHeaders('meta', INTERNAL_KEY), 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(200);
    const body = await jsonBody<{ ok: boolean; data: { done: boolean; removed: Record<string, number>; family?: object } }>(r);
    expect(body.ok).toBe(true);
    expect(body.data.done).toBe(true);
    expect(body.data.family).toEqual({ familyId: 'fam:HTTP', outcome: 'left' });
    expect(body.data.removed).toMatchObject({ familyMember: 1, friendRequests: 1 });
  });

  it('no AccountPurgeService wired → 500 INTERNAL', async () => {
    const meta = new FakeMeta();
    const gateway = new FakeGateway();
    const now = () => 1_000;
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now });
    const bare = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: 'test-jwt-secret', internalKey: INTERNAL_KEY },
      new FamilyService({ cols: m.collections, now, gateway, meta, mail: mailSvc }),
      new FriendService({ cols: m.collections, gateway, meta, now }),
      mailSvc, gateway, meta,
    );
    await new Promise<void>((res) => bare.on('listening', res));
    try {
      const r = await fetch(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/internal/accounts/acc/purge`, {
        method: 'POST', headers: internalHeaders('meta', INTERNAL_KEY), body: '{}',
      });
      expect(r.status).toBe(500);
    } finally {
      bare.close();
    }
  });
});
