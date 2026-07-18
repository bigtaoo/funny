// socialsvc family HTTP route e2e (real node:http server + real Mongo, mirrors mailHttp.e2e.test.ts).
// Covers wire-level query-param parsing for GET /social/family/browse (default limit, custom limit,
// `q` fuzzy filter) that the service-level family.e2e.test.ts calls directly and can't exercise.
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
  const token = signToken('leader-a', { secret: SECRET });
  const auth = { authorization: `Bearer ${token}` };
  let t = 1_000_000;

  beforeAll(async () => {
    await m.collections.families.deleteMany({});
    await m.collections.familyMembers.deleteMany({});
    const meta = new FakeMeta().add('leader-a', 'P-A', 'Alice');
    const gateway = new FakeGateway();
    const familySvc = new FamilyService({ cols: m.collections, now: () => t, gateway, meta });
    const friendSvc = new FriendService({ cols: m.collections, gateway, meta, now: () => t });
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now: () => t });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: INTERNAL_KEY },
      familySvc, friendSvc, mailSvc, gateway,
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
});
