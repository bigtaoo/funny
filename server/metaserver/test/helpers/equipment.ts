// Shared test helper for seeding/reading equipment instances directly against the `equipmentInstances`
// collection (2026-07-26 storage split — see server/metaserver/src/equipment.ts header comment). Used by
// equipment.e2e.test.ts / economy.e2e.test.ts / internal-economy.test.ts so all three tests share one
// definition of the collection's document shape instead of each re-deriving it.
import type { MongoHandle, EquipmentInstance } from '@nw/shared';

/** Directly seeds (or overwrites) one equipment instance into `equipmentInstances`, bypassing the API. */
export async function seedEquipment(
  m: MongoHandle,
  accountId: string,
  inst: EquipmentInstance,
): Promise<void> {
  await m.collections.equipmentInstances.updateOne(
    { _id: inst.id },
    {
      $set: {
        _id: inst.id,
        accountId,
        defId: inst.defId,
        rarity: inst.rarity,
        level: inst.level,
        affixes: inst.affixes,
        ...(inst.locked !== undefined ? { locked: inst.locked } : {}),
        ...(inst.sourceType !== undefined ? { sourceType: inst.sourceType } : {}),
        ...(inst.obtainedAt !== undefined ? { obtainedAt: inst.obtainedAt } : {}),
      },
    },
    { upsert: true },
  );
}

/** Seeds a batch (e.g. filling an account's inventory toward the cap) and sets `equipmentInvCount` to match. */
export async function seedEquipmentBatch(
  m: MongoHandle,
  accountId: string,
  instances: EquipmentInstance[],
): Promise<void> {
  for (const inst of instances) await seedEquipment(m, accountId, inst);
  await m.collections.saves.updateOne(
    { _id: accountId },
    { $set: { 'save.equipmentInvCount': instances.length } },
  );
}

/**
 * Reads the full equipmentInv map for an account directly from `equipmentInstances` — a test-side mirror
 * of the server's own `assembleEquipmentInv` join, for asserting internal storage state without going
 * through an HTTP response (where the join happens automatically via app.ts's preSerialization hook).
 */
export async function readEquipmentInv(
  m: MongoHandle,
  accountId: string,
): Promise<Record<string, EquipmentInstance>> {
  const docs = await m.collections.equipmentInstances.find({ accountId }).toArray();
  const inv: Record<string, EquipmentInstance> = {};
  for (const d of docs) {
    inv[d._id] = {
      id: d._id,
      defId: d.defId,
      rarity: d.rarity,
      level: d.level,
      affixes: d.affixes,
      ...(d.locked !== undefined ? { locked: d.locked } : {}),
      ...(d.sourceType !== undefined ? { sourceType: d.sourceType } : {}),
      ...(d.obtainedAt !== undefined ? { obtainedAt: d.obtainedAt } : {}),
    };
  }
  return inv;
}
