// 装备库存后端端到端（E2，EQUIPMENT_DESIGN §4/§18）：
//   玩家 POST /equipment/craft（扣材料→roll→入库，幂等、材料不足、满仓）
//   内部 /internal/equipment/{escrow,grant}（worldsvc 拍卖托管/转移；穿戴中/锁定拒绝、幂等）
// 需 `cd server && docker compose up -d` + 先 `tsc -b`（导入 dist）。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createMongo,
  type JwtConfig,
  type MongoHandle,
  type EquipmentInstance,
  EQUIPMENT_INV_CAP,
} from '@nw/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../dist/app.js';

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
if (!mongo) console.warn(`[equipment.e2e] Mongo 不可达（${URI}）— 跳过。`);

describe.skipIf(!mongo)('equipment backend e2e', () => {
  const m = mongo!;
  let app: FastifyInstance;
  let token: string;
  let accountId: string;
  const body = (r: { payload: string }) => JSON.parse(r.payload);
  const auth = () => ({ authorization: `Bearer ${token}` });

  const craft = (defId: string, idempotencyKey: string) =>
    app.inject({ method: 'POST', url: '/equipment/craft', headers: auth(), payload: { defId, idempotencyKey } });
  const escrow = (instanceId: string, orderId: string, account = accountId) =>
    app.inject({ method: 'POST', url: '/internal/equipment/escrow', headers: { 'x-internal-key': IK }, payload: { accountId: account, instanceId, orderId } });
  const grant = (instance: EquipmentInstance, orderId: string, account = accountId) =>
    app.inject({ method: 'POST', url: '/internal/equipment/grant', headers: { 'x-internal-key': IK }, payload: { accountId: account, instance, orderId } });

  const seedMaterials = (mats: Record<string, number>) =>
    m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.materials': mats } });
  const readSave = async () => (await m.collections.saves.findOne({ _id: accountId }))!.save;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    if (app) await app.close();
    app = await buildApp({ cols: m.collections, jwt, internalKey: IK });
    const r = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'eq-dev-1' } }));
    token = r.data.token;
    accountId = r.data.accountId;
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // 建档
  });
  afterAll(async () => { if (app) await app.close(); });

  // ── E2 合成 ─────────────────────────────────────────────────────────────────
  it('craft 成功：扣材料 + 入库 + 主词条', async () => {
    await seedMaterials({ scrap: 20 });
    const r = body(await craft('wp_pencil', 'ik1')); // common，配方 scrap:5，0 副词条
    expect(r.data.instance.defId).toBe('wp_pencil');
    expect(r.data.instance.level).toBe(0);
    expect(r.data.instance.rarity).toBe('common');
    expect(r.data.instance.affixes).toHaveLength(1); // 仅主词条
    expect(r.data.instance.affixes[0].id).toBe('m_atk');
    expect(r.data.save.materials.scrap).toBe(15); // 20-5
    expect(r.data.save.equipmentInv[r.data.instance.id]).toBeTruthy();
  });

  it('craft 稀有度副词条：wp_pen（fine）roll 1 副词条', async () => {
    await seedMaterials({ scrap: 20, lead: 10 });
    const r = body(await craft('wp_pen', 'ik2')); // fine，配方 scrap:8 lead:2，1 副词条
    expect(r.data.instance.affixes.length).toBe(2); // 主 + 1 副
    expect(r.data.instance.affixes.some((a: { id: string }) => a.id.startsWith('s_'))).toBe(true);
    expect(r.data.save.materials.scrap).toBe(12);
    expect(r.data.save.materials.lead).toBe(8);
  });

  it('craft 材料不足 → 402', async () => {
    await seedMaterials({ scrap: 2 });
    const res = await craft('wp_pencil', 'ik3');
    expect(res.statusCode).toBe(402);
    expect(body(res).error.code).toBe('INSUFFICIENT_MATERIALS');
  });

  it('craft 幂等：同 idempotencyKey 重放不二次扣料 + 同一实例', async () => {
    await seedMaterials({ scrap: 20 });
    const r1 = body(await craft('wp_pencil', 'dup-key'));
    const r2 = body(await craft('wp_pencil', 'dup-key'));
    expect(r2.data.instance.id).toBe(r1.data.instance.id); // 同实例
    const save = await readSave();
    expect(save.materials.scrap).toBe(15); // 只扣一次
    expect(Object.keys(save.equipmentInv)).toHaveLength(1); // 只产一件
  });

  it('craft 满仓 → 409 INVENTORY_FULL', async () => {
    await seedMaterials({ scrap: 20 });
    // 直接灌满 300 件占位实例
    const full: Record<string, EquipmentInstance> = {};
    for (let i = 0; i < EQUIPMENT_INV_CAP; i++) {
      full[`fill_${i}`] = { id: `fill_${i}`, defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] };
    }
    await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.equipmentInv': full } });
    const res = await craft('wp_pencil', 'ik-full');
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('INVENTORY_FULL');
  });

  it('craft 未知 defId → 400', async () => {
    const res = await craft('nope', 'ik-bad');
    expect(res.statusCode).toBe(400);
  });

  // ── 内部托管 / 转移（worldsvc 拍卖）────────────────────────────────────────────
  it('escrow：移出卖方库存 + 返回快照；grant：写入目标库存', async () => {
    await seedMaterials({ scrap: 20 });
    const inst = body(await craft('wp_pencil', 'ik-e1')).data.instance as EquipmentInstance;
    // 托管：移出
    const er = body(await escrow(inst.id, 'order1'));
    expect(er.ok).toBe(true);
    expect(er.instance.id).toBe(inst.id);
    expect((await readSave()).equipmentInv[inst.id]).toBeUndefined(); // 已移出
    // 转移给买方（另起账号）
    const buyer = body(await app.inject({ method: 'POST', url: '/auth/device', payload: { deviceId: 'eq-buyer' } }));
    await app.inject({ method: 'GET', url: '/save', headers: { authorization: `Bearer ${buyer.data.token}` } });
    const gr = body(await grant(er.instance, 'order1:item', buyer.data.accountId));
    expect(gr.ok).toBe(true);
    const buyerSave = (await m.collections.saves.findOne({ _id: buyer.data.accountId }))!.save;
    expect(buyerSave.equipmentInv[inst.id]).toMatchObject({ id: inst.id, defId: 'wp_pencil' });
  });

  it('escrow 幂等：同 orderId 重放返回同快照（不二次移出）', async () => {
    await seedMaterials({ scrap: 20 });
    const inst = body(await craft('wp_pencil', 'ik-e2')).data.instance as EquipmentInstance;
    const e1 = body(await escrow(inst.id, 'orderX'));
    const e2 = body(await escrow(inst.id, 'orderX')); // 实例已移出，但 orderId 重放
    expect(e2.ok).toBe(true);
    expect(e2.instance.id).toBe(e1.instance.id);
  });

  it('escrow 不存在实例 → 404 EQUIP_NOT_FOUND', async () => {
    const res = await escrow('ghost', 'order-ghost');
    expect(res.statusCode).toBe(404);
    expect(body(res).code).toBe('EQUIP_NOT_FOUND');
  });

  it('escrow 锁定实例 → 409 EQUIP_LOCKED', async () => {
    await m.collections.saves.updateOne(
      { _id: accountId },
      { $set: { 'save.equipmentInv.locked1': { id: 'locked1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [], locked: true } } },
    );
    const res = await escrow('locked1', 'order-locked');
    expect(res.statusCode).toBe(409);
    expect(body(res).code).toBe('EQUIP_LOCKED');
  });

  it('escrow 穿戴中实例 → 409 EQUIP_IN_USE', async () => {
    await m.collections.saves.updateOne(
      { _id: accountId },
      {
        $set: {
          'save.equipmentInv.worn1': { id: 'worn1', defId: 'wp_pencil', rarity: 'common', level: 0, affixes: [] },
          'save.gear': { global: { weapon: 'worn1' } },
        },
      },
    );
    const res = await escrow('worn1', 'order-worn');
    expect(res.statusCode).toBe(409);
    expect(body(res).code).toBe('EQUIP_IN_USE');
  });

  it('grant 幂等：同实例重发只一件（按 id 覆盖）', async () => {
    const inst: EquipmentInstance = { id: 'g1', defId: 'wp_marker', rarity: 'rare', level: 2, affixes: [{ id: 'm_atk', value: 8 }] };
    await grant(inst, 'gorder');
    await grant(inst, 'gorder');
    const save = await readSave();
    expect(save.equipmentInv['g1']).toMatchObject({ level: 2 });
    expect(Object.keys(save.equipmentInv).filter((k) => k === 'g1')).toHaveLength(1);
  });
});
