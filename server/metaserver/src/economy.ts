// Economy orchestration helpers (S5-5). meta delivers items based on commercial receipts
// (inventory is meta-authoritative) + writes the wallet mirror + reconciles undelivered orders.
// Key invariants:
//  • Delivery is idempotent — deliverGrant/deliverMailGrant gate their whole write on
//    `'save.deliveredOrders': { $ne: orderId }`, so a re-run of the same orderId (concurrent
//    reconcileUndelivered racing an in-flight delivery, or a caller retry) is a no-op, not just for
//    the $addToSet'd skins but also the $inc'd materials/items (fixed 2026-08-03; deliveredOrders was
//    previously write-only and this guard did not exist, allowing double-delivery under concurrency).
//  • Wallet mirror — wallet.coins / gacha.pity are authoritative in commercial; meta only writes
//    the mirror section after a receipt, for offline display.
//  • Skin duplicates (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08): every gacha skin result — first
//    pull or dupe alike — now grants a real SkinInstance (see skin.ts); the old design where a
//    duplicate was silently dropped (no item, no coin refund, despite GACHA_DESIGN §4.3 describing an
//    auto-refund that was never actually wired up) is gone. Cashing in a surplus copy for coins is a
//    separate, player-initiated action (skin.ts sellSkinToSystem), never automatic.
import { createHash } from 'node:crypto';
import type { Collections, SaveData, Rarity, EquipmentInstance, CardInstance, SkinInstance, RedisLike } from '@nw/shared';
import {
  EQUIPMENT_DEFS, GACHA_MATERIAL_GRANTS, makeGachaEquipInstance, EQUIPMENT_INV_CAP,
  EQUIP_FULL_COMPENSATION_COINS, EQUIP_INV_FULL_MAIL_COUNT, CARD_DEFS,
  type CardDef, PRODUCT_STARTER_GROWTH, GROWTH_PACK_WINDOW_DAYS, findShopItem,
  bumpCappedCounter, readCounterField, bumpGuardedTimestamp,
} from '@nw/shared';
import { grantCards as grantHeroCards } from './cards.js';
import { insertSystemMail } from './mail.js';
import { toInstanceDoc } from './equipment.js';
import { toInstanceDoc as toSkinInstanceDoc } from './skin.js';
import type { MetaSocialsvcClient } from './socialsvcClient.js';
import type { CommercialClient, GachaResultEntry, WalletView } from './commercialClient.js';

/** 30-day expiry, matching the auction/ladder-settlement system-mail convention. */
const EQUIP_OVERFLOW_MAIL_EXPIRE_DAYS = 30;

/**
 * save.deliveredOrders is now also consulted for a dedup decision (2026-08-03 fix): deliverGrant/
 * deliverMailGrant gate their write on `{ $ne: orderId }` so a re-run of an already-delivered orderId
 * can't double-grant materials/items (previously only the $addToSet'd skins were naturally idempotent).
 * Left as an unbounded $addToSet it grows forever with every gacha draw / shop purchase, and a
 * long-lived heavy account's save document balloons (900+ entries observed in prod, 2026-07-26 lag
 * triage) — every read/write of that account's save then has to transfer/parse the whole array, adding
 * ~1s to every action that touches the save (achievements/retention/shop/gacha/pve). Capped via
 * $push+$slice to the most recent N: this means an orderId older than the last N deliveries for this
 * account falls out of the dedup window and could theoretically re-deliver — an accepted tradeoff
 * (real idempotency for the actually-concurrent case this fixes; the cap only matters for a
 * reconciliation retry arriving absurdly late, long after hundreds of newer orders).
 */
const DELIVERED_ORDERS_CAP = 200;

/** Roster/inventory-full overflow summary for one delivery call (used by gachaDraw to surface a client toast). */
export interface OverflowSummary {
  cardMailed: number;
  cardCompensatedCoins: number;
  equipMailed: number;
  equipCompensatedCoins: number;
}

/**
 * Mark each result as duplicate or not — drives the reveal UI's NEW badge. "Duplicate" means
 * lifetime ownership, not merely current possession (2026-08-08 fix; the previous version only
 * special-cased character cards — see the two bug classes below — and dumped materials/equipment
 * into the generic "skin" branch, whose within-batch-only dedup meant a material/equipment item the
 * player had owned for ages still got badged NEW on every draw as long as it wasn't a *second* copy
 * within the very same pull):
 *   - materials/equipment routed to `save.materials`/`equipmentInstances` (not `inventory.skins`)
 *     were never checked against real ownership at all — every first-in-batch material/equipment
 *     result showed NEW regardless of how much was already in the bag.
 *   - character cards routed to `cardInv` were checked against `ownedCardDefIds`, which is correct
 *     but doesn't survive every last copy of a defId being consumed away (fusion fodder) — same gap
 *     equipment/materials have when spent to zero then re-earned.
 * Callers own the ownership computation per kind, unioning the live inventory (current cardInv/
 * equipmentInstances/materials-with-count>0) with that kind's `save.everOwned.*` ledger (additive-
 * only, survives salvage/consume/sell — see SaveData.everOwned doc comment) so a legacy save whose
 * everOwned ledger has gaps still gets the right answer from the live inventory, and vice versa.
 *
 * `newSkins` stays a separate concern from the skin `duplicate` flag: it drives `inventory.skins`
 * $addToSet (has this exact skinId ever landed in the array?), which must stay keyed off the plain
 * array — a skin currently absent from inventory.skins (sold via auction escrow) needs re-adding
 * even though `everOwned.skin` means it's not a "NEW" pull.
 */
export function markDuplicates(
  ownedSkins: string[],
  everOwnedSkins: string[],
  ownedHero: string[],
  ownedEquipment: string[],
  ownedMaterial: string[],
  results: GachaResultEntry[],
): { newSkins: string[]; marked: { itemId: string; rarity: Rarity; duplicate: boolean }[] } {
  const owned = new Set(ownedSkins);
  const everOwnedSkin = new Set(everOwnedSkins);
  const ownedHeroSet = new Set(ownedHero);
  const ownedEquipSet = new Set(ownedEquipment);
  const ownedMaterialSet = new Set(ownedMaterial);
  const newSkins: string[] = [];
  const marked = results.map((r) => {
    if (CARD_DEFS[r.itemId]) {
      const duplicate = ownedHeroSet.has(r.itemId);
      if (!duplicate) ownedHeroSet.add(r.itemId);
      return { itemId: r.itemId, rarity: r.rarity, duplicate };
    }
    if (EQUIPMENT_DEFS[r.itemId]) {
      const duplicate = ownedEquipSet.has(r.itemId);
      if (!duplicate) ownedEquipSet.add(r.itemId);
      return { itemId: r.itemId, rarity: r.rarity, duplicate };
    }
    const matGrant = GACHA_MATERIAL_GRANTS[r.itemId];
    if (matGrant) {
      const matKey = Object.keys(matGrant)[0]!;
      const duplicate = ownedMaterialSet.has(matKey);
      if (!duplicate) ownedMaterialSet.add(matKey);
      return { itemId: r.itemId, rarity: r.rarity, duplicate };
    }
    // Skin: `alreadyInInv` alone still decides `newSkins` (what to $addToSet); `duplicate` (the badge)
    // additionally checks everOwnedSkin so a re-pulled, previously-sold skin doesn't show NEW.
    const alreadyInInv = owned.has(r.itemId);
    const duplicate = alreadyInInv || everOwnedSkin.has(r.itemId);
    if (!alreadyInInv) {
      owned.add(r.itemId);
      newSkins.push(r.itemId);
    }
    return { itemId: r.itemId, rarity: r.rarity, duplicate };
  });
  return { newSkins, marked };
}

/**
 * Union the live inventory (current cardInstances/equipmentInstances defIds + materials-with-
 * count>0) with each kind's `save.everOwned.*` ledger into the ownedHero/ownedEquipment/
 * ownedMaterial inputs `markDuplicates` needs. See `markDuplicates`'s doc comment for why the union
 * — live inventory covers a legacy save whose everOwned ledger predates that item's first grant;
 * everOwned covers an item since spent/salvaged/fused away entirely. Pure/sync so callers can fetch
 * `cardDocs`/`equipDocs` concurrently with the save read instead of serializing after it.
 */
export function unionOwnershipForDuplicateCheck(
  cardDefIds: string[],
  equipDefIds: string[],
  save: SaveData,
): { ownedHero: string[]; ownedEquipment: string[]; ownedMaterial: string[] } {
  const ownedHero = [...new Set([...cardDefIds, ...(save.everOwned?.hero ?? [])])];
  const ownedEquipment = [...new Set([...equipDefIds, ...(save.everOwned?.equipment ?? [])])];
  const ownedMaterial = [...new Set([
    ...Object.entries(save.materials ?? {}).filter(([, n]) => n > 0).map(([k]) => k),
    ...(save.everOwned?.material ?? []),
  ])];
  return { ownedHero, ownedEquipment, ownedMaterial };
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
  skinInstances?: SkinInstance[],
): Promise<SaveData> {
  // Equipment instances live in the equipmentInstances collection (2026-07-26 split, see equipment.ts) —
  // upsert them independently of the saves write below, idempotent by instanceId (deterministic ids
  // derived from orderId+index, see deliverLootBox), so a reconciliation retry of this whole call (e.g.
  // crash before commercial.orderDelivered) is safe to repeat. Not subject to the 300-cap (overflow →
  // mail/coin, decided by the caller before calling in here — see deliverLootBox). Count is intentionally
  // NOT precisely $inc'd here (would double-count on a retry, unlike the idempotent upsert above); it
  // self-heals via the equipmentInv join that runs on the next GET /save / response serialization.
  for (const [id, inst] of Object.entries(equipInstances ?? {})) {
    await cols.equipmentInstances.updateOne(
      { _id: id },
      { $set: toInstanceDoc(inst, accountId) },
      { upsert: true },
    );
  }
  // Skin instances (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08): one row per skin result — first pull or
  // dupe alike, unlike `newSkins` below which only covers first-time-ever ones (for everOwned/NEW-badge
  // purposes). Upsert-by-id is idempotent the same way as equipInstances above (deterministic ids, see
  // deliverLootBox), so a reconciliation retry never double-mints.
  for (const inst of skinInstances ?? []) {
    await cols.skinInstances.updateOne(
      { _id: inst.id },
      { $set: toSkinInstanceDoc(inst, accountId) },
      { upsert: true },
    );
  }

  const set: Record<string, unknown> = {
    'save.updatedAt': now,
    'save.wallet.coins': coinsAfter,
  };
  if (pityPatch) {
    for (const [pool, v] of Object.entries(pityPatch)) set[`save.gacha.pity.${pool}`] = v;
  }
  if (equipMailOverflowCount !== undefined) set['save.equipMailOverflowCount'] = equipMailOverflowCount;
  const inc: Record<string, number> = { 'save.rev': 1, rev: 1 };
  const grantedMaterialIds: string[] = [];
  for (const [mat, qty] of Object.entries(materialInc ?? {})) if (qty > 0) { inc[`save.materials.${mat}`] = qty; grantedMaterialIds.push(mat); }
  const grantedEquipDefIds = [...new Set(Object.values(equipInstances ?? {}).map((inst) => inst.defId))];
  // Lifetime skin/material/equipment-owned ledgers (avatar unlock): additive-only, same rationale as
  // deliverMailGrant above — these gacha-delivered items must stay unlocked even after being
  // salvaged/consumed/sold, unlike inventory.skins/materials/equipmentInstances themselves.
  // `'save.deliveredOrders': { $ne: orderId }` makes the $inc'd materials/items genuinely idempotent
  // (not just the $addToSet'd skins) — without this guard, a GET /save racing an in-flight delivery
  // (e.g. gachaDraw's fire-and-forget commercial.orderDelivered) could re-run this same call via
  // reconcileUndelivered and double-grant materials.
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId, 'save.deliveredOrders': { $ne: orderId } },
    {
      $addToSet: {
        'save.inventory.skins': { $each: newSkins },
        ...(newSkins.length > 0 ? { 'save.everOwned.skin': { $each: newSkins } } : {}),
        ...(grantedMaterialIds.length > 0 ? { 'save.everOwned.material': { $each: grantedMaterialIds } } : {}),
        ...(grantedEquipDefIds.length > 0 ? { 'save.everOwned.equipment': { $each: grantedEquipDefIds } } : {}),
      },
      // $push+$slice (not $addToSet: no operator supports both dedup and capping) — keeps only the
      // most recent DELIVERED_ORDERS_CAP entries; see the constant's comment for why this is safe.
      $push: { 'save.deliveredOrders': { $each: [orderId], $slice: -DELIVERED_ORDERS_CAP } },
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
  skinInstances: SkinInstance[] = [],
): Promise<SaveData> {
  // Skin instances (ITEM_IDENTITY_DESIGN.md task1, 2026-08-08): a mail attachment for a skin the
  // player already owns used to vanish on claim (filtered out of `newSkins` upstream, same bug class as
  // the gacha loot-box path) — every attached skin now becomes a real instance regardless.
  for (const inst of skinInstances) {
    await cols.skinInstances.updateOne(
      { _id: inst.id },
      { $set: toSkinInstanceDoc(inst, accountId) },
      { upsert: true },
    );
  }
  const set: Record<string, unknown> = { 'save.updatedAt': now };
  if (coinsAfter !== null) set['save.wallet.coins'] = coinsAfter;
  const inc: Record<string, number> = { 'save.rev': 1, rev: 1 };
  for (const [id, n] of Object.entries(itemInc)) if (n > 0) inc[`save.inventory.items.${id}`] = n;
  const grantedMaterialIds: string[] = [];
  for (const [id, n] of Object.entries(materialInc)) if (n > 0) { inc[`save.materials.${id}`] = n; grantedMaterialIds.push(id); }
  // Lifetime skin/material-owned ledgers (avatar unlock): additive-only, alongside the existing
  // inventory.skins $addToSet — everOwned.skin survives auction escrow removing a skin from
  // inventory.skins, and everOwned.material survives the material later being spent to 0.
  // `'save.deliveredOrders': { $ne: orderId }` guard: see deliverGrant's comment — makes the $inc'd
  // items/materials idempotent too, not just the $addToSet'd skins.
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId, 'save.deliveredOrders': { $ne: orderId } },
    {
      $addToSet: {
        'save.inventory.skins': { $each: newSkins },
        ...(newSkins.length > 0 ? { 'save.everOwned.skin': { $each: newSkins } } : {}),
        ...(grantedMaterialIds.length > 0 ? { 'save.everOwned.material': { $each: grantedMaterialIds } } : {}),
      },
      $push: { 'save.deliveredOrders': { $each: [orderId], $slice: -DELIVERED_ORDERS_CAP } },
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

/** Recursively sorts object keys so two structurally-identical objects stringify the same regardless of
 * insertion order (Mongo preserves storage order, which need not match a freshly-built plain object's). */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
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
  const monetization = {
    fatePoints: wallet.fatePoints,
    subscriptionExpiry: wallet.subscriptionExpiry,
    subscriptionLastClaimDay: wallet.subscriptionLastClaimDay,
    starterUsed: wallet.starterUsed,
    starterGrowthEligible,
    firstPurchaseUsed: wallet.firstPurchaseUsed,
    totalRechargeCents: wallet.totalRechargeCents,
  };
  // GET /save calls this on every read (not just after a real purchase/ad/gacha), so an unconditional
  // write here made every read of the save also bump the optimistic-lock rev — racing any in-flight
  // client PUT /save into a spurious 409. Skip the write entirely when the mirror is already current
  // (2026-07-27 audit); this trades an unconditional write for a read that only sometimes escalates to one.
  const cur = await cols.saves.findOne({ _id: accountId });
  if (
    cur &&
    cur.save.wallet?.coins === wallet.coins &&
    stableStringify(cur.save.gacha?.pity) === stableStringify(wallet.pity) &&
    stableStringify(cur.save.monetization) === stableStringify(monetization)
  ) {
    return cur.save;
  }
  const res = await cols.saves.findOneAndUpdate(
    { _id: accountId },
    {
      $inc: { 'save.rev': 1, rev: 1 },
      $set: {
        'save.wallet.coins': wallet.coins,
        'save.gacha.pity': wallet.pity,
        'save.monetization': monetization,
        'save.updatedAt': now,
      },
    },
    { returnDocument: 'after' },
  );
  if (res) return res.save;
  const fallback = await cols.saves.findOne({ _id: accountId });
  if (!fallback) throw new Error('save missing after wallet mirror');
  return fallback.save;
}

/**
 * Route + deliver one loot-box result set: mat_* → materials, equipment defId → equipment
 * instance, character card defId → hero card grant (grantHeroCards, writes to the `cardInstances`
 * collection), everything else → skin. Shared by deliverOrder's loot-box branch (shop/mail/reconcile replay) and
 * gachaDraw (which delivers standard-pool draws directly, without going through the
 * commercial order-replay path). Does not mark the order delivered — callers do that
 * themselves (gachaDraw does it fire-and-forget to keep it off the response critical path).
 *
 * Roster/inventory-full overflow (cards ≥500 / equipment ≥300): the first CARD_INV_OVERFLOW_BUFFER
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
      const save = await deliverMailGrant(cols, accountId, order._id, [], itemInc, coinsAfter, now);
      await commercial.orderDelivered({ orderId: order._id });
      return { save };
    }
    if (shopDef?.kind === 'material') {
      const materialInc: Record<string, number> = { [shopDef.grants]: (shopDef.qty ?? 1) * qty };
      const save = await deliverMailGrant(cols, accountId, order._id, [], {}, coinsAfter, now, materialInc);
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

/** UTC calendar-day key (for ad cap resets). `now` is injected for testability. */
export function adsDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Ad cap: atomically increment today's count; returns false (deny delivery) if the count exceeds cap.
 * Redis-backed (2026-07-27, moved off Mongo's adsDaily — see shared/src/dailyCounter.ts for the design).
 */
export async function bumpAdsCap(
  redis: RedisLike | null,
  accountId: string,
  dayKey: string,
  cap: number,
): Promise<boolean> {
  return bumpCappedCounter(redis, 'adsDaily', accountId, dayKey, 'count', cap);
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
  redis: RedisLike | null,
  accountId: string,
  dayKey: string,
  now: number,
  minIntervalMs: number,
): Promise<boolean> {
  return bumpGuardedTimestamp(redis, 'adsDaily', accountId, dayKey, 'lastAdAt', minIntervalMs, now);
}

/** Read-only snapshot of today's ad-watch state, for GET /retention (DailyScene "Ads" tab). Does not mutate. */
export async function peekAdsStatus(
  redis: RedisLike | null,
  accountId: string,
  dayKey: string,
  minIntervalMs: number,
  now: number,
): Promise<{ watchedToday: number; nextAvailableAt: number }> {
  const [watchedToday, lastAdAt] = await Promise.all([
    readCounterField(redis, 'adsDaily', accountId, dayKey, 'count'),
    readCounterField(redis, 'adsDaily', accountId, dayKey, 'lastAdAt'),
  ]);
  const nextAvailableAt = lastAdAt ? lastAdAt + minIntervalMs : 0;
  return { watchedToday, nextAvailableAt: nextAvailableAt > now ? nextAvailableAt : 0 };
}
