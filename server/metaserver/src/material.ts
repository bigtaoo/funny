// Material instance provenance ledger (ITEM_IDENTITY_DESIGN.md task2, 2026-08-10). See MaterialInstance's
// doc comment in @nw/shared (types.ts) for why this is a coarser, event-batched instantiation instead of
// a full per-unit escrow/transfer model like equipment/card/skin — materials are not tradeable and grant
// at far higher frequency, so this module only ever instruments the GRANT side (never consumption): every
// call here is fire-and-forget (errors are logged, never thrown) and runs AFTER the authoritative
// materials/inventory.items counter write has already committed, exactly like the equipmentInstances/
// skinInstances upserts in economy/delivery.ts do for their own item kinds. A failure here can never roll
// back or duplicate the real grant it's describing.
import type { Collections, MaterialInstance, MaterialInstanceDoc } from '@nw/shared';
import { createLogger } from '@nw/shared';

const log = createLogger('meta:material');

/**
 * Retention window for materialInstances rows (TTL — see MaterialInstanceDoc's doc comment for why this
 * expires outright instead of needing a DELIVERED_ORDERS_CAP-style cap). 30 days: long enough for a
 * realistic CS/support lookback, short enough to bound total collection size for an account that grinds
 * PvE/gacha daily. Unlike `deliveredOrders` (the unbounded array embedded IN the save document that
 * caused the 2026-07-26 perf incident — see economy/delivery.ts's DELIVERED_ORDERS_CAP comment),
 * `materialInstances` is its own separate collection never joined into GET/PUT /save, so its size has
 * zero effect on save-document read/write latency no matter how large it grows — this TTL exists purely
 * to bound absolute Mongo storage over time, not to protect a hot path.
 */
const MATERIAL_INSTANCE_TTL_MS = 30 * 24 * 3600 * 1000;

export function toInstanceDoc(instance: MaterialInstance, accountId: string): MaterialInstanceDoc {
  const obtainedAt = instance.obtainedAt ?? Date.now();
  return {
    _id: instance.id,
    accountId,
    materialId: instance.materialId,
    count: instance.count,
    ...(instance.sourceType !== undefined ? { sourceType: instance.sourceType } : {}),
    ...(instance.obtainedAt !== undefined ? { obtainedAt: instance.obtainedAt } : {}),
    expireAt: new Date(obtainedAt + MATERIAL_INSTANCE_TTL_MS),
  };
}

/**
 * Best-effort provenance recording for one grant EVENT that may touch several material/item ids at once
 * (e.g. a PvE clear dropping both scrap and lead) — one MaterialInstance row per id, `count` = the
 * quantity this single event granted (not one row per physical unit; see MaterialInstance's doc comment
 * in @nw/shared). `baseId` must already be unique per (accountId, event): callers derive it from whatever
 * idempotency key the surrounding grant already uses (an orderId, a `${monthKey}:${day}` checkin key, a
 * recharge tier number, a pveVerify verifyId, ...) so upsert-by-id makes a retry of the surrounding
 * operation re-assert the same row instead of minting a duplicate. A caller with no natural key at all
 * (e.g. a plain PvE clear, which has none) may pass a fresh random id — a duplicate row from a client
 * retry is a harmless, self-expiring blemish here (nothing reads this collection back to reconstruct
 * state), never a correctness bug, unlike a duplicate in the materials counter itself would be.
 * Zero-or-negative entries in `grants` are skipped (this module never records a deduction).
 */
export async function recordMaterialGrants(
  cols: Collections,
  accountId: string,
  baseId: string,
  grants: Record<string, number>,
  sourceType: string,
  obtainedAt: number,
): Promise<void> {
  for (const [materialId, count] of Object.entries(grants)) {
    if (!(count > 0)) continue;
    const instance: MaterialInstance = { id: `mat_${baseId}_${materialId}`, materialId, count, sourceType, obtainedAt };
    try {
      await cols.materialInstances.updateOne(
        { _id: instance.id },
        { $set: toInstanceDoc(instance, accountId) },
        { upsert: true },
      );
    } catch (e) {
      log.warn('material instance provenance write failed (best-effort, does not affect the materials counter)', {
        accountId, materialId, sourceType, err: (e as Error).message,
      });
    }
  }
}
