// Social friends end-to-end test (S6-1): real Mongo + injected fake gateway (records push / presence).
//   Search → request (push friend_request) → accept (build bidirectional edges + push friend_update to both parties) → both see each other in list →
//   duplicate request → ALREADY_FRIEND → block shields the target's request (BLOCKED) + removes bidirectional edges → remove friend.
// Requires `cd server && docker compose up -d` + prior `tsc -b` (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { GatewayClient, JudgeRes, SocialPushMsg } from '../dist/gatewayClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_social_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[social-friends.e2e] Mongo unreachable (${URI}) — skipping.`);

/** Fake gateway: records pushes (for asserting push targets/types); online set is configurable for presence. */
class FakeGateway implements GatewayClient {
  available = true;
  pushes: { accountId: string; msg: SocialPushMsg }[] = [];
  online = new Set<string>();
  invalidated: string[] = [];
  async judge(): Promise<JudgeRes> {
    return { ok: false };
  }
  async push(accountId: string, msg: SocialPushMsg): Promise<void> {
    this.pushes.push({ accountId, msg });
  }
  async presence(ids: string[]): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const id of ids) out[id] = this.online.has(id);
    return out;
  }
  async invalidateFriends(accountId: string): Promise<void> {
    this.invalidated.push(accountId);
  }
}

describe.skipIf(!mongo)('social friends e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let gateway: FakeGateway;
  const b = (r: { payload: string }) => JSON.parse(r.payload);

  // Register a device account, returning { token, accountId, publicId }.
  async function newAccount(deviceId: string): Promise<{ token: string; accountId: string; publicId: string }> {
    const r = b(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } }));
    return { token: r.data.token, accountId: r.data.accountId, publicId: r.data.publicId };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const post = (token: string, url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: auth(token), payload });
  const get = (token: string, url: string) =>
    app.inject({ method: 'GET', url, headers: auth(token) });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    gateway = new FakeGateway();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', gateway });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (mongo) await mongo.close();
  });

  it('search → request → accept builds bidirectional edges + pushes both parties', async () => {
    const a = await newAccount('social-aaaa');
    const c = await newAccount('social-bbbb');

    // Search for c
    const search = b(await post(a.token, '/friends/search', { publicId: c.publicId }));
    expect(search.ok).toBe(true);
    expect(search.data.profile.publicId).toBe(c.publicId);

    // a → c request: push friend_request to c
    const reqRes = b(await post(a.token, '/friends/request', { publicId: c.publicId, message: 'hi' }));
    expect(reqRes.ok).toBe(true);
    const requestId = reqRes.data.requestId;
    const reqPush = gateway.pushes.find((p) => p.accountId === c.accountId && p.msg.kind === 'friend_request');
    expect(reqPush).toBeTruthy();
    expect((reqPush!.msg as { fromPublicId: string }).fromPublicId).toBe(a.publicId);

    // c's inbox has 1 incoming request
    const inbox = b(await get(c.token, '/friends/requests'));
    expect(inbox.data.incoming).toHaveLength(1);
    expect(inbox.data.incoming[0].fromPublicId).toBe(a.publicId);
    expect(inbox.data.incoming[0].requestId).toBe(requestId);

    // c accepts → bidirectional edges + push friend_update to both parties + invalidate cache for both
    gateway.pushes = [];
    const resp = b(await post(c.token, '/friends/respond', { requestId, accept: true }));
    expect(resp.ok).toBe(true);
    const updates = gateway.pushes.filter((p) => p.msg.kind === 'friend_update');
    expect(updates.map((p) => p.accountId).sort()).toEqual([a.accountId, c.accountId].sort());
    expect(gateway.invalidated.sort()).toEqual([a.accountId, c.accountId].sort());

    // Both parties see each other in friend lists
    const aFriends = b(await get(a.token, '/friends'));
    const cFriends = b(await get(c.token, '/friends'));
    expect(aFriends.data.friends.map((f: { publicId: string }) => f.publicId)).toContain(c.publicId);
    expect(cFriends.data.friends.map((f: { publicId: string }) => f.publicId)).toContain(a.publicId);
  });

  it('reflects gateway presence on friend list', async () => {
    const a = await newAccount('social-aaaa');
    const c = await newAccount('social-bbbb');
    const reqRes = b(await post(a.token, '/friends/request', { publicId: c.publicId }));
    await post(c.token, '/friends/respond', { requestId: reqRes.data.requestId, accept: true });

    gateway.online.add(c.accountId);
    const friends = b(await get(a.token, '/friends'));
    const cView = friends.data.friends.find((f: { publicId: string }) => f.publicId === c.publicId);
    expect(cView.online).toBe(true);
  });

  it('rejects duplicate request once already friends', async () => {
    const a = await newAccount('social-aaaa');
    const c = await newAccount('social-bbbb');
    const reqRes = b(await post(a.token, '/friends/request', { publicId: c.publicId }));
    await post(c.token, '/friends/respond', { requestId: reqRes.data.requestId, accept: true });

    const dup = await post(a.token, '/friends/request', { publicId: c.publicId });
    expect(dup.statusCode).toBe(409);
    expect(b(dup).error.code).toBe('ALREADY_FRIEND');
  });

  it('block removes friendship and blocks the target request', async () => {
    const a = await newAccount('social-aaaa');
    const c = await newAccount('social-bbbb');
    const reqRes = b(await post(a.token, '/friends/request', { publicId: c.publicId }));
    await post(c.token, '/friends/respond', { requestId: reqRes.data.requestId, accept: true });

    // a blocks c → bidirectional edges removed
    const blk = await post(a.token, '/friends/block', { publicId: c.publicId });
    expect(blk.statusCode).toBe(200);
    const aFriends = b(await get(a.token, '/friends'));
    expect(aFriends.data.friends).toHaveLength(0);

    // c requests a again → BLOCKED
    const reReq = await post(c.token, '/friends/request', { publicId: a.publicId });
    expect(reReq.statusCode).toBe(403);
    expect(b(reReq).error.code).toBe('BLOCKED');

    // a unblocks → c can request again
    await app.inject({ method: 'DELETE', url: `/friends/block/${c.publicId}`, headers: auth(a.token) });
    const reReq2 = await post(c.token, '/friends/request', { publicId: a.publicId });
    expect(reReq2.statusCode).toBe(200);
  });

  it('search unknown publicId → 404; self-request → 400', async () => {
    const a = await newAccount('social-aaaa');
    const notFound = await post(a.token, '/friends/search', { publicId: '000000001' });
    expect(notFound.statusCode).toBe(404);
    const self = await post(a.token, '/friends/request', { publicId: a.publicId });
    expect(self.statusCode).toBe(400);
  });

  it('remove friend drops both edges + pushes the other party', async () => {
    const a = await newAccount('social-aaaa');
    const c = await newAccount('social-bbbb');
    const reqRes = b(await post(a.token, '/friends/request', { publicId: c.publicId }));
    await post(c.token, '/friends/respond', { requestId: reqRes.data.requestId, accept: true });

    gateway.pushes = [];
    const del = await app.inject({ method: 'DELETE', url: `/friends/${c.publicId}`, headers: auth(a.token) });
    expect(del.statusCode).toBe(200);
    const aFriends = b(await get(a.token, '/friends'));
    const cFriends = b(await get(c.token, '/friends'));
    expect(aFriends.data.friends).toHaveLength(0);
    expect(cFriends.data.friends).toHaveLength(0);
    const upd = gateway.pushes.find((p) => p.accountId === c.accountId && p.msg.kind === 'friend_update');
    expect(upd).toBeTruthy();
    expect((upd!.msg as { added: boolean }).added).toBe(false);
  });
});
