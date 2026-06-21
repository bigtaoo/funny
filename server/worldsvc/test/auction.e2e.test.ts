// worldsvc AuctionService 端到端（S8-5）：真实 Mongo 专属库。Mongo 不可达整套 skip。
// 挂拍 / 购买（扣金币+发标的+付卖方+10%税） / 取消（退标的） / 过期扫描（退标的）；
// 校验：装备未实现 / 无效时长 / 上限 / 买自己 / 非拥有者取消 / 已成交不能再买 / NOT_DESIGNATED_BUYER。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUCTION_DURATIONS_SEC,
  AUCTION_MAX_LISTINGS,
  AUCTION_TAX_RATE,
  AUCTION_DAILY_LIST_CAP,
  SlgError,
  type EquipmentInstance,
} from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { AuctionService } from '../src/auctionService';
import type { WorldCommercialClient } from '../src/commercialClient';
import type { WorldMetaClient } from '../src/metaClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_auction_test';
const W = 'auc-test';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[worldsvc.auction.e2e] Mongo 不可达（${URI}）— 跳过。先跑 docker compose up -d。`);
}

describe.skipIf(!mongo)('AuctionService e2e', () => {
  const spends: Array<{ account: string; amount: number; orderId: string }> = [];
  const grants: Array<{ account: string; amount: number; orderId: string }> = [];
  const materialDeducts: Array<{ account: string; material: string; qty: number; orderId: string }> = [];
  const materialGrants: Array<{ account: string; material: string; qty: number; orderId: string }> = [];
  // 装备：模拟 meta 库存（Map<account, Map<instanceId, instance>>）+ 托管/转移流水。
  const equipInv = new Map<string, Map<string, EquipmentInstance>>();
  const equipEscrows: Array<{ account: string; instanceId: string; orderId: string }> = [];
  const equipGrants: Array<{ account: string; instanceId: string; orderId: string }> = [];
  const seedEquip = (acct: string, inst: EquipmentInstance): void => {
    if (!equipInv.has(acct)) equipInv.set(acct, new Map());
    equipInv.get(acct)!.set(inst.id, inst);
  };

  const commercial: WorldCommercialClient = {
    available: true,
    async spend(accountId, amount, orderId) {
      spends.push({ account: accountId, amount, orderId });
    },
    async grant(accountId, amount, orderId) {
      grants.push({ account: accountId, amount, orderId });
    },
  };

  const meta: WorldMetaClient = {
    available: true,
    async deductMaterial(accountId, material, qty, orderId) {
      materialDeducts.push({ account: accountId, material, qty, orderId });
    },
    async grantMaterial(accountId, material, qty, orderId) {
      materialGrants.push({ account: accountId, material, qty, orderId });
    },
    async getProfile() {
      return null;
    },
    async escrowEquipment(accountId, instanceId, orderId) {
      const inv = equipInv.get(accountId);
      const inst = inv?.get(instanceId);
      if (!inst) throw new SlgError('EQUIP_NOT_FOUND');
      if (inst.locked) throw new SlgError('EQUIP_LOCKED');
      inv!.delete(instanceId);
      equipEscrows.push({ account: accountId, instanceId, orderId });
      return inst;
    },
    async grantEquipment(accountId, instance, orderId) {
      seedEquip(accountId, instance);
      equipGrants.push({ account: accountId, instanceId: instance.id, orderId });
    },
  };

  let svc: AuctionService;
  let nowMs = Date.now();

  beforeEach(async () => {
    await mongo!.collections.auctions.deleteMany({});
    await mongo!.collections.auctionDaily.deleteMany({});
    await mongo!.collections.auctionPrices.deleteMany({});
    spends.length = 0;
    grants.length = 0;
    materialDeducts.length = 0;
    materialGrants.length = 0;
    equipInv.clear();
    equipEscrows.length = 0;
    equipGrants.length = 0;
    nowMs = Date.now();

    svc = new AuctionService({
      cols: mongo!.collections,
      commercial,
      meta,
      now: () => nowMs,
    });
  });

  afterAll(async () => {
    await mongo?.close();
  });

  const DUR = AUCTION_DURATIONS_SEC[0]; // 最短时长（e.g. 3600s）

  it('挂拍 → 扣材料托管', async () => {
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 5, price: 10, durationSec: DUR,
    });
    expect(view.status).toBe('open');
    expect(view.qty).toBe(5);
    expect(view.totalPrice).toBe(50);
    expect(materialDeducts).toHaveLength(1);
    expect(materialDeducts[0]).toMatchObject({ account: 'alice', material: 'scrap', qty: 5 });
  });

  it('装备挂拍缺 instanceId → BAD_REQUEST（不触发托管）', async () => {
    await expect(svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'equipment',
      item: { foo: 'bar' }, qty: 1, price: 400, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(equipEscrows).toHaveLength(0);
  });

  it('无效时长 → BAD_REQUEST', async () => {
    await expect(svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 1, durationSec: 999,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('挂单超上限 → AUCTION_LIMIT_REACHED', async () => {
    // price 须落在 scrap 静态参考价护栏带内（ref=10 → [5,20]），用 10。
    for (let i = 0; i < AUCTION_MAX_LISTINGS; i++) {
      await svc.createAuction({
        worldId: W, sellerId: 'alice', itemType: 'material',
        item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
      });
    }
    await expect(svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'AUCTION_LIMIT_REACHED' });
  });

  it('购买：扣金币 + 发材料 + 付卖方（10%税）', async () => {
    // lead 静态参考价 ref=30 → 护栏带 [15,60]，用单价 30。
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'lead' }, qty: 2, price: 30, durationSec: DUR,
    });
    const bought = await svc.buyAuction(W, 'bob', view.auctionId);
    expect(bought.status).toBe('sold');
    expect(bought.buyerId).toBe('bob');
    expect(spends).toHaveLength(1);
    expect(spends[0]).toMatchObject({ account: 'bob', amount: 60 });
    expect(materialGrants).toHaveLength(1);
    expect(materialGrants[0]).toMatchObject({ account: 'bob', material: 'lead', qty: 2 });
    const tax = Math.floor(60 * AUCTION_TAX_RATE);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ account: 'alice', amount: 60 - tax });
  });

  it('买自己的拍卖 → BAD_REQUEST', async () => {
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    });
    await expect(svc.buyAuction(W, 'alice', view.auctionId)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('已成交后再次购买 → AUCTION_CLOSED', async () => {
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    });
    await svc.buyAuction(W, 'bob', view.auctionId);
    await expect(svc.buyAuction(W, 'carol', view.auctionId)).rejects.toMatchObject({ code: 'AUCTION_CLOSED' });
  });

  it('指定买家：其他人购买 → NOT_DESIGNATED_BUYER', async () => {
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'binding' }, qty: 1, price: 50, durationSec: DUR,
      designatedBuyerId: 'bob',
    });
    await expect(svc.buyAuction(W, 'carol', view.auctionId)).rejects.toMatchObject({ code: 'NOT_DESIGNATED_BUYER' });
    const bought = await svc.buyAuction(W, 'bob', view.auctionId);
    expect(bought.status).toBe('sold');
  });

  it('卖方取消 → 退还材料', async () => {
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 3, price: 5, durationSec: DUR,
    });
    const cancelled = await svc.cancelAuction(W, 'alice', view.auctionId);
    expect(cancelled.status).toBe('cancelled');
    const refund = materialGrants.find((g) => g.orderId.startsWith('auction_cancel:'));
    expect(refund).toMatchObject({ account: 'alice', material: 'scrap', qty: 3 });
  });

  it('非卖方取消 → NO_PERMISSION', async () => {
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    });
    await expect(svc.cancelAuction(W, 'bob', view.auctionId)).rejects.toMatchObject({ code: 'NO_PERMISSION' });
  });

  it('过期扫描：处理 expired + 退还卖方标的', async () => {
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'lead' }, qty: 4, price: 20, durationSec: DUR,
    });
    // 强制 expireAt 到过去
    await mongo!.collections.auctions.updateOne(
      { _id: view.auctionId },
      { $set: { expireAt: nowMs - 1000 } },
    );
    const count = await svc.processExpiredAuctions();
    expect(count).toBe(1);
    const refund = materialGrants.find((g) => g.orderId.startsWith('auction_expire:'));
    expect(refund).toMatchObject({ account: 'alice', material: 'lead', qty: 4 });
  });

  it('列出 open 拍卖 + 我的挂单', async () => {
    await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    });
    const list = await svc.listAuctions(W);
    expect(list.length).toBe(1);
    const mine = await svc.getMyListings(W, 'alice');
    expect(mine.length).toBe(1);
    const other = await svc.getMyListings(W, 'bob');
    expect(other.length).toBe(0);
  });

  // ── G 价格护栏（冷启动用静态参考价：scrap ref=10 → 带 [5,20]）──────────────
  it('G 天价挂单 → PRICE_OUT_OF_RANGE', async () => {
    await expect(svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 100, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'PRICE_OUT_OF_RANGE' });
  });

  it('G 地板价挂单 → PRICE_OUT_OF_RANGE', async () => {
    await expect(svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 2, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'PRICE_OUT_OF_RANGE' });
  });

  // ── C 每日挂单上限 ────────────────────────────────────────────────────────
  it('C 每日挂单超 AUCTION_DAILY_LIST_CAP → AUCTION_LIMIT_REACHED', async () => {
    // 挂一单即撤（不占 open 名额），循环到日上限；下一单触限。
    for (let i = 0; i < AUCTION_DAILY_LIST_CAP; i++) {
      const v = await svc.createAuction({
        worldId: W, sellerId: 'dave', itemType: 'material',
        item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
      });
      await svc.cancelAuction(W, 'dave', v.auctionId);
    }
    await expect(svc.createAuction({
      worldId: W, sellerId: 'dave', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'AUCTION_LIMIT_REACHED' });
  });

  // ── B 竞拍 ────────────────────────────────────────────────────────────────
  it('B 出价低于起拍 → BID_TOO_LOW', async () => {
    const v = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material', saleMode: 'auction',
      item: { material: 'scrap' }, qty: 1, startPrice: 10, durationSec: DUR,
    });
    await expect(svc.placeBid(W, 'bob', v.auctionId, 8)).rejects.toMatchObject({ code: 'BID_TOO_LOW' });
  });

  it('B 出价 → 更高价覆盖退还前者 → 到期结拍', async () => {
    const v = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material', saleMode: 'auction',
      item: { material: 'scrap' }, qty: 1, startPrice: 10, durationSec: DUR,
    });
    // bob 出价 12（托管 12）
    const b1 = await svc.placeBid(W, 'bob', v.auctionId, 12);
    expect(b1.topBid).toMatchObject({ bidderId: 'bob', amount: 12 });
    expect(spends.find((s) => s.account === 'bob' && s.amount === 12)).toBeTruthy();
    // carol 出价 15（托管 15）→ 退还 bob 的 12
    await svc.placeBid(W, 'carol', v.auctionId, 15);
    expect(grants.find((g) => g.account === 'bob' && g.amount === 12)).toBeTruthy();
    // 强制过期 → 扫描器结拍给 carol（卖方收 15 税后）
    await mongo!.collections.auctions.updateOne({ _id: v.auctionId }, { $set: { expireAt: nowMs - 1000 } });
    const count = await svc.processExpiredAuctions();
    expect(count).toBe(1);
    const sold = await mongo!.collections.auctions.findOne({ _id: v.auctionId });
    expect(sold?.status).toBe('sold');
    expect(sold?.buyerId).toBe('carol');
    expect(materialGrants.find((g) => g.account === 'carol' && g.material === 'scrap')).toBeTruthy();
    const tax = Math.floor(15 * AUCTION_TAX_RATE);
    expect(grants.find((g) => g.account === 'alice' && g.amount === 15 - tax)).toBeTruthy();
  });

  it('B 买断（buyout）→ 立即结拍', async () => {
    const v = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material', saleMode: 'auction',
      item: { material: 'scrap' }, qty: 1, startPrice: 10, buyoutPrice: 18, durationSec: DUR,
    });
    const bought = await svc.placeBid(W, 'bob', v.auctionId, 18);
    expect(bought.status).toBe('sold');
    expect(bought.buyerId).toBe('bob');
    expect(materialGrants.find((g) => g.account === 'bob' && g.material === 'scrap')).toBeTruthy();
  });

  it('B 竞拍有出价后不可撤单 → BAD_REQUEST', async () => {
    const v = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material', saleMode: 'auction',
      item: { material: 'scrap' }, qty: 1, startPrice: 10, durationSec: DUR,
    });
    await svc.placeBid(W, 'bob', v.auctionId, 12);
    await expect(svc.cancelAuction(W, 'alice', v.auctionId)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  // ── F 季末清算 ────────────────────────────────────────────────────────────
  it('F clearWorldOnReset：清算 open 挂单 + 退还卖方标的 + 退还竞拍托管', async () => {
    // 一口价单（退还 alice 材料）
    await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 3, price: 10, durationSec: DUR,
    });
    // 竞拍单 + bob 出价（清算时退还 bob 托管）
    const v2 = await svc.createAuction({
      worldId: W, sellerId: 'eve', itemType: 'material', saleMode: 'auction',
      item: { material: 'lead' }, qty: 1, startPrice: 30, durationSec: DUR,
    });
    await svc.placeBid(W, 'bob', v2.auctionId, 30);

    const r = await svc.clearWorldOnReset(W);
    expect(r.cancelled).toBe(2);
    expect(materialGrants.find((g) => g.orderId.startsWith('auction_reset:') && g.account === 'alice' && g.qty === 3)).toBeTruthy();
    expect(grants.find((g) => g.orderId.startsWith('auction_reset_refund:') && g.account === 'bob' && g.amount === 30)).toBeTruthy();
    const remaining = await svc.listAuctions(W);
    expect(remaining.length).toBe(0);
  });

  // ── A 装备交易（EQUIPMENT_DESIGN §4.A）。wp_marker 稀有，护栏静态参考价 400 → 带 [200,800]。──
  const mkInst = (id: string, defId = 'wp_marker', extra: Partial<EquipmentInstance> = {}): EquipmentInstance => ({
    id, defId, rarity: 'rare', level: 0, affixes: [{ id: 'm_atk', value: 8 }], ...extra,
  });

  it('A 装备挂拍 → 托管移出卖方库存 + 存实例快照 + qty 恒 1', async () => {
    seedEquip('alice', mkInst('eq1'));
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 1, price: 400, durationSec: DUR,
    });
    expect(view.status).toBe('open');
    expect(view.qty).toBe(1);
    expect(view.itemType).toBe('equipment');
    expect((view.item.instance as EquipmentInstance).id).toBe('eq1');
    expect(equipEscrows).toHaveLength(1);
    expect(equipInv.get('alice')?.has('eq1')).toBe(false); // 已移出卖方库存
  });

  it('A 装备挂拍 qty 传 99 也被强制为 1', async () => {
    seedEquip('alice', mkInst('eq1'));
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 99, price: 400, durationSec: DUR,
    });
    expect(view.qty).toBe(1);
  });

  it('A 装备购买 → 实例转移给买方（含完整词条快照）', async () => {
    seedEquip('alice', mkInst('eq1', 'wp_marker', { level: 3, affixes: [{ id: 'm_atk', value: 8 }, { id: 's_hp', value: 5 }] }));
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 1, price: 400, durationSec: DUR,
    });
    const bought = await svc.buyAuction(W, 'bob', view.auctionId);
    expect(bought.status).toBe('sold');
    expect(spends[0]).toMatchObject({ account: 'bob', amount: 400 });
    // 买方拿到实例（id + 强化等级 + 词条快照原样转移）
    const bobInst = equipInv.get('bob')?.get('eq1');
    expect(bobInst).toMatchObject({ id: 'eq1', level: 3 });
    expect(bobInst?.affixes).toHaveLength(2);
    // 卖方收税后款
    const tax = Math.floor(400 * AUCTION_TAX_RATE);
    expect(grants.find((g) => g.account === 'alice' && g.amount === 400 - tax)).toBeTruthy();
  });

  it('A 装备取消 → 退回卖方库存', async () => {
    seedEquip('alice', mkInst('eq1'));
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 1, price: 400, durationSec: DUR,
    });
    await svc.cancelAuction(W, 'alice', view.auctionId);
    expect(equipInv.get('alice')?.has('eq1')).toBe(true);
    expect(equipGrants.find((g) => g.orderId.startsWith('auction_cancel:') && g.account === 'alice')).toBeTruthy();
  });

  it('A 装备过期扫描 → 退回卖方库存', async () => {
    seedEquip('alice', mkInst('eq1'));
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 1, price: 400, durationSec: DUR,
    });
    await mongo!.collections.auctions.updateOne({ _id: view.auctionId }, { $set: { expireAt: nowMs - 1000 } });
    const count = await svc.processExpiredAuctions();
    expect(count).toBe(1);
    expect(equipInv.get('alice')?.has('eq1')).toBe(true);
  });

  it('A 装备天价挂单 → PRICE_OUT_OF_RANGE（且退还托管实例）', async () => {
    seedEquip('alice', mkInst('eq1'));
    await expect(svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 1, price: 5000, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'PRICE_OUT_OF_RANGE' });
    // 护栏拒绝后实例已退回卖方（不被吞）
    expect(equipInv.get('alice')?.has('eq1')).toBe(true);
  });

  it('A locked 装备挂拍 → EQUIP_LOCKED（meta 托管拒绝透传）', async () => {
    seedEquip('alice', mkInst('eq1', 'wp_marker', { locked: true }));
    await expect(svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 1, price: 400, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'EQUIP_LOCKED' });
  });
});
