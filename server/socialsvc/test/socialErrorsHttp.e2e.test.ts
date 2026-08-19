// Wire-level regression for the 2026-08-03 openapi-social.yml ErrorResp pass (SLG_DESIGN_LOG.md §60):
// that pass documented a specific status code + ErrorCode for every operation by tracing httpApi.ts +
// familyService.ts/friendService.ts/mailService.ts source, but tracing isn't running the code — this
// file exercises every one of those traced error paths that had zero test coverage anywhere (HTTP or
// service level) before this pass, real server + real Mongo, to confirm the documented codes are what
// actually comes back over the wire. Mirrors familyHttp.e2e.test.ts's shape.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { signToken } from '@nw/shared';
import { createSocialMongo, type SocialMongo } from '../src/db';
import { FamilyService } from '../src/familyService';
import { FriendService } from '../src/friendService';
import { MailService } from '../src/mailService';
import { startHttpApi } from '../src/httpApi';
import { FakeMeta, FakeGateway } from './harness';
import { jsonBody } from './jsonBody';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017';
const DB = 'nw_social_errors_http_test';
const SECRET = 'test-jwt-secret';
const INTERNAL_KEY = 'test-internal-key';

async function tryConnect(): Promise<SocialMongo | null> {
  try {
    const m = await createSocialMongo(URI, DB);
    await m.collections.families.estimatedDocumentCount();
    return m;
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[socialsvc.socialErrorsHttp.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('socialsvc ErrorResp wire-level coverage (2026-08-03 pass)', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let familySvc: FamilyService;
  let friendSvc: FriendService;
  const auth = (accountId: string) => ({ authorization: `Bearer ${signToken(accountId, { secret: SECRET })}` });
  const json = { 'content-type': 'application/json' };
  let t = 1_000_000;

  beforeAll(async () => {
    await m.collections.families.deleteMany({});
    await m.collections.familyMembers.deleteMany({});
    await m.collections.familyJoinRequests.deleteMany({});
    await m.collections.friendEdges.deleteMany({});
    await m.collections.friendRequests.deleteMany({});
    await m.collections.friendCounts.deleteMany({});
    await m.collections.blockList.deleteMany({});
    await m.collections.reports.deleteMany({});
    await m.collections.conversations.deleteMany({});
    await m.collections.chatMessages.deleteMany({});
    await m.collections.mails.deleteMany({});

    const meta = new FakeMeta()
      .add('leader', 'P-LEADER', 'Leader')
      .add('elder', 'P-ELDER', 'Elder')
      .add('member', 'P-MEMBER', 'Member')
      .add('outsider', 'P-OUTSIDER', 'Outsider')
      .add('friend-a', 'P-FRIEND-A', 'FriendA')
      .add('friend-b', 'P-FRIEND-B', 'FriendB');
    const gateway = new FakeGateway();
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now: () => t });
    familySvc = new FamilyService({ cols: m.collections, now: () => t, gateway, meta, mail: mailSvc });
    friendSvc = new FriendService({ cols: m.collections, gateway, meta, now: () => t });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: INTERNAL_KEY },
      familySvc, friendSvc, mailSvc, gateway, meta,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await familySvc.createFamily('leader', 'ErrorTest', 'ERRT');
    await familySvc.joinFamily('elder', 'fam:ERRT');
    await familySvc.setRole('leader', 'elder', 'elder');
    await familySvc.joinFamily('member', 'fam:ERRT');

    await friendSvc.requestFriend('friend-a', 'P-FRIEND-B', undefined).then((r) => {
      if (r.kind === 'ok') return friendSvc.respondFriend('friend-b', r.requestId, true);
    });
  });

  afterAll(async () => {
    server.close();
    await m.close();
  });

  // ── Family ──────────────────────────────────────────────────────────────────

  it('GET /social/family/search: no ?tag → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/family/search`, { headers: auth('leader') });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/family/requests/:id/respond: unknown requestId → 404 NOT_FOUND', async () => {
    const r = await fetch(`${base}/social/family/requests/no-such-request/respond`, {
      method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify({ accept: true }),
    });
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error.code).toBe('NOT_FOUND');
  });

  it('POST /social/family/leave: non-member → 403 NOT_IN_FAMILY', async () => {
    const r = await fetch(`${base}/social/family/leave`, { method: 'POST', headers: auth('outsider') });
    expect(r.status).toBe(403);
    expect((await jsonBody(r)).error.code).toBe('NOT_IN_FAMILY');
  });

  it('POST /social/family/leave: leader cannot leave → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/family/leave`, { method: 'POST', headers: auth('leader') });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/family/kick: missing targetId → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/family/kick`, { method: 'POST', headers: { ...auth('leader'), ...json }, body: '{}' });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/family/kick: self-kick → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/family/kick`, {
      method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify({ targetId: 'leader' }),
    });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/family/kick: unknown target → 404 NOT_FOUND', async () => {
    const r = await fetch(`${base}/social/family/kick`, {
      method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify({ targetId: 'no-such-account' }),
    });
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error.code).toBe('NOT_FOUND');
  });

  it('POST /social/family/kick: plain member cannot kick → 403 NO_PERMISSION', async () => {
    // member tries to kick elder — members have no kick permission at all, regardless of target.
    const r = await fetch(`${base}/social/family/kick`, {
      method: 'POST', headers: { ...auth('member'), ...json }, body: JSON.stringify({ targetId: 'elder' }),
    });
    expect(r.status).toBe(403);
    expect((await jsonBody(r)).error.code).toBe('NO_PERMISSION');
  });

  it('POST /social/family/role: missing fields → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/family/role`, { method: 'POST', headers: { ...auth('leader'), ...json }, body: '{}' });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/family/role: cannot promote to leader → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/family/role`, {
      method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify({ targetId: 'member', role: 'leader' }),
    });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/family/role: non-leader caller → 403 NO_PERMISSION', async () => {
    const r = await fetch(`${base}/social/family/role`, {
      method: 'POST', headers: { ...auth('elder'), ...json }, body: JSON.stringify({ targetId: 'member', role: 'elder' }),
    });
    expect(r.status).toBe(403);
    expect((await jsonBody(r)).error.code).toBe('NO_PERMISSION');
  });

  it('POST /social/family/role: unknown target → 404 NOT_FOUND', async () => {
    const r = await fetch(`${base}/social/family/role`, {
      method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify({ targetId: 'no-such-account', role: 'elder' }),
    });
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error.code).toBe('NOT_FOUND');
  });

  it('POST /social/family/disband: non-leader → 403 NO_PERMISSION', async () => {
    const r = await fetch(`${base}/social/family/disband`, { method: 'POST', headers: auth('elder') });
    expect(r.status).toBe(403);
    expect((await jsonBody(r)).error.code).toBe('NO_PERMISSION');
  });

  it('POST /social/family/announcement: missing field → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/family/announcement`, { method: 'POST', headers: { ...auth('leader'), ...json }, body: '{}' });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/family/announcement: over 200 chars → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/family/announcement`, {
      method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify({ announcement: 'x'.repeat(201) }),
    });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/family/announcement: plain member → 403 NO_PERMISSION', async () => {
    const r = await fetch(`${base}/social/family/announcement`, {
      method: 'POST', headers: { ...auth('member'), ...json }, body: JSON.stringify({ announcement: 'hi' }),
    });
    expect(r.status).toBe(403);
    expect((await jsonBody(r)).error.code).toBe('NO_PERMISSION');
  });

  it('GET /social/family/:id/messages: non-member → 403 NOT_IN_FAMILY', async () => {
    const r = await fetch(`${base}/social/family/fam:ERRT/messages`, { headers: auth('outsider') });
    expect(r.status).toBe(403);
    expect((await jsonBody(r)).error.code).toBe('NOT_IN_FAMILY');
  });

  // ── Friends ─────────────────────────────────────────────────────────────────

  it('POST /social/friends/search: missing publicId → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/friends/search`, { method: 'POST', headers: { ...auth('friend-a'), ...json }, body: '{}' });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/friends/search: unknown publicId → 404 NOT_FOUND', async () => {
    const r = await fetch(`${base}/social/friends/search`, {
      method: 'POST', headers: { ...auth('friend-a'), ...json }, body: JSON.stringify({ publicId: 'no-such-public-id' }),
    });
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error.code).toBe('NOT_FOUND');
  });

  it('POST /social/friends/block: missing publicId → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/friends/block`, { method: 'POST', headers: { ...auth('friend-a'), ...json }, body: '{}' });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/friends/block: unknown publicId → 404 NOT_FOUND', async () => {
    const r = await fetch(`${base}/social/friends/block`, {
      method: 'POST', headers: { ...auth('friend-a'), ...json }, body: JSON.stringify({ publicId: 'no-such-public-id' }),
    });
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error.code).toBe('NOT_FOUND');
  });

  // reportFriend: newly added to openapi-social.yml this pass (existed in httpApi.ts since 2026-07-27
  // per COMPLIANCE_GLOBAL.md §7, but had never had a test of its own anywhere).
  it('POST /social/friends/report: missing publicId → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/friends/report`, { method: 'POST', headers: { ...auth('friend-a'), ...json }, body: '{}' });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/friends/report: unknown publicId → 404 NOT_FOUND', async () => {
    const r = await fetch(`${base}/social/friends/report`, {
      method: 'POST', headers: { ...auth('friend-a'), ...json }, body: JSON.stringify({ publicId: 'no-such-public-id', reason: 'spam' }),
    });
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error.code).toBe('NOT_FOUND');
  });

  it('POST /social/friends/report: reporting yourself → 404 NOT_FOUND (reportUser treats self-target as unresolved)', async () => {
    const r = await fetch(`${base}/social/friends/report`, {
      method: 'POST', headers: { ...auth('friend-a'), ...json }, body: JSON.stringify({ publicId: 'P-FRIEND-A', reason: 'spam' }),
    });
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error.code).toBe('NOT_FOUND');
  });

  it('POST /social/friends/report: valid report → 200, persisted with status "open"', async () => {
    const r = await fetch(`${base}/social/friends/report`, {
      method: 'POST', headers: { ...auth('friend-a'), ...json }, body: JSON.stringify({ publicId: 'P-FRIEND-B', reason: 'spamming world chat' }),
    });
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).data).toEqual({ ok: true });
    const report = await m.collections.reports.findOne({ reporterId: 'friend-a', targetId: 'friend-b' });
    expect(report).toMatchObject({ status: 'open', reason: 'spamming world chat' });
  });

  // ── Direct messages ─────────────────────────────────────────────────────────

  it('GET /social/chat/:convId/messages: unknown conversation → 404 NOT_FOUND', async () => {
    const r = await fetch(`${base}/social/chat/no-such-conv/messages`, { headers: auth('friend-a') });
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error.code).toBe('NOT_FOUND');
  });

  it('GET /social/chat/:convId/messages: real conversation but caller not a member → 404 NOT_FOUND', async () => {
    await friendSvc.sendMessage('friend-a', 'P-FRIEND-B', 'seed message', 'global');
    const conv = await m.collections.conversations.findOne({ members: { $all: ['friend-a', 'friend-b'] } });
    expect(conv).toBeTruthy();
    const r = await fetch(`${base}/social/chat/${conv!._id}/messages`, { headers: auth('outsider') });
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error.code).toBe('NOT_FOUND');
  });

  it('POST /social/chat/send: missing fields → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/chat/send`, { method: 'POST', headers: { ...auth('friend-a'), ...json }, body: '{}' });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/chat/send: over the per-minute rate limit → 429 RATE_LIMITED', async () => {
    // CHAT_SEND_RATE_PER_MIN = 30 (server/shared/src/social.ts); allowChat() keys its sliding window off
    // real Date.now(), so 31 rapid-fire sends land in the same 60s window without needing a fake clock.
    let lastStatus = 0;
    for (let i = 0; i < 31; i++) {
      const r = await fetch(`${base}/social/chat/send`, {
        method: 'POST', headers: { ...auth('friend-a'), ...json },
        body: JSON.stringify({ toPublicId: 'P-FRIEND-B', body: `spam ${i}` }),
      });
      lastStatus = r.status;
      if (i === 30) {
        expect(r.status).toBe(429);
        expect((await jsonBody(r)).error.code).toBe('RATE_LIMITED');
      }
    }
    expect(lastStatus).toBe(429);
  });

  it('POST /social/chat/read: missing convId → 400 BAD_REQUEST', async () => {
    const r = await fetch(`${base}/social/chat/read`, { method: 'POST', headers: { ...auth('friend-a'), ...json }, body: '{}' });
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error.code).toBe('BAD_REQUEST');
  });

  // ── Mail ────────────────────────────────────────────────────────────────────

  it('POST /social/mail/:id/read: unknown mailId → 404 NOT_FOUND', async () => {
    const r = await fetch(`${base}/social/mail/no-such-mail/read`, { method: 'POST', headers: auth('friend-a') });
    expect(r.status).toBe(404);
    expect((await jsonBody(r)).error.code).toBe('NOT_FOUND');
  });
});
