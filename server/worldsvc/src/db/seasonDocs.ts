// Split 2026-08-10 out of worldsvc/src/db.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Season domain: cross-season settlement history/ranking (C2/§17.2) and the G6 multi-shard
// allocation + mid-season transfer cooldown tracker (§20/§27).
import type { Collection } from 'mongodb';
import type { SettleTier } from '@nw/shared';

/**
 * Season settlement history (C2/§17.2). settleSeason persists this season's ranking + prosperity snapshot, used as G6 allocation input for the next season.
 * `_id = `${worldId}:s${season}`` = idempotency key (re-entering the same season with $setOnInsert does not overwrite).
 */
export interface SeasonResultDoc {
  _id: string;
  worldId: string;
  season: number;
  settledAt: number;
  ranking: Array<{
    rank: number;
    scope: 'sect' | 'family' | 'solo';
    id: string;                // sectId / familyId / ownerId
    name?: string;
    nationCount: number;
    capitalIdxs: number[];
    prosperity?: number;       // prosperity snapshot at settlement (meaningful only for sect scope)
    memberFamilyIds?: string[]; // member family list (recorded only for sect scope; G6 next-season familyShard expansion input, §20 R2)
    tier: SettleTier;
  }>;
}

/**
 * G6 multi-shard season allocation (§20.2). On settle, distributes in a snake-draft order by last season's sect strength, persisting familyId→shardIndex for this season;
 * when players join next season, they are routed by looking up their account's last-season family (sect > family > random).
 * `_id = `s${season}`` (current season). shardCount can be incremented via $inc when population overflows.
 */
export interface ShardAllocationDoc {
  _id: string;        // `s${season}`
  season: number;
  shardCount: number;
  capacity: number;
  familyShard: Record<string, number>; // last-season familyId → this-season shardIndex
  createdAt: number;
}

/** G6 mid-season shard transfer cooldown tracker (§27). `_id` = accountId — one doc per account, independent
 *  of any world (survives the source shard's playerWorld doc being purged on transfer). */
export interface ShardTransferDoc {
  _id: string; // accountId
  lastTransferAt: number;
  /** Season the last transfer happened in (cooldown is season-scoped: a new season resets the clock). */
  season: number;
  fromWorldId: string;
  toWorldId: string;
}

/** Season-domain indexes. `shardTransfers`: _id is already accountId (unique by definition); no secondary index needed. */
export async function ensureSeasonIndexes(
  seasonResults: Collection<SeasonResultDoc>,
  shardAllocations: Collection<ShardAllocationDoc>,
): Promise<void> {
  // Season settlement history (C2/§17.2): query most recent season by worldId; G6 allocation reads last-season ranking.
  await seasonResults.createIndex({ worldId: 1, season: -1 });
  // G6 multi-shard allocation (§20): retrieve this-season allocation table by season (join routing looks up familyShard).
  await shardAllocations.createIndex({ season: 1 });
}
