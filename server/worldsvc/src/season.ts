// worldsvc season / multi-shard domain (S8-7 + G6 §20). Peeled out of the WorldService god-class (2026-07-03).
// Depends on WorldCore (shared state + nations) and, for joinSeason capital placement, the TerritoryService peer.
// No behavior change.
import {
  SlgError,
  settleTier,
  SETTLE_REWARDS,
  CENTER_CAPITAL_IDX,
  CENTER_CAPITAL_MULT,
  BP_SETTLE_EXTRA,
  RESET_DELETE_BATCH,
  WORLD_CAPACITY,
  worldShardId,
  shardCountForPopulation,
  allocateSectsToShards,
  type SectStrength,
} from '@nw/shared';
import { ENGINE_VERSION } from '@nw/engine';
import { WorldCore, deleteInBatches } from './core';
import { aggregateSectProsperity } from './prosperity';
import type { TerritoryService } from './territory';
import type { PlayerWorldView } from './worldTypes';

export class SeasonService {
  constructor(
    private readonly core: WorldCore,
    private readonly territory: TerritoryService,
  ) {}

  // ── S8-7: season management ────────────────────────────────────────

  /** Get world/season info (GET /world/season). */
  async getSeason(worldId: string): Promise<{
    worldId: string;
    season: number;
    shard: number;
    status: string;
    openAt: number;
    resetAt?: number;
    capacity: number;
    population: number;
    mapW: number;
    mapH: number;
  } | null> {
    const w = await this.core.deps.cols.worlds.findOne({ _id: worldId });
    if (!w) return null;
    return {
      worldId: w._id,
      season: w.season,
      shard: w.shard,
      status: w.status,
      openAt: w.openAt,
      ...(w.resetAt ? { resetAt: w.resetAt } : {}),
      capacity: w.capacity,
      population: w.population,
      mapW: w.mapW,
      mapH: w.mapH,
    };
  }

  /**
   * Return the highest season number among currently open/active worlds (§20.8).
   * Used by GET /world/active-season so the client does not need to hard-code CURRENT_SEASON.
   * Falls back to 1 when no worlds exist yet (dev/test environments).
   */
  async getActiveSeasonNo(): Promise<number> {
    const w = await this.core.deps.cols.worlds.findOne(
      { status: { $in: ['open', 'active'] } },
      { sort: { season: -1 }, projection: { season: 1 } },
    );
    return w?.season ?? 1;
  }

  /**
   * Open a season: create the world document (idempotent — if it already exists, update status → open).
   * worldId must have the form `s{season}-{shard}`.
   */
  async openSeason(
    worldId: string,
    season: number,
    shard: number,
    capacity: number,
  ): Promise<void> {
    const { cols, now } = this.core.deps;
    await cols.worlds.updateOne(
      { _id: worldId },
      {
        $setOnInsert: {
          _id: worldId,
          season,
          shard,
          mapW: this.core.deps.mapW,
          mapH: this.core.deps.mapH,
          openAt: now(),
          capacity,
          population: 0,
          rev: 0,
        },
        // status is set only in $set (both first insert and reopen set it to open); the same field cannot appear in both $set and $setOnInsert (Mongo upsert conflict).
        // Pin the engine version on open (C7/§17.9): consistency anchor for authoritative siege / replay. Reopen pins the current process version.
        $set: { status: 'open' as const, engineVersion: ENGINE_VERSION },
      },
      { upsert: true },
    );
    // Initialize the 10 capital documents
    await this.core.initNations(worldId);
  }

  /**
   * Expand a ranking entity to the set of all player accounts it covers (§17.5 reward recipients).
   * sect → all members of its member families; family → all family members; solo → the occupier themselves. Deduped.
   */
  private async expandToAccounts(worldId: string, scope: 'sect' | 'family' | 'solo', id: string): Promise<string[]> {
    const { cols } = this.core.deps;
    if (scope === 'solo') return [id];
    const familyIds = scope === 'sect'
      ? (await this.core.socialsvc.getFamiliesBySect(id)).map((f) => f.familyId)
      : [id];
    if (familyIds.length === 0) return [];
    const members = await cols.playerWorld.find({ worldId, familyId: { $in: familyIds } }).project({ accountId: 1 }).toArray();
    return [...new Set(members.map((m) => (m as unknown as { accountId: string }).accountId))];
  }

  /**
   * Season settlement (settling): rank entities by the number of capitals they occupy (§2.1 grand contest = shard-level ranking of sects by capital count).
   * Aggregation priority: sect → unaffiliated family → individual (owner), cascading fallback for occupiers with no sect/family.
   * Settlement only computes rankings; it does not wipe data (data wipe goes through resetSeason). Returns the ranking list (descending by capital count).
   * `scope` identifies the aggregation dimension: 'sect' | 'family' | 'solo'.
   */
  async settleSeason(worldId: string): Promise<Array<{
    rank: number;
    scope: 'sect' | 'family' | 'solo';
    /** Aggregation entity ID (sectId / familyId / ownerId). Field name kept as familyId for backward compatibility with existing callers. */
    familyId: string;
    name?: string;
    nationCount: number;
    capitalIdxs: number[];
  }>> {
    const { cols, now } = this.core.deps;

    // Mark the season as entering settlement state (§17.3 guard: only active/settling may settle; reentrant safe).
    // dev/test environments without a world document skip the guard (consistent with joinWorld capacity guard policy) and compute rankings directly.
    const w = await cols.worlds.findOne({ _id: worldId });
    if (w) {
      const moved = await cols.worlds.findOneAndUpdate(
        { _id: worldId, status: { $in: ['active', 'settling'] } },
        { $set: { status: 'settling' as const } },
      );
      if (!moved) throw new SlgError('WORLD_CLOSED', 'World cannot be settled (must be active/settling)');
    }

    const nations = await cols.nations.find({ worldId, ownerId: { $exists: true } }).toArray();

    // family → sectId mapping (which sect each occupier's family belongs to), fetched from socialsvc for just the families that occupy a nation.
    const occupyingFamilyIds = [...new Set(nations.map((n) => n.familyId).filter((id): id is string => !!id))];
    const fams = await this.core.socialsvc.getFamiliesByIds(occupyingFamilyIds);
    const familySect = new Map<string, string | undefined>();
    const familyName = new Map<string, string>();
    for (const f of fams) {
      familySect.set(f.familyId, f.sectId);
      familyName.set(f.familyId, f.name);
    }
    const sectName = new Map<string, string>();
    for (const s of await cols.sects.find({ worldId }).toArray()) sectName.set(s._id, s.name);

    // Aggregate capital counts by "sect → family → individual" in order of priority.
    const agg = new Map<string, { scope: 'sect' | 'family' | 'solo'; name?: string; capitalIdxs: number[] }>();
    for (const n of nations) {
      let scope: 'sect' | 'family' | 'solo';
      let key: string;
      let name: string | undefined;
      const sid = n.familyId ? familySect.get(n.familyId) : undefined;
      if (sid) {
        scope = 'sect'; key = sid; name = sectName.get(sid);
      } else if (n.familyId) {
        scope = 'family'; key = n.familyId; name = familyName.get(n.familyId);
      } else {
        scope = 'solo'; key = n.ownerId ?? 'solo';
      }
      const cur = agg.get(key) ?? { scope, name, capitalIdxs: [] };
      cur.capitalIdxs.push(n.capitalIdx);
      agg.set(key, cur);
    }

    const ranking = [...agg.entries()]
      .sort((a, b) => b[1].capitalIdxs.length - a[1].capitalIdxs.length)
      .map(([id, v], i) => ({
        rank: i + 1,
        scope: v.scope,
        familyId: id,
        ...(v.name ? { name: v.name } : {}),
        nationCount: v.capitalIdxs.length,
        capitalIdxs: v.capitalIdxs,
      }));

    // Persist historical records + dispatch rewards (C1/C2) only when a world document exists (requires the season anchor for dispatchKey / idempotency key).
    if (w) {
      // Sect prosperity snapshot (aggregated and refreshed on settle, §17.4) + member family list snapshot (G6 next-season familyShard expansion, §20 R2).
      const sectProsperity = new Map<string, number>();
      const sectMemberFamilyIds = new Map<string, string[]>();
      for (const r of ranking) {
        if (r.scope === 'sect') {
          const memberFams = await this.core.socialsvc.getFamiliesBySect(r.familyId);
          const sum = aggregateSectProsperity(memberFams, now());
          sectProsperity.set(r.familyId, sum);
          sectMemberFamilyIds.set(r.familyId, memberFams.map((f) => f.familyId));
          await cols.sects.updateOne({ _id: r.familyId }, { $set: { prosperity: sum } });
        }
      }

      // ① Persist historical record (C2, idempotent: _id = `${worldId}:s${season}`, $setOnInsert).
      await cols.seasonResults.updateOne(
        { _id: `${worldId}:s${w.season}` },
        {
          $setOnInsert: {
            worldId,
            season: w.season,
            settledAt: now(),
            ranking: ranking.map((r) => ({
              rank: r.rank,
              scope: r.scope,
              id: r.familyId,
              ...(r.name ? { name: r.name } : {}),
              nationCount: r.nationCount,
              capitalIdxs: r.capitalIdxs,
              tier: settleTier(r.rank),
              ...(r.scope === 'sect' ? {
                prosperity: sectProsperity.get(r.familyId) ?? 0,
                memberFamilyIds: sectMemberFamilyIds.get(r.familyId) ?? [],
              } : {}),
            })),
          },
        },
        { upsert: true },
      );

      // ② Dispatch rewards (C1): for each ranking entity, expand to all player accounts under it and send a system mail with attachments (dispatchKey idempotent).
      for (const r of ranking) {
        const tier = settleTier(r.rank);
        const base = SETTLE_REWARDS[tier];
        const mult = r.capitalIdxs.includes(CENTER_CAPITAL_IDX) ? CENTER_CAPITAL_MULT : 1; // central capital multiplier (§2.4)
        const items: Record<string, number> = {};
        for (const [id, n] of Object.entries(base.items)) items[id] = n * mult;
        const accounts = await this.expandToAccounts(worldId, r.scope, r.familyId);
        const dispatchKey = `slg-settle:${worldId}:s${w.season}`;
        const attachments = [
          // Materials (scrap/lead/binding) are sent to SaveData.materials — the unified progression pool (SLG8) — so kind:'material'
          // is used rather than the generic 'item' (which lands in inventory.items and is invisible to progression/equipment/auction → orphaned).
          ...Object.entries(items).filter(([, n]) => n > 0).map(([id, count]) => ({ kind: 'material' as const, id, count })),
          ...base.skins.map((id) => ({ kind: 'skin' as const, id })),
          ...(base.coins ? [{ kind: 'coins' as const, count: base.coins }] : []),
        ];
        for (const acct of accounts) {
          void this.core.mail.sendSystemMail(acct, dispatchKey, {
            subject: 'slg.settle.subject',
            body: `slg.settle.body|rank=${r.rank}|tier=${tier}|nations=${r.nationCount}`,
            attachments,
            expireDays: 30,
          });
          if (base.titleId) {
            void this.core.meta.grantTitle(acct, base.titleId).catch((e) =>
              console.error('[worldsvc] settle grantTitle failed', { acct, titleId: base.titleId, err: (e as Error).message }),
            );
          }
        }
      }

      // Extra settlement reward for battle-pass holders (S8-8 extra-settlement-reward tier): sent once per holder regardless of tier.
      const bpPlayers = await cols.playerWorld
        .find({ worldId, hasBattlePass: true }, { projection: { accountId: 1 } })
        .toArray();
      const bpDispatchKey = `slg-settle-bp:${worldId}:s${w.season}`;
      const bpAttachments = Object.entries(BP_SETTLE_EXTRA.items)
        .filter(([, n]) => n > 0)
        .map(([id, count]) => ({ kind: 'material' as const, id, count }));
      for (const pw of bpPlayers) {
        void this.core.mail.sendSystemMail(pw.accountId, bpDispatchKey, {
          subject: 'slg.settle.bp.subject',
          body: 'slg.settle.bp.body',
          attachments: bpAttachments,
          expireDays: 30,
        });
      }
    }

    return ranking;
  }

  /**
   * Season reset (wipe map state; preserve progression + cosmetics + rank, §2.3 SLG4 / §17.6).
   * Guard (C5): only settling/resetting may reset (settle must persist seasonResults first; prevents skipping settlement and losing history).
   * State machine: settling → resetting (intermediate) → wipe → open; a crash mid-resetting resumes from resetting on retry (idempotent).
   * Data wipe is batched (tens of thousands of records, yields the event loop); family membership is preserved but season state is zeroed; engineVersion re-pinned to current process version (C7).
   */
  async resetSeason(worldId: string): Promise<{ deleted: Record<string, number> }> {
    const { cols, now } = this.core.deps;
    // ① Status guard + intermediate state (idempotent: already resetting → continue directly).
    const w = await cols.worlds.findOneAndUpdate(
      { _id: worldId, status: { $in: ['settling', 'resetting'] } },
      { $set: { status: 'resetting' as const } },
    );
    if (!w) throw new SlgError('WORLD_CLOSED', 'Must settle before resetting');

    // ② Snapshot which families were active in this world (needed to zero their SLG state on socialsvc below — playerWorld is about to be wiped).
    const activeFamilyIds = [...new Set(
      (await cols.playerWorld.find({ worldId, familyId: { $exists: true } }).project<{ familyId: string }>({ familyId: 1 }).toArray())
        .map((p) => p.familyId),
    )];

    // ③ Batch-delete large collections (tiles/marches/playerWorld/sieges may have tens of thousands of records).
    const deleted: Record<string, number> = {};
    for (const c of ['tiles', 'marches', 'playerWorld', 'nations', 'sieges', 'sects', 'sectMessages'] as const) {
      deleted[c] = await deleteInBatches(cols[c] as never, { worldId }, RESET_DELETE_BATCH);
    }

    // ④ Zero season state (territory/prosperity/activity reset to 0 + clear sect affiliation) for families that played in this world.
    // Family identity/membership itself persists across seasons on socialsvc — only the SLG mirror is reset here.
    await Promise.all(activeFamilyIds.map((fid) => this.core.socialsvc.resetSlgState(fid)));

    // ⑤ Reopen (re-pin engineVersion to the current process version, C7).
    await cols.worlds.updateOne(
      { _id: worldId },
      { $set: { status: 'open' as const, population: 0, resetAt: now(), engineVersion: ENGINE_VERSION }, $inc: { rev: 1 } },
    );
    // Re-initialize capital documents
    await this.core.initNations(worldId);
    return { deleted };
  }

  /** List all shard world operational summaries (G7/§17.7 admin backend, internal endpoint). */
  async listWorlds(): Promise<Array<{
    worldId: string; season: number; shard: number; status: string;
    population: number; capacity: number; openAt: number; resetAt?: number; engineVersion?: number;
  }>> {
    const worlds = await this.core.deps.cols.worlds.find({}).sort({ season: -1, shard: 1 }).toArray();
    return worlds.map((w) => ({
      worldId: w._id,
      season: w.season,
      shard: w.shard,
      status: w.status,
      population: w.population,
      capacity: w.capacity,
      openAt: w.openAt,
      ...(w.resetAt ? { resetAt: w.resetAt } : {}),
      ...(w.engineVersion != null ? { engineVersion: w.engineVersion } : {}),
    }));
  }

  /** Close a world (archive at end of season). */
  async closeSeason(worldId: string): Promise<void> {
    await this.core.deps.cols.worlds.updateOne(
      { _id: worldId },
      { $set: { status: 'closed' as const }, $inc: { rev: 1 } },
    );
  }

  // ── G6 multi-shard runtime scheduling (§20) ────────────────────────────

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
      await this.openSeason(wid, season, i, capacity);
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
    await this.openSeason(wid, season, nextIdx, capacity);
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
