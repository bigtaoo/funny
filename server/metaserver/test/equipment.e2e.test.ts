// Equipment inventory backend end-to-end (E2/E3/E4, EQUIPMENT_DESIGN §4/§6/§18):
//   Player POST /equipment/craft (deduct materials → roll → insert into inventory; idempotent, insufficient materials, full inventory)
//   Player POST /equipment/enhance (server-side dice roll → deduct materials + coins → on success level+1; idempotent, max level, insufficient)
//   Player POST /equipment/salvage (+0~4 returns 70% materials and removes; +5/equipped/locked rejected; batch, idempotent)
//   Player POST /equipment/equip (equip/unequip, slot validation, global/byUnit)
//   Player POST /equipment/reforge (E6, EQUIPMENT_DESIGN §7.8: material slot/rarity/level validation)
//   Internal /internal/equipment/{escrow,grant} (worldsvc auction escrow/transfer; equipped/locked rejected, idempotent)
// Requires `cd server && docker compose up -d` + `tsc -b` first (imports from dist).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMongo,
  type JwtConfig,
  type MongoHandle,
  type EquipmentInstance,
  EQUIPMENT_INV_CAP,
  rollEnhanceSuccess,
  enhanceCost,
  salvageRefund,
} from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import type { CommercialClient } from '../dist/commercialClient.js';
import { buildApp } from '../dist/app.js';

/** Minimal fake commercial client: only getWallet/spend are real (enhance uses coins); everything else is stubbed. */
function makeFakeCommercial(): CommercialClient & {
  setCoins(id: string, n: number): void;
  bal(id: string): number;
} {
  const coins = new Map<string, number>();
  const spent = new Set<string>();
  const bal = (id: string) => coins.get(id) ?? 0;
  return {
    available: true,
    setCoins: (id: string, n: number) => coins.set(id, n),
    bal,
    async getWallet(id: string) {
      return { coins: bal(id), pity: {} };
    },
    async spend(a: { accountId: string; amount: number; reason: string; orderId: string }) {
      if (spent.has(a.orderId)) return { ok: true as const, coinsAfter: bal(a.accountId) };
      if (bal(a.accountId) < a.amount) return { ok: false as const, error: 'INSUFFICIENT_FUNDS' };
      coins.set(a.accountId, bal(a.accountId) - a.amount);
      spent.add(a.orderId);
      return { ok: true as const, coinsAfter: bal(a.accountId) };
    },
  } as unknown as CommercialClient & { setCoins(id: string, n: number): void; bal(id: string): number };
}

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_equipment_test';
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
if (!mongo) console.warn(`[equipment.e2e] Mongo unreachable (${URI}) — skipping.`);

describe.skipIf(!mongo)('equipment backend e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let comm: ReturnType<typeof makeFakeCommercial>;
  let token: string;
  let accountId: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  const craft = (defId: string, idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/equipment/craft', headers: auth(), payload: { defId, idempotencyKey } });
  const enhance = (instanceId: string, idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/equipment/enhance', headers: auth(), payload: { instanceId, idempotencyKey } });
  const salvage = (instanceIds: string[], idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/equipment/salvage', headers: auth(), payload: { instanceIds, idempotencyKey } });
  const equip = (slot: string, instanceId: string | null, cardInstanceId: string) =>
    app.inject({ method: 'POST', url: '/equipment/equip', headers: auth(), payload: { slot, instanceId, cardInstanceId } });
  const reforge = (targetId: string, materialId: string, idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/equipment/reforge', headers: auth(), payload: { targetId, materialId, idempotencyKey } });
  const escrow = (instanceId: string, orderId: string, account = accountId) =>
    app.inject({ method: 'POST', url: '/internal/equipment/escrow', headers: { 'x-internal-key': IK }, payload: { accountId: account, instanceId, orderId } });
  const grant = (instance: EquipmentInstance, orderId: string, account = accountId) =>
    app.inject({ method: 'POST', url: '/internal/equipment/grant', headers: { 'x-internal-key': IK }, payload: { accountId: account, instance, orderId } });

  const seedMaterials = (mats: Record<string, number>) =>
    m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.materials': mats } });
  /** Directly seed one equipment instance into inventory (with specified level/locked), returning its id. */
  const seedInstance = async (id: string, defId: string, level = 0, extra: Partial<EquipmentInstance> = {}) => {
    const inst: EquipmentInstance = { id, defId, rarity: 'common', level, affixes: [], ...extra };
    await m.collections.saves.updateOne({ _id: accountId }, { $set: { [`save.equipmentInv.${id}`]: inst } });
    return id;
  };
  const readSave = async () => (await m.collections.saves.findOne({ _id: accountId }))!.save;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    comm = makeFakeCommercial();
    app = await buildApp({ cols: m.collections, jwt, internalKey: IK, commercial: comm });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'eq-dev-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // create save file
    comm.setCoins(accountId, 100000); // plenty of coins so enhance is not blocked by coins (individual tests that need low coins set their own amount)
  });
  afterAll(async () => { if (app) await app.close(); });

  // ── E2 Crafting ─────────────────────────────────────────────────────────────────
  it('craft success: deduct materials + insert into inventory + primary affix', async () => {
    await seedMaterials({ scrap: 20 });
    const r = body(await craft('wp_pencil', 'ik1')); // common, recipe scrap:5, 0 secondary affixes
    expect(r.data.instance.defId).toBe('wp_pencil');
    expect(r.data.instance.level).toBe(0);
    expect(r.data.instance.rarity).toBe('common');
    expect(r.data.instance.affixes).toHaveLength(1); // primary affix only
    expect(r.data.instance.affixes[0].id).toBe('m_atk');
    expect(r.data.save.materials.scrap).toBe(15); // 20-5 = 15
    expect(r.data.save.equipmentInv[r.data.instance.id]).toBeTruthy();
  });

  it('craft rarity secondary affixes: wp_pen (fine) rolls 1 secondary affix', async () => {
    await seedMaterials({ scrap: 20, lead: 10 });
    const r = body(await craft('wp_pen', 'ik2')); // fine, recipe scrap:8 lead:2, 1 secondary affix
    expect(r.data.instance.affixes.length).toBe(2); // primary + 1 secondary
    expect(r.data.instance.affixes.some((a: { id: string }) => a.id.startsWith('s_'))).toBe(true);
    expect(r.data.save.materials.scrap).toBe(12);
    expect(r.data.save.materials.lead).toBe(8);
  });

  it('craft insufficient materials → 402', async () => {
    await seedMaterials({ scrap: 2 });
    const res = await craft('wp_pencil', 'ik3');
    expect(res.statusCode).toBe(402);
    expect(body(res).error.code).toBe('INSUFFICIENT_MATERIALS');
  });

  it('craft idempotency: replaying with the same idempotencyKey does not deduct materials again and returns the same instance', async () => {
    await seedMaterials({ scrap: 20 });
    const r1 = body(await craft('wp_pencil', 'dup-key'));
    const r2 = body(await craft('wp_pencil', 'dup-key'));
    expect(r2.data.instance.id).toBe(r1.data.instance.id); // same instance
    const save = await readSave();
    expect(save.materials.scrap).toBe(15); // deducted only once
    expect(Object.keys(save.equipmentInv)).toHaveLength(1); // only one item produced
  });

  it('craft full inventory → 409 INVENTORY_FULL', async () => {
    await seedMaterials({ scrap: 20 });
    // Directly seed 300 placeholder instances to fill the inventory
    const full: Record<string, EquipmentInstance> = {};
    for (let i = 0; i < EQUIPMENT_INV_CAP; i++) {
      full[`fill_${i}`] = { id: `fill_${i}`, defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] };
    }
    await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.equipmentInv': full } });
    const res = await craft('wp_pencil', 'ik-full');
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('INVENTORY_FULL');
  });

  it('craft unknown defId → 400', async () => {
    const res = await craft('nope', 'ik-bad');
    expect(res.statusCode).toBe(400);
  });

  // ── Internal escrow / transfer (worldsvc auction) ────────────────────────────────────────────
  it('escrow: remove from seller inventory + return snapshot; grant: write to target inventory', async () => {
    await seedMaterials({ scrap: 20 });
    const inst = body(await craft('wp_pencil', 'ik-e1')).data.instance as EquipmentInstance;
    // escrow: remove from inventory
    const er = body(await escrow(inst.id, 'order1'));
    expect(er.ok).toBe(true);
    expect(er.instance.id).toBe(inst.id);
    expect((await readSave()).equipmentInv[inst.id]).toBeUndefined(); // already removed
    // transfer to buyer (a separate account)
    const buyer = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'eq-buyer' } }));
    await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${buyer.data.token}` } });
    const gr = body(await grant(er.instance, 'order1:item', buyer.data.accountId));
    expect(gr.ok).toBe(true);
    const buyerSave = (await m.collections.saves.findOne({ _id: buyer.data.accountId }))!.save;
    expect(buyerSave.equipmentInv[inst.id]).toMatchObject({ id: inst.id, defId: 'wp_pencil' });
  });

  it('escrow idempotency: replaying with the same orderId returns the same snapshot (no double-removal)', async () => {
    await seedMaterials({ scrap: 20 });
    const inst = body(await craft('wp_pencil', 'ik-e2')).data.instance as EquipmentInstance;
    const e1 = body(await escrow(inst.id, 'orderX'));
    const e2 = body(await escrow(inst.id, 'orderX')); // instance already removed, but orderId replay
    expect(e2.ok).toBe(true);
    expect(e2.instance.id).toBe(e1.instance.id);
  });

  it('escrow non-existent instance → 404 EQUIP_NOT_FOUND', async () => {
    const res = await escrow('ghost', 'order-ghost');
    expect(res.statusCode).toBe(404);
    expect(body(res).code).toBe('EQUIP_NOT_FOUND');
  });

  it('escrow locked instance → 409 EQUIP_LOCKED', async () => {
    await m.collections.saves.updateOne(
      { _id: accountId },
      { $set: { 'save.equipmentInv.locked1': { id: 'locked1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [], locked: true } } },
    );
    const res = await escrow('locked1', 'order-locked');
    expect(res.statusCode).toBe(409);
    expect(body(res).code).toBe('EQUIP_LOCKED');
  });

  it('escrow equipped instance → 409 EQUIP_IN_USE', async () => {
    // CC-2: equipped state lives in cardInv[].gear (not the deprecated save.gear.global). Equip via the real flow.
    await seedInstance('worn1', 'wp_pencil', 0);
    await equip('weapon', 'worn1', await starterCardId());
    const res = await escrow('worn1', 'order-worn');
    expect(res.statusCode).toBe(409);
    expect(body(res).code).toBe('EQUIP_IN_USE');
  });

  it('grant idempotency: re-sending the same instance results in only one item (overwritten by id)', async () => {
    const inst: EquipmentInstance = { id: 'g1', defId: 'wp_marker', rarity: 'rare', level: 2, affixes: [{ id: 'm_atk', value: 8 }] };
    await grant(inst, 'gorder');
    await grant(inst, 'gorder');
    const save = await readSave();
    expect(save.equipmentInv['g1']).toMatchObject({ level: 2 });
    expect(Object.keys(save.equipmentInv).filter((k) => k === 'g1')).toHaveLength(1);
  });

  // ── E3 Enhancement ───────────────────────────────────────────────────────────────────
  it('enhance success: level+1, deduct materials + coins', async () => {
    // Find an idemKey that guarantees success at level 0 (deterministic dice roll).
    let key = '';
    for (let i = 0; ; i++) if (rollEnhanceSuccess(`s${i}`, 0)) { key = `s${i}`; break; }
    await seedInstance('e1', 'wp_pencil', 0);
    await seedMaterials({ scrap: 100, lead: 100, binding: 100 });
    comm.setCoins(accountId, 1000);
    const cost = enhanceCost(0); // { scrap: 4, coins: 40 }
    const r = body(await enhance('e1', key));
    expect(r.data.success).toBe(true);
    expect(r.data.instance.level).toBe(1);
    expect(r.data.save.materials.scrap).toBe(100 - cost.materials.scrap);
    expect(r.data.save.wallet.coins).toBe(1000 - cost.coins);
    expect(comm.bal(accountId)).toBe(1000 - cost.coins);
  });

  it('enhance failure: level unchanged, materials + coins still deducted (gentle tier: no level loss, no break)', async () => {
    let key = '';
    for (let i = 0; ; i++) if (!rollEnhanceSuccess(`f${i}`, 0)) { key = `f${i}`; break; }
    await seedInstance('e2', 'wp_pencil', 0);
    await seedMaterials({ scrap: 100 });
    comm.setCoins(accountId, 1000);
    const cost = enhanceCost(0);
    const r = body(await enhance('e2', key));
    expect(r.data.success).toBe(false);
    expect(r.data.instance.level).toBe(0); // no level loss
    expect(r.data.save.materials.scrap).toBe(100 - cost.materials.scrap); // still consumed
    expect(r.data.save.wallet.coins).toBe(1000 - cost.coins);
  });

  it('enhance idempotency: replaying with the same key does not deduct again or re-roll; result is consistent', async () => {
    await seedInstance('e3', 'wp_pencil', 0);
    await seedMaterials({ scrap: 100 });
    comm.setCoins(accountId, 1000);
    const r1 = body(await enhance('e3', 'dup-enh'));
    const r2 = body(await enhance('e3', 'dup-enh'));
    expect(r2.data.success).toBe(r1.data.success);
    expect(r2.data.instance.level).toBe(r1.data.instance.level);
    const save = await readSave();
    expect(save.materials.scrap).toBe(100 - enhanceCost(0).materials.scrap); // deducted only once
    expect(comm.bal(accountId)).toBe(1000 - enhanceCost(0).coins); // coins deducted only once
  });

  it('enhance at max level → 409 ENHANCE_MAX_LEVEL', async () => {
    await seedInstance('e9', 'wp_pencil', 9);
    await seedMaterials({ scrap: 100 });
    const res = await enhance('e9', 'ek-max');
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('ENHANCE_MAX_LEVEL');
  });

  it('enhance insufficient materials → 402, state and coins unchanged', async () => {
    await seedInstance('e4', 'wp_pencil', 0);
    await seedMaterials({ scrap: 1 });
    comm.setCoins(accountId, 1000);
    const res = await enhance('e4', 'ek-nomat');
    expect(res.statusCode).toBe(402);
    expect(body(res).error.code).toBe('INSUFFICIENT_MATERIALS');
    expect((await readSave()).equipmentInv['e4'].level).toBe(0);
    expect(comm.bal(accountId)).toBe(1000); // coins untouched
  });

  it('enhance insufficient coins → 402 INSUFFICIENT_FUNDS, materials not deducted', async () => {
    await seedInstance('e5', 'wp_pencil', 0);
    await seedMaterials({ scrap: 100 });
    comm.setCoins(accountId, 10); // less than the required 40
    const res = await enhance('e5', 'ek-nocoin');
    expect(res.statusCode).toBe(402);
    expect(body(res).error.code).toBe('INSUFFICIENT_FUNDS');
    expect((await readSave()).materials.scrap).toBe(100); // materials untouched
  });

  it('enhance non-existent instance → 404', async () => {
    const res = await enhance('ghost', 'ek-ghost');
    expect(res.statusCode).toBe(404);
    expect(body(res).error.code).toBe('EQUIP_NOT_FOUND');
  });

  // ── E3 Salvage ───────────────────────────────────────────────────────────────────
  it('salvage: return 70% craft materials + remove from inventory', async () => {
    await seedInstance('s1', 'wp_pencil', 0); // craftCost scrap:5 → refund floor(3.5)=3
    await seedMaterials({ scrap: 10 });
    const refund = salvageRefund('wp_pencil'); // { scrap:3 }
    const r = body(await salvage(['s1'], 'sk1'));
    expect(r.data.refunded).toEqual(refund);
    expect(r.data.save.materials.scrap).toBe(10 + refund.scrap);
    expect(r.data.save.equipmentInv['s1']).toBeUndefined();
  });

  it('salvage batch: total refund across all items', async () => {
    await seedInstance('s2', 'wp_pencil', 1);
    await seedInstance('s3', 'wp_pencil', 4);
    await seedMaterials({ scrap: 0 });
    const r = body(await salvage(['s2', 's3'], 'sk-batch'));
    expect(r.data.refunded.scrap).toBe(salvageRefund('wp_pencil').scrap * 2);
    const save = await readSave();
    expect(save.equipmentInv['s2']).toBeUndefined();
    expect(save.equipmentInv['s3']).toBeUndefined();
  });

  it('salvage +5 and above → 409 NOT_SALVAGEABLE (whole batch rejected, no partial execution)', async () => {
    await seedInstance('s4', 'wp_pencil', 0);
    await seedInstance('s5', 'wp_pencil', 5);
    const res = await salvage(['s4', 's5'], 'sk-hi');
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('NOT_SALVAGEABLE');
    expect((await readSave()).equipmentInv['s4']).toBeTruthy(); // whole batch not executed
  });

  it('salvage locked → 409 EQUIP_LOCKED; equipped → 409 EQUIP_IN_USE', async () => {
    await seedInstance('sl', 'wp_pencil', 0, { locked: true });
    expect((await salvage(['sl'], 'sk-lock')).statusCode).toBe(409);
    expect(body(await salvage(['sl'], 'sk-lock2')).error.code).toBe('EQUIP_LOCKED');

    await seedInstance('sw', 'wp_pencil', 0);
    await equip('weapon', 'sw', await starterCardId()); // CC-2: equip via cardInv[].gear, not deprecated save.gear.global
    expect(body(await salvage(['sw'], 'sk-worn')).error.code).toBe('EQUIP_IN_USE');
  });

  it('salvage idempotency: replaying with the same key does not refund twice', async () => {
    await seedInstance('s6', 'wp_pencil', 0);
    await seedMaterials({ scrap: 0 });
    await salvage(['s6'], 'sk-dup');
    const r2 = body(await salvage(['s6'], 'sk-dup'));
    expect(r2.data.refunded.scrap).toBe(salvageRefund('wp_pencil').scrap);
    expect((await readSave()).materials.scrap).toBe(salvageRefund('wp_pencil').scrap); // refunded only once
  });

  // ── E4 Equip (CC-2: gear now lives in CardInstance.gear[slot]) ────────────────────────────
  /** Return the first card instance id from the starter roster (granted on account creation). */
  const starterCardId = async () => {
    const s = await readSave();
    return Object.keys(s.cardInv ?? {})[0]!;
  };

  it('equip: equip → CardInstance.gear[slot]; unequip → removed', async () => {
    await seedInstance('w1', 'wp_pencil', 0); // weapon slot
    const cardId = await starterCardId();
    const r = body(await equip('weapon', 'w1', cardId));
    expect(r.data.save.cardInv[cardId].gear.weapon).toBe('w1');
    const r2 = body(await equip('weapon', null, cardId));
    expect(r2.data.save.cardInv[cardId].gear.weapon).toBeUndefined();
  });

  it('equip slot mismatch → 400 INVALID_SLOT', async () => {
    await seedInstance('w2', 'wp_pencil', 0); // weapon equipment
    const cardId = await starterCardId();
    const res = await equip('armor', 'w2', cardId); // weapon equipment into armor slot
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe('INVALID_SLOT');
  });

  it('equip invalid slot name → 400 (openapi enum validation intercepts at contract layer first)', async () => {
    const cardId = await starterCardId();
    const res = await equip('helmet', null, cardId);
    expect(res.statusCode).toBe(400); // slot enum=[weapon,armor,trinket] validation fails → BAD_REQUEST
  });

  it('equip non-existent instance → 404', async () => {
    const cardId = await starterCardId();
    const res = await equip('weapon', 'nope', cardId);
    expect(res.statusCode).toBe(404);
    expect(body(res).error.code).toBe('EQUIP_NOT_FOUND');
  });

  it('equip card not found → 404', async () => {
    await seedInstance('w3', 'wp_pencil', 0);
    const res = await equip('weapon', 'w3', 'card_does_not_exist');
    expect(res.statusCode).toBe(404);
    expect(body(res).error.code).toBe('NOT_FOUND'); // equipEquipment emits generic NOT_FOUND for a missing card (no CARD_NOT_FOUND code exists)
  });

  it('equip equipped instance cannot be salvaged (EQUIP_IN_USE)', async () => {
    await seedInstance('w4', 'wp_pencil', 0);
    const cardId = await starterCardId();
    await equip('weapon', 'w4', cardId);
    expect(body(await salvage(['w4'], 'sk-equipped')).error.code).toBe('EQUIP_IN_USE');
  });

  // ── E6 Reforge ───────────────────────────────────────────────────────────────────
  it('reforge rejects an already-enhanced material → 400 INVALID_MATERIAL_LEVEL (client restricts the picker to +0, but a direct API call must be rejected too so sunk enhance materials/rolls cannot be destroyed)', async () => {
    await seedInstance('rt1', 'wp_pen', 0, { rarity: 'fine' }); // target: fine, needs a common material
    await seedInstance('rm1', 'wp_pencil', 1, { rarity: 'common' }); // material: right slot+rarity, but already +1
    const res = await reforge('rt1', 'rm1', 'rk-lvl');
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe('INVALID_MATERIAL_LEVEL');
    // no partial mutation: both items still present, target untouched, material not consumed
    const save = await readSave();
    expect(save.equipmentInv['rt1']).toBeTruthy();
    expect(save.equipmentInv['rm1']).toMatchObject({ level: 1 });
  });
});
