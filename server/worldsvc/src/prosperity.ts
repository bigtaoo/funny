// Family prosperity (G2 / SLG_DESIGN §17.4): score = familyProsperity(territory, member, activity),
// lazily decayed on read (analogous to resource yield; not ticked daily). territory = number of tiles
// currently occupied by family members (same source as the per-player countDocuments in getMe,
// expanded by aggregating across members). Explicit refresh points (occupation / siege / sect-founding / settle)
// write back prosperity + prosperityUpdatedAt anchor.
import { familyProsperity, decayProsperity } from '@nw/shared';
import type { WorldCollections, FamilyDoc } from './db';

/** Effective prosperity after lazy decay on read (not written back). base defaults to 0; anchor defaults to now (no decay). */
export function effectiveProsperity(fam: Pick<FamilyDoc, 'prosperity' | 'prosperityUpdatedAt'>, now: number): number {
  const base = fam.prosperity ?? 0;
  const anchor = fam.prosperityUpdatedAt ?? now;
  const dtDays = Math.max(0, (now - anchor) / 86_400_000);
  return decayProsperity(base, dtDays);
}

/**
 * Recompute and write back family prosperity (§17.4 explicit refresh point).
 * territory = number of tiles occupied by family members,
 * member = FamilyDoc.memberCount, activity = FamilyDoc.activity (season cumulative activity).
 * Writes back prosperity + prosperityUpdatedAt=now. Returns the new value (freshly refreshed, no further decay needed).
 * Best-effort semantics are the caller's responsibility; family not found → returns 0 without writing.
 */
export async function refreshFamilyProsperity(
  cols: WorldCollections,
  worldId: string,
  familyId: string,
  now: number,
): Promise<number> {
  const fam = await cols.families.findOne({ _id: familyId });
  if (!fam) return 0;
  const members = await cols.familyMembers.find({ familyId }).project({ accountId: 1 }).toArray();
  const ids = members.map((m) => (m as unknown as { accountId: string }).accountId);
  const territoryCount = ids.length > 0
    ? await cols.tiles.countDocuments({ worldId, ownerId: { $in: ids } })
    : 0;
  const prosperity = familyProsperity(territoryCount, fam.memberCount, fam.activity ?? 0);
  await cols.families.updateOne(
    { _id: familyId },
    { $set: { prosperity, prosperityUpdatedAt: now } },
  );
  return prosperity;
}

/** Sect prosperity aggregate = ∑ effective prosperity of member families (§17.4, refreshed on settle / sect-founding / G6 harvest). */
export async function aggregateSectProsperity(cols: WorldCollections, sectId: string, now: number): Promise<number> {
  const fams = await cols.families.find({ sectId }).toArray();
  return fams.reduce((sum, f) => sum + effectiveProsperity(f, now), 0);
}
