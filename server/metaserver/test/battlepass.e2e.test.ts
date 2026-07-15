// Battle Pass end-to-end (S11 §9): real Mongo + injected fake commercial. No existing test exercised
// /battlepass/buy or /battlepass/claim at all before this file — covers material (free track) landing in
// save.materials and coins (paid track) mirroring the wallet, plus the PASS_REQUIRED / ALREADY_CLAIMED guards.
// Requires `cd server && docker compose up -d` + prior `tsc -b` (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';
import type { CommercialClient, UndeliveredOrder } from '../dist/commercialClient.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_battlepass_test';
const jwt: JwtConfig = { secret: 'test-secret' };

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[battlepass.e2e] Mongo unreachable (${URI}) — skipping.`);

/** Minimal fake commercial: spend (buy) + idempotent grant (paid-track coins claim). */
class FakeCommercial implements CommercialClient {
  readonly available = true;
  coins = new Map<string, number>();
  granted = new Set<string>();
  bal(id: string) {
    return this.coins.get(id) ?? 0;
  }
  async getWallet(id: string) {
    return { coins: this.bal(id), pity: {} };
  }
  async spend(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    if (this.bal(a.accountId) < a.amount) return { ok: false as const, error: 'INSUFFICIENT_FUNDS' };
    this.coins.set(a.accountId, this.bal(a.accountId) - a.amount);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  async grant(a: { accountId: string; amount: number; reason: string; orderId: string }) {
    if (this.granted.has(a.orderId)) return { ok: true as const, coinsAfter: this.bal(a.accountId) };
    this.coins.set(a.accountId, this.bal(a.accountId) + a.amount);
    this.granted.add(a.orderId);
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  async undeliveredOrders(): Promise<UndeliveredOrder[]> {
    return [];
  }
  async shopCharge() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async gachaDraw() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async orderDelivered() {
    return { ok: true as const };
  }
  async rechargeVerify() {
    return { ok: false as const, error: 'NOT_IMPL' };
  }
  async adsCredit(a: { accountId: string; amount: number }) {
    return { ok: true as const, coinsAfter: this.bal(a.accountId) };
  }
  async victoryCredit(a: { accountId: string; amount: number }) {
    return { ok: true as const, coinsAfter: this.bal(a.accountId), credited: a.amount, capped: false };
  }
}

describe.skipIf(!mongo)('meta battle pass e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let comm: FakeCommercial;
  let token: string;
  let accountId: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    comm = new FakeCommercial();
    app = await buildApp({ cols: m.collections, jwt, internalKey: 'k', commercial: comm });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'dev-bp-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // create save record
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  it('claim before ever buying the pass or playing a ranked match → 400 (no battlePass state exists yet)', async () => {
    const r = await app.inject({ method: 'POST', url: '/battlepass/claim', headers: auth(), payload: { track: 'free', level: 1 } });
    expect(r.statusCode).toBe(400);
  });

  it('claim level-1 free-track reward (material) → save.materials incremented, not inventory.skins (free track is claimable without hasPass, only the paid track is gated)', async () => {
    comm.coins.set(accountId, 1000);
    await app.inject({ method: 'POST', url: '/battlepass/buy', headers: auth() }); // only way to lazily initialize battlePass state outside of a ranked match
    const r = body(await app.inject({ method: 'POST', url: '/battlepass/claim', headers: auth(), payload: { track: 'free', level: 1 } }));
    expect(r.ok).toBe(true);
    expect(r.data.reward).toMatchObject({ kind: 'material', id: 'scrap', count: 2 });
    expect(r.data.battlePass.claimedFree).toContain(1);
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.save.materials.scrap).toBe(2);
    expect(save.data.save.inventory.skins).not.toContain('scrap');
  });

  it('claim level-1 free-track reward twice → 409 ALREADY_CLAIMED, materials not double-granted', async () => {
    comm.coins.set(accountId, 1000);
    await app.inject({ method: 'POST', url: '/battlepass/buy', headers: auth() });
    await app.inject({ method: 'POST', url: '/battlepass/claim', headers: auth(), payload: { track: 'free', level: 1 } });
    const r = await app.inject({ method: 'POST', url: '/battlepass/claim', headers: auth(), payload: { track: 'free', level: 1 } });
    expect(r.statusCode).toBe(409);
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.save.materials.scrap).toBe(2);
  });

  it('buy pass (deducts 600 coins) then claim level-1 paid-track reward (coins) → wallet mirrors the grant', async () => {
    comm.coins.set(accountId, 1000);
    const buy = body(await app.inject({ method: 'POST', url: '/battlepass/buy', headers: auth() }));
    expect(buy.data.battlePass.hasPass).toBe(true);
    expect(comm.bal(accountId)).toBe(400); // 1000 - 600

    const r = body(await app.inject({ method: 'POST', url: '/battlepass/claim', headers: auth(), payload: { track: 'paid', level: 1 } }));
    expect(r.data.reward).toMatchObject({ kind: 'coins', count: 20 });
    expect(r.data.battlePass.claimedPaid).toContain(1);
    const save = body(await app.inject({ method: 'GET', url: '/save', headers: auth() }));
    expect(save.data.save.wallet.coins).toBe(420); // 400 + 20
  });

  it('buy pass twice → second buy 400 (already purchased)', async () => {
    comm.coins.set(accountId, 1000);
    await app.inject({ method: 'POST', url: '/battlepass/buy', headers: auth() });
    const r = await app.inject({ method: 'POST', url: '/battlepass/buy', headers: auth() });
    expect(r.statusCode).toBe(400);
  });

  it('claim a level not yet reached → 400', async () => {
    const r = await app.inject({ method: 'POST', url: '/battlepass/claim', headers: auth(), payload: { track: 'free', level: 5 } });
    expect(r.statusCode).toBe(400);
  });
});
