// socialsvc family HTTP route e2e (real node:http server + real Mongo, mirrors mailHttp.e2e.test.ts).
// Covers wire-level query-param parsing for GET /social/family/browse (default limit, custom limit,
// `q` fuzzy filter) that the service-level family.e2e.test.ts calls directly and can't exercise.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { signToken, internalHeaders } from '@nw/shared';
import { createSocialMongo, type SocialMongo } from '../src/db';
import { FamilyService } from '../src/familyService';
import { FriendService } from '../src/friendService';
import { MailService } from '../src/mailService';
import { startHttpApi } from '../src/httpApi';
import { FakeMeta, FakeGateway } from './harness';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017';
const DB = 'nw_social_family_http_test';
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
if (!mongo) console.warn(`[socialsvc.familyHttp.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('socialsvc family HTTP routes e2e', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let familySvc: FamilyService;
  const token = signToken('leader-a', { secret: SECRET });
  const auth = { authorization: `Bearer ${token}` };
  let t = 1_000_000;

  beforeAll(async () => {
    await m.collections.families.deleteMany({});
    await m.collections.familyMembers.deleteMany({});
    const meta = new FakeMeta().add('leader-a', 'P-A', 'Alice', 'gold').add('leader-b', 'P-B', 'Bob');
    const gateway = new FakeGateway();
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now: () => t });
    familySvc = new FamilyService({ cols: m.collections, now: () => t, gateway, meta, mail: mailSvc });
    const friendSvc = new FriendService({ cols: m.collections, gateway, meta, now: () => t });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: INTERNAL_KEY },
      familySvc, friendSvc, mailSvc, gateway, meta,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await familySvc.createFamily('leader-a', 'AlphaKnight', 'ALFA');
    await familySvc.createFamily('leader-b', 'BetaRaiders', 'BETA');
    await familySvc.refreshProsperity('fam:ALFA', 5);
    await familySvc.refreshProsperity('fam:BETA', 50);
  });

  afterAll(async () => {
    server.close();
    await m.collections.families.deleteMany({});
    await m.collections.familyMembers.deleteMany({});
    await m.close();
  });

  it('no token → 401', async () => {
    const r = await fetch(`${base}/social/family/browse`);
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe('UNAUTHENTICATED');
  });

  it('GET /social/player/:accountId/rank: returns the rank the meta client resolved', async () => {
    const r = await fetch(`${base}/social/player/leader-a/rank`, { headers: auth });
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ rank: 'gold' });
  });

  it('GET /social/player/:accountId/rank: unranked/unknown account → empty object, not an error', async () => {
    const r = await fetch(`${base}/social/player/no-such-account/rank`, { headers: auth });
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({});
  });

  it('GET /social/family/browse: no query → top families by prosperity desc', async () => {
    const r = await fetch(`${base}/social/family/browse`, { headers: auth });
    expect(r.status).toBe(200);
    const families = (await r.json()).data as Array<{ familyId: string }>;
    expect(families.map((f) => f.familyId)).toEqual(['fam:BETA', 'fam:ALFA']);
  });

  it('GET /social/family/browse?q=: fuzzy-matches by name, case-insensitive', async () => {
    const r = await fetch(`${base}/social/family/browse?q=alpha`, { headers: auth });
    expect(r.status).toBe(200);
    const families = (await r.json()).data as Array<{ familyId: string }>;
    expect(families.map((f) => f.familyId)).toEqual(['fam:ALFA']);
  });

  it('GET /social/family/browse?limit=1: caps the result count', async () => {
    const r = await fetch(`${base}/social/family/browse?limit=1`, { headers: auth });
    expect(r.status).toBe(200);
    const families = (await r.json()).data as Array<{ familyId: string }>;
    expect(families).toHaveLength(1);
    expect(families[0]!.familyId).toBe('fam:BETA');
  });

  it('GET /social/family/requests: 403 for a caller not in any family', async () => {
    const outsiderToken = signToken('outsider-a', { secret: SECRET });
    const r = await fetch(`${base}/social/family/requests`, { headers: { authorization: `Bearer ${outsiderToken}` } });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('NOT_IN_FAMILY');
  });

  it('POST /respond: 403 when the caller is a plain member (leader/elder only)', async () => {
    const leaderBToken = signToken('leader-b', { secret: SECRET });
    const leaderBAuth = { authorization: `Bearer ${leaderBToken}` };
    const memberToken = signToken('member-b', { secret: SECRET });
    const memberAuth = { authorization: `Bearer ${memberToken}` };

    await familySvc.joinFamily('member-b', 'fam:BETA'); // direct add — this member isn't the applicant under test
    const { requestId } = await familySvc.requestJoin('applicant-b', 'fam:BETA');

    const listAsMember = await fetch(`${base}/social/family/requests`, { headers: memberAuth });
    expect(listAsMember.status).toBe(403);
    expect((await listAsMember.json()).error.code).toBe('NO_PERMISSION');

    const respondAsMember = await fetch(`${base}/social/family/requests/${requestId}/respond`, {
      method: 'POST',
      headers: { ...memberAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true }),
    });
    expect(respondAsMember.status).toBe(403);
    expect((await respondAsMember.json()).error.code).toBe('NO_PERMISSION');

    // Sanity: the leader (who does have permission) can still resolve it — the request wasn't
    // consumed by the rejected attempts above.
    const respondAsLeader = await fetch(`${base}/social/family/requests/${requestId}/respond`, {
      method: 'POST',
      headers: { ...leaderBAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: false }),
    });
    expect(respondAsLeader.status).toBe(200);
  });

  it('POST /respond {accept:false}: mails the applicant a rejection notice (wire-level)', async () => {
    const leaderBToken = signToken('leader-b', { secret: SECRET });
    const leaderBAuth = { authorization: `Bearer ${leaderBToken}` };
    const { requestId } = await familySvc.requestJoin('applicant-c', 'fam:BETA');

    const r = await fetch(`${base}/social/family/requests/${requestId}/respond`, {
      method: 'POST',
      headers: { ...leaderBAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: false }),
    });
    expect(r.status).toBe(200);

    const mail = await m.collections.mails.findOne({ to: 'applicant-c' });
    expect(mail).toMatchObject({ subject: 'family.mail.rejected.subject' });
    expect(mail!.body).toMatch(/^family\.mail\.rejected\.body\|familyName=BetaRaiders$/);

    // Rejected applicant is not a member.
    const famRes = await fetch(`${base}/social/family/fam:BETA`, { headers: leaderBAuth });
    const fam = (await famRes.json()).data as { members: Array<{ accountId: string }> };
    expect(fam.members.map((mem) => mem.accountId)).not.toContain('applicant-c');
  });

  it('join → requests → respond: full wire round trip, and GET /requests is not swallowed by GET /:id', async () => {
    const applicantToken = signToken('applicant-a', { secret: SECRET });
    const applicantAuth = { authorization: `Bearer ${applicantToken}` };

    const joinRes = await fetch(`${base}/social/family/fam:ALFA/join`, { method: 'POST', headers: applicantAuth });
    expect(joinRes.status).toBe(200);
    const { requestId } = (await joinRes.json()).data as { requestId: string };
    expect(requestId).toBeTruthy();

    // GET /social/family/requests must resolve to the requests-list route, not the generic
    // GET /social/family/:id route (which would 500 trying to look up a family named "requests").
    const listRes = await fetch(`${base}/social/family/requests`, { headers: auth });
    expect(listRes.status).toBe(200);
    const { requests } = (await listRes.json()).data as { requests: Array<{ requestId: string; accountId: string }> };
    expect(requests).toEqual([expect.objectContaining({ requestId, accountId: 'applicant-a' })]);

    const respondRes = await fetch(`${base}/social/family/requests/${requestId}/respond`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ accept: true }),
    });
    expect(respondRes.status).toBe(200);

    const famRes = await fetch(`${base}/social/family/fam:ALFA`, { headers: auth });
    const fam = (await famRes.json()).data as { members: Array<{ accountId: string }> };
    expect(fam.members.map((mem) => mem.accountId)).toContain('applicant-a');
  });

  it('POST /internal/family/:id/sect: mirrors sectId + sectName; clearing wipes both (wire-level)', async () => {
    const internalAuth = internalHeaders('worldsvc', INTERNAL_KEY);

    const setRes = await fetch(`${base}/internal/family/fam:ALFA/sect`, {
      method: 'POST',
      headers: { ...internalAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ sectId: 'sect:1', sectName: 'Iron Fist' }),
    });
    expect(setRes.status).toBe(200);

    const afterSet = await fetch(`${base}/social/family/fam:ALFA`, { headers: auth });
    const famAfterSet = (await afterSet.json()).data as { sectId?: string; sectName?: string };
    expect(famAfterSet.sectId).toBe('sect:1');
    expect(famAfterSet.sectName).toBe('Iron Fist');

    const clearRes = await fetch(`${base}/internal/family/fam:ALFA/sect`, {
      method: 'POST',
      headers: { ...internalAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ sectId: null }),
    });
    expect(clearRes.status).toBe(200);

    const afterClear = await fetch(`${base}/social/family/fam:ALFA`, { headers: auth });
    const famAfterClear = (await afterClear.json()).data as { sectId?: string; sectName?: string };
    expect(famAfterClear.sectId).toBeUndefined();
    expect(famAfterClear.sectName).toBeUndefined();
  });

  it('POST /internal/family/:id/sect: without X-Internal-Key → 401', async () => {
    const r = await fetch(`${base}/internal/family/fam:ALFA/sect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sectId: 'sect:2', sectName: 'Nope' }),
    });
    expect(r.status).toBe(401);
  });
});
