// Unit-style coverage backfill for src/service/inventory.ts (InventoryService: equipment craft/enhance/
// salvage/equip/reforge, cards fuse/lock/unlock, skin sell) — 2026-08-14 coverage task.
//
// Why this file exists: the underlying business logic (src/equipment/*.ts, src/cards/*.ts, src/skin.ts)
// already has thorough function-level unit coverage via equipment-craft-unit.test.ts / equipment-enhance-
// unit.test.ts / equipment-equip-unit.test.ts / equipment-reforge-unit.test.ts / equipment-salvage-unit.test.ts
// (all import directly from '../src/equipment/*.ts'), and equipment.e2e.test.ts / cards.e2e.test.ts /
// skin.e2e.test.ts exercise the same logic again through the real HTTP routes — but those three import
// `buildApp` from '../dist/app.js', so v8 coverage never attributes their execution back to
// src/service/inventory.ts (the thin HTTP wrapper layer: pulling fields off req.body, calling the
// underlying function, mapping its error code to an HTTP status via ERROR_HTTP_STATUS). This file
// imports `buildApp` from '../src/app.js' instead and re-drives one happy path + one error branch per
// handler — enough to cover every line/branch inventory.ts itself contains (the deeper business-logic
// branches are already covered elsewhere and are not the point of this file).
//
// Existing e2e test files read for scenarios/shapes/defIds: equipment.e2e.test.ts, cards.e2e.test.ts, skin.e2e.test.ts.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMongo,
  type JwtConfig,
  type MongoHandle,
  type EquipmentInstance,
  rollEnhanceSuccess,
} from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import type { CommercialClient } from '../src/commercialClient.js';
import { buildApp } from '../src/app.js';
import { seedEquipment } from './helpers/equipment.js';
import { seedCard, readCardInv } from './helpers/cards.js';

/** Minimal fake commercial client: getWallet/spend/grant are real (enhance/reforge/sellSkin touch coins). */
function makeFakeCommercial(): CommercialClient & { setCoins(id: string, n: number): void; bal(id: string): number } {
  const coins = new Map<string, number>();
  const spent = new Set<string>();
  const granted = new Set<string>();
  const bal = (id: string) => coins.get(id) ?? 0;
  return {
    available: true,
    setCoins: (id: string, n: number) => coins.set(id, n),
    bal,
    async getWallet(id: string) { return { coins: bal(id), pity: {} }; },
    async spend(a: { accountId: string; amount: number; orderId: string }) {
      if (spent.has(a.orderId)) return { ok: true as const, coinsAfter: bal(a.accountId) };
      if (bal(a.accountId) < a.amount) return { ok: false as const, error: 'INSUFFICIENT_FUNDS' };
      coins.set(a.accountId, bal(a.accountId) - a.amount);
      spent.add(a.orderId);
      return { ok: true as const, coinsAfter: bal(a.accountId) };
    },
    async grant(a: { accountId: string; amount: number; orderId: string }) {
      if (!granted.has(a.orderId)) {
        granted.add(a.orderId);
        coins.set(a.accountId, bal(a.accountId) + a.amount);
      }
      return { ok: true as const, coinsAfter: bal(a.accountId) };
    },
  } as unknown as CommercialClient & { setCoins(id: string, n: number): void; bal(id: string): number };
}

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_inventorysvc_unit_test';
const jwt: JwtConfig = { secret: 'test-secret' };
const IK = 'k';

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[inventory-service-unit] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('InventoryService handlers (src import, coverage backfill)', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let comm: ReturnType<typeof makeFakeCommercial>;
  let token: string;
  let accountId: string;

  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  const craft = (defId: string, idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/equipment/craft', headers: auth(), payload: { defId, idempotencyKey } });
  const enhance = (instanceId: string, idempotencyKey: string, useProtect?: boolean) =>
    app.inject({ method: 'POST', url: '/equipment/enhance', headers: auth(), payload: { instanceId, idempotencyKey, useProtect } });
  const salvage = (instanceIds: string[], idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/equipment/salvage', headers: auth(), payload: { instanceIds, idempotencyKey } });
  const equip = (slot: string, instanceId: string | null, cardInstanceId: string) =>
    app.inject({ method: 'POST', url: '/equipment/equip', headers: auth(), payload: { slot, instanceId, cardInstanceId } });
  const reforge = (targetId: string, materialId: string, idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/equipment/reforge', headers: auth(), payload: { targetId, materialId, idempotencyKey } });
  const fuse = (targetId: string, materialIds: string[], idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/cards/fuse', headers: auth(), payload: { targetId, materialIds, idempotencyKey } });
  const lock = (cardInstanceId: string) =>
    app.inject({ method: 'POST', url: '/cards/lock', headers: auth(), payload: { cardInstanceId } });
  const unlock = (cardInstanceId: string) =>
    app.inject({ method: 'POST', url: '/cards/unlock', headers: auth(), payload: { cardInstanceId } });
  const sellSkin = (skinId: string, idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/skins/sell', headers: auth(), payload: { skinId, idempotencyKey } });

  const seedMaterials = (mats: Record<string, number>) =>
    m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.materials': mats } });
  const seedInstance = async (id: string, defId: string, level = 0, extra: Partial<EquipmentInstance> = {}) => {
    const inst: EquipmentInstance = { id, defId, rarity: 'common', level, affixes: [], ...extra };
    await seedEquipment(m, accountId, inst);
    await m.collections.saves.updateOne({ _id: accountId }, { $inc: { 'save.equipmentInvCount': 1 } });
    return id;
  };
  const starterCardId = async () => Object.keys(await readCardInv(m, accountId))[0]!;
  const readSave = async () => (await m.collections.saves.findOne({ _id: accountId }))!.save;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    comm = makeFakeCommercial();
    app = await buildApp({ cols: m.collections, jwt, internalKey: IK, commercial: comm });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: `inv-dev-${Math.random()}` } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() });
    comm.setCoins(accountId, 100000);
  });

  afterAll(async () => {
    if (app) await app.close();
    await m.db.dropDatabase();
    await m.close();
  });

  // ── POST /equipment/craft (craftEquipment) ────────────────────────────────────────────────
  describe('POST /equipment/craft', () => {
    it('happy path: deducts materials, returns the new instance', async () => {
      await seedMaterials({ scrap: 20 });
      const r = body(await craft('wp_pencil', 'ik-craft-1'));
      expect(r.ok).toBe(true);
      expect(r.data.instance.defId).toBe('wp_pencil');
      expect(r.data.save.materials.scrap).toBe(15);
    });

    it('unknown defId -> 400 (default ERROR_HTTP_STATUS fallback, code not in the map)', async () => {
      const res = await craft('not_a_real_def', 'ik-craft-bad');
      expect(res.statusCode).toBe(400);
    });
  });

  // ── POST /equipment/enhance (enhanceEquipment) ────────────────────────────────────────────
  describe('POST /equipment/enhance', () => {
    it('happy path: success roll deducts materials/coins, level+1', async () => {
      let key = '';
      for (let i = 0; ; i++) if (rollEnhanceSuccess(`s${i}`, 0)) { key = `s${i}`; break; }
      await seedInstance('e1', 'wp_pencil', 0);
      await seedMaterials({ scrap: 100, lead: 100, binding: 100 });
      const r = body(await enhance('e1', key));
      expect(r.ok).toBe(true);
      expect(r.data.instance.level).toBe(1);
      expect(r.data.success).toBe(true);
    });

    it('non-existent instance -> 404 EQUIP_NOT_FOUND', async () => {
      const res = await enhance('ghost', 'ik-enh-bad');
      expect(res.statusCode).toBe(404);
      expect(body(res).error.code).toBe('EQUIP_NOT_FOUND');
    });
  });

  // ── POST /equipment/salvage (salvageEquipment) ────────────────────────────────────────────
  describe('POST /equipment/salvage', () => {
    it('happy path: refunds a fraction of the craft materials, removes the instance', async () => {
      await seedInstance('s1', 'wp_pencil', 0);
      await seedMaterials({ scrap: 10 });
      const r = body(await salvage(['s1'], 'ik-salv-1'));
      expect(r.ok).toBe(true);
      expect(r.data.refunded.scrap).toBeGreaterThan(0);
    });

    it('locked instance -> 409 EQUIP_LOCKED', async () => {
      await seedInstance('s-locked', 'wp_pencil', 0, { locked: true });
      const res = await salvage(['s-locked'], 'ik-salv-bad');
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('EQUIP_LOCKED');
    });
  });

  // ── POST /equipment/equip (equipEquipment) ────────────────────────────────────────────────
  describe('POST /equipment/equip', () => {
    it('happy path: equips onto a card gear slot', async () => {
      await seedInstance('w1', 'wp_pencil', 0);
      const cardId = await starterCardId();
      const r = body(await equip('weapon', 'w1', cardId));
      expect(r.ok).toBe(true);
      expect(r.data.save.cardInv[cardId].gear.weapon).toBe('w1');
    });

    it('non-existent instance -> 404 EQUIP_NOT_FOUND', async () => {
      const cardId = await starterCardId();
      const res = await equip('weapon', 'ghost', cardId);
      expect(res.statusCode).toBe(404);
      expect(body(res).error.code).toBe('EQUIP_NOT_FOUND');
    });
  });

  // ── POST /equipment/reforge (reforgeEquipment) ────────────────────────────────────────────
  describe('POST /equipment/reforge', () => {
    it('happy path: re-rolls the target, consumes the material, deducts coins', async () => {
      await seedInstance('rt0', 'wp_pen', 0, { rarity: 'fine' });
      await seedInstance('rm0', 'wp_pencil', 0, { rarity: 'common' });
      const before = comm.bal(accountId);
      const res = await reforge('rt0', 'rm0', 'ik-reforge-1');
      expect(res.statusCode).toBe(200);
      expect(comm.bal(accountId)).toBeLessThan(before);
    });

    it('locked material -> 409 EQUIP_LOCKED', async () => {
      await seedInstance('rt1', 'wp_pen', 0, { rarity: 'fine' });
      await seedInstance('rm1', 'wp_pencil', 0, { rarity: 'common', locked: true });
      const res = await reforge('rt1', 'rm1', 'ik-reforge-bad');
      expect(res.statusCode).toBe(409);
      expect(body(res).error.code).toBe('EQUIP_LOCKED');
    });
  });

  // ── POST /cards/fuse (fuseCards) ──────────────────────────────────────────────────────────
  describe('POST /cards/fuse', () => {
    async function seedFiveMaterials(): Promise<{ targetId: string; materialIds: string[] }> {
      const inv = await readCardInv(m, accountId);
      const taoCards = Object.values(inv); // starter cards are all 'tao' faction
      const targetId = taoCards[0]!.id;
      const existingMaterials = taoCards.slice(1).map((c) => c.id);
      const extraIds = ['seed_m1', 'seed_m2', 'seed_m3'];
      for (const id of extraIds) await seedCard(m, accountId, { id, defId: 'lichuang', level: 1, gear: {}, locked: false });
      return { targetId, materialIds: [...existingMaterials, ...extraIds] };
    }

    it('happy path: consumes 5 materials, raises the target one level', async () => {
      const { targetId, materialIds } = await seedFiveMaterials();
      const r = body(await fuse(targetId, materialIds, 'ik-fuse-1'));
      expect(r.ok).toBe(true);
      expect(r.data.card.id).toBe(targetId);
    });

    it('wrong material count -> 400 BAD_REQUEST', async () => {
      const { targetId, materialIds } = await seedFiveMaterials();
      const res = await fuse(targetId, materialIds.slice(0, 2), 'ik-fuse-bad');
      expect(res.statusCode).toBe(400);
    });
  });

  // ── POST /cards/lock / /cards/unlock (setCardLock) ────────────────────────────────────────
  describe('POST /cards/lock and /cards/unlock', () => {
    it('lock happy path: locked flag set on the card', async () => {
      const cardId = await starterCardId();
      const r = body(await lock(cardId));
      expect(r.ok).toBe(true);
      expect((await readCardInv(m, accountId))[cardId]!.locked).toBe(true);
    });

    it('unlock happy path: locked flag cleared', async () => {
      const cardId = await starterCardId();
      await lock(cardId);
      const r = body(await unlock(cardId));
      expect(r.ok).toBe(true);
      expect((await readCardInv(m, accountId))[cardId]!.locked).toBe(false);
    });

    it('lock unknown card -> 404 CARD_NOT_FOUND', async () => {
      const res = await lock('ghost-card');
      expect(res.statusCode).toBe(404);
      expect(body(res).error.code).toBe('CARD_NOT_FOUND');
    });

    it('unlock unknown card -> 404 CARD_NOT_FOUND', async () => {
      const res = await unlock('ghost-card');
      expect(res.statusCode).toBe(404);
      expect(body(res).error.code).toBe('CARD_NOT_FOUND');
    });
  });

  // ── POST /skins/sell (sellSkinToSystem) ───────────────────────────────────────────────────
  describe('POST /skins/sell', () => {
    it('happy path: sells a surplus skin instance for coins', async () => {
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.inventory.skins': ['skin_l1'] } });
      await m.collections.skinInstances.insertMany([
        { _id: 'sk_1', accountId, skinId: 'skin_l1', sourceType: 'test' },
        { _id: 'sk_2', accountId, skinId: 'skin_l1', sourceType: 'test' },
      ]);
      const before = comm.bal(accountId);
      const r = body(await sellSkin('skin_l1', 'ik-sell-1'));
      expect(r.ok).toBe(true);
      expect(r.data.credited).toBeGreaterThan(0);
      expect(comm.bal(accountId)).toBe(before + r.data.credited);
    });

    it('skin not owned -> 404 SKIN_NOT_FOUND', async () => {
      const res = await sellSkin('skin_never_owned', 'ik-sell-bad');
      expect(res.statusCode).toBe(404);
      expect(body(res).error.code).toBe('SKIN_NOT_FOUND');
    });
  });
});
