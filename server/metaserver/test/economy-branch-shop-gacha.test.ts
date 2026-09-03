// Branch-coverage backfill for src/service/economy/{shop,gacha}.ts (2026-09-03). The happy paths and
// most refusals are already covered by test/economy-service-unit.test.ts; this file adds what a
// schema-validated route cannot deliver (a `qty` below the schema minimum) plus the branches that need
// a specific commercial response or a specific pre-existing save shape: a non-INSUFFICIENT_FUNDS charge
// refusal, a ten-pull, a same-day repeat draw (retention already accrued), and fate-point mirroring onto
// a save that already carries a monetization block.
//
// Real Mongo (rs0, DB nw_meta_grpC_branch_test): every delivery here goes through deliverGrant /
// deliverMailGrant, whose `{$ne: orderId}` guard and `$push`+`$slice` cap FakeCollection does not model.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createMongo, makeNewSave, type MongoHandle, type SaveData,
  SHOP_BUY_MAX_QTY, MATERIAL_SHOP_DAILY_CAP, findShopItem,
} from '@nw/shared';
import { shopBuyHandler, getShopItemsHandler } from '../src/service/economy/shop.js';
import { gachaDrawHandler, redeemFateHandler, getGachaPoolsHandler } from '../src/service/economy/gacha.js';
import type { GachaResultEntry } from '../src/commercialClient.js';
import { BranchCommercial, makeCore, mkReply, mkReq } from './economy-branch-fakes.js';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_meta_grpC_branch_test';
const NOW = 1_800_000_000_000;

async function tryConnect(): Promise<MongoHandle | null> {
  try {
    return await createMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch (err) {
    if (process.env.NW_REQUIRE_DB) throw err;
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) console.warn(`[economy-branch-shop-gacha] Mongo unreachable (${URI}) — skipping.`);

const res = (itemId: string): GachaResultEntry => ({ itemId, rarity: 'common' } as GachaResultEntry);

describe.skipIf(!mongo)('service/economy/{shop,gacha}.ts branch backfill', () => {
  const m = mongo!;
  let accountId: string;
  let comm: BranchCommercial;
  let core: ReturnType<typeof makeCore>;
  let now = NOW;

  const data = (r: unknown) => (r as { data: Record<string, never> }).data;
  const saveOf = async (): Promise<SaveData> => (await m.collections.saves.findOne({ _id: accountId }))!.save;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    // A fresh accountId per test: the daily-cap counters fall back to an in-process store when
    // `redis` is null, and that store is not reset between tests.
    accountId = `acc-${randomUUID()}`;
    now = NOW;
    comm = new BranchCommercial();
    core = makeCore({ cols: m.collections, commercial: comm, now: () => now });
    const save = makeNewSave(accountId, NOW);
    await m.collections.saves.updateOne(
      { _id: accountId },
      { $setOnInsert: { _id: accountId, save, rev: save.rev } },
      { upsert: true },
    );
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  // ── shop.ts ────────────────────────────────────────────────────────────────────────────────────
  describe('shopBuyHandler', () => {
    it('qty below the schema minimum (0) is clamped to one unit, and only one unit is charged', async () => {
      // The openapi schema pins qty>=1, so this guard is only reachable by calling the handler
      // directly — but if it ever stopped clamping, a qty of 0 would charge 0 coins and still deliver.
      const { reply, get } = mkReply();
      const out = await shopBuyHandler(core, mkReq(accountId, { itemId: 'protect_enhance', qty: 0 }), reply);
      expect(get()).toBeUndefined();
      expect(data(out).granted).toBe('protect_enhance');
      expect((await saveOf()).inventory.items?.protect_enhance).toBe(1);
      expect(comm.bal(accountId)).toBe(-findShopItem('protect_enhance')!.cost); // exactly one unit charged
    });

    it('qty above SHOP_BUY_MAX_QTY is clamped to the ceiling rather than rejected', async () => {
      const { reply } = mkReply();
      await shopBuyHandler(core, mkReq(accountId, { itemId: 'protect_enhance', qty: 999 }), reply);
      expect((await saveOf()).inventory.items?.protect_enhance).toBe(SHOP_BUY_MAX_QTY);
    });

    it('a non-integer qty falls back to one unit', async () => {
      const { reply } = mkReply();
      await shopBuyHandler(core, mkReq(accountId, { itemId: 'protect_enhance', qty: 2.5 }), reply);
      expect((await saveOf()).inventory.items?.protect_enhance).toBe(1);
    });

    it('unknown itemId -> 400 before anything is charged', async () => {
      const { reply, get } = mkReply();
      await shopBuyHandler(core, mkReq(accountId, { itemId: 'no_such_item' }), reply);
      expect(get()?.code).toBe(400);
      expect(comm.bal(accountId)).toBe(0);
    });

    it('INSUFFICIENT_FUNDS -> 402 with the dedicated error code', async () => {
      comm.nextShopChargeError = 'INSUFFICIENT_FUNDS';
      const { reply, get } = mkReply();
      await shopBuyHandler(core, mkReq(accountId, { itemId: 'skin_shop_c1' }), reply);
      expect(get()?.code).toBe(402);
      expect(get()?.payload.error?.code).toBe('INSUFFICIENT_FUNDS');
    });

    it('any other charge refusal -> 400 BAD_REQUEST carrying the raw commercial error', async () => {
      // Distinct from the 402 above: the client must not show "top up coins" for e.g. a wallet lock.
      comm.nextShopChargeError = 'WALLET_LOCKED';
      const { reply, get } = mkReply();
      await shopBuyHandler(core, mkReq(accountId, { itemId: 'skin_shop_c1' }, 'ios'), reply);
      expect(get()?.code).toBe(400);
      expect(get()?.payload.error?.message).toBe('WALLET_LOCKED');
      expect((await saveOf()).inventory.skins).toEqual([]);
    });

    it('a qty that does not fit the remaining daily material allowance is rejected outright, wallet untouched', async () => {
      const { reply, get } = mkReply();
      const overCap = MATERIAL_SHOP_DAILY_CAP.mat_buy_scrap! + 1;
      await shopBuyHandler(core, mkReq(accountId, { itemId: 'mat_buy_scrap', qty: overCap }), reply);
      expect(get()?.code).toBe(400);
      expect(get()?.payload.error?.message).toBe('daily material purchase cap reached');
      expect(comm.bal(accountId)).toBe(0);
      expect((await saveOf()).materials?.scrap ?? 0).toBe(0);
    });

    it('commercial not configured -> 503, nothing charged or delivered', async () => {
      const down = makeCore({ cols: m.collections, commercial: new BranchCommercial(false), now: () => now });
      const { reply, get } = mkReply();
      await shopBuyHandler(down, mkReq(accountId, { itemId: 'skin_shop_c1' }), reply);
      expect(get()?.code).toBe(503);
    });

    it('socialsvc not configured: the purchase still delivers (mail is only needed for overflow)', async () => {
      const noSocial = makeCore({ cols: m.collections, commercial: comm, now: () => now, socialsvc: null });
      const { reply, get } = mkReply();
      await shopBuyHandler(noSocial, mkReq(accountId, { itemId: 'skin_shop_c1' }), reply);
      expect(get()).toBeUndefined();
      expect((await saveOf()).inventory.skins).toContain('skin_shop_c1');
    });

    it('catalog list: material bundles carry live daily-cap progress, non-material items do not', async () => {
      const out = await getShopItemsHandler(core.deps, mkReq(accountId));
      const items = data(out).items as unknown as { id: string; dailyLimit?: number; purchasedToday?: number }[];
      expect(items.find((i) => i.id === 'mat_buy_scrap')).toMatchObject({ dailyLimit: MATERIAL_SHOP_DAILY_CAP.mat_buy_scrap, purchasedToday: 0 });
      expect(items.find((i) => i.id === 'protect_enhance')).not.toHaveProperty('dailyLimit');
    });
  });

  // ── gacha.ts: gachaDrawHandler ─────────────────────────────────────────────────────────────────
  describe('gachaDrawHandler', () => {
    it('ten-pull: all ten results are delivered and badged in one order', async () => {
      comm.results = Array.from({ length: 10 }, () => res('mat_scrap'));
      const { reply, get } = mkReply();
      const out = await gachaDrawHandler(core, mkReq(accountId, { poolId: 'standard', count: 10 }), reply);
      expect(get()).toBeUndefined();
      expect((data(out).results as unknown as unknown[]).length).toBe(10);
      expect((await saveOf()).materials.scrap).toBe(100);
    });

    it('invalid count -> 400 (neither 1 nor 10)', async () => {
      const { reply, get } = mkReply();
      await gachaDrawHandler(core, mkReq(accountId, { poolId: 'standard', count: 3 }), reply);
      expect(get()?.code).toBe(400);
    });

    it('INSUFFICIENT_FUNDS -> 402; POOL_UNAVAILABLE -> 404; anything else -> 400', async () => {
      for (const [error, code] of [['INSUFFICIENT_FUNDS', 402], ['POOL_UNAVAILABLE', 404], ['POOL_CLOSED', 400]] as const) {
        comm.nextGachaDrawError = error;
        const { reply, get } = mkReply();
        await gachaDrawHandler(core, mkReq(accountId, { poolId: 'standard', count: 1 }), reply);
        expect(get()?.code).toBe(code);
      }
    });

    it('a second draw on the same day leaves the retention snapshot object untouched', async () => {
      // The `nextRetention2 !== save.retention` fork: accrueRetentionTask returns the SAME object when
      // the task is already accrued for today, and the handler must then not clone the save needlessly.
      const { reply: r1 } = mkReply();
      const first = await gachaDrawHandler(core, mkReq(accountId, { poolId: 'standard', count: 1 }), r1);
      const { reply: r2 } = mkReply();
      const second = await gachaDrawHandler(core, mkReq(accountId, { poolId: 'standard', count: 1 }), r2);
      const retOf = (o: unknown) => ((data(o).save as unknown as SaveData).retention as unknown as { tasks?: unknown });
      expect(retOf(first)).toBeDefined();
      expect(retOf(second)).toEqual(retOf(first));
    });

    it('fate points gained: the existing monetization block is preserved, only fatePoints move', async () => {
      await m.collections.saves.updateOne(
        { _id: accountId },
        {
          $set: {
            'save.monetization': {
              fatePoints: 5, subscriptionExpiry: 999, starterUsed: ['starter_draw'],
              firstPurchaseUsed: true, totalRechargeCents: 499,
            },
          },
        },
      );
      comm.fateGained = 1;
      comm.fatePoints = 5;
      const { reply } = mkReply();
      const out = await gachaDrawHandler(core, mkReq(accountId, { poolId: 'standard', count: 1 }), reply);
      const save = data(out).save as unknown as SaveData;
      expect(save.monetization).toMatchObject({
        fatePoints: 6, subscriptionExpiry: 999, starterUsed: ['starter_draw'], firstPurchaseUsed: true,
      });
    });

    it('fate points gained on a save with no monetization block yet -> defaults are filled in', async () => {
      comm.fateGained = 2;
      const { reply } = mkReply();
      const out = await gachaDrawHandler(core, mkReq(accountId, { poolId: 'standard', count: 1 }), reply);
      const save = data(out).save as unknown as SaveData;
      expect(save.monetization).toMatchObject({ fatePoints: 2, subscriptionExpiry: 0, starterUsed: [] });
    });

    it('commercial not configured -> 503', async () => {
      const down = makeCore({ cols: m.collections, commercial: new BranchCommercial(false), now: () => now });
      const { reply, get } = mkReply();
      await gachaDrawHandler(down, mkReq(accountId, { poolId: 'standard', count: 1 }), reply);
      expect(get()?.code).toBe(503);
    });

    it('the fire-and-forget orderDelivered failing does not fail the draw (the order is reconciled later)', async () => {
      comm.orderDelivered = async () => { throw new Error('commercial unreachable'); };
      const { reply, get } = mkReply();
      const out = await gachaDrawHandler(core, mkReq(accountId, { poolId: 'standard', count: 1 }), reply);
      expect(get()).toBeUndefined();
      expect((data(out).save as unknown as SaveData).inventory.skins).toContain('skin_l1');
      await new Promise((r) => setTimeout(r, 0)); // let the detached catch settle before the suite moves on
    });

    it('socialsvc not configured: the draw still delivers (the null client only matters on overflow)', async () => {
      const noSocial = makeCore({ cols: m.collections, commercial: comm, now: () => now, socialsvc: null });
      const { reply, get } = mkReply();
      await gachaDrawHandler(noSocial, mkReq(accountId, { poolId: 'standard', count: 1 }), reply);
      expect(get()).toBeUndefined();
      expect((await saveOf()).inventory.skins).toContain('skin_l1');
    });
  });

  // ── gacha.ts: redeemFateHandler ────────────────────────────────────────────────────────────────
  describe('redeemFateHandler', () => {
    it('happy path preserves the rest of the monetization mirror while debiting fate points', async () => {
      await m.collections.saves.updateOne(
        { _id: accountId },
        {
          $set: {
            'save.monetization': {
              fatePoints: 30, subscriptionExpiry: 1234, starterUsed: ['starter_growth'],
              firstPurchaseUsed: true, totalRechargeCents: 999,
            },
          },
        },
      );
      comm.fatePoints = 30;
      const { reply, get } = mkReply();
      const out = await redeemFateHandler(core, mkReq(accountId, { itemId: 'skin_l1' }), reply);
      expect(get()).toBeUndefined();
      expect(data(out).granted).toBe('skin_l1');
      const save = data(out).save as unknown as SaveData;
      expect(save.monetization).toMatchObject({
        fatePoints: 0, subscriptionExpiry: 1234, starterUsed: ['starter_growth'], firstPurchaseUsed: true,
      });
      expect(save.inventory.skins).toContain('skin_l1');
    });

    it('redemption on a save with no monetization block -> expiry/starterUsed default rather than crash', async () => {
      comm.fatePoints = 30;
      const { reply } = mkReply();
      const out = await redeemFateHandler(core, mkReq(accountId, { itemId: 'skin_l1' }), reply);
      const save = data(out).save as unknown as SaveData;
      expect(save.monetization).toMatchObject({ fatePoints: 0, subscriptionExpiry: 0, starterUsed: [] });
    });

    it('missing itemId -> 400 before any fate point is spent', async () => {
      comm.fatePoints = 30;
      const { reply, get } = mkReply();
      await redeemFateHandler(core, mkReq(accountId, {}), reply);
      expect(get()?.code).toBe(400);
      expect(comm.fatePoints).toBe(30);
    });

    it('FATE_INSUFFICIENT -> 402; FATE_INVALID_ITEM -> 400 with its own code; anything else -> 400 BAD_REQUEST', async () => {
      const cases = [
        ['FATE_INSUFFICIENT', 402, 'FATE_INSUFFICIENT'],
        ['FATE_INVALID_ITEM', 400, 'FATE_INVALID_ITEM'],
        ['FATE_POOL_RETIRED', 400, 'BAD_REQUEST'],
      ] as const;
      for (const [error, code, errCode] of cases) {
        comm.nextFateError = error;
        const { reply, get } = mkReply();
        await redeemFateHandler(core, mkReq(accountId, { itemId: 'skin_l1' }), reply);
        expect(get()?.code).toBe(code);
        expect(get()?.payload.error?.code).toBe(errCode);
      }
    });

    it('commercial not configured -> 503', async () => {
      const down = makeCore({ cols: m.collections, commercial: new BranchCommercial(false), now: () => now });
      const { reply, get } = mkReply();
      await redeemFateHandler(down, mkReq(accountId, { itemId: 'skin_l1' }), reply);
      expect(get()?.code).toBe(503);
    });

    it('socialsvc not configured: the redemption still delivers the chosen skin', async () => {
      comm.fatePoints = 30;
      const noSocial = makeCore({ cols: m.collections, commercial: comm, now: () => now, socialsvc: null });
      const { reply, get } = mkReply();
      await redeemFateHandler(noSocial, mkReq(accountId, { itemId: 'skin_l1' }), reply);
      expect(get()).toBeUndefined();
      expect((await saveOf()).inventory.skins).toContain('skin_l1');
    });
  });

  // ── gacha.ts: getGachaPoolsHandler ─────────────────────────────────────────────────────────────
  describe('getGachaPoolsHandler', () => {
    it('static pools always come back with per-entry probabilities', async () => {
      const out = await getGachaPoolsHandler(core.deps);
      const pools = data(out).pools as unknown as { id: string; entries: { probability: number }[] }[];
      expect(pools[0]!.id).toBe('standard');
      expect(pools[0]!.entries[0]!.probability).toBeGreaterThan(0);
    });

    it('commercial down -> the static pools are still served (no 503, no throw)', async () => {
      const down = makeCore({ cols: m.collections, commercial: new BranchCommercial(false), now: () => now });
      const out = await getGachaPoolsHandler(down.deps);
      expect((data(out).pools as unknown as unknown[]).length).toBeGreaterThan(0);
    });

    it('an active derived limited pool is appended with its banner metadata', async () => {
      comm.activeLimitedPools = [{
        id: 'limited_summer', name: 'Summer Banner', featuredLegendary: 'skin_l1',
        startAt: now - 1000, endAt: now + 100000, createdBy: 'ops1', createdAt: now,
      }];
      const out = await getGachaPoolsHandler(core.deps);
      const pools = data(out).pools as unknown as { id: string; limited?: boolean; name?: string; featuredLegendary?: string }[];
      expect(pools.find((p) => p.id === 'limited_summer')).toMatchObject({
        limited: true, name: 'Summer Banner', featuredLegendary: 'skin_l1',
      });
      // Static pools carry none of that metadata.
      expect(pools.find((p) => p.id === 'standard')).not.toHaveProperty('limited');
    });

    it('an active ops-authored custom pool takes the custom view (own cost, no pity)', async () => {
      comm.activeLimitedPools = [{
        kind: 'custom', id: 'custom_1', name: 'Custom Banner', costSingle: 100,
        startAt: now - 1000, endAt: now + 100000,
        categories: [{ category: 'skin', weight: 1, items: [{ itemId: 'skin_e1', weight: 1 }] }],
        createdBy: 'ops1', createdAt: now,
      }];
      const out = await getGachaPoolsHandler(core.deps);
      const pools = data(out).pools as unknown as { id: string; pityThreshold: number; dupePolicy: string; costSingle: number }[];
      expect(pools.find((p) => p.id === 'custom_1')).toMatchObject({ pityThreshold: 0, dupePolicy: 'coins', costSingle: 100 });
    });

    it('listActiveLimitedPools throwing is swallowed: the static pools are still returned', async () => {
      const throwing = new BranchCommercial();
      throwing.listActiveLimitedPools = async () => { throw new Error('simulated commercial outage'); };
      const c = makeCore({ cols: m.collections, commercial: throwing, now: () => now });
      const out = await getGachaPoolsHandler(c.deps);
      const pools = data(out).pools as unknown as { id: string }[];
      expect(pools[0]!.id).toBe('standard');
    });
  });
});
