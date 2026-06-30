// End-to-end test for offline notification-badge aggregation (S6 final, SOC8): real Mongo + fake gateway/commercial.
//   GET /social/badges aggregates in one shot: pending incoming friend requests / conversations with unread messages /
//   unread mail, plus a total.
//   Asserts: all zero initially; each source increments its badge independently; badge drops after reading/responding;
//   total equals the sum of the three individual counts.
// Requires `cd server && docker compose up -d` and `tsc -b` first (imports dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { GatewayClient, JudgeRes, SocialPushMsg } from '../dist/gatewayClient.js';
import type { CommercialClient } from '../dist/commercialClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_badges_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[social-badges.e2e] Mongo unreachable (${URI}) — skipping.`);

class FakeGateway implements GatewayClient {
  available = true;
  async judge(): Promise<JudgeRes> {
    return { ok: false };
  }
  async push(_accountId: string, _msg: SocialPushMsg): Promise<void> {}
  async presence(ids: string[]): Promise<Record<string, boolean>> {
    return Object.fromEntries(ids.map((id) => [id, false]));
  }
  async invalidateFriends(): Promise<void> {}
}

class FakeCommercial implements CommercialClient {
  readonly available = true;
  async getWallet() { return { coins: 0, pity: {} }; }
  async grant() { return { ok: true as const, coinsAfter: 0 }; }
  async shopCharge() { return { ok: false as const, error: 'BAD_REQUEST' }; }
  async gachaDraw() { return { ok: false as const, error: 'BAD_REQUEST' }; }
  async spend() { return { ok: false as const, error: 'BAD_REQUEST' }; }
  async orderDelivered() { return { ok: true as const }; }
  async undeliveredOrders() { return []; }
  async rechargeVerify() { return { ok: false as const, error: 'INVALID_RECEIPT' }; }
  async adsCredit() { return { ok: true as const, coinsAfter: 0 }; }
  async victoryCredit() { return { ok: true as const, coinsAfter: 0, credited: 0, capped: false }; }
}

describe.skipIf(!mongo)('social badges e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  const b = (r: { payload: string }) => JSON.parse(r.payload);

  async function newAccount(deviceId: string): Promise<{ token: string; accountId: string; publicId: string }> {
    const r = b(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } }));
    return { token: r.data.token, accountId: r.data.accountId, publicId: r.data.publicId };
  }
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const get = (token: string, url: string) => app.inject({ method: 'GET', url, headers: auth(token) });
  const post = (token: string, url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: auth(token), payload });
  const internal = (url: string, payload: unknown) =>
    app.inject({ method: 'POST', url, headers: { 'x-internal-key': 'k' }, payload });
  const badges = async (token: string) => b(await get(token, '/social/badges')).data;

  async function befriend(a: { token: string }, c: { token: string; publicId: string }) {
    const req = b(await post(a.token, '/friends/request', { publicId: c.publicId }));
    await post(c.token, '/friends/respond', { requestId: req.data.requestId, accept: true });
  }

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', gateway: new FakeGateway(), commercial: new FakeCommercial() });
  });
  afterAll(async () => {
    if (app) await app.close();
    if (mongo) await mongo.close();
  });

  it('fresh account has zero badges', async () => {
    const a = await newAccount('badge-aaa');
    expect(await badges(a.token)).toEqual({ friendRequests: 0, chat: 0, mail: 0, total: 0 });
  });

  it('aggregates incoming friend requests / unread conversations / unread mail; total is the sum', async () => {
    const a = await newAccount('badge-aaa');
    const c = await newAccount('badge-ccc');
    await get(a.token, '/save');

    // 1) c sends a friend request to a → a's friendRequests=1 (only received requests count; outgoing do not).
    await post(c.token, '/friends/request', { publicId: a.publicId });
    expect(await badges(a.token)).toMatchObject({ friendRequests: 1, chat: 0, mail: 0, total: 1 });
    // The sender c's badge is unaffected (outgoing requests do not count).
    expect(await badges(c.token)).toMatchObject({ friendRequests: 0, total: 0 });

    // After accepting, the friend-request badge resets to zero and both become friends.
    const reqs = b(await get(a.token, '/friends/requests')).data;
    await post(a.token, '/friends/respond', { requestId: reqs.incoming[0].requestId, accept: true });
    expect((await badges(a.token)).friendRequests).toBe(0);

    // 2) c sends two direct messages to a → a's chat=1 (counted by number of conversations with unread messages, not message count).
    await post(c.token, '/chat/send', { toPublicId: a.publicId, body: 'hi' });
    await post(c.token, '/chat/send', { toPublicId: a.publicId, body: 'there' });
    expect(await badges(a.token)).toMatchObject({ chat: 1 });

    // 3) System mail delivered → a's mail=1.
    await internal('/internal/mail/system/send', {
      dispatchKey: 'badge-mail-1',
      scope: 'single',
      target: { publicId: a.publicId },
      subject: 'Compensation',
      body: 'x',
      attachments: [{ kind: 'coins', count: 10 }],
      expireDays: 7,
    });

    // total = friendRequests(0) + chat(1) + mail(1) = 2.
    expect(await badges(a.token)).toEqual({ friendRequests: 0, chat: 1, mail: 1, total: 2 });
  });

  it('reading mail and conversations clears their badges', async () => {
    const a = await newAccount('badge-aaa');
    const c = await newAccount('badge-ccc');
    await get(a.token, '/save');
    await befriend(c, a);

    await post(c.token, '/chat/send', { toPublicId: a.publicId, body: 'yo' });
    await internal('/internal/mail/system/send', {
      dispatchKey: 'badge-mail-2',
      scope: 'single',
      target: { publicId: a.publicId },
      subject: 's',
      body: 'b',
      expireDays: 7,
    });
    expect(await badges(a.token)).toMatchObject({ chat: 1, mail: 1, total: 2 });

    // Mark conversation as read → chat drops to zero.
    const convId = b(await get(a.token, '/chat/conversations')).data.conversations[0].convId;
    await post(a.token, '/chat/read', { convId });
    expect(await badges(a.token)).toMatchObject({ chat: 0, mail: 1, total: 1 });

    // Mark mail as read → mail drops to zero.
    const mailId = b(await get(a.token, '/mail')).data.mail[0].mailId;
    await post(a.token, `/mail/${mailId}/read`, {});
    expect(await badges(a.token)).toEqual({ friendRequests: 0, chat: 0, mail: 0, total: 0 });
  });

  it('requires auth', async () => {
    const r = await app.inject({ method: 'GET', url: '/social/badges' });
    expect(r.statusCode).toBe(401);
  });
});
