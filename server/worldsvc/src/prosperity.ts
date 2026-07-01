// Family prosperity (G2 / SLG_DESIGN §17.4): score = familyProsperity(territory, member, activity).
// P4 follow-up: prosperity/activity are now owned by socialsvc's FamilyDoc (worldsvc no longer keeps a local
// family mirror); worldsvc only knows tile ownership, so it computes territoryCount and asks socialsvc to
// recompute + persist prosperity via the internal API. decayProsperity is applied lazily by callers that read
// an already-fetched FamilySummary (e.g. sect prosperity aggregation at settlement) rather than by worldsvc itself.
import { decayProsperity } from '@nw/shared';
import type { WorldCollections } from './db';
import type { WorldSocialsvcClient, FamilySummary } from './socialsvcClient';

/** Effective prosperity after lazy decay on read (not written back). base defaults to 0; anchor defaults to now (no decay). */
export function effectiveProsperity(fam: Pick<FamilySummary, 'prosperity' | 'prosperityUpdatedAt'>, now: number): number {
  const base = fam.prosperity ?? 0;
  const anchor = fam.prosperityUpdatedAt ?? now;
  const dtDays = Math.max(0, (now - anchor) / 86_400_000);
  return decayProsperity(base, dtDays);
}

/**
 * Recompute family prosperity via socialsvc (§17.4 explicit refresh point).
 * territory = number of tiles occupied by family members currently joined to this world (via PlayerWorldDoc.familyId,
 * SS7 mirror). member/activity are supplied by socialsvc from its own FamilyDoc. Best-effort: failure returns 0.
 */
export async function refreshFamilyProsperity(
  cols: WorldCollections,
  socialsvc: WorldSocialsvcClient,
  worldId: string,
  familyId: string,
): Promise<number> {
  const members = await cols.playerWorld.find({ worldId, familyId }).project({ accountId: 1 }).toArray();
  const ids = members.map((m) => (m as unknown as { accountId: string }).accountId);
  const territoryCount = ids.length > 0
    ? await cols.tiles.countDocuments({ worldId, ownerId: { $in: ids } })
    : 0;
  return socialsvc.refreshProsperity(familyId, territoryCount);
}

/** Sect prosperity aggregate = ∑ effective prosperity of already-fetched member families (§17.4, refreshed on settle / sect-founding / G6 harvest). */
export function aggregateSectProsperity(fams: FamilySummary[], now: number): number {
  return fams.reduce((sum, f) => sum + effectiveProsperity(f, now), 0);
}
