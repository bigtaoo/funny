// worldsvc business layer — WorldCore shared kernel (assembled).
//
// WorldCore was a single ~1070-line class, later split by concern across a 7-deep linear
// inheritance chain (kernel → yield → push → nation → spawn → vision → map, one file per layer
// under ./core/, 2026-07-03). 2026-08-11 (mixin-chain re-audit, claudedocs/server.md's "拆分形态的
//优先级" 形态②/独立类+组合): the chain bought nothing — the cross-layer call graph is a clean DAG
// (nation/spawn only read a couple of kernel primitives; vision reads kernel + push.pushTile; map
// reads kernel + yield.settle + vision's family/sect/ally lookups — see the per-file headers under
// ./core/ for the exact edges) — so it converts to composition, same shape as combatSiege.ts/
// AuctionService. Unlike those, WorldCore itself stays the thing EVERY external call site (47 files)
// reaches every method and field on directly — `core.deps`/`core.gateway`/`core.getMap(...)`/
// `core.settle(...)` etc. are called throughout worldsvc, not through a handful of narrow entry
// points — so WorldCore doubles as both the shared root (kernel fields + primitives, formerly
// `core/kernel.ts`'s `WorldCoreKernel`) AND the assembly shell forwarding every non-root layer's
// public methods, one line each (same `(...args) => sibling.method(...args)` shape as
// combatSiege.ts/Gateway.ts). WorldCore stays exported HERE so importers (`from './core'`) keep
// resolving to this file, not the directory; `WorldService extends WorldCore` (service.ts) is
// unaffected — a single level of inheritance over one composed class, not a chain.
//
//   (this file)     WorldCore       — kernel fields/primitives (was core/kernel.ts) + composition +
//                                     one-line forwards for every sibling below
//   core/yield.ts   YieldService    — settle / yieldRecord / recomputeYield
//   core/push.ts    PushService     — Redis schedule ZSETs + gateway push helpers
//   core/nation.ts  NationService   — nation init / founding / naming / lookup
//   core/spawn.ts   SpawnService    — spawn selection + 3×3 base footprint helpers (ADR-025)
//   core/vision.ts  VisionService   — family/sect membership, fog-of-war vision, observers
//   core/map.ts     MapService      — map / tile / getMe reads + tile→view mappers
//
// Standalone free functions & constants live in core/helpers.ts; they are re-exported here so
// existing `import { emptyResources, deleteInBatches, lootSummary, MARCHABLE_KINDS } from './core'`
// call sites keep working unchanged.
import { provinceCapitalPositions, worldSeed, type SlgShopPriceCache, type WordlistCache } from '@nw/shared';
import type { MarchDoc } from './db';
import { nullWorldGatewayClient, type WorldGatewayClient } from './gatewayClient';
import { nullWorldMetaClient, type WorldMetaClient } from './metaClient';
import { nullWorldCommercialClient, type WorldCommercialClient } from './commercialClient';
import { nullWorldMailClient, type WorldMailClient } from './mailClient';
import { nullWorldSocialsvcClient, type WorldSocialsvcClient } from './socialsvcClient';
import type { MarchView, WorldServiceDeps, WorldMapView, WorldMapSparseView, WorldTileView, PlayerWorldView } from './worldTypes';
import type { ResourceType, TileType } from '@nw/shared';
import type { NationDoc, PlayerWorldDoc, SiegeDoc, TileDoc } from './db';
import type { PlayerProfile } from './metaClient';
import type { ChatRegion } from '@nw/shared';
import { YieldService } from './core/yield';
import { PushService, type OccEntry, type CoverEntry } from './core/push';
import { NationService } from './core/nation';
import { CitySiegeService, type CityState } from './core/citySiege';
import { SpawnService } from './core/spawn';
import { VisionService } from './core/vision';
import { MapService } from './core/map';

export { emptyResources, deleteInBatches, lootSummary, MARCHABLE_KINDS } from './core/helpers';

/**
 * The full shared kernel: root fields/primitives + composed domain layers. Constructed as
 * `new WorldCore(deps)`; `WorldService extends WorldCore` inherits the whole forwarded surface.
 */
export class WorldCore {
  // ── kernel fields (was core/kernel.ts) ──────────────────────────
  readonly gateway: WorldGatewayClient;
  readonly meta: WorldMetaClient;
  readonly commercial: WorldCommercialClient;
  readonly mail: WorldMailClient;
  /** In-process monotonic sequence number — ensures marchIds do not collide when multiple marches depart within the same millisecond. */
  marchSeq = 0;
  /** In-process monotonic sequence number — ensures siegeIds do not collide when multiple sieges resolve within the same millisecond. */
  siegeSeq = 0;
  /** Cached province-capital coordinate list, keyed by worldId (ADR-034: capitals are now seed-derived, not fixed by map size alone). */
  private _capitalsByWorld = new Map<string, readonly [number, number][]>();

  readonly socialsvc: WorldSocialsvcClient;
  /** SLG shop price/effect override cache; undefined = always uses SLG_SHOP_ITEMS code defaults. */
  readonly shopPrices: SlgShopPriceCache | undefined;
  /** Content-moderation word list overlay cache; undefined = built-in REGION_WORDLISTS only. */
  readonly wordlists: WordlistCache | undefined;

  // ── composed domain layers ───────────────────────────────────────
  private readonly yieldSvc: YieldService;
  private readonly pushSvc: PushService;
  private readonly nationSvc: NationService;
  private readonly citySvc: CitySiegeService;
  private readonly spawnSvc: SpawnService;
  private readonly visionSvc: VisionService;
  private readonly mapSvc: MapService;

  constructor(readonly deps: WorldServiceDeps) {
    this.gateway = deps.gateway ?? nullWorldGatewayClient;
    this.meta = deps.meta ?? nullWorldMetaClient;
    this.commercial = deps.commercial ?? nullWorldCommercialClient;
    this.mail = deps.mail ?? nullWorldMailClient;
    this.socialsvc = deps.socialsvc ?? nullWorldSocialsvcClient;
    this.shopPrices = deps.shopPrices;
    this.wordlists = deps.wordlists;

    // Built after the kernel fields above so every sibling's `core: WorldCore` reference sees a
    // fully-initialized kernel surface the moment it's constructed (same ordering `WorldService`'s
    // own constructor already relies on for `new ShopService(this)` etc.).
    this.yieldSvc = new YieldService(this);
    this.pushSvc = new PushService(this);
    this.nationSvc = new NationService(this);
    this.citySvc = new CitySiegeService(this);
    this.spawnSvc = new SpawnService(this);
    this.visionSvc = new VisionService(this, this.pushSvc);
    this.mapSvc = new MapService(this, this.yieldSvc, this.visionSvc);
  }

  // ── kernel primitives (was core/kernel.ts) ───────────────────────

  /** Province-capital coordinates for a given world (ADR-034: seed-derived, so keyed per worldId rather than a single map-wide cache). */
  capitalsFor(worldId: string): readonly [number, number][] {
    let caps = this._capitalsByWorld.get(worldId);
    if (!caps) {
      caps = provinceCapitalPositions(this.deps.mapW, this.deps.mapH, worldSeed(worldId));
      this._capitalsByWorld.set(worldId, caps);
    }
    return caps;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.deps.mapW && y < this.deps.mapH;
  }

  // tileId = `{worldId}:{x}:{y}`; extract coordinates (worldId itself contains no ':', so take the last two segments).
  coordX(tid: string): number {
    const p = tid.split(':');
    return Number(p[p.length - 2]);
  }
  coordY(tid: string): number {
    const p = tid.split(':');
    return Number(p[p.length - 1]);
  }

  marchView(m: MarchDoc): MarchView {
    return {
      marchId: m._id,
      kind: m.kind,
      fromTile: m.fromTile,
      toTile: m.toTile,
      troops: m.troops,
      departAt: m.departAt,
      arriveAt: m.arriveAt,
      status: m.status,
      ...(m.teamId ? { teamId: m.teamId } : {}),
      ...(m.leaderUnitType ? { leaderUnitType: m.leaderUnitType } : {}),
    };
  }

  // ── yield (core/yield.ts) ─────────────────────────────────────────
  settle(doc: PlayerWorldDoc, now: number): Record<ResourceType, number> { return this.yieldSvc.settle(doc, now); }
  settleExpr(...args: Parameters<YieldService['settleExpr']>): ReturnType<YieldService['settleExpr']> { return this.yieldSvc.settleExpr(...args); }
  yieldRecord(tiles: { type: TileType; level: number; resType?: ResourceType }[]): Record<ResourceType, number> { return this.yieldSvc.yieldRecord(tiles); }
  recomputeYield(...args: Parameters<YieldService['recomputeYield']>): ReturnType<YieldService['recomputeYield']> { return this.yieldSvc.recomputeYield(...args); }

  // ── push (core/push.ts) ───────────────────────────────────────────
  setOccupancy(worldId: string, tile: string, occ: OccEntry): Promise<void> { return this.pushSvc.setOccupancy(worldId, tile, occ); }
  clearOccupancy(worldId: string, tile: string, id: string): Promise<void> { return this.pushSvc.clearOccupancy(worldId, tile, id); }
  getOccupancy(worldId: string, tile: string): Promise<OccEntry | null> { return this.pushSvc.getOccupancy(worldId, tile); }
  addCover(worldId: string, cx: number, cy: number, entry: CoverEntry): Promise<void> { return this.pushSvc.addCover(worldId, cx, cy, entry); }
  removeCover(worldId: string, cx: number, cy: number, sourceTile: string): Promise<void> { return this.pushSvc.removeCover(worldId, cx, cy, sourceTile); }
  getCover(worldId: string, tile: string): Promise<CoverEntry[]> { return this.pushSvc.getCover(worldId, tile); }
  clearSpatialIndexes(worldId: string): Promise<void> { return this.pushSvc.clearSpatialIndexes(worldId); }
  pushMarch(accountId: string, v: MarchView): Promise<void> { return this.pushSvc.pushMarch(accountId, v); }
  pushOccupationSettled(accountId: string, occ: { tile: string; dueAt: number; garrison: number }): Promise<void> { return this.pushSvc.pushOccupationSettled(accountId, occ); }
  pushTile(accountId: string, t: TileDoc, ownerProfile?: PlayerProfile | null): Promise<void> { return this.pushSvc.pushTile(accountId, t, ownerProfile); }
  pushSiege(accountId: string, s: SiegeDoc, lootSummaryStr: string): Promise<void> { return this.pushSvc.pushSiege(accountId, s, lootSummaryStr); }

  // ── nation (core/nation.ts) ───────────────────────────────────────
  initNations(worldId: string): Promise<void> { return this.nationSvc.initNations(worldId); }
  getNations(worldId: string): Promise<NationDoc[]> { return this.nationSvc.getNations(worldId); }
  setNationName(worldId: string, accountId: string, capitalIdx: number, name: string, region?: ChatRegion): Promise<void> {
    return this.nationSvc.setNationName(worldId, accountId, capitalIdx, name, region);
  }
  getNationAt(worldId: string, x: number, y: number): Promise<NationDoc | null> { return this.nationSvc.getNationAt(worldId, x, y); }

  // ── wild-city siege (core/citySiege.ts, ADR-074 P1) ───────────────
  initCities(worldId: string): Promise<void> { return this.citySvc.initCities(worldId); }
  getCityStates(worldId: string): Promise<CityState[]> { return this.citySvc.getCityStates(worldId); }
  getCity(worldId: string, nodeId: string): Promise<CityState | null> { return this.citySvc.getCity(worldId, nodeId); }
  cityAt(worldId: string, x: number, y: number): Promise<CityState | null> { return this.citySvc.cityAt(worldId, x, y); }
  requireSect(worldId: string, accountId: string): Promise<string> { return this.citySvc.requireSect(worldId, accountId); }
  getCityViews(worldId: string): ReturnType<CitySiegeService['getCityViews']> { return this.citySvc.getCityViews(worldId); }
  // P3 occupation payoff (§8)
  recomputeSectPayoff(worldId: string, sectId: string): ReturnType<CitySiegeService['recomputeSectPayoff']> { return this.citySvc.recomputeSectPayoff(worldId, sectId); }
  clearSectPayoffs(worldId: string): Promise<void> { return this.citySvc.clearSectPayoffs(worldId); }
  sectPayoff(sectId: string | undefined): ReturnType<CitySiegeService['sectPayoff']> { return this.citySvc.sectPayoff(sectId); }
  stationableCityAt(...args: Parameters<CitySiegeService['stationableCityAt']>): ReturnType<CitySiegeService['stationableCityAt']> { return this.citySvc.stationableCityAt(...args); }
  inOwnSectProvince(...args: Parameters<CitySiegeService['inOwnSectProvince']>): Promise<boolean> { return this.citySvc.inOwnSectProvince(...args); }

  // ── spawn (core/spawn.ts) ─────────────────────────────────────────
  pickRandomEmptyTile(...args: Parameters<SpawnService['pickRandomEmptyTile']>): ReturnType<SpawnService['pickRandomEmptyTile']> { return this.spawnSvc.pickRandomEmptyTile(...args); }
  pickSpawnTile(...args: Parameters<SpawnService['pickSpawnTile']>): ReturnType<SpawnService['pickSpawnTile']> { return this.spawnSvc.pickSpawnTile(...args); }
  baseTileDocs(...args: Parameters<SpawnService['baseTileDocs']>): ReturnType<SpawnService['baseTileDocs']> { return this.spawnSvc.baseTileDocs(...args); }
  footprintFree(...args: Parameters<SpawnService['footprintFree']>): ReturnType<SpawnService['footprintFree']> { return this.spawnSvc.footprintFree(...args); }
  footprintOwnedBy(...args: Parameters<SpawnService['footprintOwnedBy']>): ReturnType<SpawnService['footprintOwnedBy']> { return this.spawnSvc.footprintOwnedBy(...args); }
  isBaseIntact(worldId: string, accountId: string, mainBaseTile: string): Promise<boolean> { return this.spawnSvc.isBaseIntact(worldId, accountId, mainBaseTile); }
  purgePlayerWorld(worldId: string, accountId: string): Promise<void> { return this.spawnSvc.purgePlayerWorld(worldId, accountId); }

  // ── vision (core/vision.ts) ───────────────────────────────────────
  familyMemberIds(worldId: string, accountId: string): Promise<Set<string>> { return this.visionSvc.familyMemberIds(worldId, accountId); }
  friendlyAccountIds(worldId: string, accountId: string): Promise<Set<string>> { return this.visionSvc.friendlyAccountIds(worldId, accountId); }
  computeVisionSources(...args: Parameters<VisionService['computeVisionSources']>): ReturnType<VisionService['computeVisionSources']> { return this.visionSvc.computeVisionSources(...args); }
  visionObservers(...args: Parameters<VisionService['visionObservers']>): ReturnType<VisionService['visionObservers']> { return this.visionSvc.visionObservers(...args); }
  pushTileToObservers(t: TileDoc, exclude: ReadonlySet<string>): Promise<void> { return this.visionSvc.pushTileToObservers(t, exclude); }
  targetFootprintCells(tile: TileDoc | null | undefined, x: number, y: number): { x: number; y: number }[] { return this.visionSvc.targetFootprintCells(tile, x, y); }
  isConnectedToSectTerritory(...args: Parameters<VisionService['isConnectedToSectTerritory']>): ReturnType<VisionService['isConnectedToSectTerritory']> { return this.visionSvc.isConnectedToSectTerritory(...args); }
  sameFamily(worldId: string, a: string, b: string): Promise<boolean> { return this.visionSvc.sameFamily(worldId, a, b); }
  bumpFamilyActivity(worldId: string, familyId: string | undefined, delta: number): Promise<void> { return this.visionSvc.bumpFamilyActivity(worldId, familyId, delta); }

  // ── map (core/map.ts) ─────────────────────────────────────────────
  getMap(...args: Parameters<MapService['getMap']>): Promise<WorldMapView> { return this.mapSvc.getMap(...args); }
  getMapSparse(...args: Parameters<MapService['getMapSparse']>): Promise<WorldMapSparseView> { return this.mapSvc.getMapSparse(...args); }
  getTile(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> { return this.mapSvc.getTile(worldId, accountId, x, y); }
  getMe(worldId: string, accountId: string): Promise<PlayerWorldView> { return this.mapSvc.getMe(worldId, accountId); }
  getCities(worldId: string): ReturnType<MapService['getCities']> { return this.mapSvc.getCities(worldId); }
  tileDocView(...args: Parameters<MapService['tileDocView']>): WorldTileView { return this.mapSvc.tileDocView(...args); }
}
