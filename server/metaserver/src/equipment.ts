// Equipment inventory backend (E2 crafting + worldsvc auction escrow/transfer). EQUIPMENT_DESIGN §3 / §6 / §18.
//
// Fully server-authoritative (L2): equipment instances are written exclusively by this module.
// There is no generic client-sync write endpoint at all (PUT /save removed) — see DECISIONS.md.
//
// Storage (2026-07-26, perf): instances live in the `equipmentInstances` collection (_id=instanceId),
// NOT embedded in SaveData.equipmentInv anymore — an embedded map blew up save-doc size (81KB for a
// heavy account) and every save write (not just equipment ones) paid to rewrite it on Atlas M0. `save`
// only carries an `equipmentInvCount` mirror for cheap cap checks. GET /save and /internal/save-fields
// still reassemble the full `equipmentInv` map on demand (`assembleEquipmentInv`) — those are the
// "pull the whole inventory once" points (login/refresh), so client/worldsvc get the complete map there
// unchanged. Every mutation function below (craft/enhance/salvage/reforge/equip) instead returns
// `equipmentInv: null` (`leanSave`, phase 2 of the split, 2026-07-26 — see EQUIPMENT_DESIGN.md §3.3):
// the caller already holds everything needed to update its own copy (the `instance` handed back, or the
// `instanceIds`/`materialId` it sent as request params), so paying for a fresh
// `equipmentInstances.find({accountId})` on every single-item craft/enhance just to re-hand back a
// 51KB map the caller already knows how to reconstruct is pure waste — both in bytes over the wire and
// in the query itself.
//
// No Mongo transactions in this codebase (see shared/src/mongo.ts header) — cross-collection consistency
// here relies on ordering discipline + idempotency, same house style as the existing equipmentIdem
// ledger: commit the costly/guarded side of an operation first (so a crash before the second write can
// only under-deliver, never over-deliver), and make every idempotent-replay branch *re-assert* the
// target state rather than trust that a prior attempt's second write actually landed ("verify-and-heal").
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
  isSalvageable,
  REFORGE_MATERIAL_RARITY,
  reforgeCoinCost,
  PROTECT_ENHANCE_ITEM_ID,
  rollCraftedAffixes,
  rollEnhanceSuccess,
  rollReforgedAffixes,
  enhanceCost,
  salvageRefund,
  type Collections,
  type SaveData,
  type EquipSlot,
  type EquipmentInstance,
  type EquipmentInstanceDoc,
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
  | 'INVALID_MATERIAL_LEVEL'
  | 'REV_CONFLICT';

export interface EquipError {
  error: string;
  code: EquipErrorCode;
}

const REV_RETRIES = 3;

function idemExpireAt(now: number): Date {
  return new Date(now + EQUIPMENT_IDEM_TTL_SEC * 1000);
}

export function toInstanceDoc(instance: EquipmentInstance, accountId: string): EquipmentInstanceDoc {
  return {
    _id: instance.id,
    accountId,
    defId: instance.defId,
    rarity: instance.rarity,
    level: instance.level,
    affixes: instance.affixes,
    ...(instance.locked !== undefined ? { locked: instance.locked } : {}),
  };
}

function fromInstanceDoc(doc: EquipmentInstanceDoc): EquipmentInstance {
  return {
    id: doc._id,
    defId: doc.defId,
    rarity: doc.rarity,
    level: doc.level,
    affixes: doc.affixes,
    ...(doc.locked !== undefined ? { locked: doc.locked } : {}),
  };
}

/**
 * Reassembles the full equipmentInv map from `equipmentInstances`, for wire-format compatibility
 * (phase 1 of the storage split keeps every player-facing response shape unchanged). Also opportunistically
 * self-heals `equipmentInvCount` drift (a plain field $set, no rev guard — it's an informational mirror
 * never used as a lock, so this can never spuriously conflict with a real optimistic-lock write) since this
 * call already has the true count in hand.
 */
export async function assembleEquipmentInv(
  cols: Collections,
  accountId: string,
  save?: SaveData,
): Promise<Record<string, EquipmentInstance>> {
  const docs = await cols.equipmentInstances.find({ accountId }).toArray();
  const inv: Record<string, EquipmentInstance> = {};
  for (const doc of docs) inv[doc._id] = fromInstanceDoc(doc);
  if (save && save.equipmentInvCount !== docs.length) {
    await cols.saves.updateOne({ _id: accountId }, { $set: { 'save.equipmentInvCount': docs.length } });
  }
  return inv;
}

/**
 * Marks a mutation response as intentionally not carrying the full equipmentInv map (phase 2 of the
 * storage split, EQUIPMENT_DESIGN §3.3): the caller already has everything it needs to update its local
 * copy — the returned/consumed `instance`(s) for craft/enhance/reforge, or the `instanceIds`/`materialId`
 * it sent as request params for salvage/reforge/equip — so there is no need to pay for an
 * `equipmentInstances.find({accountId})` just to hand back a map the caller can reconstruct for free.
 * `null` (not simply omitting the field) is required so the `app.ts` preSerialization backstop — which
 * fills in the full map whenever `equipmentInv === undefined` — knows this response opted out on purpose.
 */
function leanSave(save: SaveData): SaveData {
  return { ...save, equipmentInv: null };
}

/**
 * Returns whether an equipment instance is currently equipped by any card in the Hero Roster.
 * cardInv moved to its own `cardInstances` collection (2026-07-27 split, cards.ts) — queries directly
 * for a card whose gear references this instance (one of the fixed EQUIP_SLOTS keys), instead of
 * scanning an in-memory map that no longer exists on the save document.
 */
async function isEquipped(cols: Collections, accountId: string, instanceId: string): Promise<boolean> {
  const match = await cols.cardInstances.findOne({
    accountId,
    $or: EQUIP_SLOTS.map((slot) => ({ [`gear.${slot}`]: instanceId })),
  });
  return !!match;
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
  if (cur.equipmentInvCount >= EQUIPMENT_INV_CAP) {
    return { error: 'equipment inventory full', code: 'INVENTORY_FULL' };
  }

  // Idempotency gate: claim the idemKey first (unique _id). Claim failure = a request with this same key
  // is already in flight or already finished → replay first result IF it actually paid (see `committed`).
  try {
    await cols.equipmentIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'craft',
      result: instance,
      committed: false,
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
      if (!prev?.committed) {
        // The original request for this key hasn't committed its cost yet (still racing, or exhausted
        // retries and gave up without ever charging materials) — granting the instance now would be a
        // free item. Ask the caller to retry rather than trusting the claim alone (2026-08-03 fix: this
        // used to unconditionally re-assert the instance here, letting a concurrent duplicate request
        // grant a free craft if the original then failed).
        return { error: 'craft already in progress, retry', code: 'REV_CONFLICT' };
      }
      // Verify-and-heal: cost was already paid by the original request; re-assert the instance exists
      // in case that request crashed between the save write and the instance upsert.
      const replayInstance = (prev.result as EquipmentInstance) ?? instance;
      await cols.equipmentInstances.updateOne(
        { _id: replayInstance.id },
        { $set: toInstanceDoc(replayInstance, accountId) },
        { upsert: true },
      );
      const save = await getOrCreateSave(cols, accountId, now());
      return { instance: replayInstance, save: leanSave(save) };
    }
    throw e;
  }

  // Cost-and-grant: commit the costly/guarded side FIRST (materials + count, rev-guarded). If this
  // exhausts retries, the player paid nothing and received nothing — safe. Only once it succeeds do we
  // grant the instance (an idempotent upsert, safe to repeat on any later replay).
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
    if (save.equipmentInvCount >= EQUIPMENT_INV_CAP) {
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
      equipmentInvCount: save.equipmentInvCount + 1,
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      // Mark the claim committed before granting: a concurrent duplicate request's E11000 catch above
      // now knows the cost was actually paid and can safely replay-grant even if it reads this before
      // the instance upsert below lands.
      await cols.equipmentIdem.updateOne({ _id: idempotencyKey }, { $set: { committed: true } });
      await cols.equipmentInstances.updateOne(
        { _id: instance.id },
        { $set: toInstanceDoc(instance, accountId) },
        { upsert: true },
      );
      return { instance, save: leanSave(next) };
    }
    // rev conflict (concurrent PUT /save / pve write) → re-read and retry
  }
  // Retries exhausted: nothing was ever charged (the cost-and-grant write above never landed), so unlike
  // the escrow/salvage/fuse destructive-delete-up-front functions, there is nothing irreversible to protect
  // here — release the claim so a client retry with the SAME idempotencyKey can restart cleanly. Retaining
  // a `committed: false` claim here used to permanently wedge that key: every future retry would hit the
  // E11000 branch above, see `committed` still false, and return "craft already in progress, retry" forever
  // (materials were never charged, so `committed` could never become true), with no code path telling the
  // client to mint a fresh key.
  await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
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

  const instDoc = await cols.equipmentInstances.findOne({ _id: instanceId, accountId });
  if (!instDoc) {
    // Concurrently escrowed (idem already written) → replay; otherwise the instance genuinely does not exist.
    const replay = await cols.equipmentIdem.findOne({ _id: orderId });
    if (replay?.op === 'escrow') return { instance: replay.result as EquipmentInstance };
    return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
  }
  const inst = fromInstanceDoc(instDoc);
  if (inst.locked) return { error: 'equipment locked', code: 'EQUIP_LOCKED' };
  if (await isEquipped(cols, accountId, instanceId)) return { error: 'equipment in use (equipped)', code: 'EQUIP_IN_USE' };

  // Destructive op: remove from equipmentInstances once, up front (idempotent delete — safe even if the
  // saves-side rev-guard below has to loop on a concurrent write to this account's save, since we never
  // repeat this delete). Worst-case crash window after this line is a briefly-overcounted cap mirror
  // (benign, self-heals on the next GET /save), never a duplicated/still-visible item.
  await cols.equipmentInstances.deleteOne({ _id: instanceId });

  // Record ledger entry (snapshot used for trade transfer / return; $setOnInsert prevents concurrent
  // overwrites) immediately — the delete above already happened unconditionally, so this claim must exist
  // BEFORE the save-count-decrement retry loop below, not only after it succeeds. Otherwise, exhausting all
  // rev-conflict retries would report REV_CONFLICT while the item is already gone with no escrow record
  // anywhere (mirrors the reforgeEquipment fix — see its doc comment for the full rationale).
  await cols.equipmentIdem.updateOne(
    { _id: orderId },
    { $setOnInsert: { accountId, op: 'escrow', result: inst, expireAt: idemExpireAt(now()) } },
    { upsert: true },
  );

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      equipmentInvCount: Math.max(0, save.equipmentInvCount - 1),
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) return { instance: inst };
  }
  // equipmentInvCount is an informational mirror that self-heals (see assembleEquipmentInv) — the escrow
  // itself (delete + idem record) already committed above regardless of this decrement's outcome, so report
  // success rather than REV_CONFLICT for an operation that already happened (mirrors reforgeEquipment).
  return { instance: inst };
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

  // Idempotent by instance.id: if this exact instance already exists for this account, a prior call
  // already completed (including the count increment below) — replay without double-incrementing.
  const already = await cols.equipmentInstances.findOne({ _id: instance.id, accountId });
  await cols.equipmentInstances.updateOne(
    { _id: instance.id },
    { $set: toInstanceDoc(instance, accountId) },
    { upsert: true },
  );
  if (already) return { ok: true };

  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) return { error: 'save not found', code: 'NOT_FOUND' };
    const save = doc.save;
    // Lifetime equipment-owned ledger (avatar unlock): grantEquipment is the only place a new
    // equipment instance enters a save, so this is the single place to record "obtained once" —
    // never pruned when the instance is later salvaged/enhanced away (unlike equipmentInstances).
    const everOwnedEquip = new Set(save.everOwned?.equipment ?? []);
    everOwnedEquip.add(instance.defId);
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      equipmentInvCount: save.equipmentInvCount + 1,
      everOwned: { ...save.everOwned, equipment: [...everOwnedEquip] },
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
 * Ordering (player safety): first atomically update the save (deduct materials, rev guard),
 * then apply the level/affix change to the equipmentInstances document, **then** deduct coins.
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
  clientPlatform?: string,
): Promise<{ success: boolean; instance: EquipmentInstance; save: SaveData } | EquipError> {
  if (!instanceId) return { error: 'instanceId required', code: 'BAD_REQUEST' };
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };

  // Replay: verify-and-heal (re-assert the instance reflects the replayed result — a prior attempt may
  // have deducted materials/consumed the protect item but crashed before the equipmentInstances write)
  // + idempotently settle coins (covers the "save updated but coin deduction interrupted" window).
  // Gated on `committed` (2026-08-03 fix): a claim doc can exist before its cost has landed (see the
  // insertOne below), so a concurrent duplicate arriving here first must not synthesize a free
  // enhancement — only replay once the original request's cost write actually succeeded.
  const replay = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'enhance' && replay.committed) {
    const r = replay.result as { success: boolean; instance: EquipmentInstance; coins: number; skipMaterials?: boolean };
    await cols.equipmentInstances.updateOne(
      { _id: r.instance.id },
      { $set: toInstanceDoc(r.instance, accountId) },
      { upsert: true },
    );
    const save = await settleEquipCoins(cols, commercial, now, accountId, idempotencyKey, r.coins, 'equip_enhance', clientPlatform);
    return { success: r.success, instance: r.instance, save: leanSave(save) };
  }
  if (replay?.op === 'enhance' && !replay.committed) {
    return { error: 'enhance already in progress, retry', code: 'REV_CONFLICT' };
  }

  // Coins go through commercial authority; if not configured, enhancement is unavailable (same 503 as shop/gacha).
  if (!commercial.available) return { error: 'commercial service unavailable', code: 'NOT_IMPLEMENTED' };

  const [cur, inst0Doc] = await Promise.all([
    getOrCreateSave(cols, accountId, now()),
    cols.equipmentInstances.findOne({ _id: instanceId, accountId }),
  ]);
  if (!inst0Doc) return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
  const inst0 = fromInstanceDoc(inst0Doc);
  if (inst0.level >= EQUIP_MAX_LEVEL) return { error: 'already max level', code: 'ENHANCE_MAX_LEVEL' };

  const fromLevel = inst0.level;
  const cost = enhanceCost(fromLevel);
  // Pre-validate materials (friendly early error; re-checked inside the rev loop).
  for (const [mat, qty] of Object.entries(cost.materials)) {
    if ((cur.materials?.[mat] ?? 0) < qty) return { error: `insufficient ${mat}`, code: 'INSUFFICIENT_MATERIALS' };
  }
  // Pre-validate coins (commercial authoritative; insufficient → no state changes, friendly 402).
  const wallet = await commercial.getWallet(accountId, clientPlatform);
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
      committed: false,
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
      if (!prev?.committed) {
        return { error: 'enhance already in progress, retry', code: 'REV_CONFLICT' };
      }
      const r = prev.result as { success: boolean; instance: EquipmentInstance; coins: number; skipMaterials?: boolean };
      await cols.equipmentInstances.updateOne(
        { _id: r.instance.id },
        { $set: toInstanceDoc(r.instance, accountId) },
        { upsert: true },
      );
      const save = await settleEquipCoins(cols, commercial, now, accountId, idempotencyKey, r.coins);
      return { success: r.success, instance: r.instance, save: leanSave(save) };
    }
    throw e;
  }

  // Cost side first (materials / protect-item consumption, rev-guarded save write). The per-instance
  // level check below (instDoc.level !== fromLevel) replaces the old whole-save rev check for "did the
  // instance change since I read it" — same safety property, just scoped to one document.
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const [doc, instDoc] = await Promise.all([
      cols.saves.findOne({ _id: accountId }),
      cols.equipmentInstances.findOne({ _id: instanceId, accountId }),
    ]);
    if (!doc) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'save not found', code: 'NOT_FOUND' };
    }
    if (!instDoc || instDoc.level !== fromLevel) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'instance level changed, retry', code: 'REV_CONFLICT' };
    }
    const save = doc.save;
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
      inventory: { ...(save.inventory ?? { skins: [] }), items: nextItems },
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      // Cost committed → mark the claim so a concurrent duplicate's replay/catch path above can now
      // safely grant, then apply the level/affix change (filtered on fromLevel, mirroring the check
      // above; in the extreme case this doesn't match — a concurrent write to this exact instanceId
      // within the few-ms window since the check just above — the replay path's verify-and-heal
      // re-applies it later).
      await cols.equipmentIdem.updateOne({ _id: idempotencyKey }, { $set: { committed: true } });
      await cols.equipmentInstances.updateOne(
        { _id: instanceId, level: fromLevel },
        { $set: toInstanceDoc(instanceAfter, accountId) },
      );
      const saveFinal = await settleEquipCoins(cols, commercial, now, accountId, idempotencyKey, cost.coins, 'equip_enhance', clientPlatform);
      return { success, instance: instanceAfter, save: leanSave(saveFinal) };
    }
    // rev conflict → re-read and retry
  }
  // Save update failed (coins untouched) → release claim; client can safely retry.
  await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
  return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
}

/** Deducts equipment operation coins (commercial authoritative, orderId=idemKey idempotent) + writes mirror; if commercial is unavailable/fails, the mirror is not updated. */
async function settleEquipCoins(
  cols: Collections,
  commercial: CommercialClient,
  now: () => number,
  accountId: string,
  idempotencyKey: string,
  coins: number,
  reason = 'equip_enhance',
  clientPlatform?: string,
): Promise<SaveData> {
  if (coins > 0 && commercial.available) {
    const charge = await commercial.spend({ accountId, amount: coins, reason, orderId: idempotencyKey, clientPlatform });
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

  // Applies the materials refund + equipmentInvCount decrement for an already-claimed salvage batch
  // (rev-guarded retry loop over `saves`). Shared by the first-attempt path and the not-yet-committed
  // replay/duplicate-claim paths below — a batch whose destructive delete already happened but whose
  // save-side credit never landed (retries exhausted) must be able to complete the credit on a LATER call
  // with the same idempotencyKey, not just report cached success without ever crediting the materials.
  async function settleSalvageCredit(refund: Record<string, number>, count: number): Promise<SaveData | null> {
    for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
      const doc = await cols.saves.findOne({ _id: accountId });
      if (!doc) return null;
      const save = doc.save;
      const nextMaterials = { ...save.materials };
      for (const [mat, qty] of Object.entries(refund)) nextMaterials[mat] = (nextMaterials[mat] ?? 0) + qty;
      const next: SaveData = {
        ...save,
        rev: save.rev + 1,
        updatedAt: now(),
        materials: nextMaterials,
        equipmentInvCount: Math.max(0, save.equipmentInvCount - count),
      };
      const res = await cols.saves.findOneAndUpdate(
        { _id: accountId, rev: doc.rev },
        { $set: { save: next, rev: next.rev } },
      );
      if (res) return next;
    }
    return null;
  }

  const replay = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'salvage') {
    const r = replay.result as { refunded: Record<string, number>; instanceIds: string[] };
    // Verify-and-heal: re-assert the whole batch is actually gone. Scoped to accountId (2026-08-03 fix)
    // in case one of these ids was traded away via auction escrow and re-granted to a different account
    // in the narrow window since the original validation — this delete must never remove someone else's item.
    if (r.instanceIds?.length) await cols.equipmentInstances.deleteMany({ _id: { $in: r.instanceIds }, accountId });
    if (!replay.committed) {
      // The destructive delete already happened on the original attempt, but the save-side materials
      // credit never landed (rev-conflict retries exhausted) — finish the credit now instead of reporting
      // cached success for a refund that was never actually applied.
      const settled = await settleSalvageCredit(r.refunded, r.instanceIds?.length ?? 0);
      if (!settled) return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
      await cols.equipmentIdem.updateOne({ _id: idempotencyKey }, { $set: { committed: true } });
      return { refunded: r.refunded, save: leanSave(settled) };
    }
    return { refunded: r.refunded, save: leanSave(await getOrCreateSave(cols, accountId, now())) };
  }

  const ids = [...new Set(instanceIds)];
  // Validate + accumulate refund (using current instances/save; not re-checked after this point — see
  // the up-front destructive delete below, which commits to this validation rather than re-checking
  // against a partially-mutated batch on a later retry).
  const instDocs = await cols.equipmentInstances.find({ _id: { $in: ids }, accountId }).toArray();
  const instMap = new Map(instDocs.map((d) => [d._id, fromInstanceDoc(d)]));
  const refunded: Record<string, number> = {};
  for (const id of ids) {
    const inst = instMap.get(id);
    if (!inst) return { error: `equipment instance not found: ${id}`, code: 'EQUIP_NOT_FOUND' };
    if (inst.locked) return { error: `equipment locked: ${id}`, code: 'EQUIP_LOCKED' };
    if (await isEquipped(cols, accountId, id)) return { error: `equipment in use: ${id}`, code: 'EQUIP_IN_USE' };
    if (!isSalvageable(inst.rarity, inst.level)) return { error: `not salvageable (${inst.rarity} +${inst.level}): ${id}`, code: 'NOT_SALVAGEABLE' };
    for (const [mat, qty] of Object.entries(salvageRefund(inst.defId))) refunded[mat] = (refunded[mat] ?? 0) + qty;
  }

  // Idempotency claim.
  try {
    await cols.equipmentIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'salvage',
      result: { refunded, instanceIds: ids },
      committed: false,
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
      const r = prev?.result as { refunded: Record<string, number>; instanceIds: string[] };
      if (r.instanceIds?.length) await cols.equipmentInstances.deleteMany({ _id: { $in: r.instanceIds } });
      if (!prev?.committed) {
        const settled = await settleSalvageCredit(r.refunded, r.instanceIds?.length ?? 0);
        if (!settled) return { error: 'rev conflict, retry', code: 'REV_CONFLICT' };
        await cols.equipmentIdem.updateOne({ _id: idempotencyKey }, { $set: { committed: true } });
        return { refunded: r.refunded, save: leanSave(settled) };
      }
      return { refunded: r.refunded, save: leanSave(await getOrCreateSave(cols, accountId, now())) };
    }
    throw e;
  }

  // Destructive batch op: delete all instances once, up front (idempotent — a re-run over an
  // already-emptied batch is a no-op), then just retry the saves-side refund/count decrement.
  // Scoped to accountId (2026-08-03 fix): ownership was validated above via instDocs, but without this
  // guard the delete itself would match purely on _id, closing a narrow cross-account TOCTOU window
  // (an id traded away via auction escrow + re-granted to a buyer between validation and this delete).
  await cols.equipmentInstances.deleteMany({ _id: { $in: ids }, accountId });

  const settled = await settleSalvageCredit(refunded, ids.length);
  if (settled) {
    await cols.equipmentIdem.updateOne({ _id: idempotencyKey }, { $set: { committed: true } });
    return { refunded, save: leanSave(settled) };
  }
  // Retries exhausted: the destructive delete above already committed, unconditionally. Do NOT delete the
  // idem claim here (that would orphan the refund with no record of what was owed, per the class of bug
  // fixed in reforgeEquipment) — leave it `committed: false` so a client retry with the same
  // idempotencyKey re-enters the replay branch above and finishes the materials credit instead of losing it.
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
  commercial: CommercialClient,
  now: () => number,
  accountId: string,
  targetId: string,
  materialId: string,
  idempotencyKey: string,
  clientPlatform?: string,
): Promise<{ instance: EquipmentInstance; save: SaveData } | EquipError> {
  if (!idempotencyKey) return { error: 'idempotencyKey required', code: 'BAD_REQUEST' };
  if (targetId === materialId) return { error: 'target and material must differ', code: 'BAD_REQUEST' };

  // Replay: verify-and-heal (re-assert target reflects the reroll + material is gone) + idempotently
  // settle coins (covers the "save updated but coin deduction interrupted" window).
  const replay = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
  if (replay?.op === 'reforge') {
    const r = replay.result as { instance: EquipmentInstance; coins?: number };
    await cols.equipmentInstances.updateOne(
      { _id: r.instance.id },
      { $set: toInstanceDoc(r.instance, accountId) },
      { upsert: true },
    );
    // Scoped to accountId (2026-08-03 fix): closes the same cross-account TOCTOU window as salvage's
    // batch delete above — this must never remove a material instance that has since been traded away.
    await cols.equipmentInstances.deleteOne({ _id: materialId, accountId });
    const save = await settleEquipCoins(cols, commercial, now, accountId, idempotencyKey, r.coins ?? 0, 'equip_reforge', clientPlatform);
    return { instance: r.instance, save: leanSave(save) };
  }

  // Reforge is a coin sink (ADR-030): coins go through commercial authority; if not configured, reforge is unavailable (same 503 as enhance/shop).
  if (!commercial.available) return { error: 'commercial service unavailable', code: 'NOT_IMPLEMENTED' };

  const [targetDoc, materialDoc] = await Promise.all([
    cols.equipmentInstances.findOne({ _id: targetId, accountId }),
    cols.equipmentInstances.findOne({ _id: materialId, accountId }),
  ]);
  if (!targetDoc) return { error: 'target equipment not found', code: 'EQUIP_NOT_FOUND' };
  const target = fromInstanceDoc(targetDoc);
  if (await isEquipped(cols, accountId, targetId)) return { error: 'target is equipped', code: 'EQUIP_IN_USE' };
  if (target.locked) return { error: 'target is locked', code: 'EQUIP_LOCKED' };

  const requiredMatRarity = REFORGE_MATERIAL_RARITY[target.rarity];
  if (!requiredMatRarity) return { error: `${target.rarity} equipment cannot be reforged`, code: 'NOT_REFORGE_ELIGIBLE' };

  if (!materialDoc) return { error: 'material equipment not found', code: 'EQUIP_NOT_FOUND' };
  const material = fromInstanceDoc(materialDoc);
  if (await isEquipped(cols, accountId, materialId)) return { error: 'material is equipped', code: 'EQUIP_IN_USE' };
  // 2026-08-03 fix: the target's lock is checked above, but the fuel material's was never checked here —
  // a locked item is destroyed by reforge exactly like a salvage input, so a client that skips the (also
  // now-fixed) picker filter, or a direct API call, could otherwise destroy a player-locked item.
  if (material.locked) return { error: 'material is locked', code: 'EQUIP_LOCKED' };

  const targetDef = EQUIPMENT_DEFS[target.defId];
  const matDef = EQUIPMENT_DEFS[material.defId];
  if (!targetDef || !matDef) return { error: 'unknown equipment def', code: 'BAD_REQUEST' };
  if (matDef.slot !== targetDef.slot) return { error: `material slot ${matDef.slot} must match target slot ${targetDef.slot}`, code: 'INVALID_SLOT' };
  if (material.rarity !== requiredMatRarity) {
    return { error: `material must be ${requiredMatRarity} (got ${material.rarity})`, code: 'INVALID_RARITY' };
  }
  // Only never-enhanced (+0) items may be used as fuel (client restricts the picker to the same; EQUIPMENT_DESIGN §7.8),
  // so an enhanced item's sunk materials/rolls can't be destroyed by a modified client or direct API call.
  if (material.level !== 0) {
    return { error: `material must be unenhanced (+0), got +${material.level}`, code: 'INVALID_MATERIAL_LEVEL' };
  }

  // Reforge coin fee (ADR-030): charged every attempt on top of the fuel item. Pre-validate (commercial authoritative; insufficient → no state changes).
  const coins = reforgeCoinCost(target.rarity);
  const wallet = await commercial.getWallet(accountId, clientPlatform);
  if ((wallet?.coins ?? 0) < coins) return { error: 'not enough coins', code: 'INSUFFICIENT_FUNDS' };

  // Deterministic re-roll (idempotencyKey used as seed)
  const newAffixes = rollReforgedAffixes(target.defId, idempotencyKey, target.affixes);
  const reforged: EquipmentInstance = { ...target, affixes: newAffixes };

  // Idempotency claim (result includes coins for replay re-settlement)
  try {
    await cols.equipmentIdem.insertOne({
      _id: idempotencyKey,
      accountId,
      op: 'reforge',
      result: { instance: reforged, coins },
      expireAt: idemExpireAt(now()),
    });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const prev = await cols.equipmentIdem.findOne({ _id: idempotencyKey });
      const r = prev?.result as { instance: EquipmentInstance; coins?: number };
      await cols.equipmentInstances.updateOne(
        { _id: r.instance.id },
        { $set: toInstanceDoc(r.instance, accountId) },
        { upsert: true },
      );
      // Scoped to accountId (2026-08-03 fix): closes the same cross-account TOCTOU window as salvage's
    // batch delete above — this must never remove a material instance that has since been traded away.
    await cols.equipmentInstances.deleteOne({ _id: materialId, accountId });
      const save = await settleEquipCoins(cols, commercial, now, accountId, idempotencyKey, r.coins ?? 0, 'equip_reforge', clientPlatform);
      return { instance: r.instance, save: leanSave(save) };
    }
    throw e;
  }

  // Two-document effect (target upgrade + material consumption) can't be one atomic write without a
  // transaction (this codebase deliberately has none — see shared/src/mongo.ts header). Target first
  // (idempotent upsert-by-id, deterministic from idemKey), material delete second (idempotent): a crash
  // between the two leaves "target upgraded, material still present" — recoverable via the replay branch
  // above — rather than the worse "material consumed, target not upgraded."
  await cols.equipmentInstances.updateOne(
    { _id: targetId, accountId },
    { $set: toInstanceDoc(reforged, accountId) },
  );
  // Scoped to accountId (2026-08-03 fix): closes the same cross-account TOCTOU window as salvage's
  // batch delete above — this must never remove a material instance that has since been traded away.
  await cols.equipmentInstances.deleteOne({ _id: materialId, accountId });

  // Saves-side: count decrement (material instance removed), rev-guarded.
  for (let attempt = 0; attempt < REV_RETRIES; attempt++) {
    const doc = await cols.saves.findOne({ _id: accountId });
    if (!doc) {
      await cols.equipmentIdem.deleteOne({ _id: idempotencyKey });
      return { error: 'save not found', code: 'NOT_FOUND' };
    }
    const save = doc.save;
    const next: SaveData = {
      ...save,
      rev: save.rev + 1,
      updatedAt: now(),
      equipmentInvCount: Math.max(0, save.equipmentInvCount - 1),
    };
    const res = await cols.saves.findOneAndUpdate(
      { _id: accountId, rev: doc.rev },
      { $set: { save: next, rev: next.rev } },
    );
    if (res) {
      // Save committed → deduct coins (idemKey idempotent) + mirror. If coin deduction is interrupted the replay path re-settles.
      const saveFinal = await settleEquipCoins(cols, commercial, now, accountId, idempotencyKey, coins, 'equip_reforge', clientPlatform);
      return { instance: reforged, save: leanSave(saveFinal) };
    }
    // rev conflict on the equipmentInvCount decrement (contention from an unrelated concurrent save
    // write) → re-read and retry. Unlike craft/enhance, this is NOT a "nothing happened yet" retry: the
    // target upgrade + material deletion above already landed unconditionally and are irreversible.
  }
  // 2026-08-03 fix: retries exhausted for the equipmentInvCount decrement, but the reforge itself (target
  // upgrade + material consumption) already committed above, unconditionally, before this loop — deleting
  // the idem claim here used to orphan that state: a client retry would then re-enter this function fresh,
  // fail to find the already-deleted material (EQUIP_NOT_FOUND), and the coin fee would never be charged,
  // even though the player's item was already reforged and their fuel already destroyed. Instead, settle
  // coins (idempotent) and report success; equipmentInvCount is an informational mirror that self-heals via
  // assembleEquipmentInv (see its docstring) — drifting by 1 here is far cheaper than reporting failure for
  // an operation that already committed, or permanently wedging a retry against a missing material.
  const saveFinal = await settleEquipCoins(cols, commercial, now, accountId, idempotencyKey, coins, 'equip_reforge', clientPlatform);
  return { instance: reforged, save: leanSave(saveFinal) };
}

// ── E4 Equip (EQUIPMENT_DESIGN §3.4 / CC-2) ──────────────────────────────────────

/**
 * Equips or unequips one item onto a specific card instance (CC-2, CHARACTER_CARDS_DESIGN §5).
 * Pure state change, no randomness, no resources → naturally idempotent, no idemKey needed.
 * instanceId=null unequips the slot; otherwise validates instance existence + slot match (INVALID_SLOT).
 * cardInstanceId must reference an existing CardInstance in the `cardInstances` collection (2026-07-27
 * split, cards.ts); gear is written to CardInstance.gear[slot] (CC-2 per-card loadout;
 * CHARACTER_CARDS_DESIGN §5). Never touches equipmentInstances (only the card's gear, a pointer).
 * Doesn't touch `saves` at all anymore: gear lives entirely on the card document now, so there is
 * nothing left in the save doc for this mutation to change (no rev bump needed).
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

  if (instanceId !== null) {
    const instDoc = await cols.equipmentInstances.findOne({ _id: instanceId, accountId });
    if (!instDoc) return { error: 'equipment instance not found', code: 'EQUIP_NOT_FOUND' };
    const def = EQUIPMENT_DEFS[instDoc.defId];
    if (def && def.slot !== slot) return { error: `slot mismatch: ${instDoc.defId} is ${def.slot}`, code: 'INVALID_SLOT' };
    // Must not already be equipped on a DIFFERENT card — without this check the same instanceId could be
    // written into two cards' gear[slot] at once, doubling its stat contribution (equipment duplication).
    // Re-equipping the same instance onto the SAME card/slot (no-op) is allowed through.
    const equippedOn = await cols.cardInstances.findOne({
      accountId,
      _id: { $ne: cardInstanceId },
      $or: EQUIP_SLOTS.map((s) => ({ [`gear.${s}`]: instanceId })),
    });
    if (equippedOn) return { error: 'equipment in use (equipped)', code: 'EQUIP_IN_USE' };
  }

  const cardDoc = await cols.cardInstances.findOne({ _id: cardInstanceId, accountId });
  if (!cardDoc) return { error: 'card instance not found', code: 'NOT_FOUND' };

  const updatedGear = { ...(cardDoc.gear ?? {}) };
  if (instanceId === null) delete (updatedGear as Record<string, string | undefined>)[slot];
  else (updatedGear as Record<string, string>)[slot] = instanceId;
  const updatedGearInstanceIds = Object.values(updatedGear).filter((v): v is string => !!v);

  try {
    await cols.cardInstances.updateOne(
      { _id: cardInstanceId, accountId },
      { $set: { gear: updatedGear, gearInstanceIds: updatedGearInstanceIds } },
    );
  } catch (e) {
    // Unique multikey index on gearInstanceIds (mongo.ts) is the atomic backstop behind the "equipped
    // elsewhere" read above: a concurrent equip of the SAME instanceId onto a DIFFERENT card that raced
    // past that check lands here instead of silently duplicating the instance's stat contribution.
    if ((e as { code?: number }).code === 11000) return { error: 'equipment in use (equipped)', code: 'EQUIP_IN_USE' };
    throw e;
  }

  const save = await getOrCreateSave(cols, accountId, now());
  return { save: leanSave(save) };
}
