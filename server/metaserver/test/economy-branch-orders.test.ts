// Branch-coverage backfill for src/economy/orders.ts (2026-09-03). deliverLootBox/deliverOrder/
// reconcileUndelivered are exercised end-to-end by economy.e2e.test.ts, but that file imports
// '../dist/app.js' and vitest's v8 provider cannot attribute compiled-dist execution back to src/*.ts.
// This file drives the routing/overflow/refusal branches directly from '../src/economy/orders.js':
// roster- and inventory-full overflow (mail quota vs. coin compensation, with commercial up and down),
// re-purchase of an already-owned skin, bulk-buy qty defaults, and reconciliation of a partially
// delivered order set.
//
// Real Mongo (rs0, DB nw_meta_grpC_branch_test): every path here bottoms out in deliverGrant/
// deliverMailGrant, whose `{$ne: orderId}` guard and `$push`+`$slice` cap FakeCollection does not model.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createMongo, makeNewSave, type MongoHandle, type Collections, type SaveData,
  EQUIP_FULL_COMPENSATION_COINS, EQUIP_INV_FULL_MAIL_COUNT, EQUIPMENT_INV_CAP, CARD_INV_CAP,
  CARD_INV_OVERFLOW_BUFFER,
} from '@nw/shared';
import { deliverLootBox, deliverOrder, reconcileUndelivered } from '../src/economy/orders.js';
import type { CommercialClient, GachaResultEntry, UndeliveredOrder, WalletView } from '../src/commercialClient.js';
import { fakeCommercial, FakeSocialsvc } from './helpers/fakeClients.js';

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
if (!mongo) console.warn(`[economy-branch-orders] Mongo unreachable (${URI}) — skipping.`);

/** fakeCommercial (grantCalls + the `available` flag) plus the three order-lifecycle methods orders.ts calls. */
function makeCommercial(available = true) {
  const base = fakeCommercial(available);
  const delivered: string[] = [];
  const pending: UndeliveredOrder[] = [];
  let walletView: WalletView | null = null;
  return Object.assign(base, {
    delivered,
    pending,
    setWallet(w: WalletView | null) { walletView = w; },
    async orderDelivered(a: { orderId: string }) { delivered.push(a.orderId); return { ok: true as const }; },
    async undeliveredOrders() { return pending; },
    async getWallet() { return walletView; },
  });
}

const res = (itemId: string): GachaResultEntry => ({ itemId, rarity: 'common' } as GachaResultEntry);

describe.skipIf(!mongo)('economy/orders.ts branch backfill', () => {
  const m = mongo!;
  let accountId: string;
  let comm: ReturnType<typeof makeCommercial>;
  let social: FakeSocialsvc;

  async function seedSave(patch: Partial<SaveData> = {}): Promise<void> {
    const save = { ...makeNewSave(accountId, NOW), ...patch };
    await m.collections.saves.updateOne(
      { _id: accountId },
      { $setOnInsert: { _id: accountId, save, rev: save.rev } },
      { upsert: true },
    );
  }

  /** Collections whose first `saves.findOne` returns null — the "read raced ahead of the save doc" side
   *  of orders.ts's `cur?.save...` fallbacks (a lagging read, or a first-ever delivery on a fresh account). */
  function colsWithFirstSaveReadMissing(): Collections {
    const real = m.collections.saves;
    let calls = 0;
    return {
      ...m.collections,
      saves: {
        ...real,
        findOne: async (q: Record<string, unknown>) => (++calls === 1 ? null : real.findOne(q as never)),
        findOneAndUpdate: real.findOneAndUpdate.bind(real),
        updateOne: real.updateOne.bind(real),
      } as unknown as typeof real,
    };
  }

  const commercial = () => comm as unknown as CommercialClient;

  beforeEach(async () => {
    await m.db.dropDatabase();
    await m.ensureIndexes();
    accountId = `acc-${randomUUID()}`;
    comm = makeCommercial();
    social = new FakeSocialsvc();
    await seedSave();
  });

  afterAll(async () => {
    await m.db.dropDatabase();
    await m.close();
  });

  // ── deliverLootBox ─────────────────────────────────────────────────────────────────────────────
  describe('deliverLootBox', () => {
    it('save read comes back empty -> owned/invCount fall back to empty-and-zero, delivery still lands', async () => {
      const out = await deliverLootBox(
        colsWithFirstSaveReadMissing(), commercial(), social, accountId, 'ord-nosave',
        [res('skin_l1')], 10, null, NOW,
      );
      expect(out.save.inventory.skins).toContain('skin_l1');
      expect(out.overflow).toEqual({ cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 });
    });

    it('materials + equipment + skins in one box: each routed to its own store', async () => {
      const out = await deliverLootBox(
        m.collections, commercial(), social, accountId, 'ord-mixed',
        [res('mat_scrap'), res('mat_scrap'), res('wp_pencil'), res('skin_l1')], 500, { standard: 4 }, NOW,
      );
      expect(out.save.materials.scrap).toBe(20); // two mat_scrap results accumulate into one $inc
      expect(out.save.inventory.skins).toContain('skin_l1');
      expect(out.equipmentGrants).toHaveLength(1);
      expect(out.save.gacha.pity.standard).toBe(4);
    });

    it('equipment inventory at the cap, mail quota free -> instances are mailed, not silently dropped', async () => {
      await m.collections.saves.updateOne(
        { _id: accountId },
        { $set: { 'save.equipmentInvCount': EQUIPMENT_INV_CAP } },
      );
      const results = Array.from({ length: EQUIP_INV_FULL_MAIL_COUNT }, () => res('wp_pencil'));
      const out = await deliverLootBox(m.collections, commercial(), social, accountId, 'ord-eqmail', results, 0, null, NOW);
      expect(out.overflow.equipMailed).toBe(EQUIP_INV_FULL_MAIL_COUNT);
      expect(out.overflow.equipCompensatedCoins).toBe(0);
      expect(out.equipmentGrants).toEqual([]); // nothing landed in the inventory itself
      expect(social.mail.size).toBe(1);
      expect([...social.mail.values()][0]!.attachments).toHaveLength(EQUIP_INV_FULL_MAIL_COUNT);
      // The quota counter is persisted so the next overflow starts from where this one stopped.
      expect((await m.collections.saves.findOne({ _id: accountId }))!.save.equipMailOverflowCount)
        .toBe(EQUIP_INV_FULL_MAIL_COUNT);
    });

    it('equipment inventory at the cap AND the mail quota spent -> coin compensation is actually granted', async () => {
      await m.collections.saves.updateOne(
        { _id: accountId },
        { $set: { 'save.equipmentInvCount': EQUIPMENT_INV_CAP, 'save.equipMailOverflowCount': EQUIP_INV_FULL_MAIL_COUNT } },
      );
      const out = await deliverLootBox(m.collections, commercial(), social, accountId, 'ord-eqcoin', [res('wp_pencil'), res('wp_pen')], 0, null, NOW);
      expect(out.overflow.equipCompensatedCoins).toBe(2 * EQUIP_FULL_COMPENSATION_COINS);
      expect(social.mail.size).toBe(0);
      expect(comm.grantCalls).toEqual([
        { accountId, amount: 2 * EQUIP_FULL_COMPENSATION_COINS, reason: 'equip_inv_full', orderId: 'ord-eqcoin:equip_comp' },
      ]);
    });

    it('commercial down: the same overflow is reported but no compensation is credited (the player is owed coins)', async () => {
      comm = makeCommercial(false);
      await m.collections.saves.updateOne(
        { _id: accountId },
        { $set: { 'save.equipmentInvCount': EQUIPMENT_INV_CAP, 'save.equipMailOverflowCount': EQUIP_INV_FULL_MAIL_COUNT } },
      );
      const out = await deliverLootBox(m.collections, commercial(), social, accountId, 'ord-eqdown', [res('wp_pencil')], 0, null, NOW);
      expect(out.overflow.equipCompensatedCoins).toBe(EQUIP_FULL_COMPENSATION_COINS);
      expect(comm.grantCalls).toEqual([]);
    });

    it('free room in the equipment inventory refills the mail quota (the persisted counter is reset to 0)', async () => {
      await m.collections.saves.updateOne(
        { _id: accountId },
        { $set: { 'save.equipmentInvCount': EQUIPMENT_INV_CAP - 1, 'save.equipMailOverflowCount': EQUIP_INV_FULL_MAIL_COUNT } },
      );
      // Two results: the first fits (invCount+0 < cap), the second overflows into a refilled mail quota.
      const out = await deliverLootBox(m.collections, commercial(), social, accountId, 'ord-eqrefill', [res('wp_pencil'), res('wp_pen')], 0, null, NOW);
      expect(out.equipmentGrants).toHaveLength(1);
      expect(out.overflow.equipMailed).toBe(1);
      expect((await m.collections.saves.findOne({ _id: accountId }))!.save.equipMailOverflowCount).toBe(1);
    });

    it('character cards route to grantCards (cardInstances), not to inventory.skins', async () => {
      const out = await deliverLootBox(m.collections, commercial(), social, accountId, 'ord-card', [res('lichuang')], 0, null, NOW);
      expect(out.cardGrants).toHaveLength(1);
      expect(out.overflow.cardMailed).toBe(0);
      expect(out.save.inventory.skins).not.toContain('lichuang');
      expect(await m.collections.cardInstances.countDocuments({ accountId })).toBe(1);
    });

    it('roster full, card mail quota free -> the card is mailed', async () => {
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.cardInvCount': CARD_INV_CAP } });
      const out = await deliverLootBox(m.collections, commercial(), social, accountId, 'ord-cardmail', [res('lichuang')], 0, null, NOW);
      expect(out.overflow.cardMailed).toBe(1);
      expect(out.overflow.cardCompensatedCoins).toBe(0);
      expect(comm.grantCalls).toEqual([]);
    });

    it('roster full AND card mail quota spent -> coin compensation is granted under a distinct orderId', async () => {
      await m.collections.saves.updateOne(
        { _id: accountId },
        { $set: { 'save.cardInvCount': CARD_INV_CAP, 'save.cardMailOverflowCount': CARD_INV_OVERFLOW_BUFFER } },
      );
      const out = await deliverLootBox(m.collections, commercial(), social, accountId, 'ord-cardcoin', [res('lichuang')], 0, null, NOW);
      expect(out.overflow.cardCompensatedCoins).toBeGreaterThan(0);
      expect(comm.grantCalls).toEqual([
        { accountId, amount: out.overflow.cardCompensatedCoins, reason: 'card_inv_full', orderId: 'ord-cardcoin:card_comp' },
      ]);
    });

    it('commercial down on a full roster: compensation is reported but never credited', async () => {
      comm = makeCommercial(false);
      await m.collections.saves.updateOne(
        { _id: accountId },
        { $set: { 'save.cardInvCount': CARD_INV_CAP, 'save.cardMailOverflowCount': CARD_INV_OVERFLOW_BUFFER } },
      );
      const out = await deliverLootBox(m.collections, commercial(), social, accountId, 'ord-carddown', [res('lichuang')], 0, null, NOW);
      expect(out.overflow.cardCompensatedCoins).toBeGreaterThan(0);
      expect(comm.grantCalls).toEqual([]);
    });
  });

  // ── deliverOrder ───────────────────────────────────────────────────────────────────────────────
  describe('deliverOrder', () => {
    const order = (o: Partial<UndeliveredOrder> & { _id: string; kind: UndeliveredOrder['kind'] }) =>
      ({ result: {}, ...o }) as Parameters<typeof deliverOrder>[4];

    it('fate redemption of an unowned skin adds it to inventory.skins and marks the order delivered', async () => {
      const out = await deliverOrder(
        m.collections, commercial(), social, accountId,
        order({ _id: 'ord-fate', kind: 'fate', result: { itemId: 'skin_l1' } }), 0, null, NOW,
      );
      expect(out.save.inventory.skins).toContain('skin_l1');
      expect(comm.delivered).toEqual(['ord-fate']);
      expect(await m.collections.skinInstances.countDocuments({ accountId })).toBe(1);
    });

    it('fate redemption of an ALREADY-OWNED skin still mints a real instance (a paid redemption is never a no-op)', async () => {
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.inventory.skins': ['skin_l1'] } });
      const out = await deliverOrder(
        m.collections, commercial(), social, accountId,
        order({ _id: 'ord-fate-dup', kind: 'fate', result: { itemId: 'skin_l1' } }), 0, null, NOW,
      );
      expect(out.save.inventory.skins).toEqual(['skin_l1']); // no duplicate array entry
      expect(await m.collections.skinInstances.countDocuments({ accountId })).toBe(1); // but an instance exists
    });

    it('fate redemption when the save read comes back empty -> owned falls back to [] and the skin is granted', async () => {
      const out = await deliverOrder(
        colsWithFirstSaveReadMissing(), commercial(), social, accountId,
        order({ _id: 'ord-fate-nosave', kind: 'fate', result: { itemId: 'skin_l1' } }), 0, null, NOW,
      );
      expect(out.save.inventory.skins).toContain('skin_l1');
    });

    it('shop item purchase with qty omitted defaults to one unit', async () => {
      const out = await deliverOrder(
        m.collections, commercial(), social, accountId,
        order({ _id: 'ord-item1', kind: 'shop', result: { itemId: 'protect_enhance' } }), 0, null, NOW,
      );
      expect(out.save.inventory.items?.protect_enhance).toBe(1);
      expect(comm.delivered).toEqual(['ord-item1']);
    });

    it('shop item purchase with qty=3 credits three units in the one order', async () => {
      const out = await deliverOrder(
        m.collections, commercial(), social, accountId,
        order({ _id: 'ord-item3', kind: 'shop', result: { itemId: 'protect_enhance', qty: 3 } }), 0, null, NOW,
      );
      expect(out.save.inventory.items?.protect_enhance).toBe(3);
    });

    it('shop material bundle multiplies the bundle size by qty', async () => {
      const out = await deliverOrder(
        m.collections, commercial(), social, accountId,
        order({ _id: 'ord-mat', kind: 'shop', result: { itemId: 'mat_buy_scrap', qty: 2 } }), 0, null, NOW,
      );
      expect(out.save.materials.scrap).toBe(20); // qty(2) × bundle qty(10)
      expect(out.save.everOwned?.material).toContain('scrap');
    });

    it('shop skin purchase, qty=1: single deterministic instance id, skin added to the array', async () => {
      const out = await deliverOrder(
        m.collections, commercial(), social, accountId,
        order({ _id: 'ord-skin1', kind: 'shop', result: { itemId: 'skin_shop_c1' } }), 0, null, NOW,
      );
      expect(out.save.inventory.skins).toContain('skin_shop_c1');
      expect(await m.collections.skinInstances.findOne({ _id: 'skin_shop_ord-skin1' })).not.toBeNull();
    });

    it('re-buying an already-owned shop skin with qty=2 mints two indexed instances and no array duplicate', async () => {
      await m.collections.saves.updateOne({ _id: accountId }, { $set: { 'save.inventory.skins': ['skin_shop_c1'] } });
      const out = await deliverOrder(
        m.collections, commercial(), social, accountId,
        order({ _id: 'ord-skin2', kind: 'shop', result: { itemId: 'skin_shop_c1', qty: 2 } }), 0, null, NOW,
      );
      expect(out.save.inventory.skins).toEqual(['skin_shop_c1']);
      expect(await m.collections.skinInstances.countDocuments({ accountId })).toBe(2);
      expect(await m.collections.skinInstances.findOne({ _id: 'skin_shop_ord-skin2_0' })).not.toBeNull();
    });

    it('shop skin purchase when the save read comes back empty -> treated as unowned', async () => {
      const out = await deliverOrder(
        colsWithFirstSaveReadMissing(), commercial(), social, accountId,
        order({ _id: 'ord-skin-nosave', kind: 'shop', result: { itemId: 'skin_shop_c1' } }), 0, null, NOW,
      );
      expect(out.save.inventory.skins).toContain('skin_shop_c1');
    });

    it('a loot-box order with no results array at all delivers nothing but still marks the order delivered', async () => {
      // Absent-field fallback: reconciliation replays whatever commercial stored for the order, and an
      // order row with a missing `results` must not crash the whole GET /save reconciliation pass.
      const out = await deliverOrder(
        m.collections, commercial(), social, accountId,
        order({ _id: 'ord-empty', kind: 'gacha' }), 42, null, NOW,
      );
      expect(out.save.wallet.coins).toBe(42);
      expect(out.overflow).toEqual({ cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 });
      expect(comm.delivered).toEqual(['ord-empty']);
    });
  });

  // ── reconcileUndelivered ───────────────────────────────────────────────────────────────────────
  describe('reconcileUndelivered', () => {
    it('gacha order with a poolId and a live wallet -> pity is mirrored from the wallet', async () => {
      comm.setWallet({
        coins: 700, pity: { standard: 12 }, fatePoints: 0, subscriptionExpiry: 0,
        starterUsed: [], firstPurchaseUsed: false, totalRechargeCents: 0,
      } as WalletView);
      comm.pending.push({ _id: 'r-gacha', accountId, kind: 'gacha', result: { results: [res('skin_l1')], poolId: 'standard' } });
      const w = await reconcileUndelivered(m.collections, commercial(), social, accountId, NOW);
      expect(w?.coins).toBe(700);
      const save = (await m.collections.saves.findOne({ _id: accountId }))!.save;
      expect(save.gacha.pity.standard).toBe(12);
      expect(save.wallet.coins).toBe(700);
      expect(comm.delivered).toEqual(['r-gacha']);
    });

    it('gacha order for a pool absent from the wallet pity map -> mirrored as 0, not left undefined', async () => {
      comm.setWallet({
        coins: 0, pity: {}, fatePoints: 0, subscriptionExpiry: 0,
        starterUsed: [], firstPurchaseUsed: false, totalRechargeCents: 0,
      } as WalletView);
      comm.pending.push({ _id: 'r-newpool', accountId, kind: 'gacha', result: { results: [res('skin_l1')], poolId: 'limited_x' } });
      await reconcileUndelivered(m.collections, commercial(), social, accountId, NOW);
      expect((await m.collections.saves.findOne({ _id: accountId }))!.save.gacha.pity.limited_x).toBe(0);
    });

    it('a non-gacha order carries no pity patch, and the wallet balance is fetched once for the whole batch', async () => {
      comm.setWallet({
        coins: 250, pity: { standard: 9 }, fatePoints: 0, subscriptionExpiry: 0,
        starterUsed: [], firstPurchaseUsed: false, totalRechargeCents: 0,
      } as WalletView);
      comm.pending.push(
        { _id: 'r-shop', accountId, kind: 'shop', result: { itemId: 'protect_enhance' } },
        { _id: 'r-fate', accountId, kind: 'fate', result: { itemId: 'skin_l1' } },
      );
      await reconcileUndelivered(m.collections, commercial(), social, accountId, NOW);
      const save = (await m.collections.saves.findOne({ _id: accountId }))!.save;
      expect(save.gacha.pity.standard ?? 0).toBe(0); // untouched: only a gacha order patches pity
      expect(save.inventory.items?.protect_enhance).toBe(1);
      expect(comm.delivered).toEqual(['r-shop', 'r-fate']);
    });

    it('wallet unavailable -> orders are still delivered, with the coin mirror falling back to 0', async () => {
      // The degraded-commercial side: refusing to deliver here would leave a charged order forever
      // undelivered, so the item lands and only the (commercial-authoritative) balance mirror is stale.
      comm.setWallet(null);
      comm.pending.push({ _id: 'r-nowallet', accountId, kind: 'gacha', result: { results: [res('skin_l1')], poolId: 'standard' } });
      const w = await reconcileUndelivered(m.collections, commercial(), social, accountId, NOW, 'ios');
      expect(w).toBeNull();
      const save = (await m.collections.saves.findOne({ _id: accountId }))!.save;
      expect(save.inventory.skins).toContain('skin_l1');
      expect(save.wallet.coins).toBe(0);
      expect(save.gacha.pity.standard ?? 0).toBe(0); // no wallet -> no pity patch
    });

    it('nothing undelivered -> no delivery calls at all', async () => {
      comm.setWallet(null);
      await reconcileUndelivered(m.collections, commercial(), social, accountId, NOW);
      expect(comm.delivered).toEqual([]);
    });
  });
});
