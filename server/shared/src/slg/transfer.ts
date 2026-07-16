// G6 mid-season shard transfer/merge (SLG_DESIGN_LOG.md §27). Split out per the god-file split pattern.
//
// Design summary (full rationale in SLG_DESIGN_LOG.md §27):
//   - Every SLG collection (playerWorld/tiles/marches/families/sects/...) lives in ONE shared set of
//     Mongo collections, keyed by `worldId` (not one DB per shard) — so moving a player between shards is a
//     same-collection operation, not a cross-database migration.
//   - 转区 (individual transfer) = "leave + rejoin, on purpose": vacate the old shard entirely (all tiles
//     including the capital, via the existing `purgePlayerWorld`) then call the existing `joinWorld` on the
//     destination shard, exactly as if joining for the first time. No stat migration — shard-scoped progress
//     (city/tiles/troops) is deliberately NOT carried over; everything account-scoped (SaveData: cards,
//     equipment, coins) was never shard-scoped to begin with, so it's unaffected.
//   - 合区 (shard merge) = the SAME per-player transfer, applied to every remaining player in a low-population
//     shard, followed by closing that shard. This deliberately avoids ever needing to reconcile two live maps'
//     colliding tile ownership — the hard problem the original design left unsolved — because there is no
//     merge of live map state, only bulk relocation of players out of a shard before it closes.

/** Minimum days between two transfers for the same account (anti shard-hopping/scouting). */
export const SHARD_TRANSFER_COOLDOWN_DAYS = 7;
export const SHARD_TRANSFER_COOLDOWN_MS = SHARD_TRANSFER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

/** Reverse of {@link import('./core').worldId}: parses `s{season}-{shard}` back into its parts, or null if malformed. */
export function parseWorldId(id: string): { season: number; shard: number } | null {
  const m = /^s(\d+)-(\d+)$/.exec(id);
  if (!m) return null;
  return { season: Number(m[1]), shard: Number(m[2]) };
}
