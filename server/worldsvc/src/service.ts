// worldsvc business layer — public facade (WorldService).
//
// The implementation was split out of a single 3800-line class by domain
// (god-class refactor, 2026-07-03). No behavior change: WorldService re-exposes the
// exact same public API, so all callers (httpApi / index / scheduler / e2e tests)
// import `{ WorldService }` from here unchanged.
//
//   worldTypes.ts  view/response interfaces + WorldServiceDeps
//   core.ts        WorldCore — shared state, map reads, vision, spawn,
//                  push/schedule infra, settle/yield, nations
//
// Domain method groups (combat / territory / city / season / shop) are peeled off
// WorldCore into their own files incrementally; WorldService composes them while
// inheriting the shared core surface.
import { WorldCore } from './core';
import { ShopService } from './shop';
import { TerritoryService } from './territory';
import { SeasonService } from './season';
import { CityService } from './city';
import { CombatService } from './combat';
import type { PlayerWorldView, WorldTileView, MarchView, OccupationView } from './worldTypes';
import type { SLG_SHOP_ITEMS, BuildingKey, MarchKind } from '@nw/shared';
import type { TeamTemplate } from './db';

// Re-export the response/deps types so existing `import { ... } from './service'` keeps working.
export * from './worldTypes';
export { WorldCore } from './core';

export class WorldService extends WorldCore {
  private readonly shop = new ShopService(this);
  private readonly territory = new TerritoryService(this);
  private readonly season = new SeasonService(this, this.territory);
  private readonly city = new CityService(this);
  private readonly combat = new CombatService(this);

  // ── marches / siege / defense / replay (combat.ts) ───────────
  startMarch(
    worldId: string, accountId: string,
    fromX: number, fromY: number, toX: number, toY: number,
    kind: MarchKind, troops: number, teamId?: string,
  ): Promise<MarchView> {
    return this.combat.startMarch(worldId, accountId, fromX, fromY, toX, toY, kind, troops, teamId);
  }
  recallMarch(worldId: string, accountId: string, mid: string): Promise<MarchView> {
    return this.combat.recallMarch(worldId, accountId, mid);
  }
  cancelOccupation(worldId: string, accountId: string, teamId: string): Promise<void> {
    return this.combat.cancelOccupation(worldId, accountId, teamId);
  }
  getMarches(worldId: string, accountId: string): Promise<MarchView[]> {
    return this.combat.getMarches(worldId, accountId);
  }
  getOccupations(worldId: string, accountId: string): Promise<OccupationView[]> {
    return this.combat.getOccupations(worldId, accountId);
  }
  processDueArrivals(nowMs?: number): Promise<number> {
    return this.combat.processDueArrivals(nowMs);
  }
  processDueSiegeDamage(nowMs?: number): Promise<number> {
    return this.combat.processDueSiegeDamage(nowMs);
  }
  // ADR-037 (§5.4): occupation-hold settlement.
  processDueOccupations(nowMs?: number): Promise<number> {
    return this.combat.processDueOccupations(nowMs);
  }
  setDefense(worldId: string, accountId: string, tileKey: string, defenseConfig: Record<string, unknown>): Promise<void> {
    return this.combat.setDefense(worldId, accountId, tileKey, defenseConfig);
  }
  getDefense(worldId: string, accountId: string, tileKey: string): Promise<Record<string, unknown> | null> {
    return this.combat.getDefense(worldId, accountId, tileKey);
  }
  getSiegeReplay(worldId: string, accountId: string, sid: string): ReturnType<CombatService['getSiegeReplay']> {
    return this.combat.getSiegeReplay(worldId, accountId, sid);
  }

  // ── home city: training / buildings / teams / cards (city.ts) ─
  trainTroops(worldId: string, accountId: string, qty: number): Promise<PlayerWorldView> {
    return this.city.trainTroops(worldId, accountId, qty);
  }
  speedupTraining(worldId: string, accountId: string, coins: number): Promise<PlayerWorldView> {
    return this.city.speedupTraining(worldId, accountId, coins);
  }
  processCompletedTraining(nowMs?: number): Promise<number> {
    return this.city.processCompletedTraining(nowMs);
  }
  upgradeBuilding(worldId: string, accountId: string, key: BuildingKey): Promise<PlayerWorldView> {
    return this.city.upgradeBuilding(worldId, accountId, key);
  }
  speedupBuild(worldId: string, accountId: string, coins: number): Promise<PlayerWorldView> {
    return this.city.speedupBuild(worldId, accountId, coins);
  }
  processCompletedBuilds(nowMs?: number): Promise<number> {
    return this.city.processCompletedBuilds(nowMs);
  }
  getTeams(worldId: string, accountId: string): Promise<TeamTemplate[]> {
    return this.city.getTeams(worldId, accountId);
  }
  setTeams(worldId: string, accountId: string, teams: TeamTemplate[]): Promise<void> {
    return this.city.setTeams(worldId, accountId, teams);
  }
  distributeTroops(worldId: string, accountId: string, allocations: Record<string, number>): Promise<void> {
    return this.city.distributeTroops(worldId, accountId, allocations);
  }
  recoverCard(worldId: string, accountId: string, cardInstanceId: string): Promise<void> {
    return this.city.recoverCard(worldId, accountId, cardInstanceId);
  }

  // ── season / multi-shard (season.ts) ─────────────────────────
  getSeason(worldId: string): ReturnType<SeasonService['getSeason']> {
    return this.season.getSeason(worldId);
  }
  getActiveSeasonNo(): Promise<number> {
    return this.season.getActiveSeasonNo();
  }
  openSeason(worldId: string, season: number, shard: number, capacity: number): Promise<void> {
    return this.season.openSeason(worldId, season, shard, capacity);
  }
  settleSeason(worldId: string): ReturnType<SeasonService['settleSeason']> {
    return this.season.settleSeason(worldId);
  }
  resetSeason(worldId: string): Promise<{ deleted: Record<string, number> }> {
    return this.season.resetSeason(worldId);
  }
  listWorlds(): ReturnType<SeasonService['listWorlds']> {
    return this.season.listWorlds();
  }
  closeSeason(worldId: string): Promise<void> {
    return this.season.closeSeason(worldId);
  }
  allocateNextSeason(season: number, capacity?: number): ReturnType<SeasonService['allocateNextSeason']> {
    return this.season.allocateNextSeason(season, capacity);
  }
  resolveSeasonShard(season: number, accountId: string): Promise<{ worldId: string }> {
    return this.season.resolveSeasonShard(season, accountId);
  }
  joinSeason(season: number, accountId: string): Promise<PlayerWorldView> {
    return this.season.joinSeason(season, accountId);
  }
  patrolShardIsolation(): ReturnType<SeasonService['patrolShardIsolation']> {
    return this.season.patrolShardIsolation();
  }

  // ── territory (territory.ts) ─────────────────────────────────
  joinWorld(worldId: string, accountId: string, x?: number, y?: number): Promise<PlayerWorldView> {
    return this.territory.joinWorld(worldId, accountId, x, y);
  }
  occupyTile(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    return this.territory.occupyTile(worldId, accountId, x, y);
  }
  abandonTile(worldId: string, accountId: string, x: number, y: number): Promise<PlayerWorldView> {
    return this.territory.abandonTile(worldId, accountId, x, y);
  }
  listTerritories(worldId: string, accountId: string): Promise<WorldTileView[]> {
    return this.territory.listTerritories(worldId, accountId);
  }
  relocateBase(worldId: string, accountId: string, x: number, y: number): Promise<PlayerWorldView> {
    return this.territory.relocateBase(worldId, accountId, x, y);
  }
  buildWatchtower(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    return this.territory.buildWatchtower(worldId, accountId, x, y);
  }

  // ── SLG shop (shop.ts) ──────────────────────────────────────
  buySlgShopItem(worldId: string, accountId: string, itemId: string): Promise<PlayerWorldView> {
    return this.shop.buySlgShopItem(worldId, accountId, itemId);
  }
  getSlgShopItems(): typeof SLG_SHOP_ITEMS {
    return this.shop.getSlgShopItems();
  }
}
