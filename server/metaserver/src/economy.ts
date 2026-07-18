// Economy orchestration helpers (S5-5). meta delivers items based on commercial receipts
// (inventory is meta-authoritative) + writes the wallet mirror + reconciles undelivered orders.
// Key invariants:
//  • Delivery is idempotent — save.deliveredOrders records orderId; $addToSet deduplicates naturally;
//    skins are a set, so re-delivery never grants duplicates.
//  • Wallet mirror — wallet.coins / gacha.pity are authoritative in commercial; meta only writes
//    the mirror section after a receipt, for offline display.
//  • Duplicate conversion (refund coins / shards) is deferred to S5 (§4.3 refund amount TBD +
//    re-grant recalculation is not idempotent); only new skins are granted for now; the channel
//    in commercial is already prepared.
import { createHash } from 'node:crypto';
import type { Collections, SaveData, Rarity, EquipmentInstance } from '@nw/shared';
import {
  EQUIPMENT_DEFS, GACHA_MATERIAL_GRANTS, makeGachaEquipInstance, EQUIPMENT_INV_CAP,
  EQUIP_FULL_COMPENSATION_COINS, EQUIP_INV_FULL_MAIL_COUNT, equipmentInvCount, CARD_DEFS,
  type CardDef, PRODUCT_STARTER_GROWTH, GROWTH_PACK_WINDOW_DAYS, findShopItem,
} from '@nw/shared';
import { grantCards as grantHeroCards } from './cards.js';
import { insertSystemMail } from './mail.js';
import type { MetaSocialsvcClient } from './socialsvcClient.js';
import type { CommercialClient, GachaResultEntry, WalletView } from './commercialClient.js';

/** 30-day expiry, matching the auction/ladder-settlement system-mail convention. */
const EQUIP_OVERFLOW_MAIL_EXPIRE_DAYS = 30;

/** Roster/inventory-full overflow summary for one delivery call (used by gachaDraw to surface a client toast). */
export interface OverflowSummary {
  cardMailed: number;
  cardCompensatedCoins: number;
  equipMailed: number;
  equipCompensatedCoins: number;
}

/**
 * Mark each result as duplicate or not (compared against current inventory + already granted in
 * this batch; used by the client for loot-box display). Character cards are routed to `cardInv`
 * on delivery (not `inventory.skins`), so they're checked against `ownedCardDefIds` instead —
 * otherwise a card already owned (at any level) would still show the NEW badge every draw.
 */
export function markDuplicates(
  ownedSkins: string[],
  ownedCardDefIds: string[],
  results: GachaResultEntry[],
): { newSkins: string[]; marked: { itemId: string; rarity: Rarity; duplicate: boolean }[] } {
  const owned = new Set(ownedSkins);
  const ownedCards = new Set(ownedCardDefIds);
  const newSkins: string[] = [];
  const marked = results.map((r) => {
    if (CARD_DEFS[r.itemId]) {
      const duplicate = ownedCards.has(r.itemId);
      if (!duplicate) ownedCards.add(r.itemId);
      return { itemId: r.itemId, rarity: r.rarity, duplicate };
    }
    const duplicate = owned.has(r.itemId);
    if (!duplicate) {
      owned.add(r.itemId);
      newSkins.push(r.itemId);
    }
    return { itemId: r.itemId, rarity: r.rarity, duplicate };
  });
  return { newSkins, marked };
}

/**
 * Deliver items + mirror the wallet in a single atomic, idempotent document update
 * (deliveredOrders $addToSet deduplicates). Returns the updated save; if orderId was already
 * delivered, returns the current save without re-granting. E7 extension: optional materialInc
 * (material increments) + equipInstances (equipment instance map) are written atomically in
 * the same operation.
 */
export async function deliverGrant(
  cols: Collections,
  accountId: string,
  orderId: string,
  newSkins: string[],
  coinsAfter: number,
  pityPatch: Record<string, number> | null,
  now: number,
  materialInc?: Record<string, number>,
  equipInstances?: Record<string, EquipmentInstance>,
  equipMailOverflowCount?: number,
): Promise<SaveData> {
  const set: Record<string, unknown> = {
    'save.updatedAt': now,
    'save.wallet.coins': coinsAfter,
  };
  if (pityPatch) {
    for (const [pool, v] of Object.entries(pityPatch)) set[`save.gacha.pity.${pool}`] = v;
  }
  // Equipment instances are $set one by one (not subject to the 300-cap; overflow → mail/coin, see deliverLootBox).
  for (const [id, inst] of Object.entries(equipInstances ?? {})) set[`save.equipmentInv.${id}`] = inst;
  if (equipMailOverflowCount !== undefined) set['save.equipMailOverflowCount'] = equipMailOverflowCount;
  const inc: Record<string, number> = { 'save.rev': 1, rev: 1 };
  for (const [mat, qty] of Object.entries(materialInc ?? {})) if (qty > 0) inc[`save.materials.${mat}`] = qty;
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId },
    {
      $addToSet: {
        'save.inventory.skins': { $each: newSkins },
        'save.deliveredOrders': orderId,
      },
      $inc: inc,
      $set: set,
    },
    { returnDocument: 'after' },
  );
  if (res) return res.save;
  const cur = await cols.saves.findOne({ _id: accountId });
  if (!cur) throw new Error('save missing after grant');
  return cur.save;
}

/**
 * Deliver mail attachments (S6-3): single-document atomic + idempotent (deliveredOrders $addToSet
 * deduplicates). Skins go into inventory.skins (set deduplication); items are $inc'd into
 * inventory.items.{id}; materials are $inc'd into materials.{id} (unified progression pool,
 * SLG8 season rewards, etc.); coins are mirrored when coinsAfter is non-null.
 * `orderId` = mail.claimOrderId; re-delivery of the same orderId does not re-grant items
 * ($addToSet deduplication + coins use the commercial-authoritative mirror).
 */
export async function deliverMailGrant(
  cols: Collections,
  accountId: string,
  orderId: string,
  newSkins: string[],
  itemInc: Record<string, number>,
  coinsAfter: number | null,
  now: number,
  materialInc: Record<string, number> = {},
): Promise<SaveData> {
  const set: Record<string, unknown> = { 'save.updatedAt': now };
  if (coinsAfter !== null) set['save.wallet.coins'] = coinsAfter;
  const inc: Record<string, number> = { 'save.rev': 1, rev: 1 };
  for (const [id, n] of Object.entries(itemInc)) if (n > 0) inc[`save.inventory.items.${id}`] = n;
  for (const [id, n] of Object.entries(materialInc)) if (n > 0) inc[`save.materials.${id}`] = n;
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId },
    {
      $addToSet: {
        'save.inventory.skins': { $each: newSkins },
        'save.deliveredOrders': orderId,
      },
      $inc: inc,
      $set: set,
    },
    { returnDocument: 'after' },
  );
  if (res) return res.save;
  const cur = await cols.saves.findOne({ _id: accountId });
  if (!cur) throw new Error('save missing after mail grant');
  return cur.save;
}

/** Refresh the wallet mirror only (top-up / ad reward: no item delivery, just write back the balance). */
export async function mirrorCoins(
  cols: Collections,
  accountId: string,
  coins: number,
  now: number,
): Promise<SaveData> {
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId },
    { $inc: { 'save.rev': 1, rev: 1 }, $set: { 'save.wallet.coins': coins, 'save.updatedAt': now } },
    { returnDocument: 'after' },
  );
  if (res) return res.save;
  const cur = await cols.saves.findOne({ _id: accountId });
  if (!cur) throw new Error('save missing after mirror');
  return cur.save;
}

/** Pull the authoritative balance + pity + monetization state from commercial and write the mirror (refreshed alongside GET /save). */
export async function mirrorWalletFrom(
  cols: Collections,
  accountId: string,
  wallet: WalletView,
  now: number,
): Promise<SaveData> {
  // Growth pack's first-N-days window (GACHA_DESIGN §6) is account-age gated; mirror the eligibility
  // so the client can hide the card once it's closed instead of showing a Buy button that always 403s.
  let starterGrowthEligible = true;
  if (!wallet.starterUsed.includes(PRODUCT_STARTER_GROWTH)) {
    const acct = await cols.accounts.findOne({ _id: accountId }, { projection: { createdAt: 1 } });
    starterGrowthEligible = !acct || now - acct.createdAt <= GROWTH_PACK_WINDOW_DAYS * 86400000;
  }
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId },
    {
      $inc: { 'save.rev': 1, rev: 1 },
      $set: {
        'save.wallet.coins': wallet.coins,
        'save.gacha.pity': wallet.pity,
        'save.monetization': {
          fatePoints: wallet.fatePoints,
          subscriptionExpiry: wallet.subscriptionExpiry,
          subscriptionLastClaimDay: wallet.subscriptionLastClaimDay,
          starterUsed: wallet.starterUsed,
          starterGrowthEligible,
          firstPurchaseUsed: wallet.firstPurchaseUsed,
        },
        'save.updatedAt': now,
      },
    },
    { returnDocument: 'after' },
  );
  if (res) return res.save;
  const cur = await cols.saves.findOne({ _id: accountId });
  if (!cur) throw new Error('save missing after wallet mirror');
  return cur.save;
}

/**
 * Route + deliver one loot-box result set: mat_* → materials, equipment defId → equipment
 * instance, character card defId → hero card grant (grantHeroCards/save.cardInv), everything
 * else → skin. Shared by deliverOrder's loot-box branch (shop/mail/reconcile replay) and
 * gachaDraw (which delivers standard-pool draws directly, without going through the
 * commercial order-replay path). Does not mark the order delivered — callers do that
 * themselves (gachaDraw does it fire-and-forget to keep it off the response critical path).
 *
 * Roster/inventory-full overflow (cards ≥150 / equipment ≥300): the first INV_FULL_MAIL_COUNT
 * overflow items per type (since that inventory last had free space) are mailed to the player as
 * real instances instead of being coin-compensated; the persistent per-account counter lives on
 * save.cardMailOverflowCount / save.equipMailOverflowCount. Returned `overflow` lets gachaDraw
 * surface a "inventory full" toast.
 */
export async function deliverLootBox(
  cols: Collections,
  commercial: CommercialClient,
  socialsvc: MetaSocialsvcClient,
  accountId: string,
  orderId: string,
  results: GachaResultEntry[],
  coinsAfter: number,
  pityPatch: Record<string, number> | null,
  now: number,
): Promise<{ save: SaveData; overflow: OverflowSummary }> {
  const cur = await cols.saves.findOne({ _id: accountId });
  const owned = cur?.save.inventory.skins ?? [];
  const invCount = equipmentInvCount(cur?.save.equipmentInv);
  // Free room right now → the mail quota refills; otherwise carry the persisted counter forward.
  let equipMailOverflowCount = invCount < EQUIPMENT_INV_CAP ? 0 : (cur?.save.equipMailOverflowCount ?? 0);

  const skinResults: GachaResultEntry[] = [];
  const materialInc: Record<string, number> = {};
  const equipInstances: Record<string, EquipmentInstance> = {};
  const equipMailInstances: EquipmentInstance[] = [];
  let equipCompensatedCoins = 0;
  const cardDefs: CardDef[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const matGrant = GACHA_MATERIAL_GRANTS[r.itemId];
    if (matGrant) {
      for (const [mat, qty] of Object.entries(matGrant)) materialInc[mat] = (materialInc[mat] ?? 0) + qty;
    } else if (EQUIPMENT_DEFS[r.itemId]) {
      const instanceId = `eq_gacha_${orderId}_${i}`;
      const instance = makeGachaEquipInstance(r.itemId, instanceId) as EquipmentInstance;
      if (invCount + Object.keys(equipInstances).length < EQUIPMENT_INV_CAP) {
        equipInstances[instanceId] = instance;
      } else if (equipMailOverflowCount < EQUIP_INV_FULL_MAIL_COUNT) {
        equipMailInstances.push(instance);
        equipMailOverflowCount++;
      } else {
        equipCompensatedCoins += EQUIP_FULL_COMPENSATION_COINS;
      }
    } else if (CARD_DEFS[r.itemId]) {
      cardDefs.push(CARD_DEFS[r.itemId]!);
    } else {
      skinResults.push(r);
    }
  }

  const { newSkins } = markDuplicates(owned, [], skinResults);
  const hasMixed = Object.keys(materialInc).length > 0 || Object.keys(equipInstances).length > 0;
  const save = await deliverGrant(
    cols, accountId, orderId, newSkins, coinsAfter, pityPatch, now,
    hasMixed ? materialInc : undefined,
    hasMixed ? equipInstances : undefined,
    equipMailInstances.length > 0 || equipCompensatedCoins > 0 ? equipMailOverflowCount : undefined,
  );

  if (equipMailInstances.length > 0) {
    await insertSystemMail(socialsvc, `${orderId}:equip_mail`, accountId, {
      subject: 'equipment.mail.invFull.subject',
      body: 'equipment.mail.invFull.body',
      attachments: equipMailInstances.map((instance) => ({ kind: 'equipment' as const, instance })),
      expireDays: EQUIP_OVERFLOW_MAIL_EXPIRE_DAYS,
    }).catch(() => { /* best-effort: same risk tolerance as the coin-compensation path below */ });
  }
  if (equipCompensatedCoins > 0 && commercial.available) {
    await commercial.grant({
      accountId,
      amount: equipCompensatedCoins,
      reason: 'equip_inv_full',
      orderId: `${orderId}:equip_comp`,
    }).catch(() => { /* best-effort */ });
  }

  // Character card delivery (CC-5): grant hero cards after the skin/material/equipment grant lands.
  // Roster-full overflow: first INV_FULL_MAIL_COUNT go to mail, the rest fall back to coin compensation.
  let finalSave = save;
  let cardMailed = 0;
  let cardCompensatedCoins = 0;
  if (cardDefs.length > 0) {
    const cardResult = await grantHeroCards(cols, () => now, accountId, cardDefs, 1, {
      socialsvc,
      dispatchKey: `${orderId}:card_mail`,
    });
    if (!('error' in cardResult)) {
      finalSave = cardResult.save;
      cardMailed = cardResult.mailedCount;
      cardCompensatedCoins = cardResult.compensatedCoins;
      if (cardResult.compensatedCoins > 0 && commercial.available) {
        await commercial.grant({
          accountId,
          amount: cardResult.compensatedCoins,
          reason: 'card_inv_full',
          orderId: `${orderId}:card_comp`,
        }).catch(() => { /* best-effort */ });
      }
    }
  }

  return {
    save: finalSave,
    overflow: { cardMailed, cardCompensatedCoins, equipMailed: equipMailInstances.length, equipCompensatedCoins },
  };
}

/** Complete the delivery loop for one order (skins idempotent + mark delivered). Shared by reconciliation + fate/starter handlers. */
export async function deliverOrder(
  cols: Collections,
  commercial: CommercialClient,
  socialsvc: MetaSocialsvcClient,
  accountId: string,
  order: {
    _id: string;
    kind: 'shop' | 'gacha' | 'fate' | 'starter';
    result: { itemId?: string; results?: GachaResultEntry[]; poolId?: string };
  },
  coinsAfter: number,
  pityPatch: Record<string, number> | null,
  now: number,
): Promise<{ save: SaveData; overflow?: OverflowSummary }> {
  // Fate Point redemption (§7): a single self-chosen legendary skin, delivered idempotently like a shop skin.
  if (order.kind === 'fate' && order.result.itemId) {
    const cur = await cols.saves.findOne({ _id: accountId });
    const owned = cur?.save.inventory.skins ?? [];
    const newSkins = owned.includes(order.result.itemId) ? [] : [order.result.itemId];
    const save = await deliverGrant(cols, accountId, order._id, newSkins, coinsAfter, pityPatch, now);
    await commercial.orderDelivered({ orderId: order._id });
    return { save };
  }

  const cur = await cols.saves.findOne({ _id: accountId });
  const owned = cur?.save.inventory.skins ?? [];

  // Direct shop purchase: route by the catalog's declared kind (SHOP_ITEMS), not by itemId pattern —
  // kind='item' → inventory.items (consumables such as protect_enhance, E7); kind='skin' → skins.
  if (order.kind === 'shop' && order.result.itemId) {
    const itemId = order.result.itemId;
    const shopDef = findShopItem(itemId);
    if (shopDef?.kind === 'item') {
      const itemInc: Record<string, number> = { [itemId]: 1 };
      const save = await deliverMailGrant(cols, accountId, order._id, [], itemInc, coinsAfter, now);
      await commercial.orderDelivered({ orderId: order._id });
      return { save };
    }
    const newSkins = owned.includes(itemId) ? [] : [itemId];
    const save = await deliverGrant(cols, accountId, order._id, newSkins, coinsAfter, pityPatch, now);
    await commercial.orderDelivered({ orderId: order._id });
    return { save };
  }

  // Loot box: route each result itemId — mat_* → materials, equipment defId → equipment instance, character card defId → card grant, everything else → skin.
  const results = order.result.results ?? [];
  const { save, overflow } = await deliverLootBox(cols, commercial, socialsvc, accountId, order._id, results, coinsAfter, pityPatch, now);
  await commercial.orderDelivered({ orderId: order._id });
  return { save, overflow };
}

/**
 * Reconcile: fetch undelivered orders for this account from commercial, deliver each one +
 * mark as delivered. Called alongside GET /save; orders that crashed between "coins deducted"
 * and "delivery" are recovered here (skins are idempotent — no loss, no duplication).
 */
export async function reconcileUndelivered(
  cols: Collections,
  commercial: CommercialClient,
  socialsvc: MetaSocialsvcClient,
  accountId: string,
  now: number,
): Promise<void> {
  const orders = await commercial.undeliveredOrders(accountId);
  for (const o of orders) {
    // Use the authoritative balance fetched from commercial for the mirror (no second deduction).
    const w = await commercial.getWallet(accountId);
    const pityPatch =
      o.kind === 'gacha' && o.result.poolId && w
        ? { [o.result.poolId]: w.pity[o.result.poolId] ?? 0 }
        : null;
    await deliverOrder(cols, commercial, socialsvc, accountId, o, w?.coins ?? 0, pityPatch, now);
  }
}

/** UTC calendar-day key (for ad cap resets). `now` is injected for testability. */
export function adsDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Ad cap: atomically increment today's count; returns false (deny delivery) if the count exceeds cap.
 * Uses a document keyed by _id=`${accountId}:${dayKey}` with $inc guarded by count<cap.
 */
export async function bumpAdsCap(
  cols: Collections,
  accountId: string,
  dayKey: string,
  cap: number,
  now: number,
): Promise<boolean> {
  const id = `${accountId}:${dayKey}`;
  // First upsert to ensure the document exists, then do the guarded $inc.
  await cols.adsDaily.updateOne(
    { _id: id },
    { $setOnInsert: { _id: id, accountId, dayKey, count: 0, ts: now } },
    { upsert: true },
  );
  const res = await cols.adsDaily.findOneAndUpdate(
    { _id: id, count: { $lt: cap } },
    { $inc: { count: 1 }, $set: { ts: now } },
    { returnDocument: 'after' },
  );
  return !!res;
}

/** SHA-256 hash of an ad token (hex). Used for deduplication in adsTokens. */
export function hashAdToken(adToken: string): string {
  return createHash('sha256').update(adToken).digest('hex');
}

/**
 * Ad-token uniqueness check (C2): writes the hash to adsTokens; returns false on replay.
 * MongoDB unique _id conflict → natural deduplication; TTL 48h for automatic cleanup.
 */
export async function recordAdToken(
  cols: Collections,
  tokenHash: string,
  accountId: string,
  now: number,
): Promise<boolean> {
  try {
    await cols.adsTokens.insertOne({
      _id: tokenHash,
      accountId,
      ts: now,
      expireAt: new Date(now + 48 * 3600 * 1000),
    });
    return true;
  } catch {
    // Unique _id conflict = replay; other errors propagate up.
    return false;
  }
}

/** 30-minute interval gate (C2): atomically updates lastAdAt; returns false if less than minIntervalMs has elapsed since the last ad. */
export async function checkAdInterval(
  cols: Collections,
  accountId: string,
  dayKey: string,
  now: number,
  minIntervalMs: number,
): Promise<boolean> {
  const id = `${accountId}:${dayKey}`;
  await cols.adsDaily.updateOne(
    { _id: id },
    { $setOnInsert: { _id: id, accountId, dayKey, count: 0, ts: now } },
    { upsert: true },
  );
  const res = await cols.adsDaily.findOneAndUpdate(
    {
      _id: id,
      $or: [{ lastAdAt: { $exists: false } }, { lastAdAt: { $lte: now - minIntervalMs } }],
    },
    { $set: { lastAdAt: now } },
    { returnDocument: 'after' },
  );
  return !!res;
}
