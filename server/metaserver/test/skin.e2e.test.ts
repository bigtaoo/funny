// Skin escrow/grant backend end-to-end (auction task2, AUCTION_DESIGN §2.1/§9):
//   Internal /internal/skins/{escrow,grant} (auction escrow/transfer; owned/equipped checks, idempotent).
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createMongo, type JwtConfig, type MongoHandle } from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import type { CommercialClient } from '../dist/commercialClient.js';
import { buildApp } from '../dist/app.js';

function makeFakeCommercial(): CommercialClient {
  return {
    available: false,
    async getWallet() { return null; },
    async spend() { return { ok: false as const, error: 'NOT_IMPLEMENTED' }; },
  } as unknown as CommercialClient;
}

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_skin_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const IK = 'k'; // internalKey

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}
const mongo = await tryConnect();
if (!mongo) console.warn(`[skin.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('skin escrow/grant backend e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  let accountId: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  const escrow = (skinId: string, orderId: string, account = accountId) =>
    app.inject({ method: 'POST', url: '/internal/skins/escrow', headers: { 'x-internal-key': IK }, payload: { accountId: account, skinId, orderId } });
  const grant = (skinId: string, orderId: string, account = accountId) =>
    app.inject({ method: 'POST', url: '/internal/skins/grant', headers: { 'x-internal-key': IK }, payload: { accountId: account, skinId, orderId } });

  const seedSkins = (skins: string[]) => m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.inventory.skins': skins } });
  const seedEquipped = (equipped: Record<string, string>) => m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.equipped': equipped } });
  const readSave = async () => (await m.collections.saves.findOne({ _id: accountId }))!.save;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: IK, commercial: makeFakeCommercial() });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'skin-dev-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // create save file
  });
  afterAll(async () => { if (app) await app.close(); });

  it('escrow: removes skinId from inventory.skins', async () => {
    await seedSkins(['skin_ink_blue', 'skin_ink_red']);
    const r = body(await escrow('skin_ink_blue', 'order1'));
    expect(r.ok).toBe(true);
    expect(r.skinId).toBe('skin_ink_blue');
    expect((await readSave()).inventory.skins).toEqual(['skin_ink_red']);
  });

  it('grant: writes skinId back to target inventory.skins', async () => {
    await seedSkins([]);
    const buyer = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'skin-buyer' } }));
    await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${buyer.data.token}` } });
    const gr = body(await grant('skin_ink_blue', 'order1:item', buyer.data.accountId));
    expect(gr.ok).toBe(true);
    const buyerSave = (await m.collections.saves.findOne({ _id: buyer.data.accountId }))!.save;
    expect(buyerSave.inventory.skins).toContain('skin_ink_blue');
  });

  it('escrow idempotency: replaying the same orderId returns the same result (no double-removal side effects)', async () => {
    await seedSkins(['skin_ink_blue']);
    const e1 = body(await escrow('skin_ink_blue', 'orderX'));
    const e2 = body(await escrow('skin_ink_blue', 'orderX')); // already removed, but orderId replay
    expect(e2.ok).toBe(true);
    expect(e2.skinId).toBe(e1.skinId);
  });

  it('grant idempotency: re-granting an already-owned skin is a no-op (no duplicate entries)', async () => {
    await seedSkins(['skin_ink_blue']);
    await grant('skin_ink_blue', 'gorder');
    const save = await readSave();
    expect(save.inventory.skins.filter((id) => id === 'skin_ink_blue')).toHaveLength(1);
  });

  it('escrow not owned → 404 SKIN_NOT_FOUND', async () => {
    await seedSkins([]);
    const res = await escrow('skin_ghost', 'order-ghost');
    expect(res.statusCode).toBe(404);
    expect(body(res).code).toBe('SKIN_NOT_FOUND');
  });

  it('escrow equipped skin → 409 SKIN_IN_USE', async () => {
    await seedSkins(['skin_ink_blue']);
    await seedEquipped({ notebook: 'skin_ink_blue' });
    const res = await escrow('skin_ink_blue', 'order-worn');
    expect(res.statusCode).toBe(409);
    expect(body(res).code).toBe('SKIN_IN_USE');
  });
});
