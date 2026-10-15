// Next-day hero gift (ONBOARDING_DESIGN §17.4): the first ch1_lv5 clear stamps save.heroGift, claimable
// from the next UTC midnight via POST /pve/hero-gift/claim, which grants the hero card exactly once.
// Requires `cd server && docker compose up -d` + `tsc -b` first (for @nw/shared's dist; this file imports ../src).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle, HERO_GIFT_DEF_ID, heroGiftClaimableAt } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_pve_hero_gift_test';
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
if (!mongo) console.warn(`[pve-hero-gift.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('pve hero gift e2e', () => {
  const m = mongo!;
  const T0 = Date.UTC(2026, 9, 15, 20, 0, 0);
  let clock = T0;
  let app: FastifyInstance;
  let token: string;
  let accountId: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const clear = (levelId: string, stars = 3) =>
    app.inject({ method: 'POST', url: '/pve/clear', headers: auth(), payload: { levelId, stars } });
  const claim = () => app.inject({ method: 'POST', url: '/pve/hero-gift/claim', headers: auth() });
  const seedCleared = (cleared: string[]) =>
    m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.progress.cleared': cleared } });
  const heroCount = (save: { cardInv: Record<string, { defId: string }> }) =>
    Object.values(save.cardInv).filter((c) => c.defId === HERO_GIFT_DEF_ID).length;

  beforeEach(async () => {
    clock = T0;
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', now: () => clock });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'gift-dev-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() });
    await seedCleared(['ch1_lv1', 'ch1_lv2', 'ch1_lv3', 'ch1_lv4']);
  });
  afterAll(async () => { if (app) await app.close(); });

  it('no gift before the gift level is cleared → 404', async () => {
    const r = await claim();
    expect(r.statusCode).toBe(404);
  });

  it('first ch1_lv5 clear stamps the gift for the next UTC midnight; a replay does not move it', async () => {
    const r = body(await clear('ch1_lv5'));
    expect(r.data.save.heroGift).toEqual({ defId: HERO_GIFT_DEF_ID, claimableAt: heroGiftClaimableAt(T0) });
    expect(r.data.save.heroGift.claimableAt).toBe(Date.UTC(2026, 9, 16));
    clock = T0 + 3_600_000 * 10; // next day
    const r2 = body(await clear('ch1_lv5'));
    expect(r2.data.save.heroGift.claimableAt).toBe(Date.UTC(2026, 9, 16));
  });

  it('other levels do not stamp a gift', async () => {
    const r = body(await clear('ch1_lv1'));
    expect(r.data.save.heroGift).toBeUndefined();
  });

  it('claim before claimableAt → 400; after → the hero card once, idempotent afterwards', async () => {
    const before = body(await clear('ch1_lv5'));
    const n0 = heroCount(before.data.save);
    expect((await claim()).statusCode).toBe(400);
    clock = Date.UTC(2026, 9, 16) + 1;
    const r = await claim();
    expect(r.statusCode).toBe(200);
    const s = body(r).data.save;
    expect(s.heroGift.claimedAt).toBe(clock);
    expect(heroCount(s)).toBe(n0 + 1);
    const card = (Object.values(s.cardInv) as Array<{ defId: string; sourceType?: string }>).find((c) => c.sourceType === 'hero_gift');
    expect(card?.defId).toBe(HERO_GIFT_DEF_ID);
    const again = body(await claim()).data.save;
    expect(heroCount(again)).toBe(n0 + 1);
    expect(again.heroGift.claimedAt).toBe(s.heroGift.claimedAt);
  });
});
