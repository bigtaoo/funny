// socialsvc friend + private-chat HTTP route e2e (real node:http server + real Mongo, mirrors
// familyHttp.e2e.test.ts). 2026-08-10, friendService.ts split audit: grepping friendRoutes.ts's /
// chatRoutes.ts's route strings against the test suite (same audit shape as familyService.ts's split
// the same day) found that most of these routes were previously exercised only at the service layer
// (friend.e2e.test.ts calling `svc.xxx()` directly) or only on their error paths
// (socialErrorsHttp.e2e.test.ts) — never through the actual HTTP route + JWT auth that the client
// hits in production. A pre-existing gap, not introduced by the split.
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

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017';
const DB = 'nw_social_friend_http_test';
const SECRET = 'test-jwt-secret';
const INTERNAL_KEY = 'test-internal-key';

async function tryConnect(): Promise<SocialMongo | null> {
  try {
    const m = await createSocialMongo(URI, DB);
    await m.collections.families.estimatedDocumentCount();
    return m;
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[socialsvc.friendHttp.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('socialsvc friend + chat HTTP routes e2e', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  const auth = (accountId: string) => ({ authorization: `Bearer ${signToken(accountId, { secret: SECRET })}` });
  const json = { 'content-type': 'application/json' };
  let t = 1_000_000;

  beforeAll(async () => {
    const meta = new FakeMeta()
      .add('fa', 'P-FA', 'Alice')
      .add('fb', 'P-FB', 'Bob')
      .add('fc', 'P-FC', 'Cara')
      .add('fd', 'P-FD', 'Dan')
      .add('fe', 'P-FE', 'Eve')
      .add('ff', 'P-FF', 'Finn')
      .add('fg', 'P-FG', 'Gale')
      .add('fh', 'P-FH', 'Hana');
    const gateway = new FakeGateway();
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now: () => t });
    const familySvc = new FamilyService({ cols: m.collections, now: () => t, gateway, meta, mail: mailSvc });
    const friendSvc = new FriendService({ cols: m.collections, gateway, meta, now: () => t });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: INTERNAL_KEY },
      familySvc, friendSvc, mailSvc, gateway, meta,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await m.close();
  });

  it('POST /social/friends/search: known publicId → the profile (wire-level; error paths already covered)', async () => {
    const r = await fetch(`${base}/social/friends/search`, {
      method: 'POST',
      headers: { ...auth('fa'), ...json },
      body: JSON.stringify({ publicId: 'P-FB' }),
    });
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ profile: expect.objectContaining({ publicId: 'P-FB', displayName: 'Bob' }) });
  });

  it('POST /social/friends/request → GET /social/friends/requests → POST /social/friends/respond: full wire round trip', async () => {
    const reqRes = await fetch(`${base}/social/friends/request`, {
      method: 'POST',
      headers: { ...auth('fa'), ...json },
      body: JSON.stringify({ publicId: 'P-FB', message: 'hi!' }),
    });
    expect(reqRes.status).toBe(200);
    const { requestId } = (await reqRes.json()).data as { requestId: string };
    expect(requestId).toBeTruthy();

    const incomingRes = await fetch(`${base}/social/friends/requests`, { headers: auth('fb') });
    expect(incomingRes.status).toBe(200);
    const { incoming } = (await incomingRes.json()).data as { incoming: Array<{ requestId: string; fromPublicId: string; message?: string }> };
    expect(incoming).toEqual([expect.objectContaining({ requestId, fromPublicId: 'P-FA', message: 'hi!' })]);

    const outgoingRes = await fetch(`${base}/social/friends/requests`, { headers: auth('fa') });
    const { outgoing } = (await outgoingRes.json()).data as { outgoing: Array<{ requestId: string; toPublicId: string }> };
    expect(outgoing).toEqual([expect.objectContaining({ requestId, toPublicId: 'P-FB' })]);

    const badgesRes = await fetch(`${base}/social/badges`, { headers: auth('fb') });
    expect((await badgesRes.json()).data).toMatchObject({ friendRequests: 1 });

    const respondRes = await fetch(`${base}/social/friends/respond`, {
      method: 'POST',
      headers: { ...auth('fb'), ...json },
      body: JSON.stringify({ requestId, accept: true }),
    });
    expect(respondRes.status).toBe(200);
    expect((await respondRes.json()).data).toEqual({ ok: true });

    const friendsA = await fetch(`${base}/social/friends`, { headers: auth('fa') });
    expect((await friendsA.json()).data).toEqual({ friends: [expect.objectContaining({ publicId: 'P-FB' })] });
    const friendsB = await fetch(`${base}/social/friends`, { headers: auth('fb') });
    expect((await friendsB.json()).data).toEqual({ friends: [expect.objectContaining({ publicId: 'P-FA' })] });

    // Resolved request no longer shows up as pending on either side.
    const badgesAfter = await fetch(`${base}/social/badges`, { headers: auth('fb') });
    expect((await badgesAfter.json()).data).toMatchObject({ friendRequests: 0 });
  });

  it('POST /social/friends/respond {accept:false}: rejects without creating a friend edge (wire-level)', async () => {
    const reqRes = await fetch(`${base}/social/friends/request`, {
      method: 'POST',
      headers: { ...auth('fc'), ...json },
      body: JSON.stringify({ publicId: 'P-FD' }),
    });
    const { requestId } = (await reqRes.json()).data as { requestId: string };

    const respondRes = await fetch(`${base}/social/friends/respond`, {
      method: 'POST',
      headers: { ...auth('fd'), ...json },
      body: JSON.stringify({ requestId, accept: false }),
    });
    // The route's ack body is a bare { ok: true } regardless of accept/reject (respondFriend's
    // `accepted` flag isn't surfaced over the wire) — the actual outcome is verified below via the
    // friends list staying empty.
    expect(respondRes.status).toBe(200);
    expect((await respondRes.json()).data).toEqual({ ok: true });

    const friendsC = await fetch(`${base}/social/friends`, { headers: auth('fc') });
    expect((await friendsC.json()).data).toEqual({ friends: [] });
  });

  it('DELETE /social/friends/:publicId: removes the mutual edge on both sides (wire-level)', async () => {
    const reqRes = await fetch(`${base}/social/friends/request`, {
      method: 'POST',
      headers: { ...auth('fc'), ...json },
      body: JSON.stringify({ publicId: 'P-FD' }),
    });
    const { requestId } = (await reqRes.json()).data as { requestId: string };
    await fetch(`${base}/social/friends/respond`, {
      method: 'POST',
      headers: { ...auth('fd'), ...json },
      body: JSON.stringify({ requestId, accept: true }),
    });

    const delRes = await fetch(`${base}/social/friends/P-FD`, { method: 'DELETE', headers: auth('fc') });
    expect(delRes.status).toBe(200);
    expect((await delRes.json()).data).toEqual({ ok: true });

    const friendsC = await fetch(`${base}/social/friends`, { headers: auth('fc') });
    expect((await friendsC.json()).data).toEqual({ friends: [] });
    const friendsD = await fetch(`${base}/social/friends`, { headers: auth('fd') });
    expect((await friendsD.json()).data).toEqual({ friends: [] });
  });

  it('POST /social/friends/block → DELETE /social/friends/block/:publicId: blocking then unblocking (wire-level)', async () => {
    const blockRes = await fetch(`${base}/social/friends/block`, {
      method: 'POST',
      headers: { ...auth('fe'), ...json },
      body: JSON.stringify({ publicId: 'P-FF' }),
    });
    expect(blockRes.status).toBe(200);
    expect((await blockRes.json()).data).toEqual({ ok: true });

    // Blocked: a friend request from the blocked side is rejected.
    const blockedReqRes = await fetch(`${base}/social/friends/request`, {
      method: 'POST',
      headers: { ...auth('ff'), ...json },
      body: JSON.stringify({ publicId: 'P-FE' }),
    });
    expect(blockedReqRes.status).toBe(403);
    expect((await blockedReqRes.json()).error.code).toBe('BLOCKED');

    const unblockRes = await fetch(`${base}/social/friends/block/P-FF`, { method: 'DELETE', headers: auth('fe') });
    expect(unblockRes.status).toBe(200);
    expect((await unblockRes.json()).data).toEqual({ ok: true });

    // Unblocked: the same request now goes through.
    const reqRes = await fetch(`${base}/social/friends/request`, {
      method: 'POST',
      headers: { ...auth('ff'), ...json },
      body: JSON.stringify({ publicId: 'P-FE' }),
    });
    expect(reqRes.status).toBe(200);
  });

  it('GET /social/chat/conversations + POST /social/chat/read: conversation list + unread clears (wire-level)', async () => {
    // Chat requires an existing friendship (NOT_FRIEND otherwise).
    const reqRes = await fetch(`${base}/social/friends/request`, {
      method: 'POST',
      headers: { ...auth('fg'), ...json },
      body: JSON.stringify({ publicId: 'P-FH' }),
    });
    const { requestId } = (await reqRes.json()).data as { requestId: string };
    await fetch(`${base}/social/friends/respond`, {
      method: 'POST',
      headers: { ...auth('fh'), ...json },
      body: JSON.stringify({ requestId, accept: true }),
    });

    const sendRes = await fetch(`${base}/social/chat/send`, {
      method: 'POST',
      headers: { ...auth('fg'), ...json },
      body: JSON.stringify({ toPublicId: 'P-FH', body: 'yo' }),
    });
    expect(sendRes.status).toBe(200);

    const convRes = await fetch(`${base}/social/chat/conversations`, { headers: auth('fh') });
    expect(convRes.status).toBe(200);
    const { conversations } = (await convRes.json()).data as { conversations: Array<{ convId: string; peer: { publicId: string }; lastBody?: string; unread: number }> };
    expect(conversations).toEqual([expect.objectContaining({ peer: expect.objectContaining({ publicId: 'P-FG' }), lastBody: 'yo', unread: 1 })]);
    const convId = conversations[0]!.convId;

    const readRes = await fetch(`${base}/social/chat/read`, {
      method: 'POST',
      headers: { ...auth('fh'), ...json },
      body: JSON.stringify({ convId }),
    });
    expect(readRes.status).toBe(200);
    expect((await readRes.json()).data).toEqual({ ok: true });

    const convAfter = await fetch(`${base}/social/chat/conversations`, { headers: auth('fh') });
    const { conversations: after } = (await convAfter.json()).data as { conversations: Array<{ unread: number }> };
    expect(after[0]!.unread).toBe(0);
  });
});
