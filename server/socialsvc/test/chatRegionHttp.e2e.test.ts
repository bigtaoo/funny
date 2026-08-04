// Wire-level regression for O-CM5 (CONTENT_MODERATION_DESIGN.md §8): the client never used to send
// `X-Chat-Region`, so region-specific word lists (cn/de/en) never actually took effect in production —
// every real request fell through to the `global` default in httpApi.ts. This pins the *server* side
// of the fix at the exact header name/casing the client now sends (see client/src/net/chatRegion.ts +
// its call sites in WorldApiClient.createFamily/sendFamilyMessage and ApiClient/social.ts sendChat):
// with `X-Chat-Region: cn` a cn-only word list hit (absent from the global list) is caught; without it,
// the same word sails through untouched. Mirrors familyHttp.e2e.test.ts's real-server-real-Mongo shape.
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
const DB = 'nw_social_chat_region_http_test';
const SECRET = 'test-jwt-secret';
const INTERNAL_KEY = 'test-internal-key';

// 'private server' scam term — present in chatFilter.ts's `cn` overlay list, absent from `global`.
const CN_ONLY_WORD = '私服';

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
if (!mongo) console.warn(`[socialsvc.chatRegionHttp.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('socialsvc X-Chat-Region header e2e (O-CM5)', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let familySvc: FamilyService;
  let friendSvc: FriendService;
  const leaderToken = signToken('leader', { secret: SECRET });
  const leaderAuth = { authorization: `Bearer ${leaderToken}` };
  let t = 1_000_000;

  beforeAll(async () => {
    await m.collections.families.deleteMany({});
    await m.collections.familyMembers.deleteMany({});
    await m.collections.familyMessages.deleteMany({});
    await m.collections.chatMessages.deleteMany({});
    await m.collections.conversations.deleteMany({});
    await m.collections.friendEdges.deleteMany({});
    await m.collections.friendRequests.deleteMany({});
    await m.collections.friendCounts.deleteMany({});

    const meta = new FakeMeta().add('leader', 'P-LEA', 'Leader').add('alice', 'P-ALI', 'Alice').add('bob', 'P-BOB', 'Bob');
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

    // alice/bob mutual friendship, seeded directly (cheaper than the full request/respond flow).
    const req = await friendSvc.requestFriend('alice', 'P-BOB', undefined);
    if (req.kind === 'ok') await friendSvc.respondFriend('bob', req.requestId, true);
  });

  afterAll(async () => {
    server.close();
    await m.close();
  });

  it('POST /social/family: no X-Chat-Region header → falls back to global, cn-only word passes through', async () => {
    const r = await fetch(`${base}/social/family`, {
      method: 'POST',
      headers: { ...leaderAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${CN_ONLY_WORD}Family`, tag: 'NOCN' }),
    });
    expect(r.status).toBe(201);
    expect((await r.json()).data.name).toBe(`${CN_ONLY_WORD}Family`);
    await familySvc.dissolveFamily('leader'); // leave clean for the next case
  });

  it('POST /social/family: X-Chat-Region: cn → cn-only word list hit rejects creation', async () => {
    const r = await fetch(`${base}/social/family`, {
      method: 'POST',
      headers: { ...leaderAuth, 'content-type': 'application/json', 'X-Chat-Region': 'cn' },
      body: JSON.stringify({ name: `${CN_ONLY_WORD}Family`, tag: 'CNBAD' }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error.code).toBe('BAD_REQUEST');
  });

  it('POST /social/family/:id/messages: X-Chat-Region: cn masks a cn-only word; header absent lets it through', async () => {
    const fam = await familySvc.createFamily('leader', 'Clean Family', 'CLN2');

    const withRegion = await fetch(`${base}/social/family/${fam.familyId}/messages`, {
      method: 'POST',
      headers: { ...leaderAuth, 'content-type': 'application/json', 'X-Chat-Region': 'cn' },
      body: JSON.stringify({ body: `find me a ${CN_ONLY_WORD} now` }),
    });
    expect(withRegion.status).toBe(200);
    expect((await withRegion.json()).data.body).toBe('find me a ** now');

    const withoutRegion = await fetch(`${base}/social/family/${fam.familyId}/messages`, {
      method: 'POST',
      headers: { ...leaderAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ body: `find me a ${CN_ONLY_WORD} now` }),
    });
    expect(withoutRegion.status).toBe(200);
    expect((await withoutRegion.json()).data.body).toBe(`find me a ${CN_ONLY_WORD} now`);
  });

  it('POST /social/chat/send: X-Chat-Region: cn masks a cn-only word; header absent lets it through', async () => {
    const aliceToken = signToken('alice', { secret: SECRET });
    const aliceAuth = { authorization: `Bearer ${aliceToken}` };

    const withRegion = await fetch(`${base}/social/chat/send`, {
      method: 'POST',
      headers: { ...aliceAuth, 'content-type': 'application/json', 'X-Chat-Region': 'cn' },
      body: JSON.stringify({ toPublicId: 'P-BOB', body: `try ${CN_ONLY_WORD} today` }),
    });
    expect(withRegion.status).toBe(200);
    const { messageId: idWithRegion } = (await withRegion.json()).data as { messageId: string };

    const withoutRegion = await fetch(`${base}/social/chat/send`, {
      method: 'POST',
      headers: { ...aliceAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ toPublicId: 'P-BOB', body: `try ${CN_ONLY_WORD} today` }),
    });
    expect(withoutRegion.status).toBe(200);
    const { messageId: idWithoutRegion } = (await withoutRegion.json()).data as { messageId: string };

    const convId = ['alice', 'bob'].sort().join(':');
    const history = await fetch(`${base}/social/chat/${convId}/messages`, { headers: aliceAuth });
    const messages = (await history.json()).data.messages as Array<{ messageId: string; body: string }>;
    expect(messages.find((msg) => msg.messageId === idWithRegion)?.body).toBe('try ** today');
    expect(messages.find((msg) => msg.messageId === idWithoutRegion)?.body).toBe(`try ${CN_ONLY_WORD} today`);
  });
});
