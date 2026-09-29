// App Store Review Guideline 1.2 (user-generated content) — socialsvc half, end to end on real Mongo:
//   - reports carry category + a content pointer; server-owned text (DM / family / announcement / name) is
//     snapshotted from socialsvc's own store instead of trusted from the client, but only when the message
//     really is the reported player's;
//   - the first block of a pair files a report (source 'block') and alerts ops, a repeat block does not;
//   - GET blocked list; blocked senders drop out of the blocker's DM + family feeds (and family pushes);
//   - the filter now covers family announcements, player mail and friend-request messages;
//   - staff removal: delete one message / announcement, purge everything an author wrote;
//   - the HTTP surface for all of the above (public + /internal/moderation/*).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { FRIEND_REQUEST_MESSAGE_MAX, REPORT_SNAPSHOT_MAX, conversationId, signToken } from '@nw/shared';
import { FriendService } from '../src/friendService';
import { FamilyService } from '../src/familyService';
import { MailService } from '../src/mailService';
import { startHttpApi } from '../src/httpApi';
import type { ReportAlertInfo, ReportAlerter } from '../src/reportAlert';
import { tryConnect, FakeMeta, FakeGateway } from './harness';
import { jsonBody } from './jsonBody';

const mongo = await tryConnect('nw_social_ugc_moderation_test');
if (!mongo) console.warn('[socialsvc.ugcModeration.e2e] Mongo unreachable — skipping.');

class RecordingAlerter implements ReportAlerter {
  readonly sent: ReportAlertInfo[] = [];
  notify(info: ReportAlertInfo): void {
    this.sent.push(info);
  }
}

describe.skipIf(!mongo)('socialsvc UGC moderation (Guideline 1.2)', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let meta: FakeMeta;
  let gateway: FakeGateway;
  let alerts: RecordingAlerter;
  let svc: FriendService;
  let familySvc: FamilyService;
  let mailSvc: MailService;

  beforeEach(async () => {
    const c = m.collections;
    await Promise.all([
      c.friendEdges.deleteMany({}), c.friendRequests.deleteMany({}), c.friendCounts.deleteMany({}),
      c.blockList.deleteMany({}), c.conversations.deleteMany({}), c.chatMessages.deleteMany({}),
      c.reports.deleteMany({}), c.families.deleteMany({}), c.familyMembers.deleteMany({}),
      c.familyMessages.deleteMany({}), c.mails.deleteMany({}),
    ]);
    nowMs = 1_000_000;
    meta = new FakeMeta().add('a', 'P-A', 'Alice').add('b', 'P-B', 'Bob').add('c', 'P-C', 'Cara');
    gateway = new FakeGateway();
    alerts = new RecordingAlerter();
    svc = new FriendService({ cols: c, gateway, meta, alerts, now });
    mailSvc = new MailService({ cols: c, gateway, meta, now });
    familySvc = new FamilyService({ cols: c, gateway, meta, mail: mailSvc, now });
  });

  afterAll(async () => { await m.close(); });

  async function befriend(from: string, toPid: string, to: string): Promise<void> {
    const r = await svc.requestFriend(from, toPid, undefined);
    if (r.kind !== 'ok') throw new Error(`setup request failed: ${r.error}`);
    await svc.respondFriend(to, r.requestId, true);
  }

  /** One family 'fam:T' with the given members (first = leader). */
  async function family(members: string[]): Promise<void> {
    await m.collections.families.insertOne({
      _id: 'fam:T', name: 'Team', tag: 'T', leaderId: members[0]!, memberCount: members.length,
      prosperity: 0, prosperityUpdatedAt: 0, activity: 0, createdAt: 0, rev: 1,
    });
    await m.collections.familyMembers.insertMany(members.map((id, i) => ({
      _id: id, familyId: 'fam:T', accountId: id, role: i === 0 ? ('leader' as const) : ('member' as const), joinedAt: 0,
    })));
  }

  // ── Reports with content ─────────────────────────────────────────────────────

  it('report on a DM: stores category + the SERVER copy of the message, not the client text; alerts ops', async () => {
    await befriend('a', 'P-B', 'b');
    const sent = await svc.sendMessage('b', 'P-A', 'the real insult', 'global');
    if (sent.kind !== 'ok') throw new Error('send failed');
    expect(await svc.reportUser('a', 'P-B', {
      category: 'harassment',
      content: { channel: 'dm', messageId: sent.messageId, text: 'client says something else' },
    })).toBe(true);
    const [r] = await svc.listReports('open');
    expect(r).toMatchObject({
      reporterId: 'a', targetId: 'b', category: 'harassment', source: 'report', reason: '',
      contentRef: { kind: 'content', channel: 'dm', messageId: sent.messageId, snapshot: 'the real insult', snapshotSource: 'server' },
    });
    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0]).toMatchObject({ targetPublicId: 'P-B', targetName: 'Bob' });
    expect(alerts.sent[0]!.report._id).toBe(r!._id);
  });

  it("report on a DM id that isn't the target's message in the reporter's conversation → falls back to the client snapshot", async () => {
    await befriend('b', 'P-C', 'c');
    const other = await svc.sendMessage('b', 'P-C', 'private to cara', 'global');
    if (other.kind !== 'ok') throw new Error('send failed');
    // a reports b, pointing at a message b sent to c — a must not be able to pull it into the queue.
    await svc.reportUser('a', 'P-B', { content: { channel: 'dm', messageId: other.messageId, text: 'what a saw' } });
    const [r] = await svc.listReports('open');
    expect(r!.contentRef).toEqual({ kind: 'content', channel: 'dm', messageId: other.messageId, snapshot: 'what a saw', snapshotSource: 'client' });
  });

  it('report on family chat / announcement / name uses the server text; world snapshot is client-side and capped', async () => {
    await family(['b', 'a']);
    const msg = await familySvc.sendMessage('b', 'Bob', 'family nasty');
    await familySvc.setAnnouncement('b', 'announcement nasty');

    await svc.reportUser('a', 'P-B', { content: { channel: 'family', messageId: msg.id, text: 'x' } });
    await svc.reportUser('a', 'P-B', { content: { channel: 'announcement', text: 'x' } });
    await svc.reportUser('a', 'P-B', { category: 'offensive_name', content: { channel: 'name', text: 'x' } });
    await svc.reportUser('a', 'P-B', { category: 'spam', content: { channel: 'world', messageId: 'nm:w:1:1:ab', text: 'y'.repeat(900) } });

    const rows = await svc.listReports('open');
    expect(rows.map((r) => r.contentRef)).toEqual([
      { kind: 'content', channel: 'family', messageId: msg.id, snapshot: 'family nasty', snapshotSource: 'server' },
      { kind: 'content', channel: 'announcement', snapshot: 'announcement nasty', snapshotSource: 'server' },
      { kind: 'content', channel: 'name', snapshot: 'Bob', snapshotSource: 'server' },
      { kind: 'content', channel: 'world', messageId: 'nm:w:1:1:ab', snapshot: 'y'.repeat(REPORT_SNAPSHOT_MAX), snapshotSource: 'client' },
    ]);
  });

  it('legacy reason-only call shape still files a plain report (no category/contentRef)', async () => {
    await svc.reportUser('a', 'P-B', 'spam');
    const [r] = await svc.listReports('open');
    expect(r).toMatchObject({ reason: 'spam', source: 'report' });
    expect(r!.category).toBeUndefined();
    expect(r!.contentRef).toBeUndefined();
  });

  // ── Block = report + alert, once ────────────────────────────────────────────

  it('first block files a block-sourced report + alert; re-blocking does not file a second one', async () => {
    expect(await svc.blockUser('a', 'P-B', { category: 'harassment', content: { channel: 'sect', messageId: 'sm:s:1', text: 'rude' } })).toBe(true);
    expect(await svc.blockUser('a', 'P-B')).toBe(true);
    const rows = await svc.listReports('open');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'block', reason: 'blocked by user', category: 'harassment',
      contentRef: { kind: 'content', channel: 'sect', messageId: 'sm:s:1', snapshot: 'rude', snapshotSource: 'client' },
    });
    expect(alerts.sent).toHaveLength(1);
    // Unblock + block again is a new block → a new report (it is a fresh decision by the player).
    await svc.unblockUser('a', 'P-B');
    await svc.blockUser('a', 'P-B');
    expect(await svc.listReports('open')).toHaveLength(2);
  });

  it('listBlocked: newest first, resolved to publicId + displayName', async () => {
    await svc.blockUser('a', 'P-B');
    nowMs += 1000;
    await svc.blockUser('a', 'P-C');
    expect(await svc.listBlocked('a')).toEqual([
      { publicId: 'P-C', displayName: 'Cara', ts: 1_001_000 },
      { publicId: 'P-B', displayName: 'Bob', ts: 1_000_000 },
    ]);
    expect(await svc.listBlocked('b')).toEqual([]);
  });

  // ── Feeds exclude blocked senders ──────────────────────────────────────────

  it('DM: after blocking, the peer drops out of the conversation list and their messages out of the history', async () => {
    await befriend('a', 'P-B', 'b');
    await svc.sendMessage('a', 'P-B', 'hi bob', 'global');
    nowMs += 1;
    await svc.sendMessage('b', 'P-A', 'hi alice', 'global');
    const convId = conversationId('a', 'b');
    expect((await svc.getMessages('a', convId, undefined, 30))!.map((x) => x.body)).toEqual(['hi alice', 'hi bob']);

    expect((await svc.getSocialBadges('a')).chat).toBe(1);
    await svc.blockUser('a', 'P-B');
    expect(await svc.getConversations('a')).toEqual([]);
    expect((await svc.getSocialBadges('a')).chat).toBe(0);
    expect((await svc.getMessages('a', convId, undefined, 30))!.map((x) => x.body)).toEqual(['hi bob']);
    // The blocked side's own view is untouched (a block hides content from the blocker only).
    expect((await svc.getMessages('b', convId, undefined, 30))!.map((x) => x.body)).toEqual(['hi alice', 'hi bob']);
  });

  it('family chat: history hides blocked senders and the blocker gets no push for their new messages', async () => {
    await family(['a', 'b', 'c']);
    await familySvc.sendMessage('b', 'Bob', 'before block');
    await svc.blockUser('a', 'P-B');
    gateway.pushes.length = 0;
    nowMs += 1;
    await familySvc.sendMessage('b', 'Bob', 'after block');
    nowMs += 1;
    await familySvc.sendMessage('c', 'Cara', 'from cara');

    expect((await familySvc.getChannel('a')).map((x) => x.body)).toEqual(['from cara']);
    expect((await familySvc.getChannel('c')).map((x) => x.body)).toEqual(['from cara', 'after block', 'before block']);
    const bobPushes = gateway.pushes.filter((p) => p.msg.kind === 'family_msg' && p.msg.body === 'after block');
    expect(bobPushes.map((p) => p.accountId)).toEqual(['c']);
  });

  it('family chat carries senderPublicId: stored at write time, backfilled from meta for older docs', async () => {
    await family(['a', 'b']);
    const sent = await familySvc.sendMessage('b', 'Bob', 'hello');
    expect(sent.senderPublicId).toBe('P-B');
    expect((await m.collections.familyMessages.findOne({ _id: sent.id }))!.senderPublicId).toBe('P-B');
    // A pre-2026-09-29 doc with no senderPublicId stored.
    await m.collections.familyMessages.insertOne({ _id: 'fm:legacy', familyId: 'fam:T', senderId: 'a', senderName: 'Alice', body: 'old', ts: new Date(1) });
    const hist = await familySvc.getChannel('b');
    expect(hist.map((x) => [x.body, x.senderPublicId])).toEqual([['hello', 'P-B'], ['old', 'P-A']]);
  });

  // ── Filters on the remaining UGC surfaces ──────────────────────────────────

  it('family announcement is masked and stamped with its author', async () => {
    await family(['a', 'b']);
    await familySvc.setAnnouncement('a', 'what the fuck');
    const fam = await m.collections.families.findOne({ _id: 'fam:T' });
    expect(fam!.announcement).not.toContain('fuck');
    expect(fam!.announcement).toContain('****');
    expect(fam!.announcementBy).toBe('a');
  });

  it('player mail subject + body are masked', async () => {
    await befriend('a', 'P-B', 'b');
    const r = await mailSvc.sendPlayerMail('a', 'P-B', 'shit subject', 'visit www.scam.example');
    expect(r.kind).toBe('ok');
    const [mail] = await m.collections.mails.find({ to: 'b' }).toArray();
    expect(mail!.subject).not.toContain('shit');
    expect(mail!.body).not.toContain('www.');
  });

  it('friend-request message: masked, and over FRIEND_REQUEST_MESSAGE_MAX is rejected', async () => {
    const r = await svc.requestFriend('a', 'P-B', '  fuck you  ');
    expect(r.kind).toBe('ok');
    const doc = await m.collections.friendRequests.findOne({ from: 'a', to: 'b' });
    expect(doc!.message).toBe('**** you');
    expect(gateway.ofKind('friend_request')[0]!.message).toBe('**** you');
    const long = await svc.requestFriend('a', 'P-C', 'x'.repeat(FRIEND_REQUEST_MESSAGE_MAX + 1));
    expect(long).toEqual({ kind: 'error', error: 'BAD_REQUEST' });
  });

  // ── Staff removal ─────────────────────────────────────────────────────────

  it('deleteContent: DM message (conversation preview re-pointed), family message, announcement', async () => {
    await befriend('a', 'P-B', 'b');
    await svc.sendMessage('a', 'P-B', 'fine', 'global');
    nowMs += 1;
    const bad = await svc.sendMessage('b', 'P-A', 'abusive', 'global');
    if (bad.kind !== 'ok') throw new Error('send failed');
    expect(await svc.deleteContent('dm', bad.messageId, undefined)).toBe(true);
    expect(await svc.deleteContent('dm', bad.messageId, undefined)).toBe(false);
    const conv = await m.collections.conversations.findOne({ _id: conversationId('a', 'b') });
    expect(conv).toMatchObject({ lastBody: 'fine', lastFrom: 'a' });

    await family(['b', 'a']);
    const fm = await familySvc.sendMessage('b', 'Bob', 'family abusive');
    expect(await svc.deleteContent('family', fm.id, undefined)).toBe(true);
    expect(await familySvc.getChannel('a')).toEqual([]);

    await familySvc.setAnnouncement('b', 'bad announcement');
    expect(await svc.deleteContent('announcement', undefined, 'b')).toBe(true);
    expect((await m.collections.families.findOne({ _id: 'fam:T' }))!.announcement).toBeUndefined();
  });

  it("purgeAuthor: removes the author's DMs, family messages, announcements, mail and request messages — nobody else's", async () => {
    await befriend('a', 'P-B', 'b');
    await svc.sendMessage('a', 'P-B', 'alice keeps this', 'global');
    nowMs += 1;
    await svc.sendMessage('b', 'P-A', 'bob dm', 'global');
    await family(['b', 'a']);
    await familySvc.sendMessage('b', 'Bob', 'bob family');
    await familySvc.sendMessage('a', 'Alice', 'alice family');
    await familySvc.setAnnouncement('b', 'bob announcement');
    await mailSvc.sendPlayerMail('b', 'P-A', 'bob mail', 'body');
    await svc.requestFriend('b', 'P-C', 'bob request note');

    const res = await svc.purgeAuthor('b');
    expect(res).toEqual({ dmMessages: 1, familyMessages: 1, announcements: 1, mails: 1, friendRequestMessages: 1 });
    expect(await m.collections.chatMessages.find({}).map((d) => d.body).toArray()).toEqual(['alice keeps this']);
    expect(await m.collections.familyMessages.find({}).map((d) => d.body).toArray()).toEqual(['alice family']);
    expect((await m.collections.families.findOne({ _id: 'fam:T' }))!.announcement).toBeUndefined();
    expect(await m.collections.mails.countDocuments({})).toBe(0);
    expect((await m.collections.friendRequests.findOne({ from: 'b', to: 'c' }))!.message).toBeUndefined();
    expect(await m.collections.conversations.findOne({ _id: conversationId('a', 'b') })).toMatchObject({ lastBody: 'alice keeps this', lastFrom: 'a' });
    // Idempotent.
    expect(await svc.purgeAuthor('b')).toEqual({ dmMessages: 0, familyMessages: 0, announcements: 0, mails: 0, friendRequestMessages: 0 });
  });

  // ── HTTP surface ─────────────────────────────────────────────────────────

  describe('HTTP', () => {
    let server: Server;
    let base: string;
    const SECRET = 'test-jwt-secret';
    const KEY = 'test-internal-key';
    const auth = (id: string) => ({ authorization: `Bearer ${signToken(id, { secret: SECRET })}`, 'content-type': 'application/json' });
    const internal = { 'x-internal-key': KEY, 'content-type': 'application/json' };

    beforeAll(async () => {
      // Routes resolve services at request time from the ones passed here, so build a dedicated set whose
      // deps (meta/alerts) we can still reach from the tests via these closures.
      const httpMeta = new FakeMeta().add('ha', 'P-HA', 'Hal').add('hb', 'P-HB', 'Hob');
      const gw = new FakeGateway();
      const mail = new MailService({ cols: m.collections, gateway: gw, meta: httpMeta, now });
      const fam = new FamilyService({ cols: m.collections, gateway: gw, meta: httpMeta, mail, now });
      const friends = new FriendService({ cols: m.collections, gateway: gw, meta: httpMeta, now });
      server = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: KEY }, fam, friends, mail, gw, httpMeta);
      await new Promise<void>((res) => server.on('listening', res));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(() => { server.close(); });

    it('POST /social/friends/report with category + content → 200 and persisted; bad category/channel → 400', async () => {
      const okRes = await fetch(`${base}/social/friends/report`, {
        method: 'POST', headers: auth('ha'),
        body: JSON.stringify({ publicId: 'P-HB', category: 'hate', content: { channel: 'world', messageId: 'nm:1', text: 'slur' } }),
      });
      expect(okRes.status).toBe(200);
      const [r] = await m.collections.reports.find({ reporterId: 'ha' }).toArray();
      expect(r).toMatchObject({ category: 'hate', contentRef: { kind: 'content', channel: 'world', messageId: 'nm:1', snapshot: 'slur' } });

      const badCat = await fetch(`${base}/social/friends/report`, { method: 'POST', headers: auth('ha'), body: JSON.stringify({ publicId: 'P-HB', category: 'meh' }) });
      expect(badCat.status).toBe(400);
      const badChan = await fetch(`${base}/social/friends/report`, { method: 'POST', headers: auth('ha'), body: JSON.stringify({ publicId: 'P-HB', content: { channel: 'tv' } }) });
      expect(badChan.status).toBe(400);
    });

    it('POST /social/friends/block (with content) then GET /social/friends/blocked', async () => {
      const b = await fetch(`${base}/social/friends/block`, {
        method: 'POST', headers: auth('ha'),
        body: JSON.stringify({ publicId: 'P-HB', category: 'spam', content: { channel: 'family', text: 'spam' } }),
      });
      expect(b.status).toBe(200);
      expect(await m.collections.reports.countDocuments({ reporterId: 'ha', source: 'block', category: 'spam' })).toBe(1);
      const list = await fetch(`${base}/social/friends/blocked`, { headers: auth('ha') });
      expect(list.status).toBe(200);
      expect((await jsonBody(list)).data).toEqual({ blocked: [{ publicId: 'P-HB', displayName: 'Hob', ts: nowMs }] });
    });

    it('/internal/moderation/*: key required; validation; delete + purge', async () => {
      const noKey = await fetch(`${base}/internal/moderation/purge-author`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"accountId":"hb"}' });
      expect(noKey.status).toBe(401);
      const bad = await fetch(`${base}/internal/moderation/delete-content`, { method: 'POST', headers: internal, body: JSON.stringify({ channel: 'world', messageId: 'x' }) });
      expect(bad.status).toBe(400);
      const noId = await fetch(`${base}/internal/moderation/delete-content`, { method: 'POST', headers: internal, body: JSON.stringify({ channel: 'dm' }) });
      expect(noId.status).toBe(400);

      await m.collections.chatMessages.insertOne({ _id: 'dm-1', convId: conversationId('ha', 'hb'), from: 'hb', body: 'x', kind: 'text', ts: new Date(nowMs) });
      const del = await fetch(`${base}/internal/moderation/delete-content`, { method: 'POST', headers: internal, body: JSON.stringify({ channel: 'dm', messageId: 'dm-1' }) });
      expect((await jsonBody(del)).data).toEqual({ deleted: true });

      await m.collections.chatMessages.insertOne({ _id: 'dm-2', convId: conversationId('ha', 'hb'), from: 'hb', body: 'y', kind: 'text', ts: new Date(nowMs) });
      const purge = await fetch(`${base}/internal/moderation/purge-author`, { method: 'POST', headers: internal, body: JSON.stringify({ accountId: 'hb' }) });
      expect(purge.status).toBe(200);
      expect((await jsonBody(purge)).data).toMatchObject({ dmMessages: 1 });
    });
  });
});
