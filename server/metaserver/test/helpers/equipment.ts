// Shared test helper for seeding/reading equipment instances directly against the `equipmentInstances`
// collection (2026-07-26 storage split — see server/metaserver/src/equipment.ts header comment). Used by
// equipment.e2e.test.ts / economy.e2e.test.ts / internal-economy.test.ts so all three tests share one
// definition of the collection's document shape instead of each re-deriving it.
import type { MongoHandle, EquipmentInstance, EquipmentInstanceDoc } from '@nw/shared';

/** The `equipmentInstances` row an `EquipmentInstance` maps to — one definition shared by the single
 * and batch seeders so they can never drift apart. */
function equipmentDoc(accountId: string, inst: EquipmentInstance): EquipmentInstanceDoc {
  return {
    _id: inst.id,
    accountId,
    defId: inst.defId,
    rarity: inst.rarity,
    level: inst.level,
    affixes: inst.affixes,
    ...(inst.locked !== undefined ? { locked: inst.locked } : {}),
    ...(inst.sourceType !== undefined ? { sourceType: inst.sourceType } : {}),
    ...(inst.obtainedAt !== undefined ? { obtainedAt: inst.obtainedAt } : {}),
  };
}

/** Directly seeds (or overwrites) one equipment instance into `equipmentInstances`, bypassing the API. */
export async function seedEquipment(
  m: MongoHandle,
  accountId: string,
  inst: EquipmentInstance,
): Promise<void> {
  await m.collections.equipmentInstances.updateOne(
    { _id: inst.id },
    { $set: equipmentDoc(accountId, inst) },
    { upsert: true },
  );
}

/**
 * Seeds a batch (e.g. filling an account's inventory toward the cap) and sets `equipmentInvCount` to match.
 *
 * ONE `bulkWrite`, not a loop of `updateOne`s. Callers fill to `EQUIPMENT_INV_CAP` (1000 since the
 * 2026-08-10 300→1000 capacity raise), and a per-instance loop made the seed 1000 sequential round
 * trips — a test whose wall time is `cap × ambient latency`, i.e. one that passes or times out
 * depending on how loaded the machine is rather than on what the code does. See
 * claudedocs/server-testing-tooling.md "CI 稳定性".
 */
export async function seedEquipmentBatch(
  m: MongoHandle,
  accountId: string,
  instances: EquipmentInstance[],
): Promise<void> {
  if (instances.length > 0) {
    await m.collections.equipmentInstances.bulkWrite(
      instances.map((inst) => ({
        updateOne: { filter: { _id: inst.id }, update: { $set: equipmentDoc(accountId, inst) }, upsert: true },
      })),
      { ordered: false },
    );
  }
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
