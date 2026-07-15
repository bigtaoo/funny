// worldsvc SLG shop e2e (SLG_DESIGN §8/G7 admin-configurable pricing): real Mongo.
//   ① buySlgShopItem deducts SLG_SHOP_ITEMS coins by default (no admin override loaded);
//   ② when a SlgShopPriceCache override is present, the discounted cost/effect is used instead;
//   ③ getSlgShopItems reflects the same override in the client-facing list;
//   ④ unknown item id → NOT_FOUND.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { SLG_MAP_W, SLG_MAP_H, SLG_SHOP_ITEMS, SlgShopPriceCache, playerWorldId } from '@nw/shared';
import { createWorldMongo, type WorldMongo } from '../src/db';
import { WorldService } from '../src/service';
import type { WorldCommercialClient } from '../src/commercialClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_world_shop_test';
const W = 's1-shop';

async function tryConnect(): Promise<WorldMongo | null> {
  try {
    return await createWorldMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[worldsvc.shop.e2e] Mongo unreachable (${URI}) — skipping. Run docker compose up -d first.`);

describe.skipIf(!mongo)('worldsvc SLG shop e2e', () => {
  const m = mongo!;
  let nowMs = 1_000_000;
  const now = () => nowMs;
  let spent: { accountId: string; amount: number }[];

  const fakeCommercial: WorldCommercialClient = {
    available: true,
    async spend(accountId, amount) { spent.push({ accountId, amount }); },
    async grant() { /* no-op */ },
  };

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    nowMs = 1_000_000;
    spent = [];
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  it('no admin override loaded → deducts the SLG_SHOP_ITEMS code-default cost', async () => {
    const svc = new WorldService({ cols: m.collections, redis: null, commercial: fakeCommercial, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
    await svc.joinWorld(W, 'a', 10, 10);
    const item = SLG_SHOP_ITEMS.find((i) => i.id === 'slg_res_s')!;

    const before = (await svc.getMe(W, 'a')).resources!.ink;
    await svc.buySlgShopItem(W, 'a', 'slg_res_s');

    expect(spent).toEqual([{ accountId: 'a', amount: item.cost }]);
    const after = await svc.getMe(W, 'a');
    expect(after.resources!.ink - before).toBe(item.effect['each']);
  });

  it('admin override present → uses the discounted cost + overridden effect instead of the code default', async () => {
    const item = SLG_SHOP_ITEMS.find((i) => i.id === 'slg_res_s')!;
    const shopPrices = new SlgShopPriceCache({
      fetchAll: async () => [
        { _id: 'slg_res_s', cost: 1, effect: { each: 999_999 }, updatedAt: 1, updatedBy: 'admin' },
      ],
    });
    await shopPrices.start();

    const svc = new WorldService({ cols: m.collections, redis: null, commercial: fakeCommercial, shopPrices, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
    await svc.joinWorld(W, 'a', 10, 10);

    await svc.buySlgShopItem(W, 'a', 'slg_res_s');
    expect(spent).toEqual([{ accountId: 'a', amount: 1 }]); // overridden cost, not item.cost (300)
    expect(spent[0]!.amount).not.toBe(item.cost);

    // RESOURCE_CAP clamps the actual stored value, but the deduction above already proves the override applied.
    const items = svc.getSlgShopItems();
    const resolved = items.find((i) => i.id === 'slg_res_s')!;
    expect(resolved.cost).toBe(1);
    expect(resolved.effect['each']).toBe(999_999);
    // Untouched items still report their code default.
    const untouched = items.find((i) => i.id === 'slg_speedup_1h')!;
    expect(untouched.cost).toBe(SLG_SHOP_ITEMS.find((i) => i.id === 'slg_speedup_1h')!.cost);
  });

  it('unknown item id → NOT_FOUND', async () => {
    const svc = new WorldService({ cols: m.collections, redis: null, commercial: fakeCommercial, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
    await svc.joinWorld(W, 'a', 10, 10);
    await expect(svc.buySlgShopItem(W, 'a', 'made_up')).rejects.toThrow('Item not found');
  });

  it('daily purchase cap: buying past dailyLimit throws SHOP_LIMIT_REACHED, resets the next UTC day', async () => {
    const svc = new WorldService({ cols: m.collections, redis: null, commercial: fakeCommercial, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
    await svc.joinWorld(W, 'a', 10, 10);
    const item = SLG_SHOP_ITEMS.find((i) => i.id === 'slg_res_s')!;
    expect(item.dailyLimit).toBe(5);

    for (let i = 0; i < item.dailyLimit!; i++) await svc.buySlgShopItem(W, 'a', 'slg_res_s');
    expect(spent.length).toBe(item.dailyLimit);
    await expect(svc.buySlgShopItem(W, 'a', 'slg_res_s')).rejects.toThrow('Daily purchase limit reached');
    expect(spent.length).toBe(item.dailyLimit); // the rejected attempt never reached commercial.spend

    // Advance past midnight UTC → counter resets, purchase succeeds again.
    nowMs += 86_400_000;
    await svc.buySlgShopItem(W, 'a', 'slg_res_s');
    expect(spent.length).toBe(item.dailyLimit! + 1);
  });

  it('items with no dailyLimit (protection/battle_pass) are unbounded', async () => {
    const svc = new WorldService({ cols: m.collections, redis: null, commercial: fakeCommercial, mapW: SLG_MAP_W, mapH: SLG_MAP_H, now });
    await svc.joinWorld(W, 'a', 10, 10);
    const item = SLG_SHOP_ITEMS.find((i) => i.id === 'slg_shield_8h')!;
    expect(item.dailyLimit).toBeUndefined();
    for (let i = 0; i < 20; i++) await svc.buySlgShopItem(W, 'a', 'slg_shield_8h');
    expect(spent.length).toBe(20);
  });
});
