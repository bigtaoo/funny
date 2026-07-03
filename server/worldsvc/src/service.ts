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
import type { PlayerWorldView, WorldTileView } from './worldTypes';
import type { SLG_SHOP_ITEMS } from '@nw/shared';

// Re-export the response/deps types so existing `import { ... } from './service'` keeps working.
export * from './worldTypes';
export { WorldCore } from './core';

export class WorldService extends WorldCore {
  private readonly shop = new ShopService(this);
  private readonly territory = new TerritoryService(this);
  private readonly season = new SeasonService(this, this.territory);

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
