// auctionsvc AuctionService end-to-end (auction task 4, migrated from server/worldsvc/test/auction.e2e.test.ts).
// Tests: listing / buying (deduct coins + deliver item + pay seller + 10% tax) / cancel (refund item) / expiry scan (refund item);
// validation: equipment not implemented / invalid duration / listing cap / buying own auction / non-owner cancel / already sold / NOT_DESIGNATED_BUYER;
// plus skin trading (§9 task4 new itemType).
// Requires `cd server && docker compose up -d` (or falls back to mongodb-memory-server via globalSetup).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUCTION_DURATIONS_SEC,
  AUCTION_MAX_LISTINGS,
  AUCTION_TAX_RATE,
  AUCTION_DAILY_LIST_CAP,
  SlgError,
  type EquipmentInstance,
} from '@nw/shared';
import { createAuctionMongo, type AuctionMongo } from '../src/db';
import { AuctionService } from '../src/auctionService';
import type { AuctionCommercialClient } from '../src/commercialClient';
import type { AuctionMetaClient } from '../src/metaClient';
import type { AuctionMailClient, AuctionMailContent } from '../src/mailClient';

const URI = process.env.NW_MONGO_URI ?? 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
const DB = 'nw_auction_e2e_test';

async function tryConnect(): Promise<AuctionMongo | null> {
  try {
    return await createAuctionMongo(URI, DB, { serverSelectionTimeoutMS: 1500 });
  } catch {
    return null;
  }
}

const mongo = await tryConnect();
if (!mongo) {
  console.warn(`[auctionsvc.auction.e2e] Mongo unreachable (${URI}) — skipping.`);
}

describe.skipIf(!mongo)('AuctionService e2e', () => {
  const spends: Array<{ account: string; amount: number; orderId: string }> = [];
  const grants: Array<{ account: string; amount: number; orderId: string }> = [];
  const materialDeducts: Array<{ account: string; material: string; qty: number; orderId: string }> = [];
  const materialGrants: Array<{ account: string; material: string; qty: number; orderId: string }> = [];
  // Equipment: simulated meta inventory (Map<account, Map<instanceId, instance>>) + escrow/transfer log.
  const equipInv = new Map<string, Map<string, EquipmentInstance>>();
  const equipEscrows: Array<{ account: string; instanceId: string; orderId: string }> = [];
  const equipGrants: Array<{ account: string; instanceId: string; orderId: string }> = [];
  const seedEquip = (acct: string, inst: EquipmentInstance): void => {
    if (!equipInv.has(acct)) equipInv.set(acct, new Map());
    equipInv.get(acct)!.set(inst.id, inst);
  };
  // Skin: simulated meta inventory (Map<account, Set<skinId>>).
  const skinInv = new Map<string, Set<string>>();
  const seedSkin = (acct: string, skinId: string): void => {
    if (!skinInv.has(acct)) skinInv.set(acct, new Set());
    skinInv.get(acct)!.add(skinId);
  };

  const commercial: AuctionCommercialClient = {
    available: true,
    async spend(accountId, amount, orderId) {
      spends.push({ account: accountId, amount, orderId });
    },
    async grant(accountId, amount, orderId) {
      grants.push({ account: accountId, amount, orderId });
    },
  };

  // Escrow-out model: item delivery/return goes through system mail (not direct meta grants). Spy on sent mail.
  const mails: Array<{ account: string; dispatchKey: string; content: AuctionMailContent }> = [];
  const mail: AuctionMailClient = {
    available: true,
    async sendSystemMail(accountId, dispatchKey, content) {
      mails.push({ account: accountId, dispatchKey, content });
    },
  };
  /** First attachment of the mail whose recipient matches and dispatchKey starts with the given prefix. */
  const mailAtt = (account: string, dispatchPrefix: string) =>
    mails.find((m) => m.account === account && m.dispatchKey.startsWith(dispatchPrefix))?.content.attachments?.[0];

  const meta: AuctionMetaClient = {
    available: true,
    async deductMaterial(accountId, material, qty, orderId) {
      materialDeducts.push({ account: accountId, material, qty, orderId });
    },
    async grantMaterial(accountId, material, qty, orderId) {
      materialGrants.push({ account: accountId, material, qty, orderId });
    },
    async escrowEquipment(accountId, instanceId) {
      const inv = equipInv.get(accountId);
      const inst = inv?.get(instanceId);
      if (!inst) throw new SlgError('EQUIP_NOT_FOUND');
      if (inst.locked) throw new SlgError('EQUIP_LOCKED');
      inv!.delete(instanceId);
      equipEscrows.push({ account: accountId, instanceId, orderId: '' });
      return inst;
    },
    async grantEquipment(accountId, instance) {
      seedEquip(accountId, instance);
      equipGrants.push({ account: accountId, instanceId: instance.id, orderId: '' });
    },
    async escrowCard() { throw new Error('unused'); },
    async grantCard() { /* unused */ },
    async escrowSkin(accountId, skinId) {
      const inv = skinInv.get(accountId);
      if (!inv?.has(skinId)) throw new SlgError('SKIN_NOT_FOUND');
      inv.delete(skinId);
      return skinId;
    },
    async grantSkin(accountId, skinId) {
      seedSkin(accountId, skinId);
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
    skinInv.clear();
    mails.length = 0;
    nowMs = Date.now();

    svc = new AuctionService({
      cols: mongo!.collections,
      commercial,
      meta,
      mail,
      now: () => nowMs,
    });
  });

  afterAll(async () => {
    await mongo?.close();
  });

  const DUR = AUCTION_DURATIONS_SEC[0]!; // shortest duration (e.g. 3600s)

  it('list auction → deduct and escrow materials', async () => {
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 5, price: 10, durationSec: DUR,
    });
    expect(view.status).toBe('open');
    expect(view.qty).toBe(5);
    expect(view.totalPrice).toBe(50);
    expect(materialDeducts).toHaveLength(1);
    expect(materialDeducts[0]).toMatchObject({ account: 'alice', material: 'scrap', qty: 5 });
  });

  it('equipment listing missing instanceId → BAD_REQUEST (escrow not triggered)', async () => {
    await expect(svc.createAuction({
      sellerId: 'alice', itemType: 'equipment',
      item: { foo: 'bar' }, qty: 1, price: 400, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(equipEscrows).toHaveLength(0);
  });

  it('invalid duration → BAD_REQUEST', async () => {
    await expect(svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 1, durationSec: 999,
    })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('listing exceeds cap → AUCTION_LIMIT_REACHED', async () => {
    // price must fall within the scrap static reference price guardrail band (ref=10 → [5,20]), use 10.
    for (let i = 0; i < AUCTION_MAX_LISTINGS; i++) {
      await svc.createAuction({
        sellerId: 'alice', itemType: 'material',
        item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
      });
    }
    await expect(svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'AUCTION_LIMIT_REACHED' });
  });

  it('buy: deduct coins + mail materials to buyer + pay seller (10% tax)', async () => {
    // lead static reference price ref=30 → guardrail band [15,60], use unit price 30.
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'lead' }, qty: 2, price: 30, durationSec: DUR,
    });
    const bought = await svc.buyAuction('bob', view.auctionId);
    expect(bought.status).toBe('sold');
    expect(bought.buyerId).toBe('bob');
    expect(spends).toHaveLength(1);
    expect(spends[0]).toMatchObject({ account: 'bob', amount: 60 });
    // escrow-out: item delivered to buyer via system mail (claimed to enter inventory)
    expect(mailAtt('bob', 'auction_buy:')).toMatchObject({ kind: 'material', id: 'lead', count: 2 });
    const tax = Math.floor(60 * AUCTION_TAX_RATE);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ account: 'alice', amount: 60 - tax });
  });

  it('buy own auction → BAD_REQUEST', async () => {
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    });
    await expect(svc.buyAuction('alice', view.auctionId)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('buying an already-sold auction → AUCTION_CLOSED', async () => {
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    });
    await svc.buyAuction('bob', view.auctionId);
    await expect(svc.buyAuction('carol', view.auctionId)).rejects.toMatchObject({ code: 'AUCTION_CLOSED' });
  });

  it('designated buyer: another buyer → NOT_DESIGNATED_BUYER', async () => {
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'binding' }, qty: 1, price: 50, durationSec: DUR,
      designatedBuyerId: 'bob',
    });
    await expect(svc.buyAuction('carol', view.auctionId)).rejects.toMatchObject({ code: 'NOT_DESIGNATED_BUYER' });
    const bought = await svc.buyAuction('bob', view.auctionId);
    expect(bought.status).toBe('sold');
  });

  it('seller cancels → materials mailed back to seller', async () => {
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 3, price: 5, durationSec: DUR,
    });
    const cancelled = await svc.cancelAuction('alice', view.auctionId);
    expect(cancelled.status).toBe('cancelled');
    // escrow-out: returned to seller via system mail (claimed to re-enter inventory)
    expect(mailAtt('alice', 'auction_cancel:')).toMatchObject({ kind: 'material', id: 'scrap', count: 3 });
  });

  it('non-seller cancels → NO_PERMISSION', async () => {
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    });
    await expect(svc.cancelAuction('bob', view.auctionId)).rejects.toMatchObject({ code: 'NO_PERMISSION' });
  });

  it('expiry scan: process expired listings + mail seller items back', async () => {
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'lead' }, qty: 4, price: 20, durationSec: DUR,
    });
    // force expireAt into the past
    await mongo!.collections.auctions.updateOne(
      { _id: view.auctionId },
      { $set: { expireAt: nowMs - 1000 } },
    );
    const count = await svc.processExpiredAuctions();
    expect(count).toBe(1);
    // escrow-out: unsold item returned to seller via system mail
    expect(mailAtt('alice', 'auction_expire:')).toMatchObject({ kind: 'material', id: 'lead', count: 4 });
  });

  it('list open auctions + my listings', async () => {
    await svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    });
    const list = await svc.listAuctions();
    expect(list.length).toBe(1);
    const mine = await svc.getMyListings('alice');
    expect(mine.length).toBe(1);
    const other = await svc.getMyListings('bob');
    expect(other.length).toBe(0);
  });

  // ── G Price guardrail (cold-start static reference price: scrap ref=10 → band [5,20]) ──────────────
  it('G overpriced listing → PRICE_OUT_OF_RANGE', async () => {
    await expect(svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 100, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'PRICE_OUT_OF_RANGE' });
  });

  it('G floor-price listing → PRICE_OUT_OF_RANGE', async () => {
    await expect(svc.createAuction({
      sellerId: 'alice', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 2, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'PRICE_OUT_OF_RANGE' });
  });

  // ── C Daily listing cap ────────────────────────────────────────────────────────
  it('C daily listings exceed AUCTION_DAILY_LIST_CAP → AUCTION_LIMIT_REACHED', async () => {
    // List one and immediately cancel (does not consume an open slot), repeat to reach the daily cap; next listing hits the limit.
    for (let i = 0; i < AUCTION_DAILY_LIST_CAP; i++) {
      const v = await svc.createAuction({
        sellerId: 'dave', itemType: 'material',
        item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
      });
      await svc.cancelAuction('dave', v.auctionId);
    }
    await expect(svc.createAuction({
      sellerId: 'dave', itemType: 'material',
      item: { material: 'scrap' }, qty: 1, price: 10, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'AUCTION_LIMIT_REACHED' });
  });

  // ── B Bidding ────────────────────────────────────────────────────────────────
  it('B bid below start price → BID_TOO_LOW', async () => {
    const v = await svc.createAuction({
      sellerId: 'alice', itemType: 'material', saleMode: 'auction',
      item: { material: 'scrap' }, qty: 1, startPrice: 10, durationSec: DUR,
    });
    await expect(svc.placeBid('bob', v.auctionId, 8)).rejects.toMatchObject({ code: 'BID_TOO_LOW' });
  });

  it('B bid → higher bid replaces and refunds previous → auction closes on expiry', async () => {
    const v = await svc.createAuction({
      sellerId: 'alice', itemType: 'material', saleMode: 'auction',
      item: { material: 'scrap' }, qty: 1, startPrice: 10, durationSec: DUR,
    });
    // bob bids 12 (escrow 12)
    const b1 = await svc.placeBid('bob', v.auctionId, 12);
    expect(b1.topBid).toMatchObject({ bidderId: 'bob', amount: 12 });
    expect(spends.find((s) => s.account === 'bob' && s.amount === 12)).toBeTruthy();
    // carol bids 15 (escrow 15) → refund bob's 12
    await svc.placeBid('carol', v.auctionId, 15);
    expect(grants.find((g) => g.account === 'bob' && g.amount === 12)).toBeTruthy();
    // force expiry → scanner closes auction for carol (seller receives 15 after tax)
    await mongo!.collections.auctions.updateOne({ _id: v.auctionId }, { $set: { expireAt: nowMs - 1000 } });
    const count = await svc.processExpiredAuctions();
    expect(count).toBe(1);
    const sold = await mongo!.collections.auctions.findOne({ _id: v.auctionId });
    expect(sold?.status).toBe('sold');
    expect(sold?.buyerId).toBe('carol');
    expect(mailAtt('carol', 'auction_settle:')).toMatchObject({ kind: 'material', id: 'scrap' });
    const tax = Math.floor(15 * AUCTION_TAX_RATE);
    expect(grants.find((g) => g.account === 'alice' && g.amount === 15 - tax)).toBeTruthy();
  });

  it('B buyout → auction closes immediately', async () => {
    const v = await svc.createAuction({
      sellerId: 'alice', itemType: 'material', saleMode: 'auction',
      item: { material: 'scrap' }, qty: 1, startPrice: 10, buyoutPrice: 18, durationSec: DUR,
    });
    const bought = await svc.placeBid('bob', v.auctionId, 18);
    expect(bought.status).toBe('sold');
    expect(bought.buyerId).toBe('bob');
    expect(mailAtt('bob', 'auction_settle:')).toMatchObject({ kind: 'material', id: 'scrap' });
  });

  it('B cannot cancel auction after a bid has been placed → BAD_REQUEST', async () => {
    const v = await svc.createAuction({
      sellerId: 'alice', itemType: 'material', saleMode: 'auction',
      item: { material: 'scrap' }, qty: 1, startPrice: 10, durationSec: DUR,
    });
    await svc.placeBid('bob', v.auctionId, 12);
    await expect(svc.cancelAuction('alice', v.auctionId)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  // ── A Equipment trading (EQUIPMENT_DESIGN §4.A). wp_marker is rare; static reference price guardrail 400 → band [200,800]. ──
  const mkInst = (id: string, defId = 'wp_marker', extra: Partial<EquipmentInstance> = {}): EquipmentInstance => ({
    id, defId, rarity: 'rare', level: 0, affixes: [{ id: 'm_atk', value: 8 }], ...extra,
  });

  it('A equipment listing → escrow removes from seller inventory + stores instance snapshot + qty always 1', async () => {
    seedEquip('alice', mkInst('eq1'));
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 1, price: 400, durationSec: DUR,
    });
    expect(view.status).toBe('open');
    expect(view.qty).toBe(1);
    expect(view.itemType).toBe('equipment');
    expect((view.item.instance as EquipmentInstance).id).toBe('eq1');
    expect(equipEscrows).toHaveLength(1);
    expect(equipInv.get('alice')?.has('eq1')).toBe(false); // removed from seller inventory
  });

  it('A equipment listing with qty 99 is coerced to 1', async () => {
    seedEquip('alice', mkInst('eq1'));
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 99, price: 400, durationSec: DUR,
    });
    expect(view.qty).toBe(1);
  });

  it('A equipment buy → instance mailed to buyer (including full affix snapshot)', async () => {
    seedEquip('alice', mkInst('eq1', 'wp_marker', { level: 3, affixes: [{ id: 'm_atk', value: 8 }, { id: 's_hp', value: 5 }] }));
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 1, price: 400, durationSec: DUR,
    });
    const bought = await svc.buyAuction('bob', view.auctionId);
    expect(bought.status).toBe('sold');
    expect(spends[0]).toMatchObject({ account: 'bob', amount: 400 });
    // escrow-out: buyer receives the instance via mail attachment (id + level + affix snapshot carried as-is)
    const att = mailAtt('bob', 'auction_buy:');
    expect(att?.kind).toBe('equipment');
    const bobInst = att?.instance as EquipmentInstance | undefined;
    expect(bobInst).toMatchObject({ id: 'eq1', level: 3 });
    expect(bobInst?.affixes).toHaveLength(2);
    // seller receives payment after tax
    const tax = Math.floor(400 * AUCTION_TAX_RATE);
    expect(grants.find((g) => g.account === 'alice' && g.amount === 400 - tax)).toBeTruthy();
  });

  it('A equipment cancel → instance mailed back to seller', async () => {
    seedEquip('alice', mkInst('eq1'));
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 1, price: 400, durationSec: DUR,
    });
    await svc.cancelAuction('alice', view.auctionId);
    // escrow-out: not returned directly to inventory; delivered via mail (claimed to re-enter inventory)
    expect(equipInv.get('alice')?.has('eq1')).toBe(false);
    const att = mailAtt('alice', 'auction_cancel:');
    expect(att?.kind).toBe('equipment');
    expect((att?.instance as EquipmentInstance | undefined)?.id).toBe('eq1');
  });

  it('A equipment expiry scan → instance mailed back to seller', async () => {
    seedEquip('alice', mkInst('eq1'));
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 1, price: 400, durationSec: DUR,
    });
    await mongo!.collections.auctions.updateOne({ _id: view.auctionId }, { $set: { expireAt: nowMs - 1000 } });
    const count = await svc.processExpiredAuctions();
    expect(count).toBe(1);
    expect(equipInv.get('alice')?.has('eq1')).toBe(false);
    const att = mailAtt('alice', 'auction_expire:');
    expect((att?.instance as EquipmentInstance | undefined)?.id).toBe('eq1');
  });

  it('A equipment overpriced listing → PRICE_OUT_OF_RANGE (and escrow instance is returned)', async () => {
    seedEquip('alice', mkInst('eq1'));
    await expect(svc.createAuction({
      sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 1, price: 5000, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'PRICE_OUT_OF_RANGE' });
    // after guardrail rejection the instance is returned to the seller (not lost)
    expect(equipInv.get('alice')?.has('eq1')).toBe(true);
  });

  it('A locked equipment listing → EQUIP_LOCKED (meta escrow rejection propagated)', async () => {
    seedEquip('alice', mkInst('eq1', 'wp_marker', { locked: true }));
    await expect(svc.createAuction({
      sellerId: 'alice', itemType: 'equipment',
      item: { instanceId: 'eq1' }, qty: 1, price: 400, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'EQUIP_LOCKED' });
  });

  // ── Skin trading (§9 task4 new itemType, no price guardrail — cold-start pass-through) ────────────────
  it('skin listing → escrow removes from seller inventory + qty always 1', async () => {
    seedSkin('alice', 'skin_notebook_blue');
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'skin',
      item: { skinId: 'skin_notebook_blue' }, qty: 1, price: 500, durationSec: DUR,
    });
    expect(view.status).toBe('open');
    expect(view.qty).toBe(1);
    expect(view.itemType).toBe('skin');
    expect(view.item.skinId).toBe('skin_notebook_blue');
    expect(skinInv.get('alice')?.has('skin_notebook_blue')).toBe(false);
  });

  it('skin buy → skinId mailed to buyer, seller paid after tax', async () => {
    seedSkin('alice', 'skin_notebook_blue');
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'skin',
      item: { skinId: 'skin_notebook_blue' }, qty: 1, price: 500, durationSec: DUR,
    });
    const bought = await svc.buyAuction('bob', view.auctionId);
    expect(bought.status).toBe('sold');
    expect(spends[0]).toMatchObject({ account: 'bob', amount: 500 });
    expect(mailAtt('bob', 'auction_buy:')).toMatchObject({ kind: 'skin', id: 'skin_notebook_blue' });
    const tax = Math.floor(500 * AUCTION_TAX_RATE);
    expect(grants.find((g) => g.account === 'alice' && g.amount === 500 - tax)).toBeTruthy();
  });

  it('skin cancel → skinId mailed back to seller', async () => {
    seedSkin('alice', 'skin_notebook_blue');
    const view = await svc.createAuction({
      sellerId: 'alice', itemType: 'skin',
      item: { skinId: 'skin_notebook_blue' }, qty: 1, price: 500, durationSec: DUR,
    });
    await svc.cancelAuction('alice', view.auctionId);
    expect(mailAtt('alice', 'auction_cancel:')).toMatchObject({ kind: 'skin', id: 'skin_notebook_blue' });
  });

  it('skin not owned → SKIN_NOT_FOUND (meta escrow rejection propagated)', async () => {
    await expect(svc.createAuction({
      sellerId: 'alice', itemType: 'skin',
      item: { skinId: 'skin_never_owned' }, qty: 1, price: 500, durationSec: DUR,
    })).rejects.toMatchObject({ code: 'SKIN_NOT_FOUND' });
  });
});
