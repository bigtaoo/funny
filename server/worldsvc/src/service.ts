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
// WorldCore into their own files incrementally; WorldService composes them.
//
// 2026-08-11 (独立类+组合 re-audit, claudedocs/server.md's "拆分形态的优先级"): this was the last
// `extends` in server/ outside of `class XxxError extends Error` — `WorldService extends WorldCore`
// bought nothing (WorldCore was already itself composition-based, see core.ts's header; this was one
// more level of inheritance over an already-composed class, purely to reuse its forwarded surface).
// Converted to holding `core: WorldCore` by composition, same as every sibling domain class in this
// file already does. External call sites (httpApi/index/scheduler + this package's own e2e tests) only
// ever reach 12 of WorldCore's ~46 forwarded methods directly on the service instance (grep-verified
// against test/*.test.ts + httpApi/**): getMe/getTile/getMap/getMapSparse/setNationName/
// addCover/removeCover/initNations/getNations/capitalsFor/pickSpawnTile — those are
// re-forwarded below, one line each, same shape as the domain-class forwards later in this file.
// `deps`/`coordX`/`coordY` are also forwarded (used internally by `enterWorld` below).
import { WorldCore } from './core';
import { ShopService } from './shop';
import { TerritoryService } from './territory';
import { SeasonService } from './season';
import { CityService } from './city';
import { CombatService } from './combat';
import { TransferService, type ShardSummary } from './transfer';
import type { PlayerWorldView, WorldTileView, MarchView, OccupationView, StationedView, WorldMapView, WorldMapSparseView, WorldServiceDeps } from './worldTypes';
import type { SLG_SHOP_ITEMS, BuildingKey, MarchKind, ChatRegion } from '@nw/shared';
import type { TeamTemplate, NationDoc } from './db';

// Re-export the response/deps types so existing `import { ... } from './service'` keeps working.
export * from './worldTypes';
export { WorldCore } from './core';

export class WorldService {
  private readonly core: WorldCore;
  private readonly shop: ShopService;
  private readonly territory: TerritoryService;
  private readonly season: SeasonService;
  private readonly city: CityService;
  private readonly combat: CombatService;
  private readonly transfer: TransferService;

  constructor(deps: WorldServiceDeps) {
    // Field initializers run before this body under ES2022 class-fields semantics (useDefineForClassFields)
    // — `this.core` must be assigned first, in the body, or every sibling below would see it as
    // undefined (TS2729, same trap noted in claudedocs/server.md's "2026-08-11 metaserver ctx-bind
    // cleanup" §base-field-initializer note).
    this.core = new WorldCore(deps);
    this.shop = new ShopService(this.core);
    this.territory = new TerritoryService(this.core);
    this.season = new SeasonService(this.core, this.territory);
    this.city = new CityService(this.core);
    this.combat = new CombatService(this.core);
    this.transfer = new TransferService(this.core, this.territory);
  }

  // ── WorldCore surface reached directly by external callers (httpApi/index/scheduler/e2e tests) ─
  get deps(): WorldServiceDeps { return this.core.deps; }
  coordX(tid: string): number { return this.core.coordX(tid); }
  coordY(tid: string): number { return this.core.coordY(tid); }
  capitalsFor(worldId: string): readonly [number, number][] { return this.core.capitalsFor(worldId); }
  getMe(worldId: string, accountId: string): Promise<PlayerWorldView> { return this.core.getMe(worldId, accountId); }
  getCities(worldId: string): ReturnType<WorldCore['getCities']> { return this.core.getCities(worldId); }
  /** ADR-074 P1: the city node list enriched with live siege state (durability/owning sect/protection). */
  getCityViews(worldId: string): ReturnType<WorldCore['getCityViews']> { return this.core.getCityViews(worldId); }
  /** ADR-074 P1: create the world's city documents (season open / world reset; idempotent). */
  initCities(worldId: string): Promise<void> { return this.core.initCities(worldId); }
  /** ADR-074 P1: the city whose footprint covers (x,y), durability brought up to date, or null. */
  cityAt(worldId: string, x: number, y: number): ReturnType<WorldCore['cityAt']> { return this.core.cityAt(worldId, x, y); }
  getTile(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    return this.core.getTile(worldId, accountId, x, y);
  }
  getMap(...args: Parameters<WorldCore['getMap']>): Promise<WorldMapView> { return this.core.getMap(...args); }
  getMapSparse(...args: Parameters<WorldCore['getMapSparse']>): Promise<WorldMapSparseView> {
    return this.core.getMapSparse(...args);
  }
  getNations(worldId: string): Promise<NationDoc[]> { return this.core.getNations(worldId); }
  initNations(worldId: string): Promise<void> { return this.core.initNations(worldId); }
  setNationName(worldId: string, accountId: string, capitalIdx: number, name: string, region?: ChatRegion): Promise<void> {
    return this.core.setNationName(worldId, accountId, capitalIdx, name, region);
  }
  addCover(...args: Parameters<WorldCore['addCover']>): ReturnType<WorldCore['addCover']> { return this.core.addCover(...args); }
  removeCover(...args: Parameters<WorldCore['removeCover']>): ReturnType<WorldCore['removeCover']> {
    return this.core.removeCover(...args);
  }
  pickSpawnTile(...args: Parameters<WorldCore['pickSpawnTile']>): ReturnType<WorldCore['pickSpawnTile']> {
    return this.core.pickSpawnTile(...args);
  }

  // ── marches / siege / defense / replay (combat.ts) ───────────
  startMarch(
    worldId: string, accountId: string,
    fromX: number, fromY: number, toX: number, toY: number,
    kind: MarchKind, troops: number, teamId?: string, stationMode?: 'idle' | 'garrison',
  ): Promise<MarchView> {
    return this.combat.startMarch(worldId, accountId, fromX, fromY, toX, toY, kind, troops, teamId, stationMode);
  }
  recallMarch(worldId: string, accountId: string, mid: string): Promise<MarchView> {
    return this.combat.recallMarch(worldId, accountId, mid);
  }
  instantReturnMarch(worldId: string, accountId: string, mid: string, clientPlatform?: string): Promise<PlayerWorldView> {
    return this.combat.instantReturnMarch(worldId, accountId, mid, clientPlatform);
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
  getStationed(worldId: string, accountId: string): Promise<StationedView[]> {
    return this.combat.getStationed(worldId, accountId);
  }
  recallStationed(worldId: string, accountId: string, teamId: string): Promise<MarchView | Record<string, never>> {
    return this.combat.recallStationed(worldId, accountId, teamId);
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
  listSieges(worldId: string, accountId: string, limit?: number): ReturnType<CombatService['listSieges']> {
    return this.combat.listSieges(worldId, accountId, limit);
  }

  // ── home city: training / buildings / teams / cards (city.ts) ─
  trainTroops(worldId: string, accountId: string, qty: number): Promise<PlayerWorldView> {
    return this.city.trainTroops(worldId, accountId, qty);
  }
  speedupTraining(worldId: string, accountId: string, coins: number, clientPlatform?: string): Promise<PlayerWorldView> {
    return this.city.speedupTraining(worldId, accountId, coins, clientPlatform);
  }
  processCompletedTraining(nowMs?: number): Promise<number> {
    return this.city.processCompletedTraining(nowMs);
  }
  upgradeBuilding(worldId: string, accountId: string, key: BuildingKey): Promise<PlayerWorldView> {
    return this.city.upgradeBuilding(worldId, accountId, key);
  }
  speedupBuild(worldId: string, accountId: string, coins: number, clientPlatform?: string): Promise<PlayerWorldView> {
    return this.city.speedupBuild(worldId, accountId, coins, clientPlatform);
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
  recoverCard(worldId: string, accountId: string, cardInstanceId: string, clientPlatform?: string): Promise<void> {
    return this.city.recoverCard(worldId, accountId, cardInstanceId, clientPlatform);
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
  processDueSeasonSettlement(): ReturnType<SeasonService['processDueSeasonSettlement']> {
    return this.season.processDueSeasonSettlement();
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

  // ── G6 mid-season shard transfer/merge (transfer.ts, §27) ─────
  listTransferTargets(fromWorldId: string): Promise<ShardSummary[]> {
    return this.transfer.listTransferTargets(fromWorldId);
  }
  transferShard(accountId: string, fromWorldId: string, toWorldId: string): Promise<PlayerWorldView> {
    return this.transfer.transferShard(accountId, fromWorldId, toWorldId);
  }
  mergeShard(sourceWorldId: string, targetWorldId: string): ReturnType<TransferService['mergeShard']> {
    return this.transfer.mergeShard(sourceWorldId, targetWorldId);
  }

  // ── territory (territory.ts) ─────────────────────────────────
  joinWorld(worldId: string, accountId: string, x?: number, y?: number): Promise<PlayerWorldView> {
    return this.territory.joinWorld(worldId, accountId, x, y);
  }

  /**
   * Aggregated SLG-entry fetch (P1-5, comm-audit-2026-07-27): resolves getMe+joinWorld first (so the
   * base tile is known before the map window is picked), then composes season/nations/map(or
   * mapSparse)/marches/occupations/stationed in parallel — the facade-level composition backing
   * `POST /world/enter`, which replaces the 9-request waterfall WorldMapNet.loadData() used to fire on
   * every world-map entry (the world-channel piece is a sibling service, composed by httpApi.ts).
   * `r` is the viewport radius the client already computes from its own canvas size (independent of
   * map center); `me.justJoined` replaces the client's own local wasJoined-diff (used to gate the
   * "this is your new base" welcome toast) since the pre-join intermediate state is no longer visible
   * to the client once getMe+joinWorld are resolved server-side.
   */
  async enterWorld(worldId: string, accountId: string, r: number, zoom: 1 | 2 | 3) {
    let me = await this.getMe(worldId, accountId);
    const wasJoined = me.joined;
    let joinSucceeded = false;
    try {
      me = await this.joinWorld(worldId, accountId);
      joinSucceeded = true;
    } catch { /* world full / no slot available — keep pre-join state, map entry still proceeds */ }
    const justJoined = !wasJoined && joinSucceeded;

    const cx = me.mainBaseTile ? this.coordX(me.mainBaseTile) : Math.floor(this.deps.mapW / 2);
    const cy = me.mainBaseTile ? this.coordY(me.mainBaseTile) : Math.floor(this.deps.mapH / 2);
    const lod = zoom === 3 ? 'thin' : 'mid';

    // `cities` (2026-08-19): the world's ~64 city siege-point nodes, cloned from its map template at
    // world-open. Sent here rather than from a route of its own because the city sprite layer needs it
    // exactly once per world-map entry — the same cadence as season/nations, and one fewer round-trip.
    // ADR-074 P1: each node now carries its live siege state too (owning sect, durability with lazy regen
    // already applied, protection window, per-sect siege log) — the same one-read-per-entry cadence, so the
    // map can draw a city's HP bar and its info panel without a second round-trip per city.
    const [season, nations, cities, map, mapSparse, marches, occupations, stationed] = await Promise.all([
      this.getSeason(worldId),
      this.getNations(worldId),
      this.getCityViews(worldId),
      zoom === 1 ? this.getMap(worldId, accountId, cx, cy, r) : Promise.resolve(undefined),
      zoom !== 1 ? this.getMapSparse(worldId, accountId, cx, cy, r, lod) : Promise.resolve(undefined),
      this.getMarches(worldId, accountId),
      this.getOccupations(worldId, accountId),
      this.getStationed(worldId, accountId),
    ]);

    return {
      season, nations, cities, marches, occupations, stationed,
      me: { ...me, justJoined },
      ...(map ? { map } : {}),
      ...(mapSparse ? { mapSparse } : {}),
    };
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
  relocateBase(worldId: string, accountId: string, x: number, y: number, clientPlatform?: string): Promise<PlayerWorldView> {
    return this.territory.relocateBase(worldId, accountId, x, y, clientPlatform);
  }
  buildWatchtower(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    return this.territory.buildWatchtower(worldId, accountId, x, y);
  }
  // ADR-051 (P5): player-built map structures (arrowTower / blocker).
  buildStructure(worldId: string, accountId: string, x: number, y: number, kind: 'arrowTower' | 'blocker'): Promise<WorldTileView> {
    return this.territory.buildStructure(worldId, accountId, x, y, kind);
  }
  demolishStructure(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    return this.territory.demolishStructure(worldId, accountId, x, y);
  }

  // ── SLG shop (shop.ts) ──────────────────────────────────────
  buySlgShopItem(worldId: string, accountId: string, itemId: string, clientPlatform?: string): Promise<PlayerWorldView> {
    return this.shop.buySlgShopItem(worldId, accountId, itemId, clientPlatform);
  }
  getSlgShopItems(): typeof SLG_SHOP_ITEMS {
    return this.shop.getSlgShopItems();
  }
}
