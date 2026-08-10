// worldsvc season domain: season lifecycle management (S8-7 §17) — open/settle/reset/close + listing.
// Split out of season.ts (2026-08-10, 独立类+组合 form, friendService.ts's sibling — see season.ts's
// facade comment for why). Depends only on WorldCore. No behavior change.
import {
  SlgError,
  settleTier,
  SETTLE_REWARDS,
  CENTER_CAPITAL_IDX,
  CENTER_CAPITAL_MULT,
  BP_SETTLE_EXTRA,
  RESET_DELETE_BATCH,
  SLG_SEASON_DURATION_MS,
  slgTitleId,
  runBounded,
} from '@nw/shared';

/** Fan-out concurrency cap for per-account settlement side effects (mail/title grants). See boundedConcurrency.ts. */
const SETTLE_FANOUT_CONCURRENCY = 8;
import { ENGINE_VERSION } from '@nw/engine';
import { WorldCore, deleteInBatches } from '../core';
import { aggregateSectProsperity } from '../prosperity';

export class SeasonManagementService {
  constructor(private readonly core: WorldCore) {}

  /** Get world/season info (GET /world/season). */
  async getSeason(worldId: string): Promise<{
    worldId: string;
    season: number;
    shard: number;
    status: string;
    openAt: number;
    resetAt?: number;
    settleAt?: number;
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
      ...(w.settleAt ? { settleAt: w.settleAt } : {}),
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
   *
   * season/shard are immutable per worldId once created (worldDocs.ts's `_id: "s{season}-{shard}"` convention;
   * seasonResults/slgTitleId/march-and-tile worldId-prefix checks all assume it). Reopening an existing worldId
   * with a *different* season/shard used to silently no-op on those fields — `$setOnInsert` only fires on a
   * real insert, so a reopen against an existing _id quietly kept the old season/shard while still returning
   * success (2026-08-10 incident: ops "Open a new world" against an already-open worldId with a bumped Season
   * field looked like it worked but never advanced the active season — see SLG_DESIGN_LOG.md §17.15). Guard it
   * explicitly so a mismatched reopen fails loudly instead of stranding players on the old map.
   */
  async openSeason(
    worldId: string,
    season: number,
    shard: number,
    capacity: number,
  ): Promise<void> {
    const { cols, now } = this.core.deps;
    const existing = await cols.worlds.findOne({ _id: worldId }, { projection: { season: 1, shard: 1 } });
    if (existing && (existing.season !== season || existing.shard !== shard)) {
      throw new SlgError(
        'BAD_REQUEST',
        `worldId ${worldId} is already pinned to season ${existing.season}/shard ${existing.shard}; cannot reopen it as season ${season}/shard ${shard}. Allocate a new worldId for a new season instead of reusing this one.`,
      );
    }
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
        // settleAt (§17.14) is set here too so a reopened world (same _id) gets a fresh season clock; auto-settle (processDueSeasonSettlement) fires once now() ≥ settleAt.
        $set: { status: 'open' as const, engineVersion: ENGINE_VERSION, settleAt: now() + SLG_SEASON_DURATION_MS },
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
        // Bounded fan-out (comm-audit-internal-2026-07-28 P0-5): a large region can have thousands
        // of accounts in one ranking entity (e.g. the winning sect) — firing all their mail+title
        // grants as unbounded concurrent requests is the exact connection-pool-wedging burst
        // internalFetch.ts's header comment warns about, just at 1000x the scale that caused it.
        await runBounded(accounts, SETTLE_FANOUT_CONCURRENCY, async (acct) => {
          await this.core.mail.sendSystemMail(acct, dispatchKey, {
            subject: 'slg.settle.subject',
            body: `slg.settle.body|rank=${r.rank}|tier=${tier}|nations=${r.nationCount}`,
            attachments,
            expireDays: 30,
          }).catch((e) => console.error('[worldsvc] settle sendSystemMail failed', { acct, dispatchKey, err: (e as Error).message }));
          if (base.titleKey) {
            // Stamp the season onto the title id (slg.s{N}.{key}) so it follows the naming convention → correct weight,
            // source, and i18n on the client (TITLE_DESIGN §3). grantTitle is idempotent ($addToSet) on the meta side.
            const titleId = slgTitleId(w.season, base.titleKey);
            await this.core.meta.grantTitle(acct, titleId).catch((e) =>
              console.error('[worldsvc] settle grantTitle failed', { acct, titleId, err: (e as Error).message }),
            );
          }
        });
      }

      // Extra settlement reward for battle-pass holders (S8-8 extra-settlement-reward tier): sent once per holder regardless of tier.
      const bpPlayers = await cols.playerWorld
        .find({ worldId, hasBattlePass: true }, { projection: { accountId: 1 } })
        .toArray();
      const bpDispatchKey = `slg-settle-bp:${worldId}:s${w.season}`;
      const bpAttachments = Object.entries(BP_SETTLE_EXTRA.items)
        .filter(([, n]) => n > 0)
        .map(([id, count]) => ({ kind: 'material' as const, id, count }));
      await runBounded(bpPlayers, SETTLE_FANOUT_CONCURRENCY, async (pw) => {
        await this.core.mail.sendSystemMail(pw.accountId, bpDispatchKey, {
          subject: 'slg.settle.bp.subject',
          body: 'slg.settle.bp.body',
          attachments: bpAttachments,
          expireDays: 30,
        }).catch((e) => console.error('[worldsvc] settle bp sendSystemMail failed', { accountId: pw.accountId, err: (e as Error).message }));
      });
    }

    return ranking;
  }

  /**
   * Scheduler hook (§17.14): auto-settle every active world whose season clock has elapsed (settleAt ≤ now).
   * Only transitions active → settling (settleSeason CAS-guards + is idempotent); reset/close stay admin-driven
   * (destructive map wipe needs ops judgment on timing, consistent with G6 shard ops). Best-effort per world:
   * one world's failure does not block the others. Returns the worldIds that were settled this pass.
   */
  async processDueSeasonSettlement(): Promise<string[]> {
    const { cols, now } = this.core.deps;
    const due = await cols.worlds
      .find({ status: 'active', settleAt: { $lte: now() } }, { projection: { _id: 1 } })
      .toArray();
    const settled: string[] = [];
    for (const w of due) {
      try {
        await this.settleSeason(w._id);
        settled.push(w._id);
        console.log('[worldsvc] auto-settled season', { worldId: w._id });
      } catch (e) {
        // WORLD_CLOSED (raced to settling/closed by another actor) is benign; log others.
        console.error('[worldsvc] auto-settle failed', { worldId: w._id, err: (e as Error).message });
      }
    }
    return settled;
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
    // siegeDamage/occupations/stationed were missing here until 2026-07-27 (audit finding): each holds
    // worldId-scoped rows tied to tiles/marches this loop already wipes, and a leftover `stationed` row
    // in particular can trip its {worldId,ownerId,teamId} unique index for a returning player next season.
    // mapBaselines is handled separately by the caller (httpApi's /admin/world/reset), which re-clones it
    // from the active template exactly like /admin/world/open does — deleting it here without a re-clone
    // would silently replace a hand-authored template layout with raw proceduralTile generation.
    const deleted: Record<string, number> = {};
    for (const c of [
      'tiles', 'marches', 'playerWorld', 'nations', 'sieges', 'sects', 'sectMessages',
      'siegeDamage', 'occupations', 'stationed',
    ] as const) {
      deleted[c] = await deleteInBatches(cols[c] as never, { worldId }, RESET_DELETE_BATCH);
    }
    // ADR-051 Redis spatial indexes (occ/cover) are worldId-scoped like the Mongo collections just wiped
    // above but live outside Mongo — clear them too so a recycled worldId doesn't inherit stale entries
    // (2026-07-29 audit fix; see WorldCorePush.clearSpatialIndexes).
    await this.core.clearSpatialIndexes(worldId);

    // ④ Zero season state (territory/prosperity/activity reset to 0 + clear sect affiliation) for families that played in this world.
    // Family identity/membership itself persists across seasons on socialsvc — only the SLG mirror is reset here.
    // Bounded (comm-audit-internal-2026-07-28 P0-5): a full-population region can have hundreds of
    // families; unbounded Promise.all fired them all as concurrent socialsvc requests at once.
    await runBounded(activeFamilyIds, SETTLE_FANOUT_CONCURRENCY, (fid) =>
      this.core.socialsvc.resetSlgState(fid).catch((e) =>
        console.error('[worldsvc] resetSlgState failed', { familyId: fid, err: (e as Error).message }),
      ),
    );

    // ⑤ Reopen (re-pin engineVersion to the current process version, C7; fresh settleAt clock for the recycled world, §17.14).
    // Re-stamp mapW/mapH from the current process config too: a reset wipes every tile/nation and re-inits capitals
    // (step ⑥) at deps.mapW/mapH scale, so a recycled world must adopt the current map dimensions or the stored
    // dims (frozen at first openSeason via $setOnInsert) would drift from the coordinates everything else now uses —
    // e.g. after enlarging SLG_MAP_W/H, a reset is the ops path that makes an existing region actually adopt the new size.
    await cols.worlds.updateOne(
      { _id: worldId },
      { $set: { status: 'open' as const, population: 0, resetAt: now(), engineVersion: ENGINE_VERSION, mapW: this.core.deps.mapW, mapH: this.core.deps.mapH, settleAt: now() + SLG_SEASON_DURATION_MS }, $inc: { rev: 1 } },
    );
    // Re-initialize capital documents
    await this.core.initNations(worldId);
    return { deleted };
  }

  /** List all shard world operational summaries (G7/§17.7 admin backend, internal endpoint). */
  async listWorlds(): Promise<Array<{
    worldId: string; season: number; shard: number; status: string;
    population: number; capacity: number; openAt: number; resetAt?: number; settleAt?: number; engineVersion?: number;
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
      ...(w.settleAt ? { settleAt: w.settleAt } : {}),
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
}
