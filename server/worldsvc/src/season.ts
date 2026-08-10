// worldsvc season / multi-shard domain facade (S8-7 + G6 §20). Peeled out of the WorldService god-class
// (2026-07-03). Depends on WorldCore (shared state + nations) and, for joinSeason capital placement, the
// TerritoryService peer.
//
// Composed of two independent domain classes (2026-08-10 split, 独立类+组合 form, friendService.ts's
// sibling — the original single 638-line class had exactly one cross-domain call: the shard domain's
// allocateNextSeason/resolveShardForJoin call openSeason on new-shard overflow, which is otherwise a
// pure season-management operation — so it splits into: season lifecycle management (open/settle/reset/
// close/list) and G6 multi-shard scheduling (allocate/join/patrol), with the shard side taking the
// management side as a constructor-injected peer for that one call. See season/management.ts /
// season/shard.ts. This class is a thin delegating facade so external callers (service.ts, this
// package's own tests) keep importing `SeasonService` from this one path with an unchanged public API
// and behavior.
import { WorldCore } from './core';
import type { TerritoryService } from './territory';
import type { PlayerWorldView } from './worldTypes';
import { SeasonManagementService } from './season/management';
import { SeasonShardService } from './season/shard';

export class SeasonService {
  private readonly management: SeasonManagementService;
  private readonly shard: SeasonShardService;

  constructor(
    private readonly core: WorldCore,
    private readonly territory: TerritoryService,
  ) {
    this.management = new SeasonManagementService(core);
    this.shard = new SeasonShardService(core, territory, this.management);
  }

  // --- S8-7: season lifecycle management (season/management.ts) ---
  getSeason(worldId: string): ReturnType<SeasonManagementService['getSeason']> {
    return this.management.getSeason(worldId);
  }
  getActiveSeasonNo(): Promise<number> {
    return this.management.getActiveSeasonNo();
  }
  openSeason(worldId: string, season: number, shard: number, capacity: number): Promise<void> {
    return this.management.openSeason(worldId, season, shard, capacity);
  }
  settleSeason(worldId: string): ReturnType<SeasonManagementService['settleSeason']> {
    return this.management.settleSeason(worldId);
  }
  processDueSeasonSettlement(): Promise<string[]> {
    return this.management.processDueSeasonSettlement();
  }
  resetSeason(worldId: string): ReturnType<SeasonManagementService['resetSeason']> {
    return this.management.resetSeason(worldId);
  }
  listWorlds(): ReturnType<SeasonManagementService['listWorlds']> {
    return this.management.listWorlds();
  }
  closeSeason(worldId: string): Promise<void> {
    return this.management.closeSeason(worldId);
  }

  // --- G6 multi-shard runtime scheduling, §20 (season/shard.ts) ---
  allocateNextSeason(season: number, capacity?: number): ReturnType<SeasonShardService['allocateNextSeason']> {
    return this.shard.allocateNextSeason(season, capacity);
  }
  resolveSeasonShard(season: number, accountId: string): Promise<{ worldId: string }> {
    return this.shard.resolveSeasonShard(season, accountId);
  }
  joinSeason(season: number, accountId: string): Promise<PlayerWorldView> {
    return this.shard.joinSeason(season, accountId);
  }
  patrolShardIsolation(): ReturnType<SeasonShardService['patrolShardIsolation']> {
    return this.shard.patrolShardIsolation();
  }
}
