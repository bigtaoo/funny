// cards/* split — read-side roster reassembly (see ../cards.ts for the module overview).
import type { Collections, SaveData, CardInstance } from '@nw/shared';
import { fromCardDoc } from './helpers.js';

/**
 * Reassembles the full cardInv map from `cardInstances`, for wire-format compatibility (every player-facing
 * response shape is unchanged by the storage split). Also opportunistically self-heals `cardInvCount` drift
 * (a plain field $set, no rev guard — it's an informational mirror never used as a lock, so this can never
 * spuriously conflict with a real optimistic-lock write) since this call already has the true count in hand.
 */
export async function assembleCardInv(
  cols: Collections,
  accountId: string,
  save?: SaveData,
): Promise<Record<string, CardInstance>> {
  const docs = await cols.cardInstances.find({ accountId }).toArray();
  const inv: Record<string, CardInstance> = {};
  for (const doc of docs) inv[doc._id] = fromCardDoc(doc);
  if (save && save.cardInvCount !== docs.length) {
    await cols.saves.updateOne({ _id: accountId }, { $set: { 'save.cardInvCount': docs.length } });
  }
  return inv;
}

/**
 * Narrow variant of `assembleCardInv`: resolves only the given instance ids, still scoped to
 * `accountId` (a foreign or sold id simply doesn't come back, which is exactly the "do you still own
 * this?" answer callers want). Added 2026-08-02 for worldsvc's `getTeams` self-heal, which sits on
 * the CityScene critical path and only ever needs to validate the ≤ 5×12 ids its formations
 * reference — pulling a 500-card roster for that was the dominant cost of GET /world/teams.
 *
 * Deliberately skips assembleCardInv's opportunistic `cardInvCount` self-heal: a filtered `find` has
 * no view of the true roster size, so writing `docs.length` here would actively corrupt the mirror.
 */
export async function assembleCardInvSubset(
  cols: Collections,
  accountId: string,
  ids: readonly string[],
): Promise<Record<string, CardInstance>> {
  if (ids.length === 0) return {};
  const docs = await cols.cardInstances.find({ accountId, _id: { $in: [...ids] } }).toArray();
  const inv: Record<string, CardInstance> = {};
  for (const doc of docs) inv[doc._id] = fromCardDoc(doc);
  return inv;
}
