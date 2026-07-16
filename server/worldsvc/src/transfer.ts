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
   * open/active shard in the same season with room, no in-flight march/occupation (must recall/wait first —
   * an in-flight march referencing a tile in the shard being vacated would otherwise become a dangling
   * cross-shard reference, exactly what patrolShardIsolation's `crossWorldMarches` check exists to catch), and
   * a per-account cooldown (anti shard-hopping/scouting). Forfeits all shard-scoped state in `fromWorldId`
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

    const [busyMarch, busyHold] = await Promise.all([
      cols.marches.findOne({ worldId: fromWorldId, ownerId: accountId, status: { $ne: 'recalled' } }),
      cols.occupations.findOne({ worldId: fromWorldId, ownerId: accountId }),
    ]);
    if (busyMarch || busyHold) throw new SlgError('TRANSFER_BUSY', 'An in-flight march or occupation-hold blocks transfer; recall/wait for it first');

    await this.vacateShard(fromWorldId, accountId);
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
        // Force-clear anything that would otherwise block a voluntary transfer: delete in-flight marches and
        // occupation holds outright (not a refund/recall — the shard is closing, there is no "later" for
        // these to resolve into; troops committed to them are simply gone, same as any other shard-scoped
        // asset forfeited by vacateShard below).
        await cols.marches.deleteMany({ worldId: sourceWorldId, ownerId: pw.accountId });
        await cols.occupations.deleteMany({ worldId: sourceWorldId, ownerId: pw.accountId });
        await this.vacateShard(sourceWorldId, pw.accountId);
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

  /** Shared "leave this shard entirely" step: purge tiles/playerWorld (existing helper) + free the population slot it was holding. */
  private async vacateShard(worldId: string, accountId: string): Promise<void> {
    await this.core.purgePlayerWorld(worldId, accountId);
    await this.core.deps.cols.worlds.updateOne(
      { _id: worldId, population: { $gt: 0 } },
      { $inc: { population: -1 } },
    );
  }
}
