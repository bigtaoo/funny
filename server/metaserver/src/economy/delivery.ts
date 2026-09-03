// Idempotent item delivery + wallet-mirror primitives. Split out of economy.ts (2026-08-10, 独立函数
// 模块 form — see economy.ts's facade comment). `deliverGrant`/`deliverMailGrant` are the two atomic,
// idempotent document-update primitives that `orders.ts` (deliverLootBox/deliverOrder) builds on;
// `mirrorCoins`/`mirrorWalletFrom` refresh the wallet mirror only, with no item delivery.
import type { Collections, SaveData, EquipmentInstance, SkinInstance } from '@nw/shared';
import { PRODUCT_STARTER_GROWTH, GROWTH_PACK_WINDOW_DAYS } from '@nw/shared';
import { toInstanceDoc } from '../equipment.js';
import { toInstanceDoc as toSkinInstanceDoc } from '../skin.js';
import { recordMaterialGrants } from '../material.js';
import type { WalletView } from '../commercialClient.js';

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
  // crash before commercial.orderDelivered) is safe to repeat. Not subject to the 1000-cap (overflow →
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
  if (res) {
    // Material provenance (ITEM_IDENTITY_DESIGN.md task2, 2026-08-10): best-effort, fires only on an
    // actual fresh delivery (not a reconciliation replay of an already-delivered orderId) — this is the
    // only deliverGrant caller (deliverLootBox) that ever passes materialInc, and it's always a gacha
    // draw, so the tag is hardcoded rather than threaded through as another parameter.
    if (grantedMaterialIds.length > 0) {
      await recordMaterialGrants(cols, accountId, orderId, materialInc ?? {}, `gacha:${orderId}`, now);
    }
    return res.save;
  }
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
  // Material/item provenance tag (ITEM_IDENTITY_DESIGN.md task2, 2026-08-10) — defaults to 'mail' (this
  // function's single highest-traffic caller, social.ts's claimMail, covers every mail-delivered kind
  // regardless of the mail's original cause: auction settlement, worldsvc season rewards, admin grants,
  // ...) — same "one generic tag for every mail-sourced item" convention SkinInstance already uses.
  // Callers with a more specific context (e.g. shop.ts's direct material/item purchases) pass their own.
  provenanceSourceType = 'mail',
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
  if (res) {
    // Material/item provenance (ITEM_IDENTITY_DESIGN.md task2, 2026-08-10): best-effort, only on an
    // actual fresh delivery (guarded by the same deliveredOrders check as the counter update above).
    // Materials and inventory.items share the same MaterialInstance ledger shape (both are plain
    // Record<string,number> quantity resources) but get distinct baseId suffixes so the two namespaces
    // can never collide on the same instance _id even if a material key and an item key were ever equal.
    await recordMaterialGrants(cols, accountId, `${orderId}_mat`, materialInc, provenanceSourceType, now);
    await recordMaterialGrants(cols, accountId, `${orderId}_item`, itemInc, provenanceSourceType, now);
    return res.save;
  }
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
 * insertion order (Mongo preserves storage order, which need not match a freshly-built plain object's).
 *
 * Keys whose value is `undefined` or `null` are dropped (2026-09-03 fix), because that is exactly what a
 * round trip through Mongo does to them: `monetization` is always built with a `subscriptionLastClaimDay`
 * key, but for an account that never claimed a subscription day its value is `undefined` and the stored
 * sub-document simply has no such key. Comparing the two verbatim therefore NEVER matched for an
 * unsubscribed account, so mirrorWalletFrom's skip-the-write path below was dead for the overwhelming
 * majority of players and every GET /save bumped save.rev again — reviving the spurious-409-against-an-
 * in-flight-PUT problem the 2026-07-27 audit removed. Normalizing absent/undefined/null to the same
 * thing on both sides is what makes the comparison mean "is the stored mirror current". */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    const rec = v as Record<string, unknown>;
    const keys = Object.keys(rec).filter((k) => rec[k] !== undefined && rec[k] !== null).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`).join(',')}}`;
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
