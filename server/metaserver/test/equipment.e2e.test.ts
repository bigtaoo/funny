// 装备库存后端端到端（E2/E3/E4，EQUIPMENT_DESIGN §4/§6/§18）：
//   玩家 POST /equipment/craft（扣材料→roll→入库，幂等、材料不足、满仓）
//   玩家 POST /equipment/enhance（服务器掷骰→扣材料+金币→成功 level+1，幂等、满级、不足）
//   玩家 POST /equipment/salvage（+0~4 返 70% 材料、移出；+5/穿戴/锁定拒，批量、幂等）
//   玩家 POST /equipment/equip（穿戴/卸下，槽位校验，global/byUnit）
//   内部 /internal/equipment/{escrow,grant}（worldsvc 拍卖托管/转移；穿戴中/锁定拒绝、幂等）
// 需 `cd server && docker compose up -d` + 先 `tsc -b`（导入 dist）。
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

/** 最小假 commercial：仅 getWallet/spend 真实记账（enhance 走金币），其余 stub。 */
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
if (!mongo) console.warn(`[equipment.e2e] Mongo 不可达（${URI}）— 跳过。`);

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
  const equip = (slot: string, instanceId: string | null, unitType?: string) =>
    app.inject({ method: 'POST', url: '/equipment/equip', headers: auth(), payload: { slot, instanceId, ...(unitType ? { unitType } : {}) } });
  const escrow = (instanceId: string, orderId: string, account = accountId) =>
    app.inject({ method: 'POST', url: '/internal/equipment/escrow', headers: { 'x-internal-key': IK }, payload: { accountId: account, instanceId, orderId } });
  const grant = (instance: EquipmentInstance, orderId: string, account = accountId) =>
    app.inject({ method: 'POST', url: '/internal/equipment/grant', headers: { 'x-internal-key': IK }, payload: { accountId: account, instance, orderId } });

  const seedMaterials = (mats: Record<string, number>) =>
    m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.materials': mats } });
  /** 直接灌一件实例进库存（指定 level/locked），返回其 id。 */
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
    await app.inject({ method: 'GET', url: '/save', headers: auth() }); // 建档
    comm.setCoins(accountId, 100000); // 充足金币，enhance 不被金币卡（专项测试单独压低）
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

  // ── E3 强化 ───────────────────────────────────────────────────────────────────
  it('enhance 成功：level+1，扣材料 + 金币', async () => {
    // 找一个在 level 0 必定成功的 idemKey（确定性掷骰）。
    let key = '';
    for (let i = 0; ; i++) if (rollEnhanceSuccess(`s${i}`, 0)) { key = `s${i}`; break; }
    await seedInstance('e1', 'wp_pencil', 0);
    await seedMaterials({ scrap: 100, lead: 100, binding: 100 });
    comm.setCoins(accountId, 1000);
    const cost = enhanceCost(0); // { scrap:4, coins:40 }
    const r = body(await enhance('e1', key));
    expect(r.data.success).toBe(true);
    expect(r.data.instance.level).toBe(1);
    expect(r.data.save.materials.scrap).toBe(100 - cost.materials.scrap);
    expect(r.data.save.wallet.coins).toBe(1000 - cost.coins);
    expect(comm.bal(accountId)).toBe(1000 - cost.coins);
  });

  it('enhance 失败：level 不变，仍扣材料 + 金币（温和档不掉级不碎）', async () => {
    let key = '';
    for (let i = 0; ; i++) if (!rollEnhanceSuccess(`f${i}`, 0)) { key = `f${i}`; break; }
    await seedInstance('e2', 'wp_pencil', 0);
    await seedMaterials({ scrap: 100 });
    comm.setCoins(accountId, 1000);
    const cost = enhanceCost(0);
    const r = body(await enhance('e2', key));
    expect(r.data.success).toBe(false);
    expect(r.data.instance.level).toBe(0); // 不掉级
    expect(r.data.save.materials.scrap).toBe(100 - cost.materials.scrap); // 仍损耗
    expect(r.data.save.wallet.coins).toBe(1000 - cost.coins);
  });

  it('enhance 幂等：同 key 重放不二次扣料/掷骰，结果一致', async () => {
    await seedInstance('e3', 'wp_pencil', 0);
    await seedMaterials({ scrap: 100 });
    comm.setCoins(accountId, 1000);
    const r1 = body(await enhance('e3', 'dup-enh'));
    const r2 = body(await enhance('e3', 'dup-enh'));
    expect(r2.data.success).toBe(r1.data.success);
    expect(r2.data.instance.level).toBe(r1.data.instance.level);
    const save = await readSave();
    expect(save.materials.scrap).toBe(100 - enhanceCost(0).materials.scrap); // 只扣一次
    expect(comm.bal(accountId)).toBe(1000 - enhanceCost(0).coins); // 金币只扣一次
  });

  it('enhance 满级 → 409 ENHANCE_MAX_LEVEL', async () => {
    await seedInstance('e9', 'wp_pencil', 9);
    await seedMaterials({ scrap: 100 });
    const res = await enhance('e9', 'ek-max');
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('ENHANCE_MAX_LEVEL');
  });

  it('enhance 材料不足 → 402，且不动状态/金币', async () => {
    await seedInstance('e4', 'wp_pencil', 0);
    await seedMaterials({ scrap: 1 });
    comm.setCoins(accountId, 1000);
    const res = await enhance('e4', 'ek-nomat');
    expect(res.statusCode).toBe(402);
    expect(body(res).error.code).toBe('INSUFFICIENT_MATERIALS');
    expect((await readSave()).equipmentInv['e4'].level).toBe(0);
    expect(comm.bal(accountId)).toBe(1000); // 金币未动
  });

  it('enhance 金币不足 → 402 INSUFFICIENT_FUNDS，且不扣材料', async () => {
    await seedInstance('e5', 'wp_pencil', 0);
    await seedMaterials({ scrap: 100 });
    comm.setCoins(accountId, 10); // < 40
    const res = await enhance('e5', 'ek-nocoin');
    expect(res.statusCode).toBe(402);
    expect(body(res).error.code).toBe('INSUFFICIENT_FUNDS');
    expect((await readSave()).materials.scrap).toBe(100); // 材料未动
  });

  it('enhance 实例不存在 → 404', async () => {
    const res = await enhance('ghost', 'ek-ghost');
    expect(res.statusCode).toBe(404);
    expect(body(res).error.code).toBe('EQUIP_NOT_FOUND');
  });

  // ── E3 分解 ───────────────────────────────────────────────────────────────────
  it('salvage：返 70% 打造材料 + 移出库存', async () => {
    await seedInstance('s1', 'wp_pencil', 0); // craftCost scrap:5 → 返 floor(3.5)=3
    await seedMaterials({ scrap: 10 });
    const refund = salvageRefund('wp_pencil'); // { scrap:3 }
    const r = body(await salvage(['s1'], 'sk1'));
    expect(r.data.refunded).toEqual(refund);
    expect(r.data.save.materials.scrap).toBe(10 + refund.scrap);
    expect(r.data.save.equipmentInv['s1']).toBeUndefined();
  });

  it('salvage 批量：返还合计', async () => {
    await seedInstance('s2', 'wp_pencil', 1);
    await seedInstance('s3', 'wp_pencil', 4);
    await seedMaterials({ scrap: 0 });
    const r = body(await salvage(['s2', 's3'], 'sk-batch'));
    expect(r.data.refunded.scrap).toBe(salvageRefund('wp_pencil').scrap * 2);
    const save = await readSave();
    expect(save.equipmentInv['s2']).toBeUndefined();
    expect(save.equipmentInv['s3']).toBeUndefined();
  });

  it('salvage +5 及以上 → 409 NOT_SALVAGEABLE（整批拒，不部分执行）', async () => {
    await seedInstance('s4', 'wp_pencil', 0);
    await seedInstance('s5', 'wp_pencil', 5);
    const res = await salvage(['s4', 's5'], 'sk-hi');
    expect(res.statusCode).toBe(409);
    expect(body(res).error.code).toBe('NOT_SALVAGEABLE');
    expect((await readSave()).equipmentInv['s4']).toBeTruthy(); // 整批未执行
  });

  it('salvage 锁定 → 409 EQUIP_LOCKED；穿戴中 → 409 EQUIP_IN_USE', async () => {
    await seedInstance('sl', 'wp_pencil', 0, { locked: true });
    expect((await salvage(['sl'], 'sk-lock')).statusCode).toBe(409);
    expect(body(await salvage(['sl'], 'sk-lock2')).error.code).toBe('EQUIP_LOCKED');

    await seedInstance('sw', 'wp_pencil', 0);
    await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.gear': { global: { weapon: 'sw' } } } });
    expect(body(await salvage(['sw'], 'sk-worn')).error.code).toBe('EQUIP_IN_USE');
  });

  it('salvage 幂等：同 key 重放不二次返还', async () => {
    await seedInstance('s6', 'wp_pencil', 0);
    await seedMaterials({ scrap: 0 });
    await salvage(['s6'], 'sk-dup');
    const r2 = body(await salvage(['s6'], 'sk-dup'));
    expect(r2.data.refunded.scrap).toBe(salvageRefund('wp_pencil').scrap);
    expect((await readSave()).materials.scrap).toBe(salvageRefund('wp_pencil').scrap); // 只返一次
  });

  // ── E4 穿戴 ───────────────────────────────────────────────────────────────────
  it('equip：穿上 → gear.global[slot]；卸下 → 移除', async () => {
    await seedInstance('w1', 'wp_pencil', 0); // weapon 槽
    const r = body(await equip('weapon', 'w1'));
    expect(r.data.save.gear.global.weapon).toBe('w1');
    const r2 = body(await equip('weapon', null));
    expect(r2.data.save.gear.global.weapon).toBeUndefined();
  });

  it('equip 槽位不匹配 → 400 INVALID_SLOT', async () => {
    await seedInstance('w2', 'wp_pencil', 0); // weapon 装备
    const res = await equip('armor', 'w2'); // 塞进护甲槽
    expect(res.statusCode).toBe(400);
    expect(body(res).error.code).toBe('INVALID_SLOT');
  });

  it('equip 非法槽位名 → 400（openapi enum 契约层先拦）', async () => {
    const res = await equip('helmet', null);
    expect(res.statusCode).toBe(400); // slot enum=[weapon,armor,trinket] 校验失败 → BAD_REQUEST
  });

  it('equip 实例不存在 → 404', async () => {
    const res = await equip('weapon', 'nope');
    expect(res.statusCode).toBe(404);
    expect(body(res).error.code).toBe('EQUIP_NOT_FOUND');
  });

  it('equip byUnit：unitType 写进 gear.byUnit', async () => {
    await seedInstance('w3', 'ar_draft', 0); // armor 装备
    const r = body(await equip('armor', 'w3', 'Infantry'));
    expect(r.data.save.gear.byUnit.Infantry.armor).toBe('w3');
    expect(r.data.save.gear.global?.armor).toBeUndefined(); // 不污染 global
  });

  it('equip 穿戴后该实例不可分解（EQUIP_IN_USE）', async () => {
    await seedInstance('w4', 'wp_pencil', 0);
    await equip('weapon', 'w4');
    expect(body(await salvage(['w4'], 'sk-equipped')).error.code).toBe('EQUIP_IN_USE');
  });
});
