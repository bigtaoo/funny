// Equipment inventory backend (E2 crafting + worldsvc auction escrow/transfer). EQUIPMENT_DESIGN §3 / §6 / §18.
//
// Fully server-authoritative (L2): SaveData.equipmentInv is written exclusively by this
// module; PUT /save cannot write it (SyncPatch has been narrowed). Writes use optimistic-lock
// rev guards + retries (same pattern as internal.ts material deduction).
//
// Responsibilities:
//   · craftEquipment   Player crafting (E2): deduct stationery materials → roll a +0 base item → add to inventory (300 cap). idemKey idempotent.
//   · escrowEquipment  worldsvc auction escrow (E2.5): verify not equipped/not locked → remove from seller inventory → return snapshot for worldsvc to store in the listing.
//   · grantEquipment   worldsvc trade transfer / listing cancellation/expiry return (E2.5): write instance snapshot into target account inventory (overwrite by id = idempotent).
//   · enhanceEquipment Player enhancement (E3): server rolls dice (success rate table) → deduct materials + coins (commercial authoritative) → on success level+1. idemKey idempotent.
//   · salvageEquipment Player salvage (E3): +0–4 items refund 70% crafting materials, remove from inventory (+5 rejected; equipped/locked rejected), batch. idemKey idempotent.
//   · equipEquipment   Player equip (E4): validate slot match → write gear.global[slot] (or byUnit); instanceId=null to unequip. Pure state change.
//   · reforgeEquipment Player reforge (E6): consume same-slot lower-rarity material → re-roll secondary affixes (primary affix preserved). idemKey idempotent.
import {
  EQUIPMENT_DEFS,
  EQUIPMENT_INV_CAP,
  EQUIPMENT_IDEM_TTL_SEC,
  EQUIP_MAX_LEVEL,
  EQUIP_SLOTS,
  SALVAGE_MAX_LEVEL,
  REFORGE_MATERIAL_RARITY,
  PROTECT_ENHANCE_ITEM_ID,
  equipmentInvCount,
  rollCraftedAffixes,
  rollEnhanceSuccess,
  rollReforgedAffixes,
  enhanceCost,
  salvageRefund,
  type Collections,
  type SaveData,
  type EquipSlot,
  type EquipmentInstance,
} from '@nw/shared';
import { getOrCreateSave } from './save.js';
import { mirrorCoins } from './economy.js';
import type { CommercialClient } from './commercialClient.js';

/** Business error codes (HTTP mapping is handled in the router layer). */
export type EquipErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'NOT_IMPLEMENTED'
  | 'EQUIP_NOT_FOUND'
  | 'INSUFFICIENT_MATERIALS'
  | 'INSUFFICIENT_FUNDS'
  | 'INVENTORY_FULL'
  | 'EQUIP_LOCKED'
  | 'EQUIP_IN_USE'
  | 'ENHANCE_MAX_LEVEL'
  | 'NOT_SALVAGEABLE'
  | 'NOT_REFORGE_ELIGIBLE'
  | 'INVALID_SLOT'
  | 'INVALID_RARITY'
  | 'REV_CONFLICT';

export interface EquipError {
  error: string;
  code: EquipErrorCode;
}

const REV_RETRIES = 3;

function idemExpireAt(now: number): Date {
  return new Date(now + EQUIPMENT_IDEM_TTL_SEC * 1000);
}

/**
 * Returns whether an equipment instance is currently equipped by any card in the Hero Roster.
 * Scans every CardInstance.gear (CC-2); an equipped item cannot be listed for auction or removed.
 */
function isEquipped(save: SaveData, instanceId: string): boolean {
  for (const card of Object.values(save.cardInv ?? {})) {
    for (const slotId of Object.values(card.gear ?? {})) {
      if (slotId === instanceId) return true;
    }
  }
  return false;
}

/**
 * Crafts a +0 base equipment item (E2, EQUIPMENT_DESIGN §4/§7).
 * Deducts EQUIPMENT_DEFS[defId].craftCost materials → rolls primary + secondary affixes → adds to inventory (< 300 cap).
 * idempotencyKey idempotent: replays return the first result (no second material deduction, no second roll; the roll itself is deterministically derived from the key).
 */
export async function craftEquipment(
  cols: Collections,
  now: () => number,
  accountId: string,
  defId: string,
  idempotencyKey: string,
): Promise<{ instance: EquipmentInstance; save: SaveData } | EquipError> {
  const def = EQUIPMENT_DEFS[defId];
  if (!def) return { error: 'unknown defId', code: 'BAD_REQUEST' };
  if (!def.craftCost) return { error: 'defId not craftable', code: 'BAD_REQUEST' };
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };

  // Deterministic output (id + affixes both derived from idempotencyKey → consistent across replays/retries, preventing "retry-reroll" exploits).
  const instance: EquipmentInstance = {
    id: `eq_${idempotencyKey}`,
    defId,
    rarity: def.rarity,
    level: 0,
    affixes: rollCraftedAffixes(defId, idempotencyKey),
  };
  const craftCost = def.craftCost;

  // Pre-validate current save (friendly early error; authoritative guard re-checks inside the rev loop).
  const cur = await getOrCreateSave(cols, accountId, now());
  for (const [mat, qty] of Object.entries(craftCost)) {
    if ((cur.materials?.[mat] ?? 0) < qty) return { error: `insufficient ${mat}`, code: 'INSUFFICIENT_MATERIALS' };
  }
  if (equipmentInvCount(cur.equipmentInv) >= EQUIPMENT_INV_CAP) {
    return { error: 'equipment inventory full', code: 'INVENTORY_FULL' };
  }

  // Idempotency gate: claim the idemKey first (unique _id). Claim failure = already crafted → replay first result.
  try {
    await cols.equipmentIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'craft',
      result: instance,
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
      const save = await getOrCreateSave(cols, accountId, now());
      return { instance: (prev?.result as EquipmentInstance) ?? instance, save };
    }
    throw e;
  }

  // Claim succeeded → deduct materials + add to inventory (optimistic-lock rev guard + retries).
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'save not found', code: 'NOT_FOUND' };
    }
    const save = doc.save;
    // Re-validate inside rev loop (concurrent material consumption / full inventory). On failure release idem claim so client can correct and retry.
    for (const [mat, qty] of Object.entries(craftCost)) {
      if ((save.materials?.[mat] ?? 0) < qty) {
        await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
        return { error: `insufficient ${mat}`, code: 'INSUFFICIENT_MATERIALS' };
      }
    }
    if (equipmentInvCount(save.equipmentInv) >= EQUIPMENT_INV_CAP) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'equipment inventory full', code: 'INVENTORY_FULL' };
    }
    const nextMaterials = { ...save.materials };
    for (const [mat, qty] of Object.entries(craftCost)) nextMaterials[mat] = (nextMaterials[mat] ?? 0) - qty;
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      materials: nextMaterials,
      equipmentInv: { ...(save.equipmentInv ?? {}), [instance.id]: instance },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { instance, save: next };
    // rev conflict (concurrent PUT /save / pve write) → re-read and retry
  }
  // Retries exhausted: retain the idem claim (result instance is recorded; next replay will return it without re-deducting materials).
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/**
 * worldsvc auction escrow: removes one equipment instance from the seller's inventory and
 * returns a snapshot (worldsvc stores it in the listing doc; replayed on trade completion or return).
 * Equipped (referenced by gear) / locked → rejected. orderId idempotent: replays return the first escrow snapshot.
 */
export async function escrowEquipment(
  cols: Collections,
  now: () => number,
  accountId: string,
  instanceId: string,
  orderId: string,
): Promise<{ instance: EquipmentInstance } | EquipError> {
  if (!instanceId || !orderId) return { error: 'instanceId + orderId required', code: 'BAD_REQUEST' };

  // Replay
  const existing = await cols.equipmentIdem.findOne({ _id: orderId });
  if (existing?.op === 'escrow') return { instance: existing.result as EquipmentInstance };

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;
    const inst = save.equipmentInv?.[instanceId];
    if (!inst) {
      // Concurrently escrowed (idem already written) → replay; otherwise the instance genuinely does not exist.
      const replay = await cols.equipmentIdem.findOne({ _id: orderId });
      if (replay?.op === 'escrow') return { instance: replay.result as EquipmentInstance };
      return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
    }
    if (inst.locked) return { error: 'equipment locked', code: 'EQUIP_LOCKED' };
    if (isEquipped(save, instanceId)) return { error: 'equipment in use (equipped)', code: 'EQUIP_IN_USE' };

    const nextInv = { ...(save.equipmentInv ?? {}) };
    delete nextInv[instanceId];
    const next: SaveData = { ...save, rev: save.rev + 1, updatedAt: now(), equipmentInv: nextInv };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      // Record ledger entry (snapshot used for trade transfer / return; $setOnInsert prevents concurrent overwrites).
      await cols.equipmentIdem.updateOne(
        { _id: orderId },
        { $setOnInsert: { accountId, op: 'escrow', result: inst, expireAt: idemExpireAt(now()) } },
        { upsert: true },
      );
      return { instance: inst };
    }
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/**
 * worldsvc trade transfer (to buyer) / listing cancellation/expiry/season-end return (to seller):
 * writes the instance snapshot into the target account's inventory.
 * Overwrites by instance.id → naturally idempotent (re-delivering the same instance does not duplicate it).
 * Transfer is an "intentional gain" and **bypasses the 300-item cap** (overflow-to-mail fallback
 * is §13 follow-up work; this slice does not block trade completion to prevent asset loss).
 */
export async function grantEquipment(
  cols: Collections,
  now: () => number,
  accountId: string,
  instance: EquipmentInstance,
): Promise<{ ok: true } | EquipError> {
  if (!instance?.id) return { error: 'instance required', code: 'BAD_REQUEST' };
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      equipmentInv: { ...(save.equipmentInv ?? {}), [instance.id]: instance },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { ok: true };
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

// ── E3 Enhancement (EQUIPMENT_DESIGN §6 / §18.2) ──────────────────────────────────────

/**
 * Enhances one equipment item (level → level+1). EQUIPMENT_DESIGN §6: server rolls dice
 * (success rate table, −10% per level), materials + coins are deducted on both success and
 * failure (failed-attempt loss is the core sink, §6.2); failure does not reduce level or destroy the item.
 *
 * Coins go through commercial authority (`save.wallet.coins` is only a mirror, economy.ts §0),
 * so enhancement requires commercial to be online.
 * Idempotent (idempotencyKey): dice result + costs are all bound to the key; replays return
 * the first result (no second roll / second material deduction).
 * commercial.spend uses idemKey as orderId and is naturally idempotent → replaying the call
 * does not double-charge coins.
 *
 * Ordering (player safety): first atomically update the save (deduct materials + level+1 on
 * success, rev guard), **then** deduct coins.
 * If the save update fails (rev exhausted / insufficient materials), coins are untouched and
 * the idempotency claim can safely be released for a retry; if the save update succeeds and the
 * coin-deduction step hits a network hiccup, the replay path idempotently re-charges
 * (spend(idemKey)) + mirrors, ensuring no charge is ever missed.
 */
export async function enhanceEquipment(
  cols: Collections,
  commercial: CommercialClient,
  now: () => number,
  accountId: string,
  instanceId: string,
  idempotencyKey: string,
  useProtect = false,
): Promise<{ success: boolean; instance: EquipmentInstance; save: SaveData } | EquipError> {
  if (!instanceId) return { error: 'instanceId required', code: 'BAD_REQUEST' };
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };

  // Replay: return first dice result + idempotently settle coins (covers the "save updated but coin deduction interrupted" window).
  const replay = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'enhance') {
    const r = replay.result as { success: boolean; instance: EquipmentInstance; coins: number; skipMaterials?: boolean };
    const save = await settleEnhanceCoins(cols, commercial, now, accountId, idempotencyKey, r.coins);
    return { success: r.success, instance: r.instance, save };
  }

  // Coins go through commercial authority; if not configured, enhancement is unavailable (same 503 as shop/gacha).
  if (!commercial.available) return { error: 'commercial service unavailable', code: 'NOT_IMPLEMENTED' };

  const cur = await getOrCreateSave(cols, accountId, now());
  const inst0 = cur.equipmentInv?.[instanceId];
  if (!inst0) return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
  if (inst0.level >= EQUIP_MAX_LEVEL) return { error: 'already max level', code: 'ENHANCE_MAX_LEVEL' };

  const fromLevel = inst0.level;
  const cost = enhanceCost(fromLevel);
  // Pre-validate materials (friendly early error; re-checked inside the rev loop).
  for (const [mat, qty] of Object.entries(cost.materials)) {
    if ((cur.materials?.[mat] ?? 0) < qty) return { error: `insufficient ${mat}`, code: 'INSUFFICIENT_MATERIALS' };
  }
  // Pre-validate coins (commercial authoritative; insufficient → no state changes, friendly 402).
  const wallet = await commercial.getWallet(accountId);
  if ((wallet?.coins ?? 0) < cost.coins) return { error: 'not enough coins', code: 'INSUFFICIENT_FUNDS' };

  const success = rollEnhanceSuccess(idempotencyKey, fromLevel);
  const instanceAfter: EquipmentInstance = success ? { ...inst0, level: fromLevel + 1 } : { ...inst0 };

  // Protect item (E7 §6.2): on failure consumes 1 protect_enhance → skip material deduction (skipMaterials=true).
  // Coins are still deducted (protect does not waive the enhancement fee, only saves materials); not consumed on success (success has no "failed-attempt loss" to begin with).
  const hasProtect = useProtect && (cur.inventory?.items?.[PROTECT_ENHANCE_ITEM_ID] ?? 0) > 0;
  const skipMaterials = hasProtect && !success;

  // Idempotency claim (result includes coins + skipMaterials for replay re-settlement). dup = concurrent duplicate → takes the replay path.
  try {
    await cols.equipmentIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'enhance',
      result: { success, instance: instanceAfter, coins: cost.coins, skipMaterials },
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
      const r = prev?.result as { success: boolean; instance: EquipmentInstance; coins: number; skipMaterials?: boolean };
      const save = await settleEnhanceCoins(cols, commercial, now, accountId, idempotencyKey, r.coins);
      return { success: r.success, instance: r.instance, save };
    }
    throw e;
  }

  // Atomic save update: deduct materials (when skipMaterials=false) + level+1 on success + consume protect_enhance (when skipMaterials=true).
  // Rev guard; only applies if the instance still exists and its level has not changed.
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'save not found', code: 'NOT_FOUND' };
    }
    const save = doc.save;
    const inst = save.equipmentInv?.[instanceId];
    if (!inst) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
    }
    if (inst.level !== fromLevel) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'instance level changed, retry', code: 'REV_CONFLICT' };
    }
    if (!skipMaterials) {
      // No protect item / success path: deduct materials normally
      for (const [mat, qty] of Object.entries(cost.materials)) {
        if ((save.materials?.[mat] ?? 0) < qty) {
          await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
          return { error: `insufficient ${mat}`, code: 'INSUFFICIENT_MATERIALS' };
        }
      }
    }
    const nextMaterials = { ...(save.materials ?? {}) };
    if (!skipMaterials) {
      for (const [mat, qty] of Object.entries(cost.materials)) nextMaterials[mat] = (nextMaterials[mat] ?? 0) - qty;
    }
    const nextInv = { ...(save.equipmentInv ?? {}), [instanceId]: instanceAfter };
    const nextItems = { ...(save.inventory?.items ?? {}) };
    if (skipMaterials) {
      // Consume the protect item
      nextItems[PROTECT_ENHANCE_ITEM_ID] = Math.max(0, (nextItems[PROTECT_ENHANCE_ITEM_ID] ?? 0) - 1);
    }
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      materials: nextMaterials,
      equipmentInv: nextInv,
      inventory: { ...(save.inventory ?? { skins: [] }), items: nextItems },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      // Save update committed → deduct coins (idemKey idempotent) + mirror. If coin deduction fails (concurrent exhaustion) it is merely under-charged; the enhancement is already finalized (§6.2).
      const saveFinal = await settleEnhanceCoins(cols, commercial, now, accountId, idempotencyKey, cost.coins);
      return { success, instance: instanceAfter, save: saveFinal };
    }
    // rev conflict → re-read and retry
  }
  // Save update failed (coins untouched) → release claim; client can safely retry.
  await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/** Deducts enhancement coins (commercial authoritative, orderId=idemKey idempotent) + writes mirror; if commercial is unavailable/fails, the mirror is not updated. */
async function settleEnhanceCoins(
  cols: Collections,
  commercial: CommercialClient,
  now: () => number,
  accountId: string,
  idempotencyKey: string,
  coins: number,
): Promise<SaveData> {
  if (coins > 0 && commercial.available) {
    const charge = await commercial.spend({ accountId, amount: coins, reason: 'equip_enhance', orderId: idempotencyKey });
    if (charge.ok) return mirrorCoins(cols, accountId, charge.coinsAfter, now());
  }
  return getOrCreateSave(cols, accountId, now());
}

/**
 * Salvages a batch of equipment items (EQUIPMENT_DESIGN §6.3, ADR-012): refunds 70% crafting
 * materials and removes items from inventory.
 * +5 and above cannot be salvaged (NOT_SALVAGEABLE); equipped (EQUIP_IN_USE) / locked
 * (EQUIP_LOCKED) items are rejected.
 * The entire batch is validated first; any non-compliant item rejects the whole batch
 * (no partial completion state), then a single atomic write removes instances and credits materials. idemKey idempotent.
 */
export async function salvageEquipment(
  cols: Collections,
  now: () => number,
  accountId: string,
  instanceIds: string[],
  idempotencyKey: string,
): Promise<{ refunded: Record<string, number>; save: SaveData } | EquipError> {
  if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
    return { error: 'instanceIds required', code: 'BAD_REQUEST' };
  }
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };

  const replay = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'salvage') {
    const r = replay.result as { refunded: Record<string, number> };
    return { refunded: r.refunded, save: await getOrCreateSave(cols, accountId, now()) };
  }

  const ids = [...new Set(instanceIds)];
  // Validate + accumulate refund (using current save; existence re-checked inside rev loop).
  const cur = await getOrCreateSave(cols, accountId, now());
  const refunded: Record<string, number> = {};
  for (const id of ids) {
    const inst = cur.equipmentInv?.[id];
    if (!inst) return { error: `equipment instance not found: ${id}`, code: 'EQUIP_NOT_FOUND' };
    if (inst.locked) return { error: `equipment locked: ${id}`, code: 'EQUIP_LOCKED' };
    if (isEquipped(cur, id)) return { error: `equipment in use: ${id}`, code: 'EQUIP_IN_USE' };
    if (inst.level > SALVAGE_MAX_LEVEL) return { error: `not salvageable (+${inst.level}): ${id}`, code: 'NOT_SALVAGEABLE' };
    for (const [mat, qty] of Object.entries(salvageRefund(inst.defId))) refunded[mat] = (refunded[mat] ?? 0) + qty;
  }

  // Idempotency claim.
  try {
    await cols.equipmentIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'salvage',
      result: { refunded },
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
      const r = prev?.result as { refunded: Record<string, number> };
      return { refunded: r.refunded, save: await getOrCreateSave(cols, accountId, now()) };
    }
    throw e;
  }

  // Atomic write: remove instances + credit materials (rev guard; loop re-checks all are still present and salvageable).
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'save not found', code: 'NOT_FOUND' };
    }
    const save = doc.save;
    for (const id of ids) {
      const inst = save.equipmentInv?.[id];
      if (!inst || inst.locked || isEquipped(save, id) || inst.level > SALVAGE_MAX_LEVEL) {
        await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
        return { error: `equipment no longer salvageable: ${id}`, code: 'REV_CONFLICT' };
      }
    }
    const nextInv = { ...(save.equipmentInv ?? {}) };
    for (const id of ids) delete nextInv[id];
    const nextMaterials = { ...save.materials };
    for (const [mat, qty] of Object.entries(refunded)) nextMaterials[mat] = (nextMaterials[mat] ?? 0) + qty;
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      materials: nextMaterials,
      equipmentInv: nextInv,
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { refunded, save: next };
  }
  await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

// ── E6 Reforge (EQUIPMENT_DESIGN §7.8 / ADR-017) ──────────────────────────────────

/**
 * Reforges one equipment item (E6, EQUIPMENT_DESIGN §7.8): consumes a same-slot lower-rarity
 * material item, preserves the primary affix, and re-rolls all secondary affixes.
 * Only fine/rare/epic items can be reforged (common has no secondary affixes); material rarity
 * must be exactly one tier lower (REFORGE_MATERIAL_RARITY).
 * idempotencyKey idempotent (same key replays the first result).
 */
export async function reforgeEquipment(
  cols: Collections,
  now: () => number,
  accountId: string,
  targetId: string,
  materialId: string,
  idempotencyKey: string,
): Promise<{ instance: EquipmentInstance; save: SaveData } | EquipError> {
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };
  if (targetId === materialId) return { error: 'target and material must differ', code: 'BAD_REQUEST' };

  // Idempotency replay check
  const replay = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'reforge') {
    const r = replay.result as { instance: EquipmentInstance };
    return { instance: r.instance, save: await getOrCreateSave(cols, accountId, now()) };
  }

  const cur = await getOrCreateSave(cols, accountId, now());
  const target = cur.equipmentInv?.[targetId];
  if (!target) return { error: 'target equipment not found', code: 'EQUIP_NOT_FOUND' };
  if (isEquipped(cur, targetId)) return { error: 'target is equipped', code: 'EQUIP_IN_USE' };
  if (target.locked) return { error: 'target is locked', code: 'EQUIP_LOCKED' };

  const requiredMatRarity = REFORGE_MATERIAL_RARITY[target.rarity];
  if (!requiredMatRarity) return { error: `${target.rarity} equipment cannot be reforged`, code: 'NOT_REFORGE_ELIGIBLE' };

  const material = cur.equipmentInv?.[materialId];
  if (!material) return { error: 'material equipment not found', code: 'EQUIP_NOT_FOUND' };
  if (isEquipped(cur, materialId)) return { error: 'material is equipped', code: 'EQUIP_IN_USE' };

  const targetDef = EQUIPMENT_DEFS[target.defId];
  const matDef = EQUIPMENT_DEFS[material.defId];
  if (!targetDef || !matDef) return { error: 'unknown equipment def', code: 'BAD_REQUEST' };
  if (matDef.slot !== targetDef.slot) return { error: `material slot ${matDef.slot} must match target slot ${targetDef.slot}`, code: 'INVALID_SLOT' };
  if (material.rarity !== requiredMatRarity) {
    return { error: `material must be ${requiredMatRarity} (got ${material.rarity})`, code: 'INVALID_RARITY' };
  }

  // Deterministic re-roll (idempotencyKey used as seed)
  const newAffixes = rollReforgedAffixes(target.defId, idempotencyKey, target.affixes);
  const reforged: EquipmentInstance = { ...target, affixes: newAffixes };

  // Idempotency claim
  try {
    await cols.equipmentIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'reforge',
      result: { instance: reforged },
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
      const r = prev?.result as { instance: EquipmentInstance };
      return { instance: r.instance, save: await getOrCreateSave(cols, accountId, now()) };
    }
    throw e;
  }

  // Atomic write: update target affixes + remove material (rev guard)
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'save not found', code: 'NOT_FOUND' };
    }
    const save = doc.save;
    // Re-validate inside rev loop: both items must still exist, target must not be equipped/locked
    if (!save.equipmentInv?.[targetId] || !save.equipmentInv?.[materialId]) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'equipment no longer available', code: 'REV_CONFLICT' };
    }
    if (save.equipmentInv[targetId]!.locked || isEquipped(save, targetId)) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'target no longer reformable', code: 'REV_CONFLICT' };
    }
    const nextInv = { ...(save.equipmentInv ?? {}), [targetId]: reforged };
    delete nextInv[materialId];
    const next: SaveData = { ...save, rev: save.rev + 1, updatedAt: now(), equipmentInv: nextInv };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { instance: reforged, save: next };
  }
  await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

// ── E4 Equip (EQUIPMENT_DESIGN §3.4 / CC-2) ──────────────────────────────────────

/**
 * Equips or unequips one item onto a specific card instance (CC-2, CHARACTER_CARDS_DESIGN §5).
 * Pure state change, no randomness, no resources → naturally idempotent, no idemKey needed.
 * instanceId=null unequips the slot; otherwise validates instance existence + slot match (INVALID_SLOT).
 * cardInstanceId must reference an existing CardInstance in save.cardInv; gear is written to
 * CardInstance.gear[slot] (CC-2 per-card loadout; CHARACTER_CARDS_DESIGN §5).
 */
export async function equipEquipment(
  cols: Collections,
  now: () => number,
  accountId: string,
  slot: string,
  instanceId: string | null,
  cardInstanceId: string,
): Promise<{ save: SaveData } | EquipError> {
  if (!EQUIP_SLOTS.includes(slot as EquipSlot)) return { error: 'invalid slot', code: 'INVALID_SLOT' };
  if (!cardInstanceId) return { error: 'cardInstanceId required', code: 'BAD_REQUEST' };

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;

    const card = (save.cardInv ?? {})[cardInstanceId];
    if (!card) return { error: 'card instance not found', code: 'NOT_FOUND' };

    if (instanceId !== null) {
      const inst = save.equipmentInv?.[instanceId];
      if (!inst) return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
      const def = EQUIPMENT_DEFS[inst.defId];
      if (def && def.slot !== slot) return { error: `slot mismatch: ${inst.defId} is ${def.slot}`, code: 'INVALID_SLOT' };
    }

    const updatedGear = { ...(card.gear ?? {}) };
    if (instanceId === null) delete (updatedGear as Record<string, string | undefined>)[slot];
    else (updatedGear as Record<string, string>)[slot] = instanceId;

    const updatedCard = { ...card, gear: updatedGear };
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      cardInv: { ...(save.cardInv ?? {}), [cardInstanceId]: updatedCard },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { save: next };
  }
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}
