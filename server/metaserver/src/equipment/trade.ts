// E2.5 worldsvc auction escrow / trade transfer (see ../equipment.ts for the module overview).
import { type Collections, type SaveData, type EquipmentInstance } from '@nw/shared';
import { idemExpireAt, toInstanceDoc, fromInstanceDoc, isEquipped, REV_RETRIES, type EquipError } from './helpers.js';

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
