// G6 mid-season shard transfer/merge (SLG_DESIGN_LOG.md §27). Split out per the domain-service pattern
// (TerritoryService/SeasonService/... each take the shared WorldCore and live in their own file).
//
// Both player-initiated transfer and ops-initiated merge share ONE core operation: move a single account's
// SLG presence from one shard (worldId) to another. There is no map/tile merging — the destination shard's
// map is untouched; the source player's shard-scoped state (city/tiles/troops) is deliberately forfeited via
// the existing purgePlayerWorld, and they re-enter the destination exactly like a first-time join
// (joinWorld). Family/sect membership is NOT shard data (family lives in socialsvc, is not per-world) and is
// intentionally left untouched by a transfer — see the design note in shared/src/slg/transfer.ts.
import {
  SlgError,
  SHARD_TRANSFER_COOLDOWN_MS,
  tileId,
  type WorldStatus,
} from '@nw/shared';
import { WorldCore } from './core';
import type { PlayerWorldView } from './worldTypes';
import type { TerritoryService } from './territory';

const OPEN_STATUSES: readonly WorldStatus[] = ['open', 'active'];

export interface ShardSummary {
  worldId: string;
  shard: number;
  population: number;
  capacity: number;
}

export class TransferService {
  constructor(
    private readonly core: WorldCore,
    private readonly territory: TerritoryService,
  ) {}

  /**
   * List candidate destination shards for a player currently in `fromWorldId`: same season, open/active,
   * not full, excluding the current shard. Empty if the current world has no `WorldDoc` (dev/test without
   * seeded world docs — nothing meaningful to offer) or no other shard qualifies.
   */
  async listTransferTargets(fromWorldId: string): Promise<ShardSummary[]> {
    const { cols } = this.core.deps;
    const fromWorld = await cols.worlds.findOne({ _id: fromWorldId });
    if (!fromWorld) return [];
    const candidates = await cols.worlds
      .find({ season: fromWorld.season, status: { $in: OPEN_STATUSES as WorldStatus[] }, _id: { $ne: fromWorldId } })
      .toArray();
    return candidates
      .filter((w) => w.population < w.capacity)
      .map((w) => ({ worldId: w._id, shard: w.shard, population: w.population, capacity: w.capacity }));
  }

  /**
   * Player-initiated mid-season transfer (§27). Guards: must be in `fromWorldId`, target must be a different
   * open/active shard in the same season with room, no in-flight march/occupation/stationed team (must
   * recall/wait first — an in-flight march or a team parked in the field referencing a tile in the shard
   * being vacated would otherwise become a dangling cross-shard reference: a ghost `StationedDoc` the player
   * can never recall (no playerWorld doc left to own it) that permanently squats the tile via the "one
   * park per tile" rule and its stale Redis occ/cover entries — see design-doc-audit-2026-07, SLG_DESIGN_LOG
   * §27's TRANSFER_BUSY gap), and a per-account cooldown (anti shard-hopping/scouting). Forfeits all
   * shard-scoped state in `fromWorldId`
   * (via purgePlayerWorld) and re-joins `toWorldId` fresh (via joinWorld) — no stat migration, see module header.
   *
   * Residual risk (accepted, matches this codebase's existing single-document-CAS convention — no
   * cross-collection transactions anywhere, see shared/src/mongo.ts): the target's capacity is checked just
   * above, then re-checked atomically inside joinWorld itself; if capacity fills in that narrow window, the
   * player ends up vacated from `fromWorldId` with a failed join to `toWorldId` (briefly in no shard at all).
   * Recovery: the player can call the plain join endpoint (joinWorld) against any other open shard — it has
   * no dependency on prior world state, so this is a safe, ordinary path forward, not a stuck state.
   */
  async transferShard(accountId: string, fromWorldId: string, toWorldId: string): Promise<PlayerWorldView> {
    if (fromWorldId === toWorldId) throw new SlgError('TRANSFER_SAME_SHARD', 'Already in this shard');
    const { cols, now } = this.core.deps;

    const [fromPw, fromWorld, toWorld] = await Promise.all([
      cols.playerWorld.findOne({ worldId: fromWorldId, accountId }),
      cols.worlds.findOne({ _id: fromWorldId }),
      cols.worlds.findOne({ _id: toWorldId }),
    ]);
    if (!fromPw) throw new SlgError('NOT_IN_WORLD', 'Not yet in the source shard');
    if (!toWorld || (fromWorld && toWorld.season !== fromWorld.season) || !OPEN_STATUSES.includes(toWorld.status)) {
      throw new SlgError('TRANSFER_TARGET_INVALID', 'Target shard does not exist, is not open, or is a different season');
    }
    if (toWorld.population >= toWorld.capacity) throw new SlgError('TRANSFER_TARGET_INVALID', 'Target shard is full');

    const t = now();
    const transferDoc = await cols.shardTransfers.findOne({ _id: accountId });
    if (transferDoc && (fromWorld ? transferDoc.season === fromWorld.season : true) && t - transferDoc.lastTransferAt < SHARD_TRANSFER_COOLDOWN_MS) {
      throw new SlgError('TRANSFER_COOLDOWN', 'Must wait before transferring again');
    }

    const [busyMarch, busyHold, busyStationed] = await Promise.all([
      cols.marches.findOne({ worldId: fromWorldId, ownerId: accountId, status: { $ne: 'recalled' } }),
      cols.occupations.findOne({ worldId: fromWorldId, ownerId: accountId }),
      cols.stationed.findOne({ worldId: fromWorldId, ownerId: accountId }),
    ]);
    if (busyMarch || busyHold || busyStationed) throw new SlgError('TRANSFER_BUSY', 'An in-flight march, occupation-hold, or stationed team blocks transfer; recall/wait for it first');

    await vacateShard(this.core, fromWorldId, accountId);
    const view = await this.territory.joinWorld(toWorldId, accountId);
    await cols.shardTransfers.updateOne(
      { _id: accountId },
      { $set: { lastTransferAt: t, season: toWorld.season, fromWorldId, toWorldId } },
      { upsert: true },
    );
    return view;
  }

  /**
   * Ops-initiated shard merge (§27, X-Internal-Key admin action): moves EVERY remaining player out of
   * `sourceWorldId` into `targetWorldId` (same per-player transfer core, but "forced" — unlike the
   * player-initiated path, a forced transfer does not block on cooldown or in-flight marches/occupations;
   * it deletes them outright first (troops forfeited, not refunded), since the whole point is shutting the source shard down
   * completely, not leaving stragglers behind). Best-effort per account: one player's failure is logged and
   * skipped, not allowed to abort the whole merge. Once every player has been moved (or skipped), the source
   * shard is marked `closed` — already excluded from all join routing (resolveShardForJoin/joinWorld both
   * filter on status, §17.3) — completing the retirement. Does NOT touch the destination shard's map; there
   * is no tile-ownership reconciliation because there is no live-map merge, only bulk relocation before close.
   */
  async mergeShard(sourceWorldId: string, targetWorldId: string): Promise<{ moved: number; failed: string[] }> {
    if (sourceWorldId === targetWorldId) throw new SlgError('TRANSFER_SAME_SHARD', 'Source and target must differ');
    const { cols } = this.core.deps;
    const [sourceWorld, targetWorld] = await Promise.all([
      cols.worlds.findOne({ _id: sourceWorldId }),
      cols.worlds.findOne({ _id: targetWorldId }),
    ]);
    if (!sourceWorld) throw new SlgError('TRANSFER_TARGET_INVALID', 'Source shard does not exist');
    if (!targetWorld || targetWorld.season !== sourceWorld.season || !OPEN_STATUSES.includes(targetWorld.status)) {
      throw new SlgError('TRANSFER_TARGET_INVALID', 'Target shard does not exist, is not open, or is a different season');
    }

    const players = await cols.playerWorld.find({ worldId: sourceWorldId }).toArray();
    // Headroom check up front, not per-player: this codebase has no cross-document transactions (single-node
    // replica set, but every write here is a single-document CAS by convention — see shared/src/mongo.ts), so a
    // player is briefly account-less between vacateShard and joinWorld. Refusing the whole merge unless the
    // target can fit everyone avoids ever hitting that gap due to the target filling up mid-loop.
    if (targetWorld.capacity - targetWorld.population < players.length) {
      throw new SlgError('TRANSFER_TARGET_INVALID', `Target shard lacks room for all ${players.length} remaining players`);
    }
    const failed: string[] = [];
    let moved = 0;
    for (const pw of players) {
      try {
        // Force-clear anything that would otherwise block a voluntary transfer (see forceClearShardPresence:
        // the shard is closing, there is no "later" for in-flight state to resolve into — troops committed to
        // it are simply gone, same as any other shard-scoped asset forfeited by vacateShard below).
        await forceClearShardPresence(this.core, sourceWorldId, pw.accountId);
        await vacateShard(this.core, sourceWorldId, pw.accountId);
        await this.territory.joinWorld(targetWorldId, pw.accountId);
        moved++;
      } catch (err) {
        console.error('[worldsvc] mergeShard: failed to move player', { sourceWorldId, targetWorldId, accountId: pw.accountId, err: (err as Error).message });
        failed.push(pw.accountId);
      }
    }

    // All movable players relocated (failures are logged, left behind in a shard about to close — same
    // fail-safe posture as resetSeason's best-effort mail dispatch). Retire the source shard: closed status
    // is already excluded from resolveShardForJoin/joinWorld (§17.3), so no routing-table cleanup is needed.
    await cols.worlds.updateOne({ _id: sourceWorldId }, { $set: { status: 'closed' as WorldStatus } });
    return { moved, failed };
  }
}

/** Per-collection counts of what forceClearShardPresence removed (feeds the account-purge response). */
export interface ShardPresenceCleared {
  marches: number;
  occupations: number;
  stationed: number;
  contestedTiles: number;
  siegeDamage: number;
}

/**
 * Force-clear one account's in-flight state in one shard, without refunding anything. Shared by the ops
 * shard merge (mergeShard above) and the account-deletion purge (accountPurge.ts) — both are "this player's
 * presence in this shard ends NOW" operations with no later for a march/hold/park to resolve into.
 *
 *  - In-flight marches, occupation holds and stationed (parked-in-the-field) teams are deleted outright. A
 *    stepping march holds a Redis occ entry on the cell it last reached (same cleanup recallMarch does), a
 *    stationed team holds one on its tile, and a garrison-mode team additionally a 9-cell cover entry — all
 *    must go alongside the Mongo doc, or that tile becomes an eternal ghost no one can ever park a team on
 *    again, per the "one park per tile" rule.
 *  - Arrow towers on the player's own tiles registered cover in the same Redis reverse index. vacateShard's
 *    purgePlayerWorld deletes those tiles (structure gone with them) but never touched Redis, so the cover is
 *    swept here first — exactly like passiveRelocate (combatSiege/helpers.ts) does before its own tile wipe.
 *  - Tiles this player is mid-way through occupying carry `contestedBy`; the OccupationDoc that would have
 *    settled or cleared them is deleted above, so without the $unset (same one cancelOccupation uses) the tile
 *    would stay contested by nobody, forever.
 *  - Pending delayed siege hits this player launched (attackerId) are deleted: settling one after the player
 *    left would hand a captured building to an account that no longer has a presence in the shard. Hits
 *    AGAINST this player (defenderId) are deliberately left alone — they belong to the besieging player, whose
 *    team is carried on that row; once vacateShard deletes the target tiles the settlement takes its existing
 *    stale-target path (settleSiegeDamage: tile gone → void the hit, walk the besiegers home). Deleting those
 *    rows instead would strand the other player's team with no return leg.
 */
export async function forceClearShardPresence(core: WorldCore, worldId: string, accountId: string): Promise<ShardPresenceCleared> {
  const { cols } = core.deps;
  const marches = await cols.marches.find({ worldId, ownerId: accountId }).toArray();
  if (marches.length > 0) {
    await cols.marches.deleteMany({ worldId, ownerId: accountId });
    for (const m of marches) {
      const cur = m.path && m.stepIndex != null ? m.path[m.stepIndex] : undefined;
      if (cur) await core.clearOccupancy(worldId, tileId(worldId, cur.x, cur.y), m._id);
    }
  }
  const occ = await cols.occupations.deleteMany({ worldId, ownerId: accountId });
  const stationedDocs = await cols.stationed.find({ worldId, ownerId: accountId }).toArray();
  if (stationedDocs.length > 0) {
    await cols.stationed.deleteMany({ worldId, ownerId: accountId });
    for (const sd of stationedDocs) {
      await core.clearOccupancy(worldId, sd.tile, sd.tile);
      if (sd.mode === 'garrison') await core.removeCover(worldId, sd.x, sd.y, sd.tile);
    }
  }
  const towerTiles = await cols.tiles.find({ worldId, ownerId: accountId, 'structure.kind': 'arrowTower' }).toArray();
  for (const tt of towerTiles) await core.removeCover(worldId, tt.x, tt.y, tt._id);
  const contested = await cols.tiles.updateMany(
    { worldId, contestedBy: accountId },
    { $unset: { contestedBy: '', contestedUntil: '', contestedGarrison: '', contestedFamilyId: '' } },
  );
  const hits = await cols.siegeDamage.deleteMany({ worldId, attackerId: accountId });
  return {
    marches: marches.length,
    occupations: occ.deletedCount,
    stationed: stationedDocs.length,
    contestedTiles: contested.modifiedCount,
    siegeDamage: hits.deletedCount,
  };
}

/**
 * Shared "leave this shard entirely" step: purge tiles/playerWorld (existing helper) + free the population
 * slot it was holding. The decrement only fires when this call actually deleted the playerWorld doc, so a
 * re-run after a partial failure (the account purge is retried until it reports done) cannot free the same
 * slot twice; the `$gt: 0` guard still keeps a drifted counter from going negative.
 */
export async function vacateShard(core: WorldCore, worldId: string, accountId: string): Promise<{ tiles: number; playerWorld: boolean }> {
  const purged = await core.purgePlayerWorld(worldId, accountId);
  if (purged.playerWorld) {
    await core.deps.cols.worlds.updateOne(
      { _id: worldId, population: { $gt: 0 } },
      { $inc: { population: -1 } },
    );
  }
  return purged;
}
