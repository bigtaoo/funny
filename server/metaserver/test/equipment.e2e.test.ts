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
  rollEnhanceDemote,
  enhanceCost,
  salvageRefund,
} from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import type { CommercialClient } from '../dist/commercialClient.js';
import { buildApp } from '../dist/app.js';
import { reforgeEquipment, escrowEquipment, salvageEquipment, craftEquipment } from '../dist/equipment.js';
import { seedEquipment, seedEquipmentBatch, readEquipmentInv } from './helpers/equipment.js';
import { readCardInv, seedCard } from './helpers/cards.js';

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
  const enhance = (instanceId: string, idempotencyKey: string, useProtect?: boolean) =>
    app.inject({ method: 'POST', url: '/equipment/enhance', headers: auth(), payload: { instanceId, idempotencyKey, useProtect } });
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
    await seedEquipment(m, accountId, inst);
    // Keep the cap-check mirror in sync (equipment.ts reads save.equipmentInvCount, not a live count).
    await m.collections.saves.updateOne({ _id: accountId }, { $inc: { 'save.equipmentInvCount': 1 } });
    return id;
  };
  const readSave = async () => (await m.collections.saves.findOne({ _id: accountId }))!.save;
  /** equipmentInv now lives in its own collection (2026-07-26 split) — read it directly for assertions
   * against internal storage state. /equipment/* mutation responses deliberately send `equipmentInv: null`
   * (EQUIPMENT_DESIGN §3.3 phase 2) rather than the full map, so tests must assert against this helper,
   * not `r.data.save.equipmentInv` — only GET /save (and other non-equipment endpoints, via app.ts's join
   * hook) still carry the full map. */
  const readInv = (account = accountId) => readEquipmentInv(m, account);

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
    // Lean response (EQUIPMENT_DESIGN §3.3 phase 2): craft hands back the new instance directly, so it
    // doesn't also need to pay for + return the full equipmentInv map.
    expect(r.data.save.equipmentInv).toBeNull();
    expect((await readInv())[r.data.instance.id]).toBeTruthy();
  });

  it('craft stamps provenance: sourceType="craft" + obtainedAt≈now (ITEM_IDENTITY_DESIGN.md, 2026-08-04)', async () => {
    await seedMaterials({ scrap: 20 });
    const before = Date.now();
    const r = body(await craft('wp_pencil', 'ik-provenance'));
    const after = Date.now();
    expect(r.data.instance.sourceType).toBe('craft');
    expect(r.data.instance.obtainedAt).toBeGreaterThanOrEqual(before);
    expect(r.data.instance.obtainedAt).toBeLessThanOrEqual(after);
    // Round-trips through the equipmentInstances collection (toInstanceDoc/fromInstanceDoc), not just the
    // one-shot mutation response.
    const stored = (await readInv())[r.data.instance.id]!;
    expect(stored.sourceType).toBe('craft');
    expect(stored.obtainedAt).toBe(r.data.instance.obtainedAt);
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
    expect(Object.keys(await readInv())).toHaveLength(1); // only one item produced
  });

  it('regression (2026-08-03 fix): a duplicate craft request behind an uncommitted claim is rejected, not granted for free', async () => {
    // Root cause: the idempotency claim for craft/enhance/reforge is inserted BEFORE the cost-side
    // rev-guarded save write lands (so the roll stays deterministic across retries). A concurrent
    // duplicate request hitting the insert's E11000 used to unconditionally re-assert the instance —
    // if the *original* request then failed to ever commit the cost (crash, exhausted rev retries), the
    // duplicate had already granted a free item. Simulate that in-flight state directly: seed a claim
    // doc with committed:false (as if a request just claimed the key but hasn't paid yet), then fire a
    // second request with the same key.
    await seedMaterials({ scrap: 20 });
    const idempotencyKey = 'racing-key';
    await m.collections.equipmentIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'craft',
      result: { id: `eq_${idempotencyKey}`, defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] },
      committed: false,
      expireAt: new Date(Date.now() + 3600_000),
    });
    const res = await craft('wp_pencil', idempotencyKey);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('REV_CONFLICT');
    // Nothing was granted and nothing was charged.
    expect(Object.keys(await readInv())).toHaveLength(0);
    expect((await readSave()).materials.scrap).toBe(20);
  });

  it('regression: craftEquipment exhausting rev retries releases the idem claim instead of wedging the key forever', async () => {
    // Root cause: on exhaustion, craftEquipment used to keep the idem claim (committed:false forever, since
    // materials were never actually charged) and just return REV_CONFLICT — every future retry with the SAME
    // idempotencyKey then hit the E11000 duplicate-claim branch, saw committed:false, and returned
    // "craft already in progress, retry" permanently, with no path to ever complete the craft. Force every
    // findOneAndUpdate on `saves` to "lose" to simulate exhausted contention deterministically.
    await seedMaterials({ scrap: 20 });
    const realSaves = m.collections.saves;
    const wrappedSaves = {
      findOne: realSaves.findOne.bind(realSaves),
      findOneAndUpdate: async () => null,
    } as typeof realSaves;
    const wrappedCols = { ...m.collections, saves: wrappedSaves };

    const first = await craftEquipment(wrappedCols, () => Date.now(), accountId, 'wp_pencil', 'stuck-key');
    expect('error' in first).toBe(true);
    expect((first as { code: string }).code).toBe('REV_CONFLICT');
    // Nothing was charged or granted on the failed attempt.
    expect(Object.keys(await readInv())).toHaveLength(0);
    expect((await readSave()).materials.scrap).toBe(20);
    // The idem claim must be gone — a retry with the SAME key against the real (unwrapped) collections
    // must be able to succeed cleanly, not report "craft already in progress" forever.
    expect(await m.collections.equipmentIdem.findOne({ _id: 'stuck-key' })).toBeNull();
    const retry = body(await craft('wp_pencil', 'stuck-key'));
    expect(retry.data.instance.defId).toBe('wp_pencil');
    expect((await readSave()).materials.scrap).toBe(15);
  });

  it('craft full inventory → 409 INVENTORY_FULL', async () => {
    await seedMaterials({ scrap: 20 });
    // Directly seed 300 placeholder instances to fill the inventory
    const full: EquipmentInstance[] = [];
    for (let i = 0; i < EQUIPMENT_INV_CAP; i++) {
      full.push({ id: `fill_${i}`, defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] });
    }
    await seedEquipmentBatch(m, accountId, full);
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
    expect((await readInv())[inst.id]).toBeUndefined(); // already removed
    // transfer to buyer (a separate account)
    const buyer = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'eq-buyer' } }));
    await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${buyer.data.token}` } });
    const gr = body(await grant(er.instance, 'order1:item', buyer.data.accountId));
    expect(gr.ok).toBe(true);
    const buyerInv = await readInv(buyer.data.accountId);
    expect(buyerInv[inst.id]).toMatchObject({ id: inst.id, defId: 'wp_pencil' });
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
    await seedInstance('locked1', 'wp_pencil', 0, { locked: true });
    const res = await escrow('locked1', 'order-locked');
    expect(res.statusCode).toBe(409);
    expect(body(res).code).toBe('EQUIP_LOCKED');
  });

  it('regression: escrowEquipment exhausting rev retries still reports the escrow as done, not REV_CONFLICT with the item gone', async () => {
    // Root cause: escrowEquipment deleted the instance unconditionally up front, then only recorded the
    // escrow ledger entry INSIDE the successful branch of the save-count-decrement retry loop — so
    // exhausting all retries used to return REV_CONFLICT while the item was already deleted with no
    // escrow record anywhere, permanently destroying it with zero compensation and no way to recover via
    // a replay (the ledger entry was never written). Force every findOneAndUpdate on `saves` to "lose".
    await seedMaterials({ scrap: 20 });
    const inst = body(await craft('wp_pencil', 'ik-e-exhaust')).data.instance as EquipmentInstance;
    const realSaves = m.collections.saves;
    const wrappedSaves = {
      findOne: realSaves.findOne.bind(realSaves),
      findOneAndUpdate: async () => null,
    } as typeof realSaves;
    const wrappedCols = { ...m.collections, saves: wrappedSaves };

    const result = await escrowEquipment(wrappedCols, () => Date.now(), accountId, inst.id, 'order-exhaust');
    expect('error' in result).toBe(false);
    expect((result as { instance: EquipmentInstance }).instance.id).toBe(inst.id);
    expect((await readInv())[inst.id]).toBeUndefined(); // still correctly removed from the seller's inventory
    // The escrow ledger entry must exist so a replay of the same orderId (e.g. worldsvc retrying the HTTP
    // call after a timeout) returns the same snapshot instead of EQUIP_NOT_FOUND.
    const replay = body(await escrow(inst.id, 'order-exhaust'));
    expect(replay.ok).toBe(true);
    expect(replay.instance.id).toBe(inst.id);
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
    const inv = await readInv();
    expect(inv['g1']).toMatchObject({ level: 2 });
    expect(Object.keys(inv).filter((k) => k === 'g1')).toHaveLength(1);
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
    // Lean response (EQUIPMENT_DESIGN §3.3 phase 2): enhance hands back the updated instance directly.
    expect(r.data.save.equipmentInv).toBeNull();
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

  it('enhance failure at +7 with a demoting roll: level drops to +6 (ADR-063 risk tier)', async () => {
    let key = '';
    for (let i = 0; ; i++) {
      if (!rollEnhanceSuccess(`d${i}`, 7) && rollEnhanceDemote(`d${i}`, 7)) { key = `d${i}`; break; }
    }
    await seedInstance('e7a', 'wp_pencil', 7);
    await seedMaterials({ scrap: 100, lead: 100, binding: 100 });
    const r = body(await enhance('e7a', key));
    expect(r.data.success).toBe(false);
    expect(r.data.instance.level).toBe(6); // demoted one level
  });

  it('enhance failure at +7 with a non-demoting roll: level stays at +7 (demote is not guaranteed on every failure)', async () => {
    let key = '';
    for (let i = 0; ; i++) {
      if (!rollEnhanceSuccess(`n${i}`, 7) && !rollEnhanceDemote(`n${i}`, 7)) { key = `n${i}`; break; }
    }
    await seedInstance('e7b', 'wp_pencil', 7);
    await seedMaterials({ scrap: 100, lead: 100, binding: 100 });
    const r = body(await enhance('e7b', key));
    expect(r.data.success).toBe(false);
    expect(r.data.instance.level).toBe(7); // not demoted
  });

  it('a protect item blocks the +7/+8 demote roll too, not just the material loss (ADR-063)', async () => {
    let key = '';
    for (let i = 0; ; i++) {
      if (!rollEnhanceSuccess(`p${i}`, 8) && rollEnhanceDemote(`p${i}`, 8)) { key = `p${i}`; break; }
    }
    await seedInstance('e8a', 'wp_pencil', 8);
    await seedMaterials({ scrap: 100, lead: 100, binding: 100 });
    await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.inventory.items.protect_enhance': 1 } });
    const cost = enhanceCost(8);
    const r = body(await enhance('e8a', key, true));
    expect(r.data.success).toBe(false);
    expect(r.data.instance.level).toBe(8); // not demoted, even though the underlying roll said it would be
    expect(r.data.save.materials.scrap).toBe(100); // materials untouched (protect skipped the deduction)
    expect(r.data.save.wallet.coins).toBe(100000 - cost.coins); // coins are still charged
    const save = await readSave();
    expect(save.inventory.items.protect_enhance).toBe(0); // stone consumed
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
    expect((await readInv())['e4']!.level).toBe(0);
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
    // Lean response (EQUIPMENT_DESIGN §3.3 phase 2): the caller already sent instanceIds ['s1'] itself.
    expect(r.data.save.equipmentInv).toBeNull();
    expect((await readInv())['s1']).toBeUndefined();
  });

  it('salvage batch: total refund across all items', async () => {
    await seedInstance('s2', 'wp_pencil', 1);
    await seedInstance('s3', 'wp_pencil', 4);
    await seedMaterials({ scrap: 0 });
    const r = body(await salvage(['s2', 's3'], 'sk-batch'));
    expect(r.data.refunded.scrap).toBe(salvageRefund('wp_pencil').scrap * 2);
    const inv = await readInv();
    expect(inv['s2']).toBeUndefined();
    expect(inv['s3']).toBeUndefined();
  });

  it('salvage +5 and above → 409 NOT_SALVAGEABLE (whole batch rejected, no partial execution)', async () => {
    await seedInstance('s4', 'wp_pencil', 0);
    await seedInstance('s5', 'wp_pencil', 5);
    const res = await salvage(['s4', 's5'], 'sk-hi');
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('NOT_SALVAGEABLE');
    expect((await readInv())['s4']).toBeTruthy(); // whole batch not executed
  });

  it('salvage epic rarity at +0 → 409 NOT_SALVAGEABLE (ADR-050: epic never salvages, regardless of level)', async () => {
    await seedInstance('s7', 'wp_highlighter', 0, { rarity: 'epic' });
    const res = await salvage(['s7'], 'sk-epic');
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('NOT_SALVAGEABLE');
    expect((await readInv())['s7']).toBeTruthy();
  });

  it('salvage batch mixing a valid item with an epic item → whole batch 409 rejected, valid item not consumed', async () => {
    await seedInstance('s8', 'wp_pencil', 0); // otherwise perfectly salvageable
    await seedInstance('s9', 'wp_highlighter', 0, { rarity: 'epic' });
    const res = await salvage(['s8', 's9'], 'sk-mixed');
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('NOT_SALVAGEABLE');
    const inv = await readInv();
    expect(inv['s8']).toBeTruthy(); // whole batch not executed
    expect(inv['s9']).toBeTruthy();
  });

  it('regression: salvageEquipment exhausting rev retries preserves the refund for a later retry instead of losing it', async () => {
    // Root cause: salvageEquipment deleted the instances unconditionally up front (idem claim inserted
    // first, so it does carry {refunded, instanceIds}), but on exhaustion it used to DELETE that idem claim
    // and return REV_CONFLICT — orphaning the refund with items already gone and no record of what was
    // owed; a client retry with the same key would then find EQUIP_NOT_FOUND for a salvage that had already
    // destroyed the items. The fix keeps the claim (committed:false) so a retry finishes the credit instead.
    await seedInstance('s10', 'wp_pencil', 0);
    await seedMaterials({ scrap: 10 });
    const refund = salvageRefund('wp_pencil');
    const realSaves = m.collections.saves;
    const wrappedSaves = {
      findOne: realSaves.findOne.bind(realSaves),
      findOneAndUpdate: async () => null,
    } as typeof realSaves;
    const wrappedCols = { ...m.collections, saves: wrappedSaves };

    const first = await salvageEquipment(wrappedCols, () => Date.now(), accountId, ['s10'], 'sk-exhaust');
    expect('error' in first).toBe(true);
    expect((first as { code: string }).code).toBe('REV_CONFLICT');
    expect((await readInv())['s10']).toBeUndefined(); // already destroyed, as designed
    expect((await readSave()).materials.scrap).toBe(10); // not yet credited

    // Retry with the SAME key against the real (unwrapped) collections must finish the credit, not report
    // cached success without ever applying it, and not double-credit either.
    const retry = body(await salvage(['s10'], 'sk-exhaust'));
    expect(retry.data.refunded).toEqual(refund);
    expect((await readSave()).materials.scrap).toBe(10 + refund.scrap);

    // A further replay must not credit a second time.
    const replayAgain = body(await salvage(['s10'], 'sk-exhaust'));
    expect(replayAgain.data.refunded).toEqual(refund);
    expect((await readSave()).materials.scrap).toBe(10 + refund.scrap);
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
    return Object.keys(await readCardInv(m, accountId))[0]!;
  };

  it('equip: equip → CardInstance.gear[slot]; unequip → removed', async () => {
    await seedInstance('w1', 'wp_pencil', 0); // weapon slot
    const cardId = await starterCardId();
    const r = body(await equip('weapon', 'w1', cardId));
    expect(r.data.save.cardInv[cardId].gear.weapon).toBe('w1');
    // Lean response (EQUIPMENT_DESIGN §3.3 phase 2): equip never touches equipmentInv at all.
    expect(r.data.save.equipmentInv).toBeNull();
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

  // Regression for the 2026-07-29 audit fix: equipEquipment used to skip the isEquipped() check that every
  // other mutation (salvage/enhance/reforge, above) already applies, so the same instanceId could be
  // written into TWO cards' gear[slot] at once and double-count its stat bonus (equipment duplication).
  it('equip an instance already equipped on a DIFFERENT card → 409 EQUIP_IN_USE (no duplication)', async () => {
    await seedInstance('w5', 'wp_pencil', 0);
    const cardA = await starterCardId();
    const cardB = 'card_second_' + cardA;
    await seedCard(m, accountId, { id: cardB, defId: 'card_test', level: 1, gear: {}, locked: false });
    await equip('weapon', 'w5', cardA);
    const res = await equip('weapon', 'w5', cardB);
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('EQUIP_IN_USE');
    // Still only equipped on the original card — never landed on the second.
    const inv = await readCardInv(m, accountId);
    expect(inv[cardA].gear?.weapon).toBe('w5');
    expect(inv[cardB].gear?.weapon).toBeUndefined();
  });

  // Regression for the audit-followup-fixes-0729 review: the sequential test above (two SEQUENTIAL equip
  // calls) doesn't prove concurrent equips of the same instance can't both land — the pre-write occupancy
  // check (cardInstances.findOne "equipped elsewhere?") is a plain read with no atomicity of its own, so two
  // concurrent requests can both pass it before either writes. The unique multikey index on
  // CardInstanceDoc.gearInstanceIds (mongo.ts) is the actual guard: fire several concurrent equip attempts
  // of the SAME instanceId onto DIFFERENT cards at once and confirm exactly one wins (200), the rest get
  // 409 EQUIP_IN_USE, and the instance never lands on more than one card's gear.
  it('CONCURRENT equip of the SAME instance onto DIFFERENT cards → exactly one wins, no duplication (regression: gearInstanceIds unique index)', async () => {
    await seedInstance('wrace', 'wp_pencil', 0);
    const cardA = await starterCardId();
    const otherCards = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => {
        const id = `card_race_${i}_${cardA}`;
        await seedCard(m, accountId, { id, defId: 'card_test', level: 1, gear: {}, locked: false });
        return id;
      }),
    );
    const targets = [cardA, ...otherCards];
    const results = await Promise.all(targets.map((cardId) => equip('weapon', 'wrace', cardId)));
    const wins = results.filter((r) => r.statusCode === 200);
    const losses = results.filter((r) => r.statusCode === 409);
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(targets.length - 1);
    expect(losses.every((r) => body(r).error.code === 'EQUIP_IN_USE')).toBe(true);
    // Exactly one card in the whole roster ended up holding the instance — never two.
    const inv = await readCardInv(m, accountId);
    const holders = targets.filter((cardId) => inv[cardId]?.gear?.weapon === 'wrace');
    expect(holders.length).toBe(1);
  });

  it('re-equipping the same instance on the SAME card/slot is a no-op, not EQUIP_IN_USE', async () => {
    await seedInstance('w6', 'wp_pencil', 0);
    const cardId = await starterCardId();
    await equip('weapon', 'w6', cardId);
    const res = await equip('weapon', 'w6', cardId);
    expect(res.statusCode).toBe(200);
    expect(body(res).data.save.cardInv[cardId].gear.weapon).toBe('w6');
  });

  // ── E6 Reforge ───────────────────────────────────────────────────────────────────
  it('reforge success: target re-rolled affixes, material consumed, coins deducted', async () => {
    await seedInstance('rt0', 'wp_pen', 0, { rarity: 'fine' });
    await seedInstance('rm0', 'wp_pencil', 0, { rarity: 'common' });
    const before = comm.bal(accountId);
    const res = await reforge('rt0', 'rm0', 'rk-happy');
    expect(res.statusCode).toBe(200);
    const r = body(res);
    expect(r.data.instance.id).toBe('rt0');
    const inv = await readInv();
    expect(inv['rt0']).toBeTruthy();
    expect(inv['rm0']).toBeUndefined(); // fuel consumed
    expect(comm.bal(accountId)).toBeLessThan(before); // coin fee charged
  });

  it('regression (2026-08-03 fix): equipmentInvCount rev-loop exhaustion still completes the reforge (coins settled) instead of erroring after the fuel material is already destroyed', async () => {
    // Root cause: the target upgrade + material deletion happen unconditionally right after the idem
    // claim, BEFORE the equipmentInvCount rev-guarded loop even starts — so if that loop exhausts its
    // retries (contention from an unrelated concurrent save write), the old code deleted the idem claim
    // and returned REV_CONFLICT despite having already destroyed the player's fuel item and upgraded
    // their target, and without ever charging the coin fee. Force every findOneAndUpdate on `saves` to
    // "lose" to simulate that contention deterministically.
    await seedInstance('rt3', 'wp_pen', 0, { rarity: 'fine' });
    await seedInstance('rm3', 'wp_pencil', 0, { rarity: 'common' });
    const before = comm.bal(accountId);

    const realSaves = m.collections.saves;
    let findOneAndUpdateCalls = 0;
    const wrappedSaves = {
      findOne: realSaves.findOne.bind(realSaves),
      findOneAndUpdate: async () => { findOneAndUpdateCalls++; return null; },
    } as typeof realSaves;
    const wrappedCols = { ...m.collections, saves: wrappedSaves };

    const result = await reforgeEquipment(wrappedCols, comm, () => Date.now(), accountId, 'rt3', 'rm3', 'rk-exhaust', undefined);
    expect('error' in result).toBe(false);
    // 3 REV_RETRIES attempts on the equipmentInvCount decrement + 1 more from the fallback settleEquipCoins
    // → mirrorCoins write (also routed through the same stubbed findOneAndUpdate) — all REV_RETRIES
    // attempts genuinely exhausted, not silently skipped.
    expect(findOneAndUpdateCalls).toBe(4);

    // Fuel is gone, target still present (upgraded), and the coin fee was still collected via the
    // fallback settlement — the reforge completed instead of erroring on an already-irreversible mutation.
    const inv = await readInv();
    expect(inv['rt3']).toBeTruthy();
    expect(inv['rm3']).toBeUndefined();
    expect(comm.bal(accountId)).toBeLessThan(before);
  });

  it('reforge rejects an already-enhanced material → 400 INVALID_MATERIAL_LEVEL (client restricts the picker to +0, but a direct API call must be rejected too so sunk enhance materials/rolls cannot be destroyed)', async () => {
    await seedInstance('rt1', 'wp_pen', 0, { rarity: 'fine' }); // target: fine, needs a common material
    await seedInstance('rm1', 'wp_pencil', 1, { rarity: 'common' }); // material: right slot+rarity, but already +1
    const res = await reforge('rt1', 'rm1', 'rk-lvl');
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe('INVALID_MATERIAL_LEVEL');
    // no partial mutation: both items still present, target untouched, material not consumed
    const inv = await readInv();
    expect(inv['rt1']).toBeTruthy();
    expect(inv['rm1']).toMatchObject({ level: 1 });
  });

  it('reforge rejects a locked material → 409 EQUIP_LOCKED (2026-08-03 fix: only the target\'s lock was checked before; a locked item — locked specifically to protect it — could be destroyed as fuel)', async () => {
    await seedInstance('rt2', 'wp_pen', 0, { rarity: 'fine' }); // target: fine, needs a common material
    await seedInstance('rm2', 'wp_pencil', 0, { rarity: 'common', locked: true }); // material: right slot+rarity+level, but locked
    const res = await reforge('rt2', 'rm2', 'rk-matlock');
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('EQUIP_LOCKED');
    // no partial mutation: both items still present, material still locked and not consumed
    const inv = await readInv();
    expect(inv['rt2']).toBeTruthy();
    expect(inv['rm2']).toMatchObject({ locked: true });
  });
});
