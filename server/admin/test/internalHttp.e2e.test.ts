// admin internal (X-Internal-Key) HTTP route e2e — 2026-08-10, added alongside the httpApi.ts split
// (claudedocs/server.md "单文件 500 行收敛"). The httpApi.ts split isolated these three routes into
// `httpApi/session.ts`'s `handlePreAuth` (see that file's header comment) — a cleanly named unit that
// exposed a pre-existing zero-coverage gap: `getInternalFlags`/`getInternalShopPrices`/
// `getInternalWordlists` had e2e coverage only at the *service* layer (moderation.e2e.test.ts /
// shop.e2e.test.ts call `svc.getInternalXxx()` directly), never through the actual HTTP route + the
// X-Internal-Key gate that database-less backends (worldsvc/metaserver/socialsvc) really go through in
// production. This file closes that gap: real node:http server, real Mongo, no admin JWT anywhere.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { loadInternalAuth, FLAG_KEYS, SLG_SHOP_ITEMS, type LiveStats } from '@nw/shared';
import { createAdminMongo, type AdminMongo } from '../src/db';
import { AdminService } from '../src/service';
import { startHttpApi } from '../src/httpApi';
import type { MailDispatcher, MailSendReq, MailSendRes, MailPreviewReq, MailPreviewRes, PlayerClient, PlayerProfile, StatsClient } from '../src/clients';
import { jsonBody } from './jsonBody';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_admin_internal_http_test';
const JWT_SECRET = 'internal-http-test-secret';
const INTERNAL_KEY = 'internal-http-test-key';

async function tryConnect(): Promise<AdminMongo | null> {
  try {
    return await createAdminMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[admin.internalHttp.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

const stubStats: StatsClient = {
  available: true,
  fetchLive: async (): Promise<LiveStats> => ({ online: 0, queue: 0, rooms: 0, gameInstances: 0 }),
};
class FakeMail implements MailDispatcher {
  available = true;
  async send(req: MailSendReq): Promise<MailSendRes> { return { ok: true, recipientCount: req.scope === 'global' ? 100 : 1 }; }
  async preview(req: MailPreviewReq): Promise<MailPreviewRes> { return { ok: true, recipientCount: req.scope === 'global' ? 100 : 1 }; }
}
const stubPlayer: PlayerClient = {
  available: true,
  lookupByPublicId: async (): Promise<PlayerProfile | null> => null,
  // Not exercised by this suite — throw rather than answer, so a route that starts calling them
  // fails loudly instead of quietly seeing `undefined`.
  lookupByAccountId: () => { throw new Error('stubPlayer.lookupByAccountId is not stubbed'); },
  search: () => { throw new Error('stubPlayer.search is not stubbed'); },
  resetPassword: () => { throw new Error('stubPlayer.resetPassword is not stubbed'); },
};

let t = 1000;
const now = (): number => t++;

describe.skipIf(!mongo)('admin internal (X-Internal-Key) HTTP routes e2e', () => {
  const m = mongo!;
  let server: Server;
  let base: string;
  const flagKey = FLAG_KEYS[0]!;
  const shopItemId = SLG_SHOP_ITEMS[0]!.id;

  beforeAll(async () => {
    await m.ensureIndexes(3600);
    const svc = new AdminService({ cols: m.collections, stats: stubStats, players: stubPlayer, mail: new FakeMail(), now });
    server = startHttpApi(
      { host: '127.0.0.1', port: 0, jwt: { secret: JWT_SECRET }, internalAuth: loadInternalAuth(INTERNAL_KEY) },
      svc,
    );
    await new Promise<void>((res) => server.on('listening', res));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.collections.featureFlags.insertOne({ _id: flagKey, enabled: true, desc: 'seeded for internal HTTP test', updatedAt: now(), updatedBy: 'test' });
    await m.collections.slgShopPrices.insertOne({ _id: shopItemId, cost: 12345, updatedAt: now(), updatedBy: 'test' });
    await m.collections.moderationWordlists.insertOne({ _id: 'global', words: ['seeded-bad-word'], updatedAt: now(), updatedBy: 'test' });
  });

  afterAll(async () => {
    server.close();
    await m.close();
  });

  // —— No admin JWT required: these run entirely inside handlePreAuth, before authenticate() is ever called ——
  it('GET /admin/internal/flags with a valid X-Internal-Key returns the raw seeded doc, no Authorization header sent', async () => {
    const res = await fetch(`${base}/admin/internal/flags`, { headers: { 'x-internal-key': INTERNAL_KEY } });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.flags).toEqual([{ _id: flagKey, enabled: true, desc: 'seeded for internal HTTP test', updatedAt: expect.any(Number), updatedBy: 'test' }]);
  });

  it('GET /admin/internal/slg-shop-prices with a valid X-Internal-Key returns the raw seeded override', async () => {
    const res = await fetch(`${base}/admin/internal/slg-shop-prices`, { headers: { 'x-internal-key': INTERNAL_KEY } });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.items).toEqual([{ _id: shopItemId, cost: 12345, updatedAt: expect.any(Number), updatedBy: 'test' }]);
  });

  it('GET /admin/internal/moderation-wordlists with a valid X-Internal-Key returns the raw seeded overlay', async () => {
    const res = await fetch(`${base}/admin/internal/moderation-wordlists`, { headers: { 'x-internal-key': INTERNAL_KEY } });
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.items).toEqual([{ _id: 'global', words: ['seeded-bad-word'], updatedAt: expect.any(Number), updatedBy: 'test' }]);
  });

  // —— The X-Internal-Key gate itself: missing or wrong key must reject with 401, for all three routes ——
  it.each([
    ['/admin/internal/flags'],
    ['/admin/internal/slg-shop-prices'],
    ['/admin/internal/moderation-wordlists'],
  ])('GET %s with no X-Internal-Key header → 401, never reaches the service', async (path) => {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(401);
    expect(await jsonBody(res)).toEqual({ ok: false, error: 'unauthorized' });
  });

  it.each([
    ['/admin/internal/flags'],
    ['/admin/internal/slg-shop-prices'],
    ['/admin/internal/moderation-wordlists'],
  ])('GET %s with a wrong X-Internal-Key → 401', async (path) => {
    const res = await fetch(`${base}${path}`, { headers: { 'x-internal-key': 'not-the-right-key' } });
    expect(res.status).toBe(401);
    expect(await jsonBody(res)).toEqual({ ok: false, error: 'unauthorized' });
  });
});
