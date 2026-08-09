// E3 Salvage (EQUIPMENT_DESIGN §6.3, ADR-012) — see ../equipment.ts for the module overview.
import { isSalvageable, salvageRefund, type Collections, type SaveData } from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { idemExpireAt, fromInstanceDoc, isEquipped, leanSave, REV_RETRIES, type EquipError } from './helpers.js';

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
