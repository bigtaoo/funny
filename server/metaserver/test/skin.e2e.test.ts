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

/** Fake commercial with a working, orderId-idempotent `grant()` — for sellSkin's coin-credit tests. */
function makeFakeCommercialWithWallet(): CommercialClient & { coins: Map<string, number>; grantedOrders: Set<string> } {
  const coins = new Map<string, number>();
  const grantedOrders = new Set<string>();
  return {
    available: true,
    coins,
    grantedOrders,
    async getWallet(accountId: string) { return { coins: coins.get(accountId) ?? 0 } as never; },
    async spend() { return { ok: false as const, error: 'NOT_IMPLEMENTED' }; },
    async grant(a: { accountId: string; amount: number; orderId: string }) {
      if (!grantedOrders.has(a.orderId)) {
        grantedOrders.add(a.orderId);
        coins.set(a.accountId, (coins.get(a.accountId) ?? 0) + a.amount);
      }
      return { ok: true as const, coinsAfter: coins.get(a.accountId) ?? 0 };
    },
  } as unknown as CommercialClient & { coins: Map<string, number>; grantedOrders: Set<string> };
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
  /** Seeds N real skinInstances rows for `skinId` (ITEM_IDENTITY_DESIGN.md task1) — use alongside seedSkins
   *  to test duplicate-aware behavior; without this, escrow/sell fall back to the legacy self-heal path
   *  (effectiveCount=1, exercised by the pre-existing tests above). */
  const seedSkinInstances = (skinId: string, count: number) =>
    m.collections.skinInstances.insertMany(
      Array.from({ length: count }, (_, i) => ({ _id: `test_${skinId}_${i}`, accountId, skinId, sourceType: 'test' })),
    );

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

  it('grant: writes skinId back to target inventory.skins, and mints a real skinInstances row (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08 — not just a Set membership flip)', async () => {
    await seedSkins([]);
    const buyer = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'skin-buyer' } }));
    await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${buyer.data.token}` } });
    const gr = body(await grant('skin_ink_blue', 'order1:item', buyer.data.accountId));
    expect(gr.ok).toBe(true);
    const buyerSave = (await m.collections.saves.findOne({ _id: buyer.data.accountId }))!.save;
    expect(buyerSave.inventory.skins).toContain('skin_ink_blue');
    expect(await m.collections.skinInstances.countDocuments({ accountId: buyer.data.accountId, skinId: 'skin_ink_blue' })).toBe(1);
  });

  it('grant: buying the same skinId twice (two trades, two orderIds) stacks two real instances — a trade transfer is fungible, not deduped like the old Set-only model', async () => {
    await seedSkins([]);
    const buyer = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'skin-buyer-2' } }));
    await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${buyer.data.token}` } });
    await grant('skin_ink_blue', 'trade-1', buyer.data.accountId);
    await grant('skin_ink_blue', 'trade-2', buyer.data.accountId);
    const buyerSave = (await m.collections.saves.findOne({ _id: buyer.data.accountId }))!.save;
    expect(buyerSave.inventory.skins.filter((id: string) => id === 'skin_ink_blue')).toHaveLength(1); // still a dedup set
    expect(await m.collections.skinInstances.countDocuments({ accountId: buyer.data.accountId, skinId: 'skin_ink_blue' })).toBe(2);
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

  // ITEM_IDENTITY_DESIGN.md task1 (2026-08-08): a duplicate copy of an equipped skin must be
  // escrowable/sellable — only the LAST remaining copy of a currently-equipped skin is protected.
  it('escrow a surplus copy of an equipped skin succeeds (only the last copy is protected)', async () => {
    await seedSkins(['skin_ink_blue']);
    await seedEquipped({ notebook: 'skin_ink_blue' });
    await seedSkinInstances('skin_ink_blue', 2); // owns 2 real instances, one "equipped"
    const r1 = body(await escrow('skin_ink_blue', 'order-surplus'));
    expect(r1.ok).toBe(true);
    // Still owned (1 instance remains) — inventory.skins membership is unaffected.
    expect((await readSave()).inventory.skins).toContain('skin_ink_blue');
    expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_ink_blue' })).toBe(1);
    // The last remaining copy is still equipped → now blocked.
    const r2 = await escrow('skin_ink_blue', 'order-last');
    expect(r2.statusCode).toBe(409);
    expect(body(r2).code).toBe('SKIN_IN_USE');
  });
});

describe.skipIf(!mongo)('sellSkinToSystem (ITEM_IDENTITY_DESIGN.md task1) e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  let accountId: string;
  let comm: ReturnType<typeof makeFakeCommercialWithWallet>;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  const sell = (skinId: string, idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/skins/sell', headers: auth(), payload: { skinId, idempotencyKey } });
  const seedSkins = (skins: string[]) => m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.inventory.skins': skins } });
  const seedEquipped = (equipped: Record<string, string>) => m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.equipped': equipped } });
  const seedSkinInstances = (skinId: string, count: number) =>
    m.collections.skinInstances.insertMany(
      Array.from({ length: count }, (_, i) => ({ _id: `sell_${skinId}_${i}`, accountId, skinId, sourceType: 'test' })),
    );
  const readSave = async () => (await m.collections.saves.findOne({ _id: accountId }))!.save;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    comm = makeFakeCommercialWithWallet();
    app = await buildApp({ cols: m.collections, jwt, internalKey: IK, commercial: comm });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'sell-dev-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() });
  });
  afterAll(async () => { if (app) await app.close(); });

  it('happy path: sells one surplus legendary skin instance for DUPE_REFUND_COINS.legendary (1500) coins, never automatic', async () => {
    await seedSkins(['skin_l1']);
    await seedSkinInstances('skin_l1', 2);
    const r = body(await sell('skin_l1', 'sell-order-1'));
    expect(r.ok).toBe(true);
    expect(r.data.credited).toBe(1500);
    expect(r.data.coinsAfter).toBe(1500);
    expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_l1' })).toBe(1);
    expect((await readSave()).inventory.skins).toContain('skin_l1'); // one copy still owned
  });

  it('selling the only copy removes it from inventory.skins entirely', async () => {
    await seedSkins(['skin_l1']);
    await seedSkinInstances('skin_l1', 1);
    await sell('skin_l1', 'sell-order-solo');
    expect((await readSave()).inventory.skins).not.toContain('skin_l1');
  });

  it('refuses to sell the last remaining instance of a currently-equipped skin → 409 SKIN_IN_USE', async () => {
    await seedSkins(['skin_l1']);
    await seedSkinInstances('skin_l1', 1);
    await seedEquipped({ notebook: 'skin_l1' });
    const res = await sell('skin_l1', 'sell-order-worn');
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('SKIN_IN_USE');
    expect(comm.coins.get(accountId) ?? 0).toBe(0); // rejected before any credit
  });

  it('allows selling a surplus copy of an equipped skin (only the last copy is protected)', async () => {
    await seedSkins(['skin_l1']);
    await seedSkinInstances('skin_l1', 2);
    await seedEquipped({ notebook: 'skin_l1' });
    const r = body(await sell('skin_l1', 'sell-order-surplus'));
    expect(r.ok).toBe(true);
    expect(r.data.credited).toBe(1500);
  });

  it('not owned → 404 SKIN_NOT_FOUND', async () => {
    await seedSkins([]);
    const res = await sell('skin_ghost', 'sell-order-ghost');
    expect(res.statusCode).toBe(404);
    expect(body(res).error.code).toBe('SKIN_NOT_FOUND');
  });

  it('idempotent: replaying the same idempotencyKey does not double-sell or double-credit', async () => {
    await seedSkins(['skin_l1']);
    await seedSkinInstances('skin_l1', 2);
    const r1 = body(await sell('skin_l1', 'sell-order-dup'));
    const r2 = body(await sell('skin_l1', 'sell-order-dup'));
    expect(r2.data.credited).toBe(r1.data.credited);
    expect(r2.data.coinsAfter).toBe(r1.data.coinsAfter);
    expect(comm.coins.get(accountId)).toBe(1500); // credited exactly once, not 3000
    expect(await m.collections.skinInstances.countDocuments({ accountId, skinId: 'skin_l1' })).toBe(1); // removed exactly once
  });

  it('rarity-scaled payout: common skin sells for DUPE_REFUND_COINS.common (10 coins)', async () => {
    await seedSkins(['skin_shop_c1']); // common-rarity catalogue skin (GACHA_CATALOG)
    await seedSkinInstances('skin_shop_c1', 2);
    const r = body(await sell('skin_shop_c1', 'sell-order-common'));
    expect(r.data.credited).toBe(10);
  });
});
