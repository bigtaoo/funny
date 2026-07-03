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
import { grantCards, UNIT_CARD_POOL_ID, EQUIPMENT_DEFS, GACHA_MATERIAL_GRANTS, makeGachaEquipInstance, EQUIPMENT_INV_CAP, equipmentInvCount, CARD_DEFS, type CardDef } from '@nw/shared';
import { grantCards as grantHeroCards } from './cards.js';
import type { CommercialClient, GachaResultEntry, WalletView } from './commercialClient.js';

/** Mark each result as duplicate or not (compared against current inventory + already granted in this batch; used by the client for loot-box display). */
export function markDuplicates(
  ownedSkins: string[],
  results: GachaResultEntry[],
): { newSkins: string[]; marked: { itemId: string; rarity: Rarity; duplicate: boolean }[] } {
  const owned = new Set(ownedSkins);
  const newSkins: string[] = [];
  const marked = results.map((r) => {
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
): Promise<SaveData> {
  const set: Record<string, unknown> = {
    'save.updatedAt': now,
    'save.wallet.coins': coinsAfter,
  };
  if (pityPatch) {
    for (const [pool, v] of Object.entries(pityPatch)) set[`save.gacha.pity.${pool}`] = v;
  }
  // Equipment instances are $set one by one (not subject to the 300-cap; intentionally obtained via loot box; overflow handling via mail pending §13).
  for (const [id, inst] of Object.entries(equipInstances ?? {})) set[`save.equipmentInv.${id}`] = inst;
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
 * Deliver a unit-card loot-box grant (S12-C, dedicated unit card pool): adds cardGrants
 * (cardKey→count) into cardInventory. (The derived `unitLevels` snapshot was dropped with the
 * Hero Roster migration — SaveData v4 removed the field; the engine now reads `cardInv` instead.)
 * Uses an **optimistic lock read-modify-write** (rev CAS + retry, same as service.mutateSave) so a
 * concurrent PUT equipped/flags or PvE write cannot clobber the $inc. Idempotent: if deliveredOrders already contains
 * orderId the current save is returned immediately (guards against duplicate $inc, which matters
 * more here than for skin sets). Also mirrors the wallet + pity in the same operation (symmetric
 * with skin-pool deliverGrant).
 */
export async function deliverCardGrant(
  cols: Collections,
  accountId: string,
  orderId: string,
  cardGrants: Record<string, number>,
  coinsAfter: number,
  pityPatch: Record<string, number> | null,
  now: number,
): Promise<SaveData> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) throw new Error('save missing before card grant');
    if (doc.save.deliveredOrders?.includes(orderId)) return doc.save; // idempotent: already delivered, skip $inc
    const cardInventory = grantCards(doc.save.cardInventory ?? {}, cardGrants);
    const set: Record<string, unknown> = {
      'save.updatedAt': now,
      'save.wallet.coins': coinsAfter,
      'save.cardInventory': cardInventory,
    };
    if (pityPatch) {
      for (const [pool, v] of Object.entries(pityPatch)) set[`save.gacha.pity.${pool}`] = v;
    }
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      {
        $addToSet: { 'save.deliveredOrders': orderId },
        $inc: { 'save.rev': 1, rev: 1 },
        $set: set,
      },
      { returnDocument: 'after' },
    );
    if (res) return res.save;
    // rev conflict (concurrent PUT equipped/flags or concurrent PvE write) → re-read and retry.
  }
  throw new Error('rev conflict delivering card grant');
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
          starterUsed: wallet.starterUsed,
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

/** Complete the delivery loop for one order (skins idempotent + mark delivered). Shared by reconciliation + fate/starter handlers. */
export async function deliverOrder(
  cols: Collections,
  commercial: CommercialClient,
  accountId: string,
  order: {
    _id: string;
    kind: 'shop' | 'gacha' | 'fate' | 'starter';
    result: { itemId?: string; results?: GachaResultEntry[]; poolId?: string };
  },
  coinsAfter: number,
  pityPatch: Record<string, number> | null,
  now: number,
): Promise<SaveData> {
  // Fate Point redemption (§7): a single self-chosen legendary skin, delivered idempotently like a shop skin.
  if (order.kind === 'fate' && order.result.itemId) {
    const cur = await cols.saves.findOne({ _id: accountId });
    const owned = cur?.save.inventory.skins ?? [];
    const newSkins = owned.includes(order.result.itemId) ? [] : [order.result.itemId];
    const save = await deliverGrant(cols, accountId, order._id, newSkins, coinsAfter, pityPatch, now);
    await commercial.orderDelivered({ orderId: order._id });
    return save;
  }

  // Unit card pool order (S12-C): results.itemId is a cardKey; goes into cardInventory (not treated as a skin).
  if (order.kind === 'gacha' && order.result.poolId === UNIT_CARD_POOL_ID) {
    const cardGrants: Record<string, number> = {};
    for (const r of order.result.results ?? []) cardGrants[r.itemId] = (cardGrants[r.itemId] ?? 0) + 1;
    const save = await deliverCardGrant(cols, accountId, order._id, cardGrants, coinsAfter, pityPatch, now);
    await commercial.orderDelivered({ orderId: order._id });
    return save;
  }

  const cur = await cols.saves.findOne({ _id: accountId });
  const owned = cur?.save.inventory.skins ?? [];
  const invCount = equipmentInvCount(cur?.save.equipmentInv);

  // Direct shop purchase: kind='item' → inventory.items; kind='skin' → skins (existing path).
  if (order.kind === 'shop' && order.result.itemId) {
    const itemId = order.result.itemId;
    if (itemId.startsWith('mat_') && GACHA_MATERIAL_GRANTS[itemId]) {
      // Shop material (future extension); no such category yet, fall through to skin path
    } else if (EQUIPMENT_DEFS[itemId]) {
      // Shop equipment (future extension)
    } else if (!owned.includes(itemId)) {
      // Direct purchase of a regular skin
      const save = await deliverGrant(cols, accountId, order._id, [itemId], coinsAfter, pityPatch, now);
      await commercial.orderDelivered({ orderId: order._id });
      return save;
    } else {
      const save = await deliverGrant(cols, accountId, order._id, [], coinsAfter, pityPatch, now);
      await commercial.orderDelivered({ orderId: order._id });
      return save;
    }
    // kind='item': write to inventory.items (consumables such as guard items, E7).
    const itemInc: Record<string, number> = { [itemId]: 1 };
    const save = await deliverMailGrant(cols, accountId, order._id, [], itemInc, coinsAfter, now);
    await commercial.orderDelivered({ orderId: order._id });
    return save;
  }

  // Loot box: route each result itemId — mat_* → materials, equipment defId → equipment instance, character card defId → card grant, everything else → skin.
  const results = order.result.results ?? [];
  const skinResults: GachaResultEntry[] = [];
  const materialInc: Record<string, number> = {};
  const equipInstances: Record<string, EquipmentInstance> = {};
  const cardDefs: CardDef[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    const matGrant = GACHA_MATERIAL_GRANTS[r.itemId];
    if (matGrant) {
      // Material slot
      for (const [mat, qty] of Object.entries(matGrant)) materialInc[mat] = (materialInc[mat] ?? 0) + qty;
    } else if (EQUIPMENT_DEFS[r.itemId]) {
      // Equipment slot: skip if inventory full (300 cap, silently skipped; full-inventory compensation via §13 to be done later)
      if (invCount + Object.keys(equipInstances).length < EQUIPMENT_INV_CAP) {
        const instanceId = `eq_gacha_${order._id}_${i}`;
        equipInstances[instanceId] = makeGachaEquipInstance(r.itemId, instanceId) as EquipmentInstance;
      }
    } else if (CARD_DEFS[r.itemId]) {
      // Character card slot (CC-5): accumulate defs; granted after skins/materials are marked delivered.
      cardDefs.push(CARD_DEFS[r.itemId]!);
    } else {
      skinResults.push(r);
    }
  }

  const { newSkins } = markDuplicates(owned, skinResults);
  const hasMixed = Object.keys(materialInc).length > 0 || Object.keys(equipInstances).length > 0;
  const save = await deliverGrant(
    cols, accountId, order._id, newSkins, coinsAfter, pityPatch, now,
    hasMixed ? materialInc : undefined,
    hasMixed ? equipInstances : undefined,
  );
  await commercial.orderDelivered({ orderId: order._id });

  // Character card delivery (CC-5): grant hero cards after the order is marked delivered.
  // If the roster is full, compensatedCoins are credited immediately (best-effort).
  if (cardDefs.length > 0) {
    const cardResult = await grantHeroCards(cols, () => now, accountId, cardDefs);
    if (!('error' in cardResult) && cardResult.compensatedCoins > 0 && commercial.available) {
      await commercial.grant({
        accountId,
        amount: cardResult.compensatedCoins,
        reason: 'card_inv_full',
        orderId: `${order._id}:card_comp`,
      }).catch(() => { /* best-effort */ });
    }
  }

  return save;
}

/**
 * Reconcile: fetch undelivered orders for this account from commercial, deliver each one +
 * mark as delivered. Called alongside GET /save; orders that crashed between "coins deducted"
 * and "delivery" are recovered here (skins are idempotent — no loss, no duplication).
 */
export async function reconcileUndelivered(
  cols: Collections,
  commercial: CommercialClient,
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
    await deliverOrder(cols, commercial, accountId, o, w?.coins ?? 0, pityPatch, now);
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
