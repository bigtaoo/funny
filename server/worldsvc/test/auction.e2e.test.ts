// worldsvc AuctionService 端到端（S8-5）：真实 Mongo 专属库。Mongo 不可达整套 skip。
// 挂拍 / 购买（扣金币+发标的+付卖方+10%税） / 取消（退标的） / 过期扫描（退标的）；
// 校验：装备未实现 / 无效时长 / 上限 / 买自己 / 非拥有者取消 / 已成交不能再买 / NOT_DESIGNATED_BUYER。
// 需 `cd server && docker compose up -d`。
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AUCTION_DURATIONS_SEC, AUCTION_MAX_LISTINGS, AUCTION_TAX_RATE } from '@nw/shared';
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
  };

  let svc: AuctionService;
  let nowMs = Date.now();

  beforeEach(async () => {
    await mongo!.collections.auctions.deleteMany({});
    spends.length = 0;
    grants.length = 0;
    materialDeducts.length = 0;
    materialGrants.length = 0;
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

  it('装备未实现 → NOT_IMPLEMENTED', async () => {
    await expect(svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'equipment',
      item: { equipId: 'sword1' }, qty: 1, price: 100, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });
  });

  it('无效时长 → BAD_REQUEST', async () => {
    await expect(svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 1, durationSec: 999,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('挂单超上限 → AUCTION_LIMIT_REACHED', async () => {
    for (let i = 0; i < AUCTION_MAX_LISTINGS; i++) {
      await svc.createAuction({
        worldId: W, sellerId: 'alice', itemType: 'material',
        item: { material: 'scrap' }, qty: 1, price: 1, durationSec: DUR,
      });
    }
    await expect(svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 1, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'AUCTION_LIMIT_REACHED' });
  });

  it('购买：扣金币 + 发材料 + 付卖方（10%税）', async () => {
    const view = await svc.createAuction({
      worldId: W, sellerId: 'alice', itemType: 'material',
      item: { material: 'lead' }, qty: 2, price: 100, durationSec: DUR,
    });
    const bought = await svc.buyAuction(W, 'bob', view.auctionId);
    expect(bought.status).toBe('sold');
    expect(bought.buyerId).toBe('bob');
    expect(spends).toHaveLength(1);
    expect(spends[0]).toMatchObject({ account: 'bob', amount: 200 });
    expect(materialGrants).toHaveLength(1);
    expect(materialGrants[0]).toMatchObject({ account: 'bob', material: 'lead', qty: 2 });
    const tax = Math.floor(200 * AUCTION_TAX_RATE);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ account: 'alice', amount: 200 - tax });
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
});
