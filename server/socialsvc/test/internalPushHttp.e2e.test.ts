// socialsvc /internal/push + /internal/presence/* + /internal/reports* HTTP route e2e — 2026-08-10,
// added alongside the httpApi.ts split (claudedocs/server.md "单文件 500 行收敛"). The split isolated
// these into `httpApi/internalPushRoutes.ts` / `httpApi/internalReportsRoutes.ts` — cleanly named units
// that exposed a pre-existing zero-coverage gap: grepping the pre-existing test files for
// `internal/push`, `internal/presence`, `internal/reports` came up with nothing but a code comment
// (family.e2e.test.ts:110) referencing `/internal/push` in passing. Neither the delegated-push dispatch
// (account/family/explicit-targets branches) nor the presence fan-out (`presenceFanOut`, moved into
// internalPushRoutes.ts by the split) nor the reports queue had ever been driven through the actual HTTP
// route. This file closes that gap (real node:http server + real Mongo, mirrors familyHttp.e2e.test.ts's
// harness shape). The X-Internal-Key rejection path itself is already covered generically for the whole
// /internal/* prefix by familyHttp.e2e.test.ts's "without X-Internal-Key → 401" case (checked once by the
// shell before any of these routes run), so it is not duplicated here.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { internalHeaders } from '@nw/shared';
import { createSocialMongo, type SocialMongo } from '../src/db';
import { FamilyService } from '../src/familyService';
import { FriendService } from '../src/friendService';
import { MailService } from '../src/mailService';
import { startHttpApi } from '../src/httpApi';
import { FakeMeta, FakeGateway } from './harness';
import { jsonBody } from './jsonBody';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017';
const DB = 'nw_social_internal_push_http_test';
const SECRET = 'test-jwt-secret';
const INTERNAL_KEY = 'test-internal-key';
const internalAuth = internalHeaders('worldsvc', INTERNAL_KEY);

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
if (!mongo) console.warn(`[socialsvc.internalPushHttp.e2e] Mongo unreachable (${URI}) — skipping.`);

// Give the fire-and-forget presenceFanOut promise (internalPushRoutes.ts) a chance to settle before
// asserting on the FakeGateway — it's genuinely detached (`void ....catch()`) from the HTTP response.
const flushFanOut = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

describe.skipIf(!mongo)('socialsvc /internal/push + /internal/presence + /internal/reports HTTP routes e2e', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let gateway: FakeGateway;
  let friendSvc: FriendService;
  let familySvc: FamilyService;
  let t = 2_000_000;

  beforeAll(async () => {
    const meta = new FakeMeta()
      .add('acc-a', 'P-A', 'Alice')
      .add('acc-b', 'P-B', 'Bob')
      .add('acc-c', 'P-C', 'Carol');
    gateway = new FakeGateway();
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now: () => t });
    familySvc = new FamilyService({ cols: m.collections, now: () => t, gateway, meta, mail: mailSvc });
    friendSvc = new FriendService({ cols: m.collections, gateway, meta, now: () => t });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: INTERNAL_KEY },
      familySvc, friendSvc, mailSvc, gateway, meta,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await m.collections.families.deleteMany({});
    await m.collections.familyMembers.deleteMany({});
    await m.collections.friendEdges.deleteMany({});
    await m.collections.friendRequests.deleteMany({});
    await m.collections.reports.deleteMany({});
    gateway.pushes.length = 0;
    gateway.presenceMap = {};
  });

  afterAll(async () => {
    server.close();
    await m.close();
  });

  describe('POST /internal/push', () => {
    it('channel.kind=account pushes to that one account', async () => {
      const res = await fetch(`${base}/internal/push`, {
        method: 'POST',
        headers: { ...internalAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ channel: { kind: 'account', accountId: 'acc-a' }, event: 'test_event', payload: { foo: 1 } }),
      });
      expect(res.status).toBe(200);
      expect(gateway.pushes).toEqual([{ accountId: 'acc-a', msg: { kind: 'test_event', foo: 1 } }]);
    });

    it('an explicit targets[] list pushes to every listed account, ignoring channel.kind', async () => {
      const res = await fetch(`${base}/internal/push`, {
        method: 'POST',
        headers: { ...internalAuth, 'content-type': 'application/json' },
        body: JSON.stringify({
          channel: { kind: 'account', accountId: 'acc-a' },
          event: 'test_event',
          payload: {},
          targets: ['acc-b', 'acc-c'],
        }),
      });
      expect(res.status).toBe(200);
      expect(gateway.pushes.map((p) => p.accountId).sort()).toEqual(['acc-b', 'acc-c']);
    });

    it('channel.kind=family pushes to every member of that family', async () => {
      await familySvc.createFamily('acc-a', 'PushFam', 'PSHF');
      await familySvc.requestJoin('acc-b', 'fam:PSHF');
      const pending = await familySvc.listJoinRequests('acc-a');
      await familySvc.respondJoinRequest('acc-a', pending[0]!.requestId, true);
      gateway.pushes.length = 0; // clear the join-flow's own pushes

      const res = await fetch(`${base}/internal/push`, {
        method: 'POST',
        headers: { ...internalAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ channel: { kind: 'family', familyId: 'fam:PSHF' }, event: 'test_event', payload: {} }),
      });
      expect(res.status).toBe(200);
      expect(gateway.pushes.map((p) => p.accountId).sort()).toEqual(['acc-a', 'acc-b']);
    });

    it('missing channel or event → 400, no push sent', async () => {
      const res = await fetch(`${base}/internal/push`, {
        method: 'POST',
        headers: { ...internalAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ payload: {} }),
      });
      expect(res.status).toBe(400);
      expect(gateway.pushes).toEqual([]);
    });
  });

  describe('POST /internal/presence/{online,offline}', () => {
    async function makeFriends(): Promise<void> {
      const r = await friendSvc.requestFriend('acc-a', 'P-B', undefined);
      if (r.kind !== 'ok') throw new Error('setup: requestFriend failed');
      await friendSvc.respondFriend('acc-b', r.requestId, true);
    }

    it('online: pushes friend_presence(online=true) to online friends, and their status back to me', async () => {
      await makeFriends();
      gateway.presenceMap = { 'acc-b': true };
      gateway.pushes.length = 0;

      const res = await fetch(`${base}/internal/presence/online`, {
        method: 'POST',
        headers: { ...internalAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'acc-a' }),
      });
      expect(res.status).toBe(200);
      await flushFanOut();

      // "I came online" to acc-b + acc-b's own online status pushed back to me.
      expect(gateway.pushes).toEqual(
        expect.arrayContaining([
          { accountId: 'acc-b', msg: { kind: 'friend_presence', publicId: 'P-A', online: true } },
          { accountId: 'acc-a', msg: { kind: 'friend_presence', publicId: 'P-B', online: true } },
        ]),
      );
      expect(gateway.pushes).toHaveLength(2);
    });

    it('offline: pushes friend_presence(online=false) to online friends only, nothing pushed back to me', async () => {
      await makeFriends();
      gateway.presenceMap = { 'acc-b': true };
      gateway.pushes.length = 0;

      const res = await fetch(`${base}/internal/presence/offline`, {
        method: 'POST',
        headers: { ...internalAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'acc-a' }),
      });
      expect(res.status).toBe(200);
      await flushFanOut();

      expect(gateway.pushes).toEqual([{ accountId: 'acc-b', msg: { kind: 'friend_presence', publicId: 'P-A', online: false } }]);
    });

    it('offline with no online friends → no push at all (early-return branch)', async () => {
      await makeFriends();
      gateway.presenceMap = {}; // acc-b offline
      gateway.pushes.length = 0;

      const res = await fetch(`${base}/internal/presence/offline`, {
        method: 'POST',
        headers: { ...internalAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'acc-a' }),
      });
      expect(res.status).toBe(200);
      await flushFanOut();
      expect(gateway.pushes).toEqual([]);
    });

    it('missing accountId → 400', async () => {
      const res = await fetch(`${base}/internal/presence/online`, {
        method: 'POST',
        headers: { ...internalAuth, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /internal/reports + POST /internal/reports/:id/resolve', () => {
    it('lists open reports oldest-first, then resolve flips status and excludes it from a later open-list fetch', async () => {
      await friendSvc.reportUser('acc-a', 'P-C', 'first report');
      await friendSvc.reportUser('acc-b', 'P-C', 'second report');

      const listRes = await fetch(`${base}/internal/reports`, { headers: internalAuth });
      expect(listRes.status).toBe(200);
      const listed = (await jsonBody(listRes)).data.reports as Array<{ _id: string; reporterId: string }>;
      expect(listed.map((r) => r.reporterId)).toEqual(['acc-a', 'acc-b']);

      const resolveRes = await fetch(`${base}/internal/reports/${listed[0]!._id}/resolve`, {
        method: 'POST',
        headers: { ...internalAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: 'dismissed', resolvedBy: 'ops-1' }),
      });
      expect(resolveRes.status).toBe(200);

      const afterRes = await fetch(`${base}/internal/reports`, { headers: internalAuth });
      const afterListed = (await jsonBody(afterRes)).data.reports as Array<{ _id: string }>;
      expect(afterListed.map((r) => r._id)).toEqual([listed[1]!._id]);
    });

    it('resolve with an invalid resolution value → 400', async () => {
      await friendSvc.reportUser('acc-a', 'P-C', 'r');
      const listed = (await jsonBody(await fetch(`${base}/internal/reports`, { headers: internalAuth }))).data.reports as Array<{ _id: string }>;
      const res = await fetch(`${base}/internal/reports/${listed[0]!._id}/resolve`, {
        method: 'POST',
        headers: { ...internalAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: 'bogus' }),
      });
      expect(res.status).toBe(400);
    });
  });
});
