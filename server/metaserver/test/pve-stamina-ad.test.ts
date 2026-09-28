// POST /pve/stamina/ad — the CrazyGames-only rewarded-ad stamina refill (CRAZYGAMES_LAUNCH §4).
// Real Mongo (rs0), same convention as pve-service-unit.test.ts; Redis is the in-process fallback.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMongo, type JwtConfig, type MongoHandle,
  STAMINA_AD_AMOUNT, STAMINA_AD_DAILY_CAP, STAMINA_AD_CLIENT_PLATFORM,
} from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { STAMINA_REGEN_MS } from '../src/service/base.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_stamina_ad_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[pve-stamina-ad] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('POST /pve/stamina/ad', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  let accountId: string;
  let fakeNow = 1_700_000_000_000;
  let tokenSeq = 0;

  const b = (r: { payload: string }) => JSON.parse(r.payload);
  const watch = (platform: string = STAMINA_AD_CLIENT_PLATFORM, adToken = `tok-${++tokenSeq}`) =>
    app.inject({
      method: 'POST', url: '/pve/stamina/ad',
      headers: { authorization: `Bearer ${token}`, 'x-nw-platform': platform },
      payload: { adToken, platform: 'dev' },
    });
  const setStamina = (current: number, regenAt: number) =>
    m.collections.pveStamina.updateOne({ _id: accountId }, { $set: { current, regenAt } }, { upsert: true });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    fakeNow = 1_700_000_000_000;
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', now: () => fakeNow } as never);
    const r = b(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `stamina-ad-${Math.random()}` } }));
    token = r.data.token;
    accountId = r.data.accountId;
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  it('adds the refill and starts the regen timer when it stays below the cap', async () => {
    await setStamina(5, 0);
    const r = b(await watch());
    expect(r.data.stamina.current).toBe(5 + STAMINA_AD_AMOUNT);
    expect(r.data.stamina.regenAt).toBe(fakeNow + STAMINA_REGEN_MS);
    expect(r.data.adsLeft).toBe(STAMINA_AD_DAILY_CAP - 1);
    expect((await m.collections.pveStamina.findOne({ _id: accountId }))?.current).toBe(5 + STAMINA_AD_AMOUNT);
  });

  it('applies owed natural regen before adding, and keeps the running timer', async () => {
    const regenAt = fakeNow - 1; // one tick already due
    await setStamina(5, regenAt);
    const r = b(await watch());
    expect(r.data.stamina.current).toBe(5 + 1 + STAMINA_AD_AMOUNT);
    expect(r.data.stamina.regenAt).toBe(regenAt + STAMINA_REGEN_MS);
  });

  it('caps at 120 and stops the timer', async () => {
    await setStamina(110, fakeNow + 1000);
    const r = b(await watch());
    expect(r.data.stamina).toEqual({ current: 120, regenAt: 0 });
  });

  it(`allows ${STAMINA_AD_DAILY_CAP} per UTC day, then 429; the next day resets`, async () => {
    await setStamina(0, 0);
    for (let i = 1; i <= STAMINA_AD_DAILY_CAP; i++) {
      const r = b(await watch());
      expect(r.data.adsLeft).toBe(STAMINA_AD_DAILY_CAP - i);
    }
    const over = await watch();
    expect(over.statusCode).toBe(429);
    expect(b(over).error.code).toBe('DAILY_CAP_REACHED');
    fakeNow += 24 * 3600 * 1000;
    expect((await watch()).statusCode).toBe(200);
  });

  it('rejects every other client platform (web build = iOS shell origin)', async () => {
    for (const p of ['web', 'ios', 'android', 'wechat']) {
      expect((await watch(p)).statusCode).toBe(400);
    }
    const r = await app.inject({
      method: 'POST', url: '/pve/stamina/ad',
      headers: { authorization: `Bearer ${token}` }, payload: { adToken: 'no-header' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects a replayed ad token without spending a daily slot', async () => {
    await setStamina(0, 0);
    expect((await watch(STAMINA_AD_CLIENT_PLATFORM, 'same')).statusCode).toBe(200);
    expect((await watch(STAMINA_AD_CLIENT_PLATFORM, 'same')).statusCode).toBe(400);
    expect(b(await watch()).data.adsLeft).toBe(STAMINA_AD_DAILY_CAP - 2);
  });

  it('does not share the coin ads’ daily counter', async () => {
    await setStamina(0, 0);
    await watch();
    const status = b(await app.inject({ method: 'GET', url: '/retention', headers: { authorization: `Bearer ${token}` } }));
    expect(status.data.ads.watchedToday).toBe(0);
  });

  it('requires auth', async () => {
    const r = await app.inject({ method: 'POST', url: '/pve/stamina/ad', payload: { adToken: 'x' } });
    expect(r.statusCode).toBe(401);
  });
});
