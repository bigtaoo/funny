// socialsvc family HTTP route gap-fill (real node:http server + real Mongo, mirrors mailHttp.e2e.test.ts/
// familyHttp.e2e.test.ts). family.e2e.test.ts drives FamilyService directly (bypassing httpApi's wire
// parsing); familyHttp.e2e.test.ts's own HTTP coverage focuses on browse/emblem/get-by-id/join/requests +
// the internal routes. This file closes the routes neither exercises at the HTTP layer at all: GET
// /social/family/mine, GET /social/family/search, POST /social/family (create, incl. 400s), POST
// /social/family/leave, /kick, /role, /disband, /announcement (each incl. their own 400s), and GET/POST
// /social/family/:id/messages. One flowing scenario (own DB, own accounts) rather than per-test isolation,
// since most of these routes mutate shared family state.
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
const DB = 'nw_social_family_http_gaps_test';
const SECRET = 'test-jwt-secret';

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
if (!mongo) console.warn(`[socialsvc.familyHttpRoutesGaps.e2e] Mongo unreachable (${URI}) — skipping.`);

function authFor(accountId: string): Record<string, string> {
  return { authorization: `Bearer ${signToken(accountId, { secret: SECRET })}` };
}

describe.skipIf(!mongo)('socialsvc family HTTP routes gap-fill e2e', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let gateway: FakeGateway;
  let t = 2_000_000;

  beforeAll(async () => {
    await m.collections.families.deleteMany({});
    await m.collections.familyMembers.deleteMany({});
    const meta = new FakeMeta()
      .add('creator1', 'P-C1', 'Creator')
      .add('member1', 'P-M1', 'MemberOne')
      .add('member2', 'P-M2', 'MemberTwo')
      .add('member3', 'P-M3', 'MemberThree');
    gateway = new FakeGateway();
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now: () => t });
    const familySvc = new FamilyService({ cols: m.collections, now: () => t, gateway, meta, mail: mailSvc });
    const friendSvc = new FriendService({ cols: m.collections, gateway, meta, now: () => t });
    server = startHttpApi({ host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: 'k' }, familySvc, friendSvc, mailSvc, gateway, meta);
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.close();
    await m.collections.families.deleteMany({});
    await m.collections.familyMembers.deleteMany({});
    await m.close();
  });

  /** Joins accountId to familyId via the real request+accept flow (as leaderId), returns nothing. */
  async function joinAndAccept(leaderId: string, accountId: string, familyId: string): Promise<void> {
    const join = await fetch(`${base}/social/family/${familyId}/join`, { method: 'POST', headers: authFor(accountId) });
    expect(join.status).toBe(200);
    const requests = await (await fetch(`${base}/social/family/requests`, { headers: authFor(leaderId) })).json();
    const req = (requests.data.requests as Array<{ requestId: string; accountId: string }>).find((r) => r.accountId === accountId)!;
    const respond = await fetch(`${base}/social/family/requests/${req.requestId}/respond`, {
      method: 'POST', headers: { ...authFor(leaderId), 'content-type': 'application/json' }, body: JSON.stringify({ accept: true }),
    });
    expect(respond.status).toBe(200);
  }

  it('POST /social/family: missing name -> 400, missing tag -> 400', async () => {
    const noName = await fetch(`${base}/social/family`, {
      method: 'POST', headers: { ...authFor('creator1'), 'content-type': 'application/json' }, body: JSON.stringify({ tag: 'CRT1' }),
    });
    expect(noName.status).toBe(400);
    const noTag = await fetch(`${base}/social/family`, {
      method: 'POST', headers: { ...authFor('creator1'), 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Creators' }),
    });
    expect(noTag.status).toBe(400);
  });

  it('POST /social/family: creates the family, 201', async () => {
    const r = await fetch(`${base}/social/family`, {
      method: 'POST', headers: { ...authFor('creator1'), 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Creators', tag: 'CRT1' }),
    });
    expect(r.status).toBe(201);
    expect((await r.json()).data).toMatchObject({ familyId: 'fam:CRT1', tag: 'CRT1' });
  });

  it('GET /social/family/mine: returns the family the caller belongs to', async () => {
    const r = await fetch(`${base}/social/family/mine`, { headers: authFor('creator1') });
    expect(r.status).toBe(200);
    expect((await r.json()).data).toMatchObject({ familyId: 'fam:CRT1' });
  });

  it('GET /social/family/search: missing tag -> 400; found -> the matching family view', async () => {
    const missing = await fetch(`${base}/social/family/search`, { headers: authFor('creator1') });
    expect(missing.status).toBe(400);
    const found = await fetch(`${base}/social/family/search?tag=CRT1`, { headers: authFor('creator1') });
    expect(found.status).toBe(200);
    expect((await found.json()).data).toMatchObject({ familyId: 'fam:CRT1' });
  });

  it('POST /social/family/announcement: missing field -> 400; success sets it', async () => {
    const bad = await fetch(`${base}/social/family/announcement`, {
      method: 'POST', headers: { ...authFor('creator1'), 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/social/family/announcement`, {
      method: 'POST', headers: { ...authFor('creator1'), 'content-type': 'application/json' }, body: JSON.stringify({ announcement: 'Welcome!' }),
    });
    expect(ok.status).toBe(200);
    const mine = await (await fetch(`${base}/social/family/mine`, { headers: authFor('creator1') })).json();
    expect(mine.data.announcement).toBe('Welcome!');
  });

  it('member1 joins fam:CRT1 (request + leader accept)', async () => {
    await joinAndAccept('creator1', 'member1', 'fam:CRT1');
    const mine = await (await fetch(`${base}/social/family/mine`, { headers: authFor('member1') })).json();
    expect(mine.data.familyId).toBe('fam:CRT1');
  });

  it('POST /social/family/role: missing fields -> 400; success promotes member1 to elder', async () => {
    const bad = await fetch(`${base}/social/family/role`, {
      method: 'POST', headers: { ...authFor('creator1'), 'content-type': 'application/json' }, body: JSON.stringify({ targetId: 'member1' }),
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/social/family/role`, {
      method: 'POST', headers: { ...authFor('creator1'), 'content-type': 'application/json' }, body: JSON.stringify({ targetId: 'member1', role: 'elder' }),
    });
    expect(ok.status).toBe(200);
    const view = await (await fetch(`${base}/social/family/mine`, { headers: authFor('member1') })).json();
    expect((view.data.members as Array<{ accountId: string; role: string }>).find((mm) => mm.accountId === 'member1')?.role).toBe('elder');
  });

  it('GET /social/family/:id/messages: empty channel history to start', async () => {
    const r = await fetch(`${base}/social/family/fam:CRT1/messages`, { headers: authFor('creator1') });
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual([]);
  });

  it('POST /social/family/:id/messages: missing body -> 400; success pushes family_msg to the other member', async () => {
    const bad = await fetch(`${base}/social/family/fam:CRT1/messages`, {
      method: 'POST', headers: { ...authFor('creator1'), 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/social/family/fam:CRT1/messages`, {
      method: 'POST', headers: { ...authFor('creator1'), 'content-type': 'application/json' }, body: JSON.stringify({ body: 'hello family' }),
    });
    expect(ok.status).toBe(200);
    const history = await (await fetch(`${base}/social/family/fam:CRT1/messages`, { headers: authFor('creator1') })).json();
    expect(history.data).toHaveLength(1);
    expect(gateway.ofKind('family_msg').some((p) => p.body === 'hello family')).toBe(true);
  });

  it('member2 joins, then POST /social/family/kick: missing targetId -> 400; success removes member2', async () => {
    await joinAndAccept('creator1', 'member2', 'fam:CRT1');
    const bad = await fetch(`${base}/social/family/kick`, {
      method: 'POST', headers: { ...authFor('creator1'), 'content-type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/social/family/kick`, {
      method: 'POST', headers: { ...authFor('creator1'), 'content-type': 'application/json' }, body: JSON.stringify({ targetId: 'member2' }),
    });
    expect(ok.status).toBe(200);
    const mineAfterKick = await fetch(`${base}/social/family/mine`, { headers: authFor('member2') });
    expect((await mineAfterKick.json()).data).toBeNull();
  });

  it('member3 joins, then POST /social/family/leave removes them', async () => {
    await joinAndAccept('creator1', 'member3', 'fam:CRT1');
    const r = await fetch(`${base}/social/family/leave`, { method: 'POST', headers: authFor('member3') });
    expect(r.status).toBe(200);
    const mineAfterLeave = await fetch(`${base}/social/family/mine`, { headers: authFor('member3') });
    expect((await mineAfterLeave.json()).data).toBeNull();
  });

  it('POST /social/family/disband: leader dissolves the family', async () => {
    const r = await fetch(`${base}/social/family/disband`, { method: 'POST', headers: authFor('creator1') });
    expect(r.status).toBe(200);
    const mineAfterDisband = await fetch(`${base}/social/family/mine`, { headers: authFor('creator1') });
    expect((await mineAfterDisband.json()).data).toBeNull();
  });
});
