// E2 crafting (see ../equipment.ts for the module overview).
import {
  EQUIPMENT_DEFS,
  EQUIPMENT_INV_CAP,
  rollCraftedAffixes,
  type Collections,
  type SaveData,
  type EquipmentInstance,
} from '@nw/shared';
import { getOrCreateSave } from '../save.js';
import { idemExpireAt, toInstanceDoc, leanSave, REV_RETRIES, type EquipError } from './helpers.js';

/**
 * Crafts a +0 base equipment item (E2, EQUIPMENT_DESIGN §4/§7).
 * Deducts EQUIPMENT_DEFS[defId].craftCost materials → rolls primary + secondary affixes → adds to inventory (< 1000 cap).
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
    sourceType: 'craft',
    obtainedAt: now(),
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
