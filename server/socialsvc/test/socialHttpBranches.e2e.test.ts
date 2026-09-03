// httpApi branch-coverage gap-fill (2026-09-03 pass): the shell (src/httpApi.ts, 85.1% branch) plus
// the seven route files that still had gaps. Every existing HTTP e2e sends a complete, well-formed
// request to a path that exists — so the shell's four fall-through/failure exits and each route's
// "this field wasn't in the body" coercions had never run. They are exactly the paths a real client
// reaches first when something is wrong:
//
//   * an unknown path under /internal/ and under /social/ (both must be a 404 envelope, not a hang or
//     an empty 200 — and reaching them is also what walks each domain handler's "no match" exit).
//   * a token that does not verify (401 'invalid token', distinct from a missing header).
//   * a body that is not valid JSON: readJson rejects, and only the shell's non-SlgError arm turns
//     that into a 500 instead of an unhandled rejection that leaves the socket open.
//   * a request with no Host header (HTTP/1.0): `new URL(req.url, 'http://' + host)` is the first
//     thing the shell does with it, and it throws on `http://undefined` — so the `?? 'social'` is
//     what keeps such a request routable at all.
//   * every `typeof body.x === 'string' ? … : null` / `: 1` / `: 0` coercion. The internal callers
//     (worldsvc) legitimately omit `delta`/`territoryCount`, so those defaults are live behavior, not
//     dead defensiveness; the public ones decide 400-vs-crash on a malformed client request.
//   * the `sendSocialErr` hand-offs in the friend/chat routes, and mail's NOT_FOUND arm — the service
//     layer's error enum reaching the wire.
//   * `presenceFanOut`'s three early exits (gateway down / no friends / no publicId). It is
//     fire-and-forget, so the request is a 200 either way; what these pin is that nothing is pushed.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { signToken, internalHeaders, friendEdgeId, EMBLEM_KEYS } from '@nw/shared';
import { createSocialMongo, type SocialMongo } from '../src/db';
import { FamilyService } from '../src/familyService';
import { FriendService } from '../src/friendService';
import { MailService } from '../src/mailService';
import { startHttpApi } from '../src/httpApi';
import { nullSocialGatewayClient } from '../src/gatewayClient';
import { FakeMeta, FakeGateway } from './harness';
import { jsonBody } from './jsonBody';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017';
const DB = 'nw_social_http_branches_test';
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
if (!mongo) console.warn(`[socialsvc.socialHttpBranches.e2e] Mongo unreachable (${URI}) — skipping.`);

// Same settle as internalPushHttp.e2e.test.ts: presenceFanOut is detached from the HTTP response
// (`void ….catch()`), so the gateway assertions need it to have run.
const flushFanOut = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

/**
 * One raw HTTP/1.0 request, so it can go out with NO Host header — `fetch` always sends one, and
 * HTTP/1.1 requires it. Returns the full raw response text.
 */
function rawRequest(port: number, requestLines: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(`${requestLines.join('\r\n')}\r\n\r\n`));
    let out = '';
    sock.setEncoding('utf8');
    sock.on('data', (c: string) => { out += c; });
    sock.on('end', () => resolve(out));
    sock.on('error', reject);
  });
}

describe.skipIf(!mongo)('socialsvc httpApi branch gaps', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let port: number;
  let familySvc: FamilyService;
  let friendSvc: FriendService;
  let gateway: FakeGateway;
  let meta: FakeMeta;
  const auth = (accountId: string) => ({ authorization: `Bearer ${signToken(accountId, { secret: SECRET })}` });
  const json = { 'content-type': 'application/json' };
  let t = 3_000_000;

  beforeAll(async () => {
    meta = new FakeMeta()
      .add('leader', 'P-LEAD', 'Leader')
      .add('member', 'P-MEM', 'Member')
      .add('solo', 'P-SOLO', 'Solo', 'gold')
      .add('other', 'P-OTHER', 'Other');
    // 'solo' has a ladder standing but belongs to no family — the two halves of the popup "extra".
    meta.elo('solo', 1432);
    gateway = new FakeGateway();
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now: () => t });
    familySvc = new FamilyService({ cols: m.collections, now: () => t, gateway, meta, mail: mailSvc });
    friendSvc = new FriendService({ cols: m.collections, gateway, meta, now: () => t });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: INTERNAL_KEY },
      familySvc, friendSvc, mailSvc, gateway, meta,
    );
    await new Promise<void>((res) => server.on('listening', res));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  beforeEach(async () => {
    await Promise.all([
      m.collections.families.deleteMany({}),
      m.collections.familyMembers.deleteMany({}),
      m.collections.familyMessages.deleteMany({}),
      m.collections.familyJoinRequests.deleteMany({}),
      m.collections.friendEdges.deleteMany({}),
      m.collections.friendRequests.deleteMany({}),
      m.collections.friendCounts.deleteMany({}),
      m.collections.blockList.deleteMany({}),
      m.collections.conversations.deleteMany({}),
      m.collections.chatMessages.deleteMany({}),
      m.collections.mails.deleteMany({}),
      m.collections.reports.deleteMany({}),
    ]);
    gateway.pushes.length = 0;
    gateway.presenceMap = {};
  });

  afterAll(() => { server.close(); });

  // ── The shell (src/httpApi.ts) ───────────────────────────────────────────────

  describe('dispatcher', () => {
    it('an unknown /internal/ path is a 404 envelope after every internal handler declined it', async () => {
      const res = await fetch(`${base}/internal/nope/whatever`, { headers: internalAuth });
      expect(res.status).toBe(404);
      expect((await jsonBody(res)).error).toMatchObject({ code: 'NOT_FOUND', message: 'internal endpoint not found' });
    });

    it('an unknown /social/ path is a 404 envelope after every public handler declined it', async () => {
      const res = await fetch(`${base}/social/nope`, { headers: auth('leader') });
      expect(res.status).toBe(404);
      expect((await jsonBody(res)).error).toMatchObject({ code: 'NOT_FOUND', message: 'endpoint not found' });
    });

    it('a token that does not verify is 401 "invalid token" (distinct from a missing header)', async () => {
      const bad = await fetch(`${base}/social/badges`, { headers: { authorization: 'Bearer not-a-real-token' } });
      expect(bad.status).toBe(401);
      expect((await jsonBody(bad)).error).toMatchObject({ code: 'UNAUTHENTICATED', message: 'invalid token' });

      const wrongSecret = await fetch(`${base}/social/badges`, {
        headers: { authorization: `Bearer ${signToken('leader', { secret: 'a-different-secret' })}` },
      });
      expect(wrongSecret.status).toBe(401);

      const missing = await fetch(`${base}/social/badges`);
      expect(missing.status).toBe(401);
      expect((await jsonBody(missing)).error.message).toBe('missing Authorization header');
    });

    it('a body that is not JSON is a 500 envelope, not an unhandled rejection', async () => {
      // readJson rejects with a SyntaxError, which is not a SlgError — the generic arm of the shell's
      // catch is the only thing that closes the response at all.
      const res = await fetch(`${base}/social/friends/search`, {
        method: 'POST', headers: { ...auth('leader'), ...json }, body: '{"publicId":',
      });
      expect(res.status).toBe(500);
      expect((await jsonBody(res)).error).toMatchObject({ code: 'INTERNAL' });
    });

    it('a request with no Host header (HTTP/1.0) is still routed', async () => {
      // `new URL(req.url, 'http://' + req.headers.host)` runs before any routing; without the
      // 'social' fallback this throws on 'http://undefined' and the request dies with no response.
      const raw = await rawRequest(port, [
        'GET /social/badges HTTP/1.0',
        `Authorization: Bearer ${signToken('leader', { secret: SECRET })}`,
      ]);
      expect(raw).toContain('200 OK');
      expect(raw).toContain('"friendRequests":0');
    });

    it('OPTIONS preflight and /health short-circuit before any auth', async () => {
      expect((await fetch(`${base}/social/friends`, { method: 'OPTIONS' })).status).toBe(204);
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect((await jsonBody(health)).service).toBe('socialsvc');
    });
  });

  // ── /social/friends/* ────────────────────────────────────────────────────────

  describe('friend routes', () => {
    it('POST /social/friends/request without publicId is 400', async () => {
      const res = await fetch(`${base}/social/friends/request`, {
        method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify({ message: 'hi' }),
      });
      expect(res.status).toBe(400);
      expect((await jsonBody(res)).error.message).toBe('publicId required');
    });

    it('POST /social/friends/respond needs both requestId and accept', async () => {
      for (const body of [{}, { requestId: 'r1' }, { accept: true }, { requestId: 'r1', accept: 'yes' }]) {
        const res = await fetch(`${base}/social/friends/respond`, {
          method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect((await jsonBody(res)).error.message).toBe('requestId + accept required');
      }
    });

    it('POST /social/friends/respond on an unknown requestId maps the service error to 404', async () => {
      const res = await fetch(`${base}/social/friends/respond`, {
        method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify({ requestId: 'no-such', accept: true }),
      });
      expect(res.status).toBe(404);
      expect((await jsonBody(res)).error.code).toBe('NOT_FOUND');
    });

    it('POST /social/friends/request to a blocked player maps the service error to 403', async () => {
      await friendSvc.blockUser('other', 'P-LEAD');
      const res = await fetch(`${base}/social/friends/request`, {
        method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify({ publicId: 'P-OTHER' }),
      });
      expect(res.status).toBe(403);
      expect((await jsonBody(res)).error.code).toBe('BLOCKED');
    });
  });

  // ── /social/chat/* + /social/mail/* ──────────────────────────────────────────

  describe('chat + mail routes', () => {
    it('GET /social/chat/:convId/messages honours a `before` cursor', async () => {
      const convId = 'conv:leader|member';
      await m.collections.conversations.insertOne({ _id: convId, members: ['leader', 'member'], lastTs: t, unread: {} });
      await m.collections.chatMessages.insertMany([
        { _id: 'c1', convId, from: 'leader', body: 'old', kind: 'text', ts: new Date(1_000) },
        { _id: 'c2', convId, from: 'leader', body: 'new', kind: 'text', ts: new Date(9_000) },
      ]);
      const all = await fetch(`${base}/social/chat/${encodeURIComponent(convId)}/messages`, { headers: auth('leader') });
      expect((await jsonBody(all)).data.messages).toHaveLength(2);

      const before = await fetch(`${base}/social/chat/${encodeURIComponent(convId)}/messages?before=5000&limit=10`, { headers: auth('leader') });
      const page = (await jsonBody(before)).data.messages as { messageId: string }[];
      expect(page.map((x) => x.messageId)).toEqual(['c1']);
    });

    it('POST /social/chat/send to a non-friend maps the service error to 403 NOT_FRIEND', async () => {
      const res = await fetch(`${base}/social/chat/send`, {
        method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify({ toPublicId: 'P-OTHER', body: 'hi' }),
      });
      expect(res.status).toBe(403);
      expect((await jsonBody(res)).error.code).toBe('NOT_FRIEND');
    });

    it('POST /social/mail/send to an unknown publicId is 404 (its own arm, not the generic 400)', async () => {
      const res = await fetch(`${base}/social/mail/send`, {
        method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify({ toPublicId: 'P-NOBODY', subject: 'Hi' }),
      });
      expect(res.status).toBe(404);
      expect((await jsonBody(res)).error).toMatchObject({ code: 'NOT_FOUND', message: 'player not found' });
    });

    it('POST /social/mail/send to self is the generic 400 arm', async () => {
      await m.collections.friendEdges.insertOne({ _id: friendEdgeId('leader', 'leader'), owner: 'leader', friend: 'leader', since: t });
      const res = await fetch(`${base}/social/mail/send`, {
        method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify({ toPublicId: 'P-LEAD', subject: 'Hi' }),
      });
      expect(res.status).toBe(400);
      expect((await jsonBody(res)).error.code).toBe('BAD_REQUEST');
    });
  });

  // ── /social/profile/:publicId/extra ──────────────────────────────────────────

  it('GET /social/profile/:publicId/extra: rank + elo, and no family fields when the player has none', async () => {
    const res = await fetch(`${base}/social/profile/P-SOLO/extra`, { headers: auth('leader') });
    expect(res.status).toBe(200);
    const data = (await jsonBody(res)).data as Record<string, unknown>;
    expect(data).toEqual({ rank: 'gold', elo: 1432 });
  });

  // ── /social/family/* ─────────────────────────────────────────────────────────

  describe('family routes', () => {
    it('POST /social/family/emblem rejects a non-string emblemKey and a non-numeric emblemColor', async () => {
      await familySvc.createFamily('leader', 'Branchers', 'BR');
      // Both fields are read straight off the parsed JSON, so either can arrive with the wrong type
      // (a client sending the colour as the "0xff0000" it displays is the realistic one). Neither may
      // reach setEmblem, which would then persist a colour outside EMBLEM_COLORS.
      for (const body of [
        { emblemKey: EMBLEM_KEYS[0], emblemColor: '0xff0000' },
        { emblemColor: 0x1e90ff },
        { emblemKey: 7, emblemColor: 0x1e90ff },
      ]) {
        const res = await fetch(`${base}/social/family/emblem`, {
          method: 'POST', headers: { ...auth('leader'), ...json }, body: JSON.stringify(body),
        });
        expect(res.status).toBe(400);
        expect((await jsonBody(res)).error.message).toBe('emblemKey + emblemColor required');
      }
      expect((await m.collections.families.findOne({ _id: 'fam:BR' }))!.emblemKey).toBeUndefined();
    });

    it('GET /social/family/:id/messages honours a `before` cursor', async () => {
      await familySvc.createFamily('leader', 'Branchers', 'BR');
      await m.collections.familyMessages.insertMany([
        { _id: 'fm:1', familyId: 'fam:BR', senderId: 'leader', senderName: 'Leader', body: 'old', ts: new Date(1_000) },
        { _id: 'fm:2', familyId: 'fam:BR', senderId: 'leader', senderName: 'Leader', body: 'new', ts: new Date(9_000) },
      ]);
      const res = await fetch(`${base}/social/family/fam:BR/messages?before=5000&limit=10`, { headers: auth('leader') });
      const msgs = (await jsonBody(res)).data as { id: string }[];
      expect(msgs.map((x) => x.id)).toEqual(['fm:1']);
    });

    it('POST /social/family/:id/messages with no senderName falls back to the caller accountId', async () => {
      await familySvc.createFamily('leader', 'Branchers', 'BR');
      // 'nameless' is a member with no profile in meta, so nothing overrides the fallback and the
      // stored senderName is the accountId itself rather than the string "undefined".
      await familySvc.joinFamily('nameless', 'fam:BR');
      const res = await fetch(`${base}/social/family/fam:BR/messages`, {
        method: 'POST', headers: { ...auth('nameless'), ...json }, body: JSON.stringify({ body: 'hello' }),
      });
      expect(res.status).toBe(200);
      expect((await jsonBody(res)).data.senderName).toBe('nameless');

      // A client-supplied senderName is passed through to the service, which then still prefers the
      // real profile name when it has one (family.e2e covers that precedence) — here there is none.
      const named = await fetch(`${base}/social/family/fam:BR/messages`, {
        method: 'POST', headers: { ...auth('nameless'), ...json }, body: JSON.stringify({ body: 'hi', senderName: 'Nameless One' }),
      });
      expect((await jsonBody(named)).data.senderName).toBe('Nameless One');
    });
  });

  // ── /internal/family/* defaults omitted by the caller ────────────────────────

  describe('internal family routes', () => {
    beforeEach(async () => { await familySvc.createFamily('leader', 'Branchers', 'BR'); });

    it('POST /internal/family/activity without delta defaults to +1', async () => {
      const res = await fetch(`${base}/internal/family/activity`, {
        method: 'POST', headers: { ...internalAuth, ...json }, body: JSON.stringify({ familyId: 'fam:BR' }),
      });
      expect(res.status).toBe(200);
      expect((await m.collections.families.findOne({ _id: 'fam:BR' }))!.activity).toBe(1);
    });

    it('POST /internal/family/batch without a familyIds array yields no families', async () => {
      for (const body of [{}, { familyIds: 'fam:BR' }]) {
        const res = await fetch(`${base}/internal/family/batch`, {
          method: 'POST', headers: { ...internalAuth, ...json }, body: JSON.stringify(body),
        });
        expect(res.status).toBe(200);
        expect((await jsonBody(res)).data.families).toEqual([]);
      }
    });

    it('POST /internal/family/:id/prosperity/refresh without territoryCount treats it as 0', async () => {
      const res = await fetch(`${base}/internal/family/fam:BR/prosperity/refresh`, {
        method: 'POST', headers: { ...internalAuth, ...json }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      expect((await m.collections.families.findOne({ _id: 'fam:BR' }))!.territoryCount).toBe(0);
    });

    it('POST /internal/family/:id/activity-and-prosperity defaults delta to 1 and territoryCount to 0', async () => {
      const res = await fetch(`${base}/internal/family/fam:BR/activity-and-prosperity`, {
        method: 'POST', headers: { ...internalAuth, ...json }, body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const fam = (await m.collections.families.findOne({ _id: 'fam:BR' }))!;
      expect(fam.activity).toBe(1);
      expect(fam.territoryCount).toBe(0);
    });
  });

  // ── /internal/reports ────────────────────────────────────────────────────────

  describe('internal reports routes', () => {
    it('GET /internal/reports: each valid status filters, an invalid one falls back to open', async () => {
      await friendSvc.reportUser('leader', 'P-OTHER', 'spam');
      const open = (await m.collections.reports.findOne({}))!;
      await friendSvc.resolveReport(open._id, 'upheld', 'ops-1');
      await friendSvc.reportUser('member', 'P-OTHER', 'still open');

      const listed = async (qs: string) =>
        ((await jsonBody(await fetch(`${base}/internal/reports${qs}`, { headers: internalAuth }))).data.reports as { status: string }[]);
      expect((await listed('?status=upheld')).map((r) => r.status)).toEqual(['upheld']);
      expect(await listed('?status=dismissed')).toEqual([]);
      expect((await listed('?status=open')).map((r) => r.status)).toEqual(['open']);
      // An unrecognised value must not be passed through to the query (it would match nothing and
      // read as "no reports" — the ops queue silently looking empty).
      expect((await listed('?status=bogus')).map((r) => r.status)).toEqual(['open']);
      expect((await listed('?limit=notanumber')).map((r) => r.status)).toEqual(['open']);
    });

    it('POST /internal/reports/:id/resolve records "unknown" when resolvedBy is omitted', async () => {
      await friendSvc.reportUser('leader', 'P-OTHER', 'spam');
      const id = (await m.collections.reports.findOne({}))!._id;
      const res = await fetch(`${base}/internal/reports/${id}/resolve`, {
        method: 'POST', headers: { ...internalAuth, ...json }, body: JSON.stringify({ resolution: 'dismissed' }),
      });
      expect(res.status).toBe(200);
      expect((await m.collections.reports.findOne({ _id: id }))!.resolvedBy).toBe('unknown');
    });

    it('POST /internal/reports/:id/resolve twice: the second is 404, not a silent re-resolve', async () => {
      await friendSvc.reportUser('leader', 'P-OTHER', 'spam');
      const id = (await m.collections.reports.findOne({}))!._id;
      const body = JSON.stringify({ resolution: 'upheld', resolvedBy: 'ops-1' });
      expect((await fetch(`${base}/internal/reports/${id}/resolve`, { method: 'POST', headers: { ...internalAuth, ...json }, body })).status).toBe(200);
      // Resolving twice would double-count the reputation penalty admin applies alongside 'upheld'.
      const second = await fetch(`${base}/internal/reports/${id}/resolve`, { method: 'POST', headers: { ...internalAuth, ...json }, body });
      expect(second.status).toBe(404);
      expect((await jsonBody(second)).error.message).toBe('report not found or already resolved');
      expect((await m.collections.reports.findOne({ _id: id }))!.resolvedBy).toBe('ops-1');
    });
  });

  // ── presenceFanOut early exits ───────────────────────────────────────────────

  describe('POST /internal/presence/* early exits', () => {
    it('an account with no friends: 200, and no presence lookup or push', async () => {
      const res = await fetch(`${base}/internal/presence/online`, {
        method: 'POST', headers: { ...internalAuth, ...json }, body: JSON.stringify({ accountId: 'leader' }),
      });
      expect(res.status).toBe(200);
      await flushFanOut();
      expect(gateway.pushes).toEqual([]);
    });

    it('an account with friends but no resolvable publicId: 200, and nothing broadcast', async () => {
      // 'ghost' has friend edges but no profile — there is no publicId to put in the presence
      // message, so the fan-out must stop rather than broadcast an empty id to their friends.
      await m.collections.friendEdges.insertMany([
        { _id: friendEdgeId('ghost', 'member'), owner: 'ghost', friend: 'member', since: t },
        { _id: friendEdgeId('member', 'ghost'), owner: 'member', friend: 'ghost', since: t },
      ]);
      gateway.presenceMap = { member: true };
      const res = await fetch(`${base}/internal/presence/online`, {
        method: 'POST', headers: { ...internalAuth, ...json }, body: JSON.stringify({ accountId: 'ghost' }),
      });
      expect(res.status).toBe(200);
      await flushFanOut();
      expect(gateway.pushes).toEqual([]);
    });
  });
});

// A second server whose gateway is the no-op client — socialsvc runs this way whenever
// NW_GATEWAY_INTERNAL_URL is unset, and the presence fan-out has to notice before doing any work.
describe.skipIf(!mongo)('socialsvc /internal/presence with the gateway unavailable', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  let recordedPresenceCalls = 0;

  beforeAll(async () => {
    const meta = new FakeMeta().add('acc-a', 'P-A', 'Alice').add('acc-b', 'P-B', 'Bob');
    const gateway = {
      ...nullSocialGatewayClient,
      async presence(ids: string[]) { recordedPresenceCalls++; void ids; return {}; },
    };
    const mailSvc = new MailService({ cols: m.collections, gateway, meta, now: () => 1 });
    const familySvc = new FamilyService({ cols: m.collections, now: () => 1, gateway, meta, mail: mailSvc });
    const friendSvc = new FriendService({ cols: m.collections, gateway, meta, now: () => 1 });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: SECRET, internalKey: INTERNAL_KEY },
      familySvc, friendSvc, mailSvc, gateway, meta,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await m.collections.friendEdges.insertMany([
      { _id: friendEdgeId('acc-a', 'acc-b'), owner: 'acc-a', friend: 'acc-b', since: 1 },
      { _id: friendEdgeId('acc-b', 'acc-a'), owner: 'acc-b', friend: 'acc-a', since: 1 },
    ]);
  });

  afterAll(async () => {
    server.close();
    await m.collections.friendEdges.deleteMany({});
  });

  it('returns 200 and never even reads the friend list', async () => {
    const res = await fetch(`${base}/internal/presence/online`, {
      method: 'POST', headers: { ...internalAuth, 'content-type': 'application/json' }, body: JSON.stringify({ accountId: 'acc-a' }),
    });
    expect(res.status).toBe(200);
    await flushFanOut();
    expect(recordedPresenceCalls).toBe(0);
  });
});

// The two describes above share one Mongo connection; close it once everything has run.
afterAll(async () => { await mongo?.close(); });
