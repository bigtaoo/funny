// Account-deletion purge (POST /internal/accounts/:accountId/purge) end-to-end: real Mongo + real node:http.
//
// Pins the three ways a deleted player's rows are found (user_id, anonymous rows on their devices, and
// sessions that started anonymous but whose events carry the account), and the one way they must NOT
// over-reach: another account's identified rows on a shared device stay.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createAnalyticsMongo, type AnalyticsMongo, type EventDoc, type SessionDoc } from '../src/db';
import { AnalyticsService } from '../src/service';
import { startHttpApi } from '../src/httpApi';
import { createInternalAuth } from '@nw/shared';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_analytics_account_purge_test';
const INTERNAL_KEY = 'test-internal-key';

async function tryConnect(): Promise<AnalyticsMongo | null> {
  try {
    return await createAnalyticsMongo(URI, DB);
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[analyticsvc.accountPurge.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('analyticsvc account purge', () => {
  let server: Server;
  let base: string;
  let svc: AnalyticsService;

  beforeAll(async () => {
    await mongo!.db.dropDatabase();
    await mongo!.ensureIndexes();
    svc = new AnalyticsService(mongo!.collections);
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwtSecret: 'test-jwt-secret', internalAuth: createInternalAuth({ legacyKey: INTERNAL_KEY }) },
      svc,
    );
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    await mongo?.db.dropDatabase();
    await mongo?.close();
  });

  const ev = (session_id: string, device_id: string, user_id?: string): EventDoc => ({
    session_id, device_id, ...(user_id ? { user_id } : { user_id: undefined }),
    platform: 'web', os: '', game_version: '1', locale: 'en', event: 'x', props: {}, ts: new Date(),
  });
  const sess = (_id: string, device_id: string, user_id?: string): SessionDoc => ({
    _id, device_id, ...(user_id ? { user_id } : { user_id: undefined }),
    platform: 'web', os: '', started_at: new Date(), scenes_visited: [], events_count: 1,
  });

  beforeEach(async () => {
    const { events, sessions } = mongo!.collections;
    await events.deleteMany({});
    await sessions.deleteMany({});
    await events.insertMany([
      ev('s-login', 'dev-1', 'gone'),     // identified
      ev('s-pre', 'dev-1'),               // pre-login on the player's device
      ev('s-late', 'dev-9'),              // anonymous start on a device metaserver does not know…
      ev('s-late', 'dev-9', 'gone'),      // …then logged in part-way
      ev('s-other', 'dev-1', 'other'),    // another account on the same (shared) device
      ev('s-anon', 'dev-2'),              // unrelated anonymous device
    ]);
    await sessions.insertMany([
      sess('s-login', 'dev-1', 'gone'),
      sess('s-pre', 'dev-1'),
      sess('s-late', 'dev-9'),            // user_id stuck at null by $setOnInsert
      sess('s-other', 'dev-1', 'other'),
      sess('s-anon', 'dev-2'),
    ]);
  });

  const purge = (body: unknown, key: string | null = INTERNAL_KEY, account = 'gone') =>
    fetch(`${base}/internal/accounts/${account}/purge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'X-Internal-Key': key } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('deletes by user_id, anonymous rows on the given devices, and late-login sessions; keeps other accounts', async () => {
    const r = await purge({ deviceIds: ['dev-1'] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, data: { done: true, removed: { events: 4, sessions: 3 } } });

    const { events, sessions } = mongo!.collections;
    expect((await sessions.find({}).toArray()).map((s) => s._id).sort()).toEqual(['s-anon', 's-other']);
    expect((await events.find({}).toArray()).map((e) => e.session_id).sort()).toEqual(['s-anon', 's-other']);
  });

  it('without deviceIds only identified rows (and their sessions) go', async () => {
    const r = await purge({});
    expect(await r.json()).toEqual({ ok: true, data: { done: true, removed: { events: 3, sessions: 2 } } });
    expect(await mongo!.collections.events.countDocuments({ session_id: 's-pre' })).toBe(1);
  });

  it('is idempotent', async () => {
    await purge({ deviceIds: ['dev-1'] });
    const again = await purge({ deviceIds: ['dev-1'] });
    expect(await again.json()).toEqual({ ok: true, data: { done: true, removed: { events: 0, sessions: 0 } } });
  });

  it('401 without X-Internal-Key, nothing deleted', async () => {
    const r = await purge({ deviceIds: ['dev-1'] }, null);
    expect(r.status).toBe(401);
    expect(await mongo!.collections.events.countDocuments({})).toBe(6);
  });

  it.each([
    ['deviceIds not an array', { deviceIds: 'dev-1' }],
    ['non-string entry', { deviceIds: ['dev-1', 7] }],
    ['empty-string entry', { deviceIds: [''] }],
    ['over the cap', { deviceIds: Array.from({ length: 21 }, (_, i) => `d${i}`) }],
    ['malformed JSON', '{nope'],
  ])('bad body (%s) → 400, nothing deleted', async (_label, body) => {
    const r = await purge(body);
    expect(r.status).toBe(400);
    expect(await mongo!.collections.events.countDocuments({})).toBe(6);
  });

  it('GET → 404', async () => {
    const r = await fetch(`${base}/internal/accounts/gone/purge`, { headers: { 'X-Internal-Key': INTERNAL_KEY } });
    expect(r.status).toBe(404);
  });

  it('ensureIndexes creates the purge lookup indexes', async () => {
    const evIdx = (await mongo!.collections.events.indexes()).map((i) => JSON.stringify(i.key));
    const ssIdx = (await mongo!.collections.sessions.indexes()).map((i) => JSON.stringify(i.key));
    expect(evIdx).toContain(JSON.stringify({ device_id: 1 }));
    expect(ssIdx).toContain(JSON.stringify({ user_id: 1 }));
  });
});
