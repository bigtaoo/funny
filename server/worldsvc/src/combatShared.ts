// worldsvc combat domain: helpers shared across marches (combatMarch) and siege settlement (combatSiege).
// Peeled out of CombatService (2026-07-03) as free functions taking WorldCore explicitly, so both the
// march-arrival path and the siege-settlement path can refund committed troops without a class dependency.
// No behavior change.
import { RESOURCE_TYPES, RESOURCE_CAP, type ResourceType } from '@nw/shared';
import type { PlayerWorldDoc } from './db';
import type { WorldCore } from './core';

/** Refund troops to the pool (capped at troopCap) + settle resources; optionally merge loot into resources (capped at RESOURCE_CAP). */
export async function refundTroops(
  core: WorldCore,
  pw: PlayerWorldDoc,
  troops: number,
  t: number,
  loot?: Record<ResourceType, number>,
): Promise<void> {
  const resources = core.settle(pw, t);
  if (loot) {
    for (const rt of RESOURCE_TYPES) {
      resources[rt] = Math.min(RESOURCE_CAP, (resources[rt] ?? 0) + (loot[rt] ?? 0));
    }
  }
  const next = Math.min(pw.troopCap, pw.troops + troops);
  await core.deps.cols.playerWorld.updateOne(
    { _id: pw._id },
    { $set: { resources, troops: next, lastTickAt: t }, $inc: { rev: 1 } },
  );
}
