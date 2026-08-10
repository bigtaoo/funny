// Order routing/orchestration: routes one loot-box result set or one full order (shop/gacha/fate/
// starter) to the right delivery primitive in delivery.ts, plus undelivered-order reconciliation.
// Split out of economy.ts (2026-08-10, 独立函数模块 form — see economy.ts's facade comment).
import type { Collections, SaveData, EquipmentInstance, CardInstance, SkinInstance } from '@nw/shared';
import {
  EQUIPMENT_DEFS, GACHA_MATERIAL_GRANTS, makeGachaEquipInstance, EQUIPMENT_INV_CAP,
  EQUIP_FULL_COMPENSATION_COINS, EQUIP_INV_FULL_MAIL_COUNT, CARD_DEFS, type CardDef, findShopItem,
} from '@nw/shared';
import { grantCards as grantHeroCards } from '../cards.js';
import { insertSystemMail } from '../mail.js';
import type { MetaSocialsvcClient } from '../socialsvcClient.js';
import type { CommercialClient, GachaResultEntry, WalletView } from '../commercialClient.js';
import { markDuplicates } from './duplicates.js';
import { deliverGrant, deliverMailGrant } from './delivery.js';

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
 * Route + deliver one loot-box result set: mat_* → materials, equipment defId → equipment
 * instance, character card defId → hero card grant (grantHeroCards, writes to the `cardInstances`
 * collection), everything else → skin. Shared by deliverOrder's loot-box branch (shop/mail/reconcile replay) and
 * gachaDraw (which delivers standard-pool draws directly, without going through the
 * commercial order-replay path). Does not mark the order delivered — callers do that
 * themselves (gachaDraw does it fire-and-forget to keep it off the response critical path).
 *
 * Roster/inventory-full overflow (cards ≥500 / equipment ≥1000): the first CARD_INV_OVERFLOW_BUFFER
 * overflow items per type (since that inventory last had free space) are mailed to the player as
 * real instances instead of being coin-compensated; the persistent per-account counter lives on
 * save.cardMailOverflowCount / save.equipMailOverflowCount. Returned `overflow` lets gachaDraw
 * surface a "inventory full" toast.
 *
 * `cardGrants`/`equipmentGrants` are the instances actually landed in cardInv/equipmentInv by this
 * call (never the mailed-overflow ones — those aren't in the inventory yet) — gachaDraw (2026-07-28)
 * hands these back instead of the full inventory maps, see the `cardInv`/`equipmentInv` doc comment
 * in shared/src/types.ts.
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
): Promise<{ save: SaveData; overflow: OverflowSummary; cardGrants: CardInstance[]; equipmentGrants: EquipmentInstance[] }> {
  const cur = await cols.saves.findOne({ _id: accountId });
  const owned = cur?.save.inventory.skins ?? [];
  const invCount = cur?.save.equipmentInvCount ?? 0;
  // Free room right now → the mail quota refills; otherwise carry the persisted counter forward.
  let equipMailOverflowCount = invCount < EQUIPMENT_INV_CAP ? 0 : (cur?.save.equipMailOverflowCount ?? 0);

  const skinResults: GachaResultEntry[] = [];
  const skinInstances: SkinInstance[] = [];
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
      const instance = makeGachaEquipInstance(r.itemId, instanceId, `gacha:${orderId}`, now) as EquipmentInstance;
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
      // Skin (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08): every result becomes a real instance — first
      // pull or dupe alike, deterministic id from orderId+index (mirrors the equipment branch above), so
      // a reconciliation retry of this whole call never double-mints. markDuplicates below still decides
      // the NEW-badge / everOwned bookkeeping, but no longer decides whether an instance is granted at
      // all — that used to be the same flag, which is the bug: a "duplicate" pull got nothing.
      skinResults.push(r);
      skinInstances.push({ id: `skin_gacha_${orderId}_${i}`, skinId: r.itemId, sourceType: `gacha:${orderId}`, obtainedAt: now });
    }
  }

  // Only `newSkins` is consumed here (drives inventory.skins $addToSet) — `skinResults` is already
  // filtered to skin-kind entries, so the other three ownership args (unused by the skin branch's
  // `duplicate` flag, which this call site discards) are irrelevant; pass empty.
  const { newSkins } = markDuplicates(owned, [], [], [], [], skinResults);
  const hasMixed = Object.keys(materialInc).length > 0 || Object.keys(equipInstances).length > 0;
  const save = await deliverGrant(
    cols, accountId, orderId, newSkins, coinsAfter, pityPatch, now,
    hasMixed ? materialInc : undefined,
    hasMixed ? equipInstances : undefined,
    equipMailInstances.length > 0 || equipCompensatedCoins > 0 ? equipMailOverflowCount : undefined,
    skinInstances.length > 0 ? skinInstances : undefined,
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
  // Roster-full overflow: first CARD_INV_OVERFLOW_BUFFER go to mail, the rest fall back to coin compensation.
  let finalSave = save;
  let cardMailed = 0;
  let cardCompensatedCoins = 0;
  let cardGrants: CardInstance[] = [];
  if (cardDefs.length > 0) {
    const cardResult = await grantHeroCards(cols, () => now, accountId, cardDefs, `gacha:${orderId}`, 1, {
      socialsvc,
      dispatchKey: `${orderId}:card_mail`,
    });
    if (!('error' in cardResult)) {
      finalSave = cardResult.save;
      cardMailed = cardResult.mailedCount;
      cardCompensatedCoins = cardResult.compensatedCoins;
      cardGrants = cardResult.instances;
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
    cardGrants,
    equipmentGrants: Object.values(equipInstances),
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
    // qty (bulk-buy, 2026-08-10): units to deliver for a 'shop' order, charged together in one
    // shopCharge call — absent/1 for a single-unit purchase and for every other order kind.
    result: { itemId?: string; results?: GachaResultEntry[]; poolId?: string; qty?: number };
  },
  coinsAfter: number,
  pityPatch: Record<string, number> | null,
  now: number,
): Promise<{ save: SaveData; overflow?: OverflowSummary }> {
  // Fate Point redemption (§7): a single self-chosen legendary skin, delivered idempotently like a shop skin.
  // Grants a real instance even if already owned (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08) — same fix
  // as the gacha loot-box branch below, for the same reason: a redemption/purchase must never silently
  // do nothing just because the player picked something they already have.
  if (order.kind === 'fate' && order.result.itemId) {
    const cur = await cols.saves.findOne({ _id: accountId });
    const owned = cur?.save.inventory.skins ?? [];
    const itemId = order.result.itemId;
    const newSkins = owned.includes(itemId) ? [] : [itemId];
    const skinInstances: SkinInstance[] = [{ id: `skin_fate_${order._id}`, skinId: itemId, sourceType: 'fate', obtainedAt: now }];
    const save = await deliverGrant(cols, accountId, order._id, newSkins, coinsAfter, pityPatch, now, undefined, undefined, undefined, skinInstances);
    await commercial.orderDelivered({ orderId: order._id });
    return { save };
  }

  const cur = await cols.saves.findOne({ _id: accountId });
  const owned = cur?.save.inventory.skins ?? [];

  // Direct shop purchase: route by the catalog's declared kind (SHOP_ITEMS), not by itemId pattern —
  // kind='item' → inventory.items (consumables such as protect_enhance, E7); kind='skin' → skins.
  if (order.kind === 'shop' && order.result.itemId) {
    const itemId = order.result.itemId;
    // Units charged together by this order (bulk-buy, 2026-08-10) — defaults to 1 for every
    // pre-existing single-unit purchase. commercial's shopCharge already validated/clamped this
    // against SHOP_BUY_MAX_QTY before charging, so it's trusted here.
    const qty = order.result.qty ?? 1;
    const shopDef = findShopItem(itemId);
    if (shopDef?.kind === 'item') {
      const itemInc: Record<string, number> = { [itemId]: qty };
      const save = await deliverMailGrant(cols, accountId, order._id, [], itemInc, coinsAfter, now, {}, [], 'shop');
      await commercial.orderDelivered({ orderId: order._id });
      return { save };
    }
    if (shopDef?.kind === 'material') {
      const materialInc: Record<string, number> = { [shopDef.grants]: (shopDef.qty ?? 1) * qty };
      const save = await deliverMailGrant(cols, accountId, order._id, [], {}, coinsAfter, now, materialInc, [], 'shop');
      await commercial.orderDelivered({ orderId: order._id });
      return { save };
    }
    const newSkins = owned.includes(itemId) ? [] : [itemId];
    // One real instance per unit (ITEM_IDENTITY_DESIGN.md task1 already grants a real instance per
    // purchase even when re-buying an owned skin — qty>1 just repeats that qty times in one order).
    const skinInstances: SkinInstance[] = Array.from({ length: qty }, (_, i) => ({
      id: qty === 1 ? `skin_shop_${order._id}` : `skin_shop_${order._id}_${i}`,
      skinId: itemId, sourceType: 'shop', obtainedAt: now,
    }));
    const save = await deliverGrant(cols, accountId, order._id, newSkins, coinsAfter, pityPatch, now, undefined, undefined, undefined, skinInstances);
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
  clientPlatform?: string,
): Promise<WalletView | null> {
  const orders = await commercial.undeliveredOrders(accountId);
  // Fetched once, outside the loop: deliverOrder never mutates commercial's wallet (coins/pity/subscription)
  // for any order kind, so the balance is identical across every iteration for this accountId (comm-audit
  // batch F item 4 — this used to be one getWallet round trip per undelivered order, plus a further redundant
  // one right after in getSave — now callers reuse this return value instead of re-fetching).
  const w = await commercial.getWallet(accountId, clientPlatform);
  for (const o of orders) {
    const pityPatch =
      o.kind === 'gacha' && o.result.poolId && w
        ? { [o.result.poolId]: w.pity[o.result.poolId] ?? 0 }
        : null;
    await deliverOrder(cols, commercial, socialsvc, accountId, o, w?.coins ?? 0, pityPatch, now);
  }
  return w;
}
