// PvE stamina-at-entry end-to-end (A4, 2026-07-06): stamina is deducted by POST /pve/enter, not by POST /pve/clear.
//   Validates default cost (10), insufficient balance (402, no partial deduction), unknown/locked level (400),
//   banned account (403), and that /pve/clear no longer touches the pveStamina balance.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_pve_enter_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[pve-enter.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('pve stamina-at-entry e2e (A4)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  let accountId: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });
  const enter = (levelId: string) =>
    app.inject({ method: 'POST', url: '/pve/enter', headers: auth(), payload: { levelId } });
  const clear = (levelId: string, stars = 3) =>
    app.inject({ method: 'POST', url: '/pve/clear', headers: auth(), payload: { levelId, stars } });
  const setStamina = (current: number, regenAt = 0) =>
    m.collections.pveStamina.updateOne(
      { _id: accountId },
      { $set: { current, regenAt } },
      { upsert: true },
    );

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k' });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'pve-enter-dev-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // initialize save
  });
  afterAll(async () => { if (app) await app.close(); });

  it('deducts the default cost (10) from a full stamina bar (120) and starts the regen timer', async () => {
    const r = body(await enter('ch1_lv1'));
    expect(r.data.stamina.current).toBe(110);
    expect(r.data.stamina.regenAt).toBeGreaterThan(0);
  });

  it('repeated entries deduct 10 each time (uniform flat rate)', async () => {
    await enter('ch1_lv1');
    const r2 = body(await enter('ch1_lv1'));
    expect(r2.data.stamina.current).toBe(100);
  });

  it('insufficient stamina → 402, balance is left untouched', async () => {
    await setStamina(5);
    const res = await enter('ch1_lv1');
    expect(res.statusCode).toBe(402);
    const after = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(after.data.save.stamina.current).toBe(5);
  });

  it('unknown level → 400, no stamina deducted', async () => {
    const res = await enter('no_such_level');
    expect(res.statusCode).toBe(400);
    const after = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(after.data.save.stamina.current).toBe(120);
  });

  it('locked level (prerequisite not cleared) → 400, no stamina deducted', async () => {
    const res = await enter('ch1_lv2'); // ch1_lv1 must be cleared first
    expect(res.statusCode).toBe(400);
    const after = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(after.data.save.stamina.current).toBe(120);
  });

  it('banned account (antiCheat.pveBanned) → 403, no stamina deducted', async () => {
    await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.antiCheat.pveBanned': true } });
    const res = await enter('ch1_lv1');
    expect(res.statusCode).toBe(403);
    await m.collections.saves.updateOne({ _id: accountId }, { $unset: { 'save.antiCheat.pveBanned': '' } });
    const after = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(after.data.save.stamina.current).toBe(120);
  });

  it('/pve/clear no longer deducts stamina: entering once then clearing repeatedly only charges the entry', async () => {
    const entered = body(await enter('ch1_lv1'));
    expect(entered.data.stamina.current).toBe(110);
    await clear('ch1_lv1', 3);
    await clear('ch1_lv1', 1); // replay clear
    const after = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(after.data.save.stamina.current).toBe(110); // unchanged by either clear
  });

  it('clear works even with zero stamina (entry and settlement are fully decoupled)', async () => {
    await setStamina(0);
    const r = body(await clear('ch1_lv1', 3));
    expect(r.data.granted).toEqual({ scrap: 6, lead: 2 });
    expect(r.data.save.stamina.current).toBe(0); // clear response still reports the current balance, just doesn't change it
  });
});
