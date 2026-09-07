// Shared test helper for seeding/reading card instances directly against the `cardInstances`
// collection (2026-07-27 storage split — see server/metaserver/src/cards.ts header comment). Used by
// cards.e2e.test.ts / economy.e2e.test.ts / pve-verify.e2e.test.ts so all three tests share one
// definition of the collection's document shape instead of each re-deriving it. Mirrors helpers/equipment.ts.
import type { MongoHandle, CardInstance, CardInstanceDoc } from '@nw/shared';

/** The `cardInstances` row a `CardInstance` maps to — one definition shared by the single and batch
 * seeders so they can never drift apart. */
function cardDoc(accountId: string, inst: CardInstance): CardInstanceDoc {
  return {
    _id: inst.id,
    accountId,
    defId: inst.defId,
    level: inst.level,
    gear: inst.gear,
    locked: inst.locked,
    ...(inst.sourceType !== undefined ? { sourceType: inst.sourceType } : {}),
    ...(inst.obtainedAt !== undefined ? { obtainedAt: inst.obtainedAt } : {}),
  };
}

/** Directly seeds (or overwrites) one card instance into `cardInstances`, bypassing the API. */
export async function seedCard(
  m: MongoHandle,
  accountId: string,
  inst: CardInstance,
): Promise<void> {
  await m.collections.cardInstances.updateOne(
    { _id: inst.id },
    { $set: cardDoc(accountId, inst) },
    { upsert: true },
  );
}

/**
 * Seeds a batch (e.g. filling an account's roster toward the cap) and sets `cardInvCount` to match.
 *
 * ONE `bulkWrite`, not a loop of `updateOne`s — same reason as `seedEquipmentBatch` in helpers/equipment.ts:
 * callers fill to `CARD_INV_CAP` (500), and a per-instance loop makes the seed's wall time
 * `cap × ambient latency` instead of a constant, which is how these tests ended up passing or timing
 * out depending on machine load. See claudedocs/server-testing-tooling.md "CI 稳定性".
 */
export async function seedCardBatch(
  m: MongoHandle,
  accountId: string,
  instances: CardInstance[],
): Promise<void> {
  if (instances.length > 0) {
    await m.collections.cardInstances.bulkWrite(
      instances.map((inst) => ({
        updateOne: { filter: { _id: inst.id }, update: { $set: cardDoc(accountId, inst) }, upsert: true },
      })),
      { ordered: false },
    );
  }
  await m.collections.saves.updateOne(
    { _id: accountId },
    { $set: { 'save.cardInvCount': instances.length } },
  );
}

/**
 * Reads the full cardInv map for an account directly from `cardInstances` — a test-side mirror of the
 * server's own `assembleCardInv` join, for asserting internal storage state without going through an
 * HTTP response (where the join happens automatically via app.ts's preSerialization hook).
 */
export async function readCardInv(
  m: MongoHandle,
  accountId: string,
): Promise<Record<string, CardInstance>> {
  const docs = await m.collections.cardInstances.find({ accountId }).toArray();
  const inv: Record<string, CardInstance> = {};
  for (const d of docs) {
    inv[d._id] = {
      id: d._id, defId: d.defId, level: d.level, gear: d.gear, locked: d.locked,
      ...(d.sourceType !== undefined ? { sourceType: d.sourceType } : {}),
      ...(d.obtainedAt !== undefined ? { obtainedAt: d.obtainedAt } : {}),
    };
  }
  return inv;
}
