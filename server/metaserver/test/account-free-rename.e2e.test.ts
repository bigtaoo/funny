// One-time free rename e2e: players who never deliberately chose a display name (guests, or password
// users who skipped the name field) carry a system-assigned default and are entitled to exactly one
// free rename. This suite covers the freeRename flag on GET /save, the free first rename (no coins
// required), the flag flipping off afterwards, that the second rename is paid (402 with no balance),
// and that registering with an explicit name grants no free rename.
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import type { CommercialClient } from '../dist/commercialClient.js';
import { buildApp } from '../dist/app.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_free_rename_test';
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
if (!mongo) console.warn(`[account-free-rename.e2e] Mongo unreachable (${URI}) — skipping.`);

/** Minimal commercial stub: only spend/getWallet are exercised by rename; balance starts at 0. */
function makeCommercial(): CommercialClient {
  const coins = new Map<string, number>();
  return {
    available: true,
    async getWallet(id: string) {
      return { coins: coins.get(id) ?? 0, pity: {}, fatePoints: 0, subscriptionExpiry: 0, starterUsed: [], firstPurchaseUsed: false };
    },
    async spend(a: { accountId: string; amount: number; orderId: string }) {
      const bal = coins.get(a.accountId) ?? 0;
      if (bal < a.amount) return { ok: false as const, error: 'INSUFFICIENT_FUNDS' };
      coins.set(a.accountId, bal - a.amount);
      return { ok: true as const, coinsAfter: bal - a.amount };
    },
  } as unknown as CommercialClient;
}

describe.skipIf(!mongo)('one-time free rename e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;

  const body = (r: { payload: string }) => JSON.parse(r.payload);

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: KEY, commercial: makeCommercial() });
  });

  afterAll(async () => { if (app) await app.close(); });

  async function authDevice(deviceId: string) {
    const r = await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId } });
    return body(r).data as { token: string; accountId: string };
  }

  const getSave = async (token: string) =>
    body(await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${token}` } })).data;

  const rename = async (token: string, displayName: string) =>
    app.inject({ method: 'POST', url: '/profile/rename', headers: { authorization: `Bearer ${token}` }, payload: { displayName } });

  it('a never-named guest gets freeRename:true on GET /save', async () => {
    const { token } = await authDevice('free-dev-1');
    expect((await getSave(token)).freeRename).toBe(true);
  });

  it('the first rename is free (succeeds with zero balance) and flips freeRename off', async () => {
    const { token } = await authDevice('free-dev-2');
    const r = await rename(token, 'ChosenName');
    expect(r.statusCode).toBe(200);
    expect(body(r).data.displayName).toBe('ChosenName');
    expect(body(r).data.freeRename).toBe(false);

    const save = await getSave(token);
    expect(save.displayName).toBe('ChosenName');
    expect(save.freeRename).toBe(false);
  });

  it('the second rename is paid — 402 when the balance is short', async () => {
    const { token } = await authDevice('free-dev-3');
    expect((await rename(token, 'FirstFree')).statusCode).toBe(200); // free
    const r2 = await rename(token, 'SecondPaid'); // now paid, no coins → rejected
    expect(r2.statusCode).toBe(402);

    const save = await getSave(token);
    expect(save.displayName).toBe('FirstFree'); // unchanged by the failed paid rename
  });

  it('registering with an explicit displayName grants no free rename', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/register', payload: { loginId: 'fr4@test.com', password: 'pw123456', displayName: 'Picked' } });
    const { token } = body(r).data as { token: string };
    expect((await getSave(token)).freeRename).toBe(false);
    // With no balance, the (paid) rename is rejected — proving the free path was not taken.
    expect((await rename(token, 'Again')).statusCode).toBe(402);
  });
});
