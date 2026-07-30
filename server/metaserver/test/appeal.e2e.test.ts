// Player appeal e2e (CONTENT_MODERATION_DESIGN.md CM10): POST /account/appeal (only allowed while an
// enforcement is actually active; one open appeal at a time) + the admin-facing internal endpoints
// (GET /internal/appeals, POST /internal/appeals/:id/resolve — approve clears mute/temp-ban/ban but not
// reputationScore, and un-blocks a subsequent auth via the same accountCache invalidation as the penalty path).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_appeal_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const KEY = 'k';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[appeal.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('player appeal e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY });
  });
  afterAll(async () => { if (app) await app.close(); });

  async function newDevice(deviceId: string): Promise<{ accountId: string; token: string }> {
    const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } });
    return JSON.parse(r.payload).data as { accountId: string; token: string };
  }

  it('rejects an appeal when there is no active enforcement', async () => {
    const { token } = await newDevice('dev-clean');
    const r = await app.inject({
      method: 'POST', url: '/account/appeal',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'I did nothing wrong' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects an empty reason', async () => {
    const { accountId, token } = await newDevice('dev-empty-reason');
    await app.inject({
      method: 'POST', url: `/internal/accounts/${accountId}/penalty`,
      headers: { 'x-internal-key': KEY }, payload: { delta: -60 }, // → tempban
    });
    const r = await app.inject({
      method: 'POST', url: '/account/appeal',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: '   ' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('accepts an appeal once a penalty put the account under active enforcement, snapshotting the enforcement state', async () => {
    const { accountId, token } = await newDevice('dev-tempbanned');
    const penaltyRes = await app.inject({
      method: 'POST', url: `/internal/accounts/${accountId}/penalty`,
      headers: { 'x-internal-key': KEY }, payload: { delta: -60 }, // 100-60=40 → tempban
    });
    expect(JSON.parse(penaltyRes.payload).action).toBe('tempban');

    const r = await app.inject({
      method: 'POST', url: '/account/appeal',
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: 'it was a misunderstanding' },
    });
    expect(r.statusCode).toBe(200);

    const doc = await m.collections.appeals.findOne({ accountId });
    expect(doc).toMatchObject({ accountId, reason: 'it was a misunderstanding', status: 'open' });
    expect(typeof doc?.enforcementSnapshot.bannedUntil).toBe('number');
    expect(doc?.enforcementSnapshot.reputationScore).toBe(40);
  });

  it('rejects a second appeal while one is still open (409)', async () => {
    const { accountId, token } = await newDevice('dev-double-appeal');
    await app.inject({
      method: 'POST', url: `/internal/accounts/${accountId}/penalty`,
      headers: { 'x-internal-key': KEY }, payload: { delta: -60 },
    });
    const first = await app.inject({
      method: 'POST', url: '/account/appeal',
      headers: { authorization: `Bearer ${token}` }, payload: { reason: 'first' },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST', url: '/account/appeal',
      headers: { authorization: `Bearer ${token}` }, payload: { reason: 'second' },
    });
    expect(second.statusCode).toBe(409);
  });

  it('GET /internal/appeals lists open appeals and requires the internal key', async () => {
    const { accountId, token } = await newDevice('dev-listed');
    await app.inject({
      method: 'POST', url: `/internal/accounts/${accountId}/penalty`,
      headers: { 'x-internal-key': KEY }, payload: { delta: -60 },
    });
    await app.inject({
      method: 'POST', url: '/account/appeal',
      headers: { authorization: `Bearer ${token}` }, payload: { reason: 'please review' },
    });

    const unauthed = await app.inject({ method: 'GET', url: '/internal/appeals' });
    expect(unauthed.statusCode).toBe(401);

    const listed = await app.inject({ method: 'GET', url: '/internal/appeals', headers: { 'x-internal-key': KEY } });
    expect(listed.statusCode).toBe(200);
    const { appeals } = JSON.parse(listed.payload) as { appeals: { accountId: string }[] };
    expect(appeals.some((a) => a.accountId === accountId)).toBe(true);
  });

  it('resolve(approved) clears the account\'s temp-ban and un-blocks a subsequent login, but leaves reputationScore untouched', async () => {
    const { accountId, token } = await newDevice('dev-approved');
    await app.inject({
      method: 'POST', url: `/internal/accounts/${accountId}/penalty`,
      headers: { 'x-internal-key': KEY }, payload: { delta: -60 }, // → tempban
    });
    const submitted = await app.inject({
      method: 'POST', url: '/account/appeal',
      headers: { authorization: `Bearer ${token}` }, payload: { reason: 'please review' },
    });
    void submitted;
    const [appeal] = await m.collections.appeals.find({ accountId }).toArray();

    const resolveRes = await app.inject({
      method: 'POST', url: `/internal/appeals/${appeal!._id}/resolve`,
      headers: { 'x-internal-key': KEY }, payload: { resolution: 'approved', resolvedBy: 'admin-1' },
    });
    expect(resolveRes.statusCode).toBe(200);

    const doc = await m.collections.accounts.findOne({ _id: accountId });
    expect(doc?.flags?.bannedUntil).toBeUndefined();
    expect(doc?.flags?.reputationScore).toBe(40); // not restored, CM10

    // The account is no longer temp-banned — a fresh auth is no longer rejected (accountCache invalidated).
    const reauth = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'dev-approved' } });
    expect(reauth.statusCode).toBe(200);
  });

  it('resolve(denied) stamps the record without touching account flags', async () => {
    const { accountId, token } = await newDevice('dev-denied');
    await app.inject({
      method: 'POST', url: `/internal/accounts/${accountId}/penalty`,
      headers: { 'x-internal-key': KEY }, payload: { delta: -60 },
    });
    await app.inject({
      method: 'POST', url: '/account/appeal',
      headers: { authorization: `Bearer ${token}` }, payload: { reason: 'please review' },
    });
    const [appeal] = await m.collections.appeals.find({ accountId }).toArray();

    const resolveRes = await app.inject({
      method: 'POST', url: `/internal/appeals/${appeal!._id}/resolve`,
      headers: { 'x-internal-key': KEY }, payload: { resolution: 'denied', resolvedBy: 'admin-1', note: 'not convincing' },
    });
    expect(resolveRes.statusCode).toBe(200);

    const doc = await m.collections.accounts.findOne({ _id: accountId });
    expect(typeof doc?.flags?.bannedUntil).toBe('number'); // untouched, still temp-banned

    const updated = await m.collections.appeals.findOne({ _id: appeal!._id });
    expect(updated).toMatchObject({ status: 'denied', resolvedBy: 'admin-1', resolutionNote: 'not convincing' });
  });

  it('resolving an unknown or already-resolved appeal returns 404', async () => {
    const r1 = await app.inject({
      method: 'POST', url: '/internal/appeals/nonexistent/resolve',
      headers: { 'x-internal-key': KEY }, payload: { resolution: 'denied' },
    });
    expect(r1.statusCode).toBe(404);

    const { accountId, token } = await newDevice('dev-double-resolve');
    await app.inject({
      method: 'POST', url: `/internal/accounts/${accountId}/penalty`,
      headers: { 'x-internal-key': KEY }, payload: { delta: -60 },
    });
    await app.inject({
      method: 'POST', url: '/account/appeal',
      headers: { authorization: `Bearer ${token}` }, payload: { reason: 'please review' },
    });
    const [appeal] = await m.collections.appeals.find({ accountId }).toArray();
    await app.inject({
      method: 'POST', url: `/internal/appeals/${appeal!._id}/resolve`,
      headers: { 'x-internal-key': KEY }, payload: { resolution: 'denied' },
    });
    const r2 = await app.inject({
      method: 'POST', url: `/internal/appeals/${appeal!._id}/resolve`,
      headers: { 'x-internal-key': KEY }, payload: { resolution: 'approved' },
    });
    expect(r2.statusCode).toBe(404);
  });

  it('CONCURRENT resolve of the same appeal by five admins: exactly one wins, the rest see 404', async () => {
    const { accountId, token } = await newDevice('dev-concurrent-resolve');
    await app.inject({
      method: 'POST', url: `/internal/accounts/${accountId}/penalty`,
      headers: { 'x-internal-key': KEY }, payload: { delta: -60 },
    });
    await app.inject({
      method: 'POST', url: '/account/appeal',
      headers: { authorization: `Bearer ${token}` }, payload: { reason: 'please review' },
    });
    const [appeal] = await m.collections.appeals.find({ accountId }).toArray();

    // Five admins resolve the same appeal at the same instant. Without the CAS guard (status:'open' on the
    // write, not just the preceding read), several requests can pass the initial findOne and all return
    // {ok:true}, leaving the final status/resolvedBy nondeterministic instead of one clean winner + clear
    // "already resolved" losers. A 2-way race was flaky to reproduce (timing-dependent); 5-way fan-out
    // reliably triggers it, mirroring the commercial CAS regression tests' fan-out choice.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        app.inject({
          method: 'POST', url: `/internal/appeals/${appeal!._id}/resolve`,
          headers: { 'x-internal-key': KEY }, payload: { resolution: 'denied', resolvedBy: `admin-${i}` },
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 404, 404, 404, 404]);

    const updated = await m.collections.appeals.findOne({ _id: appeal!._id });
    expect(updated?.status).toBe('denied');
    const winnerIdx = results.findIndex((r) => r.statusCode === 200);
    expect(updated?.resolvedBy).toBe(`admin-${winnerIdx}`);
  });

  it('CONCURRENT submitAppeal from the same account: exactly one insert wins, the other gets 409', async () => {
    const { accountId, token } = await newDevice('dev-concurrent-submit');
    await app.inject({
      method: 'POST', url: `/internal/accounts/${accountId}/penalty`,
      headers: { 'x-internal-key': KEY }, payload: { delta: -60 },
    });

    // Two rapid submits (double-tap, or a client retry racing the original request) both pass the
    // findOne-based "no open appeal yet" precheck before either insertOne lands — only the unique partial
    // index on {accountId, status:'open'} (mongo.ts) prevents both from creating an open appeal doc.
    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST', url: '/account/appeal',
        headers: { authorization: `Bearer ${token}` }, payload: { reason: 'first' },
      }),
      app.inject({
        method: 'POST', url: '/account/appeal',
        headers: { authorization: `Bearer ${token}` }, payload: { reason: 'second' },
      }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const docs = await m.collections.appeals.find({ accountId, status: 'open' }).toArray();
    expect(docs.length).toBe(1);
  });
});
