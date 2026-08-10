// worldsvc season domain: G6 multi-shard runtime scheduling (§20) — shard allocation, join routing,
// cross-shard isolation patrol. Split out of season.ts (2026-08-10, 独立类+组合 form, friendService.ts's
// sibling — see season.ts's facade comment for why). Depends on WorldCore + the TerritoryService peer
// (joinSeason's actual join) + SeasonManagementService peer (openSeason, called on new-shard overflow and
// next-season allocation — the one genuine cross-domain call in the original class). No behavior change.
import {
  SlgError,
  WORLD_CAPACITY,
  worldShardId,
  shardCountForPopulation,
  allocateSectsToShards,
  type SectStrength,
} from '@nw/shared';
import { WorldCore } from '../core';
import type { TerritoryService } from '../territory';
import type { PlayerWorldView } from '../worldTypes';
import type { SeasonManagementService } from './management';

export class SeasonShardService {
  constructor(
    private readonly core: WorldCore,
    private readonly territory: TerritoryService,
    private readonly management: SeasonManagementService,
  ) {}

  /**
   * New season shard orchestration (admin, §20.4): read last season's seasonResults, snake-draft sects by strength for balanced shard assignment,
   * persist to shardAllocations.familyShard (member families of the same sect land in the same shard; unaffiliated families fill the least-loaded shard),
   * then call openSeason for each shardIndex. Idempotent (openSeason $setOnInsert + alloc upsert; retry does not create duplicates).
   */
  async allocateNextSeason(season: number, capacity: number = WORLD_CAPACITY): Promise<{
    shardCount: number; worldIds: string[]; allocatedFamilies: number;
  }> {
    const { cols, now } = this.core.deps;
    const prevSeason = season - 1;

    // ① Read last season's full shard settlement history → SectStrength[] + each sect's member family list.
    const prevResults = await cols.seasonResults.find({ season: prevSeason }).toArray();
    const sectStrengths: SectStrength[] = [];
    const sectFamilies = new Map<string, string[]>(); // sectId (last season) → member familyIds
    const sectFamilyAll = new Set<string>();          // families already assigned to a sect (used to distinguish unaffiliated families for fill-in)
    for (const res of prevResults) {
      for (const r of res.ranking) {
        if (r.scope !== 'sect') continue;
        const memberFamilyIds = r.memberFamilyIds ?? [];
        sectStrengths.push({
          sectId: r.id,
          lastSeasonRank: r.rank,
          memberFamilyCount: memberFamilyIds.length,
          prosperity: r.prosperity ?? 0,
        });
        sectFamilies.set(r.id, memberFamilyIds);
        for (const fid of memberFamilyIds) sectFamilyAll.add(fid);
      }
    }

    // ② shardCount = ceil(last season's total population across all shards / capacity) (first season has no prior season → 0 → 1 shard).
    const prevWorldIds = (await cols.worlds.find({ season: prevSeason }).project({ _id: 1 }).toArray()).map((w) => w._id);
    const totalPlayers = prevWorldIds.length > 0
      ? await cols.playerWorld.countDocuments({ worldId: { $in: prevWorldIds } })
      : 0;
    const shardCount = shardCountForPopulation(totalPlayers, capacity);

    // ③ Snake-draft balanced assignment: sect → shardIdx, then expand to member family granularity.
    const assignment = allocateSectsToShards(sectStrengths, shardCount);
    const familyShard: Record<string, number> = {};
    for (const [sectId, idx] of assignment) {
      for (const fid of sectFamilies.get(sectId) ?? []) familyShard[fid] = idx;
    }
    // ④ Unaffiliated families (last season had a family but no sect): deterministic fill-in to the least-loaded shard (even distribution).
    const shardLoad = new Array(shardCount).fill(0);
    for (const idx of Object.values(familyShard)) if (idx < shardCount) shardLoad[idx]++;
    if (prevWorldIds.length > 0) {
      const looseFamilyIds = [...new Set(
        (await cols.playerWorld
          .find({ worldId: { $in: prevWorldIds }, familyId: { $exists: true, $nin: [...sectFamilyAll] } })
          .project<{ familyId: string }>({ familyId: 1 }).toArray())
          .map((p) => p.familyId),
      )].sort();
      for (const fid of looseFamilyIds) {
        let min = 0;
        for (let i = 1; i < shardCount; i++) if (shardLoad[i] < shardLoad[min]) min = i;
        familyShard[fid] = min;
        shardLoad[min]++;
      }
    }

    // ⑤ Persist shardAllocations (idempotent upsert: retry overwrites the latest allocation; shardCount is incremented later on overflow).
    await cols.shardAllocations.updateOne(
      { _id: `s${season}` },
      { $set: { season, shardCount, capacity, familyShard }, $setOnInsert: { createdAt: now() } },
      { upsert: true },
    );

    // ⑥ Open N shard worlds.
    const worldIds: string[] = [];
    for (let i = 0; i < shardCount; i++) {
      const wid = worldShardId(season, i);
      await this.management.openSeason(wid, season, i, capacity);
      worldIds.push(wid);
    }
    return { shardCount, worldIds, allocatedFamilies: Object.keys(familyShard).length };
  }

  /**
   * Resolve the shard worldId this account should join for the current season (§20.4): sticky > family lookup table > least-loaded open shard > overflow (open new shard).
   */
  private async resolveShardForJoin(season: number, accountId: string): Promise<string> {
    const { cols } = this.core.deps;

    // ① Sticky: already has a playerWorld in some shard this season → return that worldId (prevents double-joining across shards).
    const existing = await cols.playerWorld.findOne(
      { accountId, worldId: { $regex: `^s${season}-` } },
      { projection: { worldId: 1 } },
    );
    if (existing) return existing.worldId;

    const alloc = await cols.shardAllocations.findOne({ _id: `s${season}` });

    // ② Family lookup: last season's family → familyShard table hit (shard must be open/active and not full).
    if (alloc) {
      const prevPw = await cols.playerWorld.findOne(
        { accountId, worldId: { $regex: `^s${season - 1}-` } },
        { projection: { familyId: 1 } },
      );
      const idx = prevPw?.familyId ? alloc.familyShard[prevPw.familyId] : undefined;
      if (idx != null) {
        const wid = worldShardId(season, idx);
        const w = await cols.worlds.findOne({ _id: wid });
        if (w && (w.status === 'open' || w.status === 'active') && w.population < w.capacity) return wid;
        // Matched shard is full or not open → fall through to overflow fill-in (preserves balance: still prefer the least-loaded open shard).
      }
    }

    // ③ Least-loaded open shard: open/active this season and not full, take the least-loaded by population ascending.
    const open = await cols.worlds
      .find({ season, status: { $in: ['open', 'active'] }, $expr: { $lt: ['$population', '$capacity'] } })
      .sort({ population: 1 }).limit(1).toArray();
    if (open.length > 0) return open[0]!._id;

    // ④ Overflow: no available shard → open a new shard (idx = alloc.shardCount or current world count), $inc shardCount.
    const capacity = alloc?.capacity ?? WORLD_CAPACITY;
    const nextIdx = alloc?.shardCount ?? await cols.worlds.countDocuments({ season });
    const wid = worldShardId(season, nextIdx);
    await this.management.openSeason(wid, season, nextIdx, capacity);
    await cols.shardAllocations.updateOne({ _id: `s${season}` }, { $inc: { shardCount: 1 } });
    return wid;
  }

  /**
   * Resolve only the shard for this account's current season (player-facing browse entry, §20.5): does not place the capital; lets the client fetch the worldId before entering the map.
   * Shares resolveShardForJoin with joinSeason (sticky > family lookup > least-loaded open shard > overflow new shard).
   */
  async resolveSeasonShard(season: number, accountId: string): Promise<{ worldId: string }> {
    return { worldId: await this.resolveShardForJoin(season, accountId) };
  }

  /**
   * Join by season (player-facing, §20.4): server resolves the shard → joinWorld (system auto-places the capital, §3.4; player does not pass coordinates).
   * WORLD_FULL (concurrent full) falls back to re-resolving once more (most likely lands in an overflow new shard). Returns the player view with worldId.
   */
  async joinSeason(season: number, accountId: string): Promise<PlayerWorldView> {
    let worldId = await this.resolveShardForJoin(season, accountId);
    try {
      return await this.territory.joinWorld(worldId, accountId);
    } catch (e) {
      if (e instanceof SlgError && e.code === 'WORLD_FULL') {
        worldId = await this.resolveShardForJoin(season, accountId);
        return await this.territory.joinWorld(worldId, accountId);
      }
      throw e;
    }
  }

  /**
   * Cross-shard isolation patrol (admin read-only, §20.4): scan for cross-shard leaks — cross-shard marches / players double-joined across shards / orphaned tiles.
   */
  async patrolShardIsolation(): Promise<{
    scannedWorlds: number;
    crossWorldMarches: { count: number; samples: string[] };
    multiShardPlayers: { count: number; samples: string[] };
    orphanTiles: { count: number; samples: string[] };
  }> {
    const { cols } = this.core.deps;
    const SAMPLE = 20;
    const scannedWorlds = await cols.worlds.countDocuments({});

    // ① Cross-shard marches: fromTile/toTile prefix ≠ worldId (march references a tile in another shard).
    const crossMarches: string[] = [];
    let crossCount = 0;
    for await (const m of cols.marches.find({}, { projection: { worldId: 1, fromTile: 1, toTile: 1 } })) {
      const pfx = `${m.worldId}:`;
      if (!m.fromTile.startsWith(pfx) || !m.toTile.startsWith(pfx)) {
        crossCount++;
        if (crossMarches.length < SAMPLE) crossMarches.push(m._id);
      }
    }

    // ② Players double-joined: accounts with playerWorld records across multiple worldIds in the same season.
    const worldSeason = new Map<string, number>(
      (await cols.worlds.find({}, { projection: { season: 1 } }).toArray()).map((w) => [w._id, w.season]),
    );
    const acctWorlds = new Map<string, Map<number, Set<string>>>();
    for await (const p of cols.playerWorld.find({}, { projection: { accountId: 1, worldId: 1 } })) {
      const season = worldSeason.get(p.worldId) ?? -1;
      let byS = acctWorlds.get(p.accountId);
      if (!byS) { byS = new Map(); acctWorlds.set(p.accountId, byS); }
      let set = byS.get(season);
      if (!set) { set = new Set(); byS.set(season, set); }
      set.add(p.worldId);
    }
    const multiSamples: string[] = [];
    let multiCount = 0;
    for (const [acct, byS] of acctWorlds) {
      for (const [season, set] of byS) {
        if (set.size > 1) {
          multiCount++;
          if (multiSamples.length < SAMPLE) multiSamples.push(`${acct}@s${season}:${[...set].join(',')}`);
        }
      }
    }

    // ③ Orphaned tiles: tiles._id prefix ≠ worldId field.
    const orphanSamples: string[] = [];
    let orphanCount = 0;
    for await (const t of cols.tiles.find({}, { projection: { worldId: 1 } })) {
      if (!t._id.startsWith(`${t.worldId}:`)) {
        orphanCount++;
        if (orphanSamples.length < SAMPLE) orphanSamples.push(t._id);
      }
    }

    return {
      scannedWorlds,
      crossWorldMarches: { count: crossCount, samples: crossMarches },
      multiShardPlayers: { count: multiCount, samples: multiSamples },
      orphanTiles: { count: orphanCount, samples: orphanSamples },
    };
  }
}
