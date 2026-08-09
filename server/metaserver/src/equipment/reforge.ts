// E6 Reforge (EQUIPMENT_DESIGN §7.8 / ADR-017) — see ../equipment.ts for the module overview.
import {
  EQUIPMENT_DEFS,
  REFORGE_MATERIAL_RARITY,
  reforgeCoinCost,
  rollReforgedAffixes,
  type Collections,
  type SaveData,
  type EquipmentInstance,
} from '@nw/shared';
import type { CommercialClient } from '../commercialClient.js';
import {
  idemExpireAt,
  toInstanceDoc,
  fromInstanceDoc,
  isEquipped,
  leanSave,
  settleEquipCoins,
  REV_RETRIES,
  type EquipError,
} from './helpers.js';

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
