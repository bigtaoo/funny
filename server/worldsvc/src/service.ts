// worldsvc business layer (S8-0 skeleton + S8-1 occupation).
// S8-0: map loading (procedural defaults + sparse DB override merge) + player state (lazy resource settlement).
// S8-1: enter world (build capital + protection shield), occupy tile (write TileDoc + update yieldRate + deduct garrison),
//        abandon tile (refund garrison + recompute yield). March (travel time) / siege are S8-2/S8-3; direct occupation takes effect immediately here.
import {
  proceduralTile,
  tileId,
  marchId,
  siegeId,
  playerWorldId,
  tileYield,
  resolveSiege,
  siegeSeedFromId,
  buildSiegeBattle,
  npcGarrison,
  strongholdGarrison,
  STRONGHOLD_LOOT_PER_LEVEL,
  strongholdMaterialLoot,
  findMarchPath,
  baseFootprintCells,
  baseFootprintInBounds,
  marchDurationFromPath,
  capitalPositions,
  capitalIdxAt,
  nearestCapitalIdx,
  SIEGE_LOOT_RATE,
  SWEEP_LOOT_PER_LEVEL,
  RESOURCE_CAP,
  RESOURCE_TYPES,
  TROOP_CAP_BASE,
  GARRISON_PER_TILE,
  OCCUPY_MIN_TROOPS,
  MARCH_MIN_TROOPS,
  PROTECTION_SEC,
  TROOP_TRAIN_INK_COST,
  TROOP_TRAIN_TIME_SEC,
  TROOP_TRAIN_BATCH_MAX,
  TROOP_TRAIN_QUEUE_MAX,
  TROOP_SPEEDUP_SECS_PER_COIN,
  buildingYieldMult,
  buildingSelfYield,
  resourceCapFor,
  troopCapFor,
  drillTrainMult,
  trainQueueMaxFor,
  buildCost,
  buildTimeSec,
  buildGateReason,
  buildingLevel,
  BUILD_QUEUE_SLOTS,
  BUILD_SPEEDUP_SECS_PER_COIN,
  type BuildingKey,
  NATION_BONUS_PRODUCTION,
  NATION_BONUS_DEFENSE,
  nationDefenseStrength,
  wallDefenseMult,
  cabinetLootProtect,
  academyBuff,
  VISION_TERRITORY_RADIUS,
  VISION_BASE_RADIUS,
  VISION_MARCH_RADIUS,
  VISION_SCOUT_RADIUS,
  VISION_WATCHTOWER_RADIUS,
  VISION_MAX_RADIUS,
  WATCHTOWER_COST,
  isInVision,
  marchInterpPos,
  type VisionSource,
  SIEGE_TEAM_CAP,
  teamSiegeValue,
  waveSeed,
  buildingMaxHp,
  SLG_SIEGE_DAMAGE_DELAY_MS,
  SLG_TEAM_INJURY_MS,
  CARD_TEAM_MAX_SIZE,
  BASE_TROOP_STOCK_INITIAL,
  CARD_RECOVER_COIN_COST,
  CARD_TROOP_PAPER_COST,
  CARD_TROOP_GRAPHITE_COST,
  CARD_TROOP_METAL_COST,
  CARD_TROOP_REFUND_RATE,
  SECT_LEADER_PENALTY_RATE,
  RELOCATE_COST,
  SLG_SHOP_ITEMS,
  CAPITAL_FRACTIONS,
  SETTLE_REWARDS,
  BP_YIELD_MULT,
  BP_SETTLE_EXTRA,
  settleTier,
  CENTER_CAPITAL_IDX,
  CENTER_CAPITAL_MULT,
  RESET_DELETE_BATCH,
  WORLD_CAPACITY,
  worldShardId,
  shardCountForPopulation,
  allocateSectsToShards,
  type SectStrength,
  SlgError,
  type SettleTier,
  type PathCell,
  type TileType,
  type ResourceType,
  type MarchKind,
  type SiegeOutcome,
  type SiegeResolution,
  type ProceduralTile,
} from '@nw/shared';
import { runSiegeBattle, synthesizeArmy, validateAttackerArmy, validateDefenseConfig, scaleArmyHp, scaleArmyByRatio, sumArmyHp, resolveCardArmy, toEngineCardInstances, computeCardStateUpdates } from './siegeEngine';
import type { GarrisonEntry, EngineEquipmentInput, EngineCardInstance, EngineEquipInv } from '@nw/engine';
import { ENGINE_VERSION } from '@nw/engine';
import { refreshFamilyProsperity, aggregateSectProsperity } from './prosperity';
import type { WorldCollections, TileDoc, PlayerWorldDoc, MarchDoc, SiegeDoc, SiegeDamageDoc, NationDoc, TrainingEntry, BuildQueueEntry, DefenseConfig, ArmyEntry, TeamTemplate, CardSLGState } from './db';
import type { WorldRedis } from './redis';
import { nullWorldGatewayClient, type WorldGatewayClient } from './gatewayClient';
import { nullWorldMetaClient, type WorldMetaClient, type PlayerProfile } from './metaClient';
import { nullWorldCommercialClient, type WorldCommercialClient } from './commercialClient';
import { nullWorldMailClient, type WorldMailClient } from './mailClient';
import { nullWorldSocialsvcClient, type WorldSocialsvcClient } from './socialsvcClient';

/** Maximum Chebyshev radius for ring-by-ring empty-tile search around family members' capitals when auto-spawning near the family (§3.4). */
const SPAWN_NEAR_FAMILY_RADIUS = 6;
/** Auto-spawn outer newbie zone threshold: only spawn randomly in the outer ring where dr (normalized distance to center) > this value, staying away from the central contest zone (§3.4). */
const SPAWN_OUTER_MIN_DR = 0.6;

/** Replayable inputs for a decisive siege (G3-2c): seed + both sides' formations + tile level, persisted to SiegeDoc for client-side replay spectating. */
export interface SiegeReplayInputs {
  seed: number;
  attackerArmy: GarrisonEntry[];
  defenderConfig: { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown } | null;
  tileLevel: number;
}

/** Single-tile view in the viewport (REST response). `mine` indicates whether the tile belongs to the requester; `ownerPublicId`/`ownerName` are the nickname of another player's territory (requires meta to be available). */
export interface WorldTileView {
  x: number;
  y: number;
  type: TileType;
  level: number;
  resType?: ResourceType;
  /** Whether occupied by any player (neutral/unoccupied = false or omitted). */
  occupied?: boolean;
  /** Whether owned by the requester. */
  mine?: boolean;
  /** Another player's territory: occupier's 9-digit public id (populated when meta is available). */
  ownerPublicId?: string;
  /** Another player's territory: occupier's display name (populated when meta is available). */
  ownerName?: string;
  familyId?: string;
  garrison?: number;
  protectedUntil?: number;
  /** §18 G5 V2: this tile has a watchtower (only exposed for tiles visible to the player) — large-radius persistent vision source; client renders the tower marker. */
  watchtower?: boolean;
  /**
   * G5: this tile is owned by an ally in the same family (not the requester, within vision). The client
   * renders it in "friendly color" — after family vision sharing, ally territory should no longer appear
   * as enemy color (occupation does not write tile.familyId, so the server determines this flag based on
   * the family member set and attaches it here).
   */
  ally?: boolean;
  /**
   * G5: this tile is owned by a member of an "allied sect" of the player's own sect (within vision, not the
   * requester, not a family member). Alliances do not share vision; they are only distinguished by a yellow
   * border marker on the map (§8.2). Family allies use `ally`; this field is specifically for cross-sect alliances.
   */
  allySect?: boolean;
  /**
   * G5 vision: whether this tile is within the requester's current vision.
   * - true: the dynamic layer (ownership/garrison/defense/protection shield) is returned as-is;
   * - false: outside vision — only the procedural base terrain (type/level/resType) is returned;
   *   all dynamic layers are hidden (not even "occupied" is leaked — type falls back to base terrain rather than 'territory').
   * Populated only by getMap viewport reads; single-tile responses like getTile/occupy do not include this field.
   */
  visible?: boolean;
}

export interface WorldMapView {
  worldId: string;
  cx: number;
  cy: number;
  r: number;
  tiles: WorldTileView[];
}

/**
 * Sparse occupied-tile view (zoom 2/3 bird's-eye layer).
 * Contains only occupied tiles (ownerId present); unoccupied tiles are rendered locally by the client from proceduralTile.
 * No profile RPC / no vision computation → an order of magnitude faster than WorldTileView.
 */
export interface WorldTileSparseView {
  x: number;
  y: number;
  type: TileType;
  mine?: boolean;
  /** Populated when lod=mid (same-family ally). */
  ally?: boolean;
  /** Populated when lod=mid (allied sect member, not family). */
  allySect?: boolean;
}

export interface WorldMapSparseView {
  worldId: string;
  cx: number;
  cy: number;
  r: number;
  lod: 'thin' | 'mid';
  /** Occupied tiles only, sparse array. Tiles not listed here are rendered by the client via proceduralTile. */
  tiles: WorldTileSparseView[];
}

export interface PlayerWorldView {
  joined: boolean;
  /** shard worldId the player is in (G6/§20 R3: join-season resolution result returned to client as basis for entering the map). */
  worldId?: string;
  troops?: number;
  troopCap?: number;
  resources?: Record<ResourceType, number>;
  yieldRate?: Record<ResourceType, number>;
  mainBaseTile?: string;
  territoryCount?: number;
  familyId?: string;
  /** Training queue (S8-2, sorted by completeAt ascending); client C4 renders countdowns based on this. */
  trainingQueue?: { qty: number; startAt: number; completeAt: number }[];
  /** Home-city building levels (SLG_CITY_DESIGN; desk≥1, others≥0). */
  buildings?: Partial<Record<BuildingKey, number>>;
  /** Build queue (SLG_CITY_DESIGN §4, ordered by completeAt ascending); client CityScene renders countdowns. */
  buildQueue?: { key: BuildingKey; toLevel: number; startAt: number; completeAt: number }[];
}

/** March view (REST response / push payload source). */
export interface MarchView {
  marchId: string;
  kind: MarchKind;
  fromTile: string;
  toTile: string;
  troops: number;
  departAt: number;
  arriveAt: number;
  status: MarchDoc['status'];
  /** G5: whether this is the requester's own march (getMarches distinguishes own vs. enemy marches in vision; not included in push payloads). */
  mine?: boolean;
}

/** Maximum viewport radius (prevents fetching too many tiles at once; hard cap before P9 viewport subscription model scales up). */
const MAP_VIEW_MAX_RADIUS = 40;

export interface WorldServiceDeps {
  cols: WorldCollections;
  redis: WorldRedis | null;
  mapW: number;
  mapH: number;
  now: () => number;
  /** Real-time event push (march_update/tile_update); default = no gateway, push is no-op (REST polling). */
  gateway?: WorldGatewayClient;
  /** Resolve player profile (publicId/displayName); default = display names are not populated. */
  meta?: WorldMetaClient;
  /** Coin deduction (troop training speedup / SLG shop); default = coin operations unavailable. */
  commercial?: WorldCommercialClient;
  /** System mail (season settlement reward dispatch, §17.5); default = no rewards sent (best-effort). */
  mail?: WorldMailClient;
  /** socialsvc internal client (SS7: syncs familyId read-only mirror on joinWorld); default = familyId not populated. */
  socialsvc?: WorldSocialsvcClient;
}

const emptyResources = (): Record<ResourceType, number> => ({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 });

/**
 * Batch deletion (§17.6): a single deleteMany on a collection with tens of thousands of records would hold
 * a lock for a long time and block the event loop. Instead, loop and delete by _id in batches of ≤ batch
 * documents, yielding the event loop between iterations. Idempotent: re-entry on already-deleted docs is a
 * no-op; eventually consistent. Returns the total number of deleted documents.
 */
async function deleteInBatches(
  col: { find: (f: object) => { project: (p: object) => { limit: (n: number) => { toArray: () => Promise<Array<{ _id: string }>> } } }; deleteMany: (f: object) => Promise<{ deletedCount: number }> },
  filter: object,
  batch: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const docs = await col.find(filter).project({ _id: 1 }).limit(batch).toArray();
    if (docs.length === 0) break;
    const ids = docs.map((d) => d._id);
    const r = await col.deleteMany({ _id: { $in: ids } });
    total += r.deletedCount;
    if (docs.length < batch) break;
  }
  return total;
}

/** Player-facing march kinds that are permitted (return is an internal recall leg only; external initiation is prohibited). */
const MARCHABLE_KINDS: ReadonlySet<string> = new Set(['occupy', 'reinforce', 'attack', 'sweep', 'scout']);

/** Vision radius of an in-transit march: scout marches see farther (VISION_SCOUT_RADIUS); all others use normal march radius (VISION_MARCH_RADIUS). */
function marchVisionRadius(kind: MarchKind): number {
  return kind === 'scout' ? VISION_SCOUT_RADIUS : VISION_MARCH_RADIUS;
}

/** Vision radius of a static vision source (territory/capital/watchtower): watchtower > capital > normal territory (§18 G5 V2). */
function tileVisionRadius(t: { type: TileType; watchtower?: boolean }): number {
  if (t.watchtower) return VISION_WATCHTOWER_RADIUS;
  return t.type === 'base' ? VISION_BASE_RADIUS : VISION_TERRITORY_RADIUS;
}

export class WorldService {
  private readonly gateway: WorldGatewayClient;
  private readonly meta: WorldMetaClient;
  private readonly commercial: WorldCommercialClient;
  private readonly mail: WorldMailClient;
  /** In-process monotonic sequence number — ensures marchIds do not collide when multiple marches depart within the same millisecond. */
  private marchSeq = 0;
  /** In-process monotonic sequence number — ensures siegeIds do not collide when multiple sieges resolve within the same millisecond. */
  private siegeSeq = 0;
  /** Cached capital coordinate list derived from the current mapW/mapH (lazy-initialized). */
  private _capitals: [number, number][] | null = null;

  private readonly socialsvc: WorldSocialsvcClient;

  constructor(private readonly deps: WorldServiceDeps) {
    this.gateway = deps.gateway ?? nullWorldGatewayClient;
    this.meta = deps.meta ?? nullWorldMetaClient;
    this.commercial = deps.commercial ?? nullWorldCommercialClient;
    this.mail = deps.mail ?? nullWorldMailClient;
    this.socialsvc = deps.socialsvc ?? nullWorldSocialsvcClient;
  }

  private get capitals(): [number, number][] {
    if (!this._capitals) {
      this._capitals = capitalPositions(this.deps.mapW, this.deps.mapH);
    }
    return this._capitals;
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.deps.mapW && y < this.deps.mapH;
  }

  /**
   * A* pathfinding for marches: pre-fetch all occupied gate tiles, assemble passableGateKeys, then call findMarchPath.
   * Gate passage rules (S8-4): gates occupied by the requester and gates occupied by members of the same family are passable
   * (allied sect passage is S8-4+ with the alliance system pending; currently only within the same family).
   * No path found → throw PATH_BLOCKED (HTTP 400).
   */
  private async computeMarchPath(
    worldId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    requesterId: string,
  ): Promise<PathCell[]> {
    // Retrieve the requester's current family (if any); gates occupied by fellow family members are also passable.
    const requesterPw = await this.deps.cols.playerWorld.findOne({ _id: playerWorldId(worldId, requesterId) });
    const allyFamilyId = requesterPw?.familyId;

    // Gates are sparse (~20–40 across the whole map); fetch all at once and filter, to avoid async calls inside A*.
    const gateTiles = await this.deps.cols.tiles
      .find({ worldId, type: 'gate' })
      .project<{ _id: string; x: number; y: number; ownerId: string | undefined; familyId: string | undefined }>({
        _id: 1, x: 1, y: 1, ownerId: 1, familyId: 1,
      })
      .toArray();
    const passableGateKeys = new Set<string>(
      gateTiles
        .filter((g) =>
          g.ownerId === requesterId ||
          (allyFamilyId && g.familyId === allyFamilyId),
        )
        .map((g) => `${g.x}:${g.y}`),
    );
    // ADR-025: other players' 3×3 capitals are solid buildings that block pathing (封路); the marcher
    // routes around them but can still march ONTO an enemy base tile to besiege it (findMarchPath exempts
    // the destination). The marcher's own base cells are excluded so owners march in/out freely.
    // When the destination IS an enemy base cell (a siege), also exclude THAT base's whole footprint so
    // every one of its 9 cells — including the center, which is otherwise walled in by its own ring — is
    // reachable ("attack any cell = attack the base"). Only that one base opens up; all others still block.
    const destTile = await this.deps.cols.tiles.findOne({ _id: tileId(worldId, toX, toY) });
    const siegeBaseOwner = destTile?.type === 'base' ? destTile.ownerId : undefined;
    const excludeOwners = siegeBaseOwner ? [requesterId, siegeBaseOwner] : [requesterId];
    const blockedBaseTiles = await this.deps.cols.tiles
      .find({ worldId, type: 'base', ownerId: { $nin: excludeOwners } })
      .project<{ x: number; y: number }>({ x: 1, y: 1 })
      .toArray();
    const blockedBaseKeys = new Set<string>(blockedBaseTiles.map((b) => `${b.x}:${b.y}`));
    const path = findMarchPath(
      worldId,
      this.deps.mapW,
      this.deps.mapH,
      fromX,
      fromY,
      toX,
      toY,
      passableGateKeys,
      blockedBaseKeys,
    );
    if (!path) throw new SlgError('PATH_BLOCKED', 'No viable path found');
    return path;
  }

  /** Viewport tiles: merges procedural defaults (neutral world) with sparse DB overrides (occupied/modified tiles). §14.2. */
  async getMap(
    worldId: string,
    accountId: string,
    cx: number,
    cy: number,
    r: number,
  ): Promise<WorldMapView> {
    const { cols, mapW, mapH } = this.deps;
    const rad = Math.max(0, Math.min(MAP_VIEW_MAX_RADIUS, Math.floor(r)));
    const x0 = Math.max(0, Math.floor(cx) - rad);
    const x1 = Math.min(mapW - 1, Math.floor(cx) + rad);
    const y0 = Math.max(0, Math.floor(cy) - rad);
    const y1 = Math.min(mapH - 1, Math.floor(cy) + rad);

    const overrides = await cols.tiles
      .find({ worldId, x: { $gte: x0, $lte: x1 }, y: { $gte: y0, $lte: y1 } })
      .toArray();
    const byKey = new Map(overrides.map((t) => [`${t.x}:${t.y}`, t]));

    // G5 vision: compute the requester's currently visible tile set (own/family territory + capitals + in-transit marches), gate the dynamic layer per tile.
    const sources = await this.computeVisionSources(worldId, accountId, x0, x1, y0, y1);
    const vis = (x: number, y: number): boolean => isInVision(sources, x, y);
    // Family member set (including self): visible family ally territory is tagged ally (client renders in friendly color, not enemy color).
    const family = await this.familyMemberIds(worldId, accountId);
    // Allied sect member set (≤2 allied sects): visible allied territory is tagged allySect (client renders yellow border, §8.2).
    const allySect = await this.allySectMemberIds(worldId, accountId);

    // Batch-resolve display names for other players' territory: only fetch profiles for "visible other players' territory" (outside vision, ownership is not shown, so no profile needed).
    const otherOwnerIds = [...new Set(
      overrides
        .filter((o) => o.ownerId && o.ownerId !== accountId && vis(o.x, o.y))
        .map((o) => o.ownerId!),
    )];
    const profileMap = new Map<string, PlayerProfile>();
    if (otherOwnerIds.length > 0 && this.meta.available) {
      const results = await Promise.allSettled(
        otherOwnerIds.map((id) => this.meta.getProfile(id).then((p) => ({ id, p }))),
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.p) profileMap.set(r.value.id, r.value.p);
      }
    }

    const tiles: WorldTileView[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!vis(x, y)) {
          // Outside vision: return only procedural base terrain; all dynamic layers (including the "occupied" signal) are hidden.
          tiles.push({ ...this.proceduralView(worldId, x, y), visible: false });
          continue;
        }
        const o = byKey.get(`${x}:${y}`);
        const ownerProfile = (o?.ownerId && o.ownerId !== accountId)
          ? profileMap.get(o.ownerId) : undefined;
        const view = o ? this.tileDocView(o, accountId, ownerProfile) : this.proceduralView(worldId, x, y);
        const ally = !!o?.ownerId && o.ownerId !== accountId && family.has(o.ownerId);
        // Alliance tag: visible, not own tile, not family, belongs to an allied sect member (family ally takes priority; the two are mutually exclusive).
        const allied = !ally && !!o?.ownerId && o.ownerId !== accountId && allySect.has(o.ownerId);
        tiles.push({
          ...view,
          visible: true,
          ...(ally ? { ally: true } : {}),
          ...(allied ? { allySect: true } : {}),
        });
      }
    }
    return { worldId, cx: Math.floor(cx), cy: Math.floor(cy), r: rad, tiles };
  }

  /**
   * Sparse occupied layer (zoom 2/3 bird's-eye exclusive, §LOD).
   * Returns only tiles that have an ownerId in the DB — unoccupied tiles are rendered locally by the client via proceduralTile.
   * Skips profile RPC / vision computation; at lod=mid, additionally computes family + sect alliance (still no profile RPC).
   */
  async getMapSparse(
    worldId: string,
    accountId: string,
    cx: number,
    cy: number,
    r: number,
    lod: 'thin' | 'mid',
  ): Promise<WorldMapSparseView> {
    const { cols, mapW, mapH } = this.deps;
    const rad = Math.max(0, Math.min(MAP_VIEW_MAX_RADIUS, Math.floor(r)));
    const x0 = Math.max(0, Math.floor(cx) - rad);
    const x1 = Math.min(mapW - 1, Math.floor(cx) + rad);
    const y0 = Math.max(0, Math.floor(cy) - rad);
    const y1 = Math.min(mapH - 1, Math.floor(cy) + rad);

    // Fetch only tiles with an owner (sparse), using projection to reduce data transfer
    const owned = await cols.tiles
      .find(
        { worldId, x: { $gte: x0, $lte: x1 }, y: { $gte: y0, $lte: y1 }, ownerId: { $exists: true } },
        { projection: { x: 1, y: 1, type: 1, ownerId: 1 } },
      )
      .toArray();

    let family = new Set<string>([accountId]);
    let allySectSet = new Set<string>();
    if (lod === 'mid') {
      family = await this.familyMemberIds(worldId, accountId);
      allySectSet = await this.allySectMemberIds(worldId, accountId);
    }

    const tiles: WorldTileSparseView[] = owned.map((o) => {
      const mine = o.ownerId === accountId;
      const tile: WorldTileSparseView = { x: o.x, y: o.y, type: o.type };
      if (mine) {
        tile.mine = true;
      } else if (lod === 'mid' && o.ownerId) {
        if (family.has(o.ownerId)) tile.ally = true;
        else if (allySectSet.has(o.ownerId)) tile.allySect = true;
      }
      return tile;
    });

    return { worldId, cx: Math.floor(cx), cy: Math.floor(cy), r: rad, lod, tiles };
  }

  /** Set of accountIds for the player plus all same-family members (family-level vision sharing / ally determination, §8.2; includes self). Sourced from PlayerWorldDoc.familyId (SS7 mirror, scoped to this world) rather than a local family mirror (dead since P4, see db.ts note above SectDoc). */
  private async familyMemberIds(worldId: string, accountId: string): Promise<Set<string>> {
    const ids = new Set<string>([accountId]);
    const myPw = await this.deps.cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (myPw?.familyId) {
      const mates = await this.deps.cols.playerWorld.find({ worldId, familyId: myPw.familyId }).toArray();
      for (const m of mates) ids.add(m.accountId);
    }
    return ids;
  }

  /**
   * G5: set of accountIds of all members of the player's sect's "allied sects" (`sect.allySectIds`, ≤2).
   * Chain: accountId → playerWorld.familyId → socialsvc family.sectId → sect.allySectIds → member families of each allied sect (socialsvc) → members joined to this world.
   * Alliances do **not** share vision (§8.2); used only by getMap to tag allied territory (yellow border). No sect / no alliance → empty set.
   * Does not include self or same-family members (those go through `familyMemberIds`).
   */
  private async allySectMemberIds(worldId: string, accountId: string): Promise<Set<string>> {
    const { cols } = this.deps;
    const result = new Set<string>();
    const myPw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!myPw?.familyId) return result;
    const [myFam] = await this.socialsvc.getFamiliesByIds([myPw.familyId]);
    if (!myFam?.sectId) return result;
    const mySect = await cols.sects.findOne({ _id: myFam.sectId });
    const allyIds = mySect?.allySectIds ?? [];
    if (allyIds.length === 0) return result;
    const allyFamilies = (await Promise.all(allyIds.map((sid) => this.socialsvc.getFamiliesBySect(sid)))).flat();
    const famIds = allyFamilies.map((f) => f.familyId);
    if (famIds.length === 0) return result;
    const members = await cols.playerWorld.find({ worldId, familyId: { $in: famIds } }).toArray();
    for (const m of members) result.add(m.accountId);
    return result;
  }

  /**
   * G5: compute the set of vision sources for the requester within the given viewport (including the radius-padded border).
   * Sources = own + same-family members' territory (capital type:'base' gets large radius, other territory gets small radius) + own/family marches in transit
   * (current position linearly interpolated from departAt/arriveAt). Family members are looked up via familyMembers (tile.familyId is not written on the occupy path
   * and cannot be relied upon), ≤30 members. Vision is not persisted; computed fresh on each read (short-TTL cache deferred to G5 follow-up optimization).
   */
  private async computeVisionSources(
    worldId: string,
    accountId: string,
    x0: number,
    x1: number,
    y0: number,
    y1: number,
  ): Promise<VisionSource[]> {
    const { cols, now } = this.deps;
    // Vision source owners = self + same-family members (family-level sharing, decided in §8.2).
    const ids = [...(await this.familyMemberIds(worldId, accountId))];

    // Source territory: pad the viewport by the maximum vision radius (territory/watchtowers outside the viewport can still illuminate its edges).
    const pad = VISION_MAX_RADIUS;
    const sources: VisionSource[] = [];
    const srcTiles = await cols.tiles
      .find({
        worldId,
        ownerId: { $in: ids },
        x: { $gte: x0 - pad, $lte: x1 + pad },
        y: { $gte: y0 - pad, $lte: y1 + pad },
      })
      .toArray();
    for (const t of srcTiles) {
      sources.push({ x: t.x, y: t.y, radius: tileVisionRadius(t) });
    }

    // In-transit marches (own + family): interpolate current position → small-radius vision (the value of scout marches).
    const marches = await cols.marches.find({ worldId, ownerId: { $in: ids }, status: 'marching' }).toArray();
    const t = now();
    for (const m of marches) {
      const pos = marchInterpPos(
        this.coordX(m.fromTile), this.coordY(m.fromTile),
        this.coordX(m.toTile), this.coordY(m.toTile),
        m.departAt, m.arriveAt, t,
      );
      sources.push({ x: pos.x, y: pos.y, radius: marchVisionRadius(m.kind) });
    }
    return sources;
  }

  /**
   * G5-2 reverse vision: find "players whose vision covers any of the given cells" — i.e. accounts that own
   * territory/capitals whose vision radius reaches any cell. Used to push events to visible observers when a march
   * starts or a tile changes hands (enemy march entering your vision triggers a push, V4).
   * Called once per low-frequency event (not per tick) to avoid the U11 reverse fan-out explosion. v1 only fetches
   * the territory owner themselves (real-time fan-out to family members deferred — they see it via family-shared
   * getMap polling too). exclude = parties already pushed individually (march owner / defender).
   */
  private async visionObservers(
    worldId: string,
    cells: readonly { x: number; y: number }[],
    exclude: ReadonlySet<string>,
  ): Promise<string[]> {
    if (cells.length === 0) return [];
    const { cols } = this.deps;
    const xs = cells.map((c) => c.x);
    const ys = cells.map((c) => c.y);
    const pad = VISION_MAX_RADIUS;
    // Vision sources are territory/capitals/watchtowers → query owned tiles within the cells bounding-box padded by the maximum vision radius.
    const owned = await cols.tiles
      .find({
        worldId,
        x: { $gte: Math.min(...xs) - pad, $lte: Math.max(...xs) + pad },
        y: { $gte: Math.min(...ys) - pad, $lte: Math.max(...ys) + pad },
      })
      .toArray();
    const seers = new Set<string>();
    for (const t of owned) {
      if (!t.ownerId || exclude.has(t.ownerId) || seers.has(t.ownerId)) continue;
      const radius = tileVisionRadius(t);
      for (const c of cells) {
        if (Math.abs(t.x - c.x) <= radius && Math.abs(t.y - c.y) <= radius) {
          seers.add(t.ownerId);
          break;
        }
      }
    }
    return [...seers];
  }

  /** G5-2: push a tile change to all observers whose vision covers it (exclude parties already pushed individually, such as the tile owner / defender). */
  private async pushTileToObservers(t: TileDoc, exclude: ReadonlySet<string>): Promise<void> {
    const observers = await this.visionObservers(t.worldId, [{ x: t.x, y: t.y }], exclude);
    for (const acct of observers) void this.pushTile(acct, t);
  }

  /** Single-tile details. DB override takes priority; otherwise falls back to procedural defaults. G5: outside vision, returns only procedural terrain (same as getMap, prevents getTile from bypassing the fog of war). */
  async getTile(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    const o = await this.deps.cols.tiles.findOne({ _id: tileId(worldId, x, y) });
    if (!o) return this.proceduralView(worldId, x, y);
    const sources = await this.computeVisionSources(worldId, accountId, x, x, y, y);
    if (!isInVision(sources, x, y)) return { ...this.proceduralView(worldId, x, y), visible: false };
    const ownerProfile = (o.ownerId && o.ownerId !== accountId && this.meta.available)
      ? await this.meta.getProfile(o.ownerId).catch(() => null) : undefined;
    return { ...this.tileDocView(o, accountId, ownerProfile ?? undefined), visible: true };
  }

  /** Player state in the world: resources are lazily settled (computed on read as yieldRate × dt, capped at RESOURCE_CAP). §14.3. */
  async getMe(worldId: string, accountId: string): Promise<PlayerWorldView> {
    const doc = await this.deps.cols.playerWorld.findOne({
      _id: playerWorldId(worldId, accountId),
    });
    if (!doc) return { joined: false, worldId };
    const resources = this.settle(doc, this.deps.now());
    return {
      joined: true,
      worldId, // G6 (§20 R3): the shard worldId resolved by join-season is returned to the client for map entry
      troops: doc.troops,
      troopCap: doc.troopCap,
      resources,
      yieldRate: doc.yieldRate,
      territoryCount: await this.deps.cols.tiles.countDocuments({ worldId, ownerId: accountId }),
      ...(doc.mainBaseTile ? { mainBaseTile: doc.mainBaseTile } : {}),
      ...(doc.familyId ? { familyId: doc.familyId } : {}),
      ...(doc.trainingQueue && doc.trainingQueue.length > 0
        ? { trainingQueue: doc.trainingQueue.map((e) => ({ qty: e.qty, startAt: e.startAt, completeAt: e.completeAt })) }
        : {}),
      ...(doc.buildings ? { buildings: doc.buildings } : {}),
      ...(doc.buildQueue && doc.buildQueue.length > 0
        ? { buildQueue: doc.buildQueue.map((e) => ({ key: e.key, toLevel: e.toLevel, startAt: e.startAt, completeAt: e.completeAt })) }
        : {}),
    };
  }

  // ── S8-1: enter world / occupy / abandon ───────────────────────────

  /**
   * Enter the world: place the capital. Idempotent (returns current state immediately if already joined, no second placement).
   *
   * Spawn point (§3.4, decided 2026-06-24): **first entry uses system auto-placement** (prefer near family → fall back to outer newbie ring → whole-map fallback).
   * Players no longer choose coordinates — only paid relocation (`relocateBase`) / passive relocation after base destruction (`passiveRelocate`) can change position.
   * The optional `(x,y)` manual placement is retained for internal/test use only (public endpoints never pass coordinates; always auto-place).
   * Validation: world open + not full (+ manual path: coordinates in bounds / not center/obstacle/gate/stronghold / unoccupied).
   * Effect: write base TileDoc (with newbie protection shield PROTECTION_SEC) + create playerWorld (full troops + initial yield).
   */
  async joinWorld(worldId: string, accountId: string, x?: number, y?: number): Promise<PlayerWorldView> {
    const { cols, now } = this.deps;
    const existing = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (existing) return this.getMe(worldId, accountId); // idempotent

    // SS7: resolve the familyId read-only mirror once up front (subsequent family changes are not written back;
    // clients read from /social/family/mine). Used for both auto-spawn placement and the playerWorld mirror below.
    const familyId = await this.socialsvc.getFamilyId(accountId).catch(() => null) ?? undefined;

    let spawn: { x: number; y: number; level: number; resType?: ResourceType };
    if (x !== undefined && y !== undefined) {
      // Manual placement (internal/test): retain the original validation rules.
      if (!this.inBounds(x, y)) throw new SlgError('OUT_OF_RANGE', 'Capital coordinates out of bounds');
      const proc = proceduralTile(worldId, x, y);
      if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'Cannot place capital at the world center');
      if (proc.type === 'obstacle' || proc.type === 'gate') throw new SlgError('BAD_REQUEST', 'Cannot place capital on obstacle/gate terrain');
      if (proc.type === 'stronghold') throw new SlgError('BAD_REQUEST', 'Cannot place capital on stronghold terrain');
      const occ = await cols.tiles.findOne({ _id: tileId(worldId, x, y) });
      if (occ?.ownerId) throw new SlgError('TILE_OCCUPIED', 'This tile is already occupied');
      // ADR-025: the capital is a 3×3 building — the whole footprint must fit + be free.
      if (!(await this.footprintFree(worldId, x, y, this.deps.mapW, this.deps.mapH))) {
        throw new SlgError('TILE_OCCUPIED', 'The 3×3 capital footprint does not fit / is occupied here');
      }
      spawn = { x, y, level: proc.level, ...(proc.resType ? { resType: proc.resType } : {}) };
    } else {
      // Auto-placement: prefer near family members → outer newbie ring → whole-map fallback.
      const spot = await this.pickSpawnTile(worldId, accountId, familyId);
      if (!spot) throw new SlgError('WORLD_FULL', 'No available spawn tile');
      spawn = spot;
    }
    const tid = tileId(worldId, spawn.x, spawn.y);

    // Capacity guard (enforced only when the world document exists — dev environments without a world document are uncapped).
    const world = await cols.worlds.findOne({ _id: worldId });
    if (world) {
      if (world.status !== 'open' && world.status !== 'active') {
        throw new SlgError('WORLD_CLOSED', 'World is not open');
      }
      const inc = await cols.worlds.findOneAndUpdate(
        { _id: worldId, status: { $in: ['open', 'active'] }, $expr: { $lt: ['$population', '$capacity'] } },
        { $inc: { population: 1 } },
      );
      if (!inc) throw new SlgError('WORLD_FULL', 'World is at capacity');
      // The first player to join advances the world from open to active (§17.3 state machine; fixes the `active` stuck value). CAS idempotent.
      if (inc.status === 'open') {
        await cols.worlds.updateOne({ _id: worldId, status: 'open' }, { $set: { status: 'active' as const } });
      }
    }

    const t = now();
    // ADR-025: only the anchor contributes the base ink trickle (ring cells add no yield).
    const yieldRate = this.yieldRecord([{ type: 'base', level: spawn.level }]);
    // Write all 9 footprint tiles (anchor + 8 ring), idempotent via $setOnInsert like the old single-tile write.
    const baseDocs = this.baseTileDocs(worldId, spawn.x, spawn.y, accountId, {
      garrison: GARRISON_PER_TILE,
      level: spawn.level,
      ...(spawn.resType ? { resType: spawn.resType } : {}),
      protectedUntil: t + PROTECTION_SEC * 1000,
      ...(familyId ? { familyId } : {}),
    });
    await Promise.all(
      baseDocs.map((d) => cols.tiles.updateOne({ _id: d._id }, { $setOnInsert: d }, { upsert: true })),
    );

    // Home-city building system (SLG_CITY_DESIGN): a fresh capital starts with desk:1; troopCap derives from buildings (drillYard 0 → TROOP_CAP_BASE).
    const buildings: Partial<Record<BuildingKey, number>> = { desk: 1 };
    const pw: PlayerWorldDoc = {
      _id: playerWorldId(worldId, accountId),
      worldId,
      accountId,
      troops: troopCapFor(buildings),
      troopCap: troopCapFor(buildings),
      resources: emptyResources(),
      yieldRate,
      lastTickAt: t,
      mainBaseTile: tid,
      buildings,
      baseTroopStock: BASE_TROOP_STOCK_INITIAL,
      ...(familyId ? { familyId } : {}),
      rev: 0,
    };
    await cols.playerWorld.insertOne(pw);
    return this.getMe(worldId, accountId);
  }

  /**
   * Occupy a tile (S8-1 direct occupation, no march travel; S8-2 switches to march occupy).
   * Validation: joined + coordinates in bounds + not center + enough troops for one garrison unit + target unoccupied by others.
   * Effect: settle resources first → deduct GARRISON_PER_TILE troops → write territory TileDoc (preserve resource type) → recompute yieldRate.
   */
  async occupyTile(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    const { cols, now } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    if (!this.inBounds(x, y)) throw new SlgError('OUT_OF_RANGE', 'Coordinates out of bounds');

    const proc = proceduralTile(worldId, x, y);
    if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'World center is contested by sects and cannot be directly occupied');
    if (proc.type === 'obstacle') throw new SlgError('BAD_REQUEST', 'Obstacle terrain cannot be occupied');

    const tid = tileId(worldId, x, y);
    const occ = await cols.tiles.findOne({ _id: tid });
    // ADR-025: a base is a 3×3 indivisible building — no cell (anchor or ring) can be occupied. Take it via siege.
    if (occ?.type === 'base') throw new SlgError('TILE_OCCUPIED', 'Cannot occupy a capital (siege the base instead)');
    if (occ?.ownerId === accountId) return this.tileDocView(occ, accountId); // idempotent
    if (occ?.ownerId) {
      // Another player's territory: S8-1 has no siege; if protected or otherwise occupied, always reject (take via S8-3 siege).
      if (occ.protectedUntil && occ.protectedUntil > now()) {
        throw new SlgError('PROTECTED', 'Target tile is under protection');
      }
      throw new SlgError('TILE_OCCUPIED', 'This tile is already occupied (use siege to take it, S8-3)');
    }

    if (pw.troops < GARRISON_PER_TILE) throw new SlgError('NO_TROOPS', 'Insufficient troops to garrison the tile');

    const t = now();
    const resources = this.settle(pw, t);

    const resType = proc.resType;
    const tileDoc: TileDoc = {
      _id: tid,
      worldId,
      x,
      y,
      type: 'territory',
      level: proc.level,
      ...(resType ? { resType } : {}),
      ownerId: accountId,
      garrison: GARRISON_PER_TILE,
      rev: 0,
    };
    await cols.tiles.updateOne({ _id: tid }, { $set: tileDoc }, { upsert: true });

    const yieldRate = await this.recomputeYield(worldId, accountId);
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      {
        $set: { resources, yieldRate, lastTickAt: t },
        $inc: { troops: -GARRISON_PER_TILE, rev: 1 },
      },
    );
    const after = await cols.tiles.findOne({ _id: tid });
    if (after) await this.pushTileToObservers(after, new Set([accountId])); // G5-2: new territory is visible to observers within vision
    // §17.4 activity increment: direct occupation (S8-1 path) → occupier's family +1 (including prosperity refresh).
    void this.bumpFamilyActivity(worldId, pw.familyId, 1);
    return this.tileDocView(after!, accountId);
  }

  /**
   * Abandon a tile: refund garrison troops + recompute yield. The capital cannot be abandoned.
   */
  async abandonTile(worldId: string, accountId: string, x: number, y: number): Promise<PlayerWorldView> {
    const { cols, now } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const tid = tileId(worldId, x, y);
    const tile = await cols.tiles.findOne({ _id: tid });
    if (!tile || tile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', 'Not your territory');
    // ADR-025: all 9 footprint cells are type:'base', so this single check rejects abandoning anchor OR ring — no change needed.
    if (tile.type === 'base') throw new SlgError('TILE_NOT_OWNED', 'Cannot abandon the capital');

    const t = now();
    const resources = this.settle(pw, t);
    const refund = tile.garrison ?? 0;
    await cols.tiles.deleteOne({ _id: tid }); // abandon → revert to procedural neutral (sparse storage leaves no empty shell)
    const yieldRate = await this.recomputeYield(worldId, accountId);
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      {
        $set: { resources, yieldRate, lastTickAt: t },
        $inc: { troops: refund, rev: 1 },
      },
    );
    return this.getMe(worldId, accountId);
  }

  /**
   * Voluntary relocation (§3.4 / §8.2, available to all players): spend RELOCATE_COST coins to move the capital to a chosen legal empty tile.
   * Validation: joined + target in bounds + not center/obstacle/gate + unoccupied by anyone. All territory is retained (only passive relocation loses territory).
   * Effect: deduct coins → delete old base tile → write base tile at new location (carrying old garrison and remaining protection shield) → update mainBaseTile + recompute yield.
   */
  async relocateBase(worldId: string, accountId: string, x: number, y: number): Promise<PlayerWorldView> {
    const { cols, now } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw || !pw.mainBaseTile) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    if (!this.inBounds(x, y)) throw new SlgError('OUT_OF_RANGE', 'Relocation coordinates out of bounds');

    const newTid = tileId(worldId, x, y);
    if (newTid === pw.mainBaseTile) return this.getMe(worldId, accountId); // relocating to the same tile = no-op, no charge

    const proc = proceduralTile(worldId, x, y);
    if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'Cannot place capital at the world center');
    if (proc.type === 'obstacle' || proc.type === 'gate') throw new SlgError('BAD_REQUEST', 'Cannot place capital on obstacle/gate terrain');
    if (proc.type === 'stronghold') throw new SlgError('BAD_REQUEST', 'Cannot place capital on stronghold terrain');
    const occ = await cols.tiles.findOne({ _id: newTid });
    if (occ?.ownerId) throw new SlgError('TILE_OCCUPIED', 'This tile is already occupied');
    // ADR-025: the whole 3×3 footprint must fit + be free at the new anchor (ignore our own old base cells).
    if (!(await this.footprintFree(worldId, x, y, this.deps.mapW, this.deps.mapH, { ignoreOwnerId: accountId }))) {
      throw new SlgError('TILE_OCCUPIED', 'The 3×3 capital footprint does not fit / is occupied at the new location');
    }

    // Deduct coins first (failure throws INSUFFICIENT_FUNDS; map state is not modified).
    const orderId = `slg_relocate:${worldId}:${accountId}:${now()}`;
    await this.commercial.spend(accountId, RELOCATE_COST, orderId);

    const t = now();
    const oldBase = await cols.tiles.findOne({ _id: pw.mainBaseTile });
    const carryGarrison = oldBase?.garrison ?? GARRISON_PER_TILE;
    const carryProtect = oldBase?.protectedUntil; // carry over the old capital's remaining protection shield (voluntary relocation grants no extension)
    // ADR-025: a player has exactly one base = its 9 footprint tiles; delete them all.
    await cols.tiles.deleteMany({ worldId, ownerId: accountId, type: 'base' });

    const baseDocs = this.baseTileDocs(worldId, x, y, accountId, {
      garrison: carryGarrison,
      level: proc.level,
      ...(proc.resType ? { resType: proc.resType } : {}),
      ...(carryProtect ? { protectedUntil: carryProtect } : {}),
      ...(pw.familyId ? { familyId: pw.familyId } : {}),
    });
    await Promise.all(
      baseDocs.map((d) => cols.tiles.updateOne({ _id: d._id }, { $set: d }, { upsert: true })),
    );

    const resources = this.settle(pw, t);
    const yieldRate = await this.recomputeYield(worldId, accountId);
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { resources, yieldRate, mainBaseTile: newTid, lastTickAt: t }, $inc: { rev: 1 } },
    );

    // Push changes for both the old and new tiles (old address reverts to neutral, new address becomes the capital).
    const after = await cols.tiles.findOne({ _id: newTid });
    if (after) {
      void this.pushTile(accountId, after);
      await this.pushTileToObservers(after, new Set([accountId])); // G5-2: new capital after relocation is visible to observers
    }
    return this.getMe(worldId, accountId);
  }

  /**
   * Build a watchtower (§18 G5 V2): spend resources on a player-owned non-capital tile to upgrade it to a
   * large-radius (VISION_WATCHTOWER_RADIUS) persistent vision source. Persisted with TileDoc — losing the tile
   * also destroys the tower; no separate refund.
   * Validation: joined + own territory + not capital (capital has built-in vision). Idempotent: if tower already exists, return current view without charging again.
   */
  async buildWatchtower(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    const { cols, now } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const tid = tileId(worldId, x, y);
    const tile = await cols.tiles.findOne({ _id: tid });
    if (!tile || tile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', 'Not your territory');
    if (tile.type === 'base') throw new SlgError('BAD_REQUEST', 'The capital has built-in vision; a watchtower cannot be built here');
    if (tile.watchtower) return this.tileDocView(tile, accountId); // idempotent

    // Settle resources first, then validate sufficiency, then deduct (insufficient resources throw INSUFFICIENT_RESOURCES; map state is not modified).
    const t = now();
    const resources = this.settle(pw, t);
    for (const rt of RESOURCE_TYPES) {
      if ((resources[rt] ?? 0) < (WATCHTOWER_COST[rt] ?? 0)) {
        throw new SlgError('INSUFFICIENT_RESOURCES', 'Insufficient resources to build a watchtower');
      }
    }
    for (const rt of RESOURCE_TYPES) resources[rt] -= WATCHTOWER_COST[rt] ?? 0;

    await cols.tiles.updateOne({ _id: tid }, { $set: { watchtower: true }, $inc: { rev: 1 } });
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
    );

    const after = await cols.tiles.findOne({ _id: tid });
    if (after) {
      void this.pushTile(accountId, after); // owner refetch → expanded vision from the new tower takes effect on next getMap
      await this.pushTileToObservers(after, new Set([accountId])); // tower is a visible structure; observers within vision also see it
    }
    return this.tileDocView(after!, accountId);
  }

  // ── S8-2: march / recall / arrival processing ──────────────────────────

  /**
   * Start a march (occupy / reinforce; attack/sweep = siege S8-3). Troops are **immediately deducted from the pool** on departure (in-transit);
   * on arrival they are applied according to kind (occupy writes TileDoc / reinforce adds garrison); on failure or recall, troops are refunded to the pool.
   * Validation (at departure): joined + valid kind + from/to in bounds + from is own tile + enough troops +
   *   occupy: target is an empty tile (not center / unoccupied) and troops ≥ OCCUPY_MIN_TROOPS / reinforce: target is own tile.
   */
  async startMarch(
    worldId: string,
    accountId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    kind: MarchKind,
    troops: number,
    teamId?: string,
  ): Promise<MarchView> {
    const { cols, now } = this.deps;
    if (!MARCHABLE_KINDS.has(kind)) {
      throw new SlgError('NOT_IMPLEMENTED', `March kind ${kind} is not implemented (siege S8-3)`);
    }
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    if (!this.inBounds(fromX, fromY) || !this.inBounds(toX, toY)) {
      throw new SlgError('OUT_OF_RANGE', 'Coordinates out of bounds');
    }
    // Siege with a team (G3-2c): draw the army from the saved attack formation template; committed troops = sum of troops assigned to each unit.
    // The team can be edited after departure without affecting the in-transit march (the army snapshot is persisted with MarchDoc). Not attack or no team → use flat troops.
    let army: ArmyEntry[] | undefined;
    if (kind === 'attack' && teamId) {
      const team = (pw.teams ?? []).find((t) => t.id === teamId);
      if (!team || team.army.length === 0) throw new SlgError('BAD_REQUEST', 'Team does not exist or is empty');
      army = team.army;
      troops = team.army.reduce((s, e) => s + Math.max(1, Math.floor(e.initialHp ?? 0)), 0);
    }
    if (!Number.isFinite(troops) || troops < MARCH_MIN_TROOPS) {
      throw new SlgError('NO_TROOPS', 'Invalid march troop count');
    }
    troops = Math.floor(troops);
    if (kind === 'occupy' && troops < OCCUPY_MIN_TROOPS) {
      throw new SlgError('NO_TROOPS', `Occupation requires at least ${OCCUPY_MIN_TROOPS} troops`);
    }

    const fromTid = tileId(worldId, fromX, fromY);
    const fromTile = await cols.tiles.findOne({ _id: fromTid });
    if (!fromTile || fromTile.ownerId !== accountId) {
      throw new SlgError('TILE_NOT_OWNED', 'Can only march from your own tile');
    }

    // Validate the target tile at departure (will be re-validated on arrival since state may have changed).
    const toTid = tileId(worldId, toX, toY);
    const proc = proceduralTile(worldId, toX, toY);
    if (proc.type === 'obstacle') throw new SlgError('BAD_REQUEST', 'Cannot march into obstacle terrain');
    const toTile = await cols.tiles.findOne({ _id: toTid });
    let defenderId: string | undefined; // attack: the attacked player's accountId (under_attack warning is pushed immediately on departure)
    if (kind === 'occupy') {
      if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'Cannot directly occupy the world center');
      // Stronghold (G8 §3.1): guarded by an extremely powerful system NPC; cannot be directly occupied — must be captured via attack siege.
      if (proc.type === 'stronghold' && !toTile?.ownerId) {
        throw new SlgError('TILE_OCCUPIED', 'Strongholds cannot be directly occupied; use attack siege to capture');
      }
      if (toTile?.ownerId === accountId) throw new SlgError('TILE_OCCUPIED', 'This tile is already your territory (use reinforce)');
      if (toTile?.ownerId) {
        if (toTile.protectedUntil && toTile.protectedUntil > now()) {
          throw new SlgError('PROTECTED', 'Target tile is under protection');
        }
        throw new SlgError('TILE_OCCUPIED', 'This tile is already occupied (use attack siege to take it)');
      }
    } else if (kind === 'reinforce') {
      if (!toTile || toTile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', 'Can only reinforce your own tile');
    } else if (kind === 'attack') {
      // Siege: target must be another player's territory/capital, or an ownerless stronghold (G8 PvE to defeat the system garrison). Use occupy/sweep for neutral ownerless tiles.
      if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'World center is contested by sects and cannot be sieged');
      if (!toTile?.ownerId) {
        // No owner: only strongholds can be sieged (defeating the ultra-strong system NPC); all other ownerless tiles use occupy/sweep.
        if (proc.type !== 'stronghold') throw new SlgError('TILE_NOT_OWNED', 'Siege target has no owner (use occupy/sweep)');
        // Stronghold PvE: leave defenderId unset (NPC does not receive an under_attack warning).
      } else {
        if (toTile.ownerId === accountId) throw new SlgError('TILE_OCCUPIED', 'Cannot siege your own territory');
        if (toTile.protectedUntil && toTile.protectedUntil > now()) {
          throw new SlgError('PROTECTED', 'Target tile is under protection');
        }
        defenderId = toTile.ownerId;
      }
      if (troops < OCCUPY_MIN_TROOPS) throw new SlgError('NO_TROOPS', `Siege requires at least ${OCCUPY_MIN_TROOPS} troops`);
    } else if (kind === 'scout') {
      // Scout: no fighting or occupation; send a small force to any non-obstacle tile (including enemy/protected/neutral/center) to reveal vision, then auto-return.
      // No ownership/center/protection-period restriction — blocking obstacle terrain above is sufficient. No defenderId (no under_attack warning).
    } else {
      // sweep: clear NPC garrison from neutral / resource tiles (no occupation; loot is carried back on return).
      if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'Cannot sweep the world center');
      // Stronghold (G8): ultra-strong system garrison; cannot be swept for loot — must be captured via attack siege.
      if (proc.type === 'stronghold') throw new SlgError('TILE_OCCUPIED', 'Strongholds must be captured via attack siege; sweeping is not allowed');
      if (toTile?.ownerId) throw new SlgError('TILE_OCCUPIED', 'Target is already occupied (use attack siege to take it)');
    }

    const t = now();
    const resources = this.settle(pw, t);
    if (pw.troops < troops) throw new SlgError('NO_TROOPS', 'Insufficient troops');

    const path = await this.computeMarchPath(worldId, fromX, fromY, toX, toY, accountId);
    const departAt = t;
    const arriveAt = departAt + marchDurationFromPath(path) * 1000;
    const mid = marchId(worldId, accountId, departAt, ++this.marchSeq);
    const doc: MarchDoc = {
      _id: mid,
      worldId,
      ownerId: accountId,
      fromTile: fromTid,
      toTile: toTid,
      kind,
      troops,
      ...(army && army.length > 0 ? { army } : {}),
      // ADR-026: record the deployed team slot so it is skipped as a defender while out (only meaningful for team-based attacks).
      ...(kind === 'attack' && teamId ? { teamId } : {}),
      departAt,
      arriveAt,
      status: 'marching',
      rev: 0,
    };
    await cols.marches.insertOne(doc);
    // Deduct troops on departure (in-transit; not in the pool).
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { resources, lastTickAt: t }, $inc: { troops: -troops, rev: 1 } },
    );
    await this.scheduleMarch(worldId, mid, arriveAt);
    const view = this.marchView(doc);
    void this.pushMarch(accountId, view);
    // G5-2 reverse vision push: push this march to observers whose vision covers its path (enemy march entering your vision triggers a push, V4).
    // Reuse the already-computed path; one reverse query (not per tick). The defender (attack) already receives under_attack separately, so exclude them from observers.
    const observers = await this.visionObservers(worldId, path, new Set([accountId, ...(defenderId ? [defenderId] : [])]));
    for (const acct of observers) void this.pushMarch(acct, view);
    // Siege: push an under_attack warning to the defender immediately on departure (§5 / §14.5).
    if (kind === 'attack' && defenderId) {
      const did = defenderId;
      void (this.meta.available
        ? this.meta.getProfile(accountId).catch(() => null)
        : Promise.resolve(null)
      ).then((p) => this.gateway.push(did, {
        kind: 'under_attack',
        tile: toTid,
        attackerName: p?.displayName ?? '',
        attackerPublicId: p?.publicId ?? '',
        arriveAt,
        troopsHint: troops,
      }));
    }
    return view;
  }

  /**
   * Recall a march: flip an in-transit outbound march into a return leg (troops travel back to the origin tile and are refunded to the troop pool).
   * Return travel time = time already elapsed (min(elapsed, total)). Troops are refunded on the return arrival. Already arrived / already recalled → MARCH_NOT_FOUND.
   */
  async recallMarch(worldId: string, accountId: string, mid: string): Promise<MarchView> {
    const { cols, now } = this.deps;
    const m = await cols.marches.findOne({ _id: mid, worldId, ownerId: accountId });
    if (!m || m.status !== 'marching' || m.kind === 'return') {
      throw new SlgError('MARCH_NOT_FOUND', 'March not found or cannot be recalled');
    }
    const t = now();
    const total = m.arriveAt - m.departAt;
    const traveled = Math.max(0, Math.min(t - m.departAt, total));
    const backArrive = t + traveled;
    // Atomic claim (prevents race with arrival processing): only an outbound march still in 'marching' state is flipped to a return leg.
    const claimed = await cols.marches.findOneAndUpdate(
      { _id: mid, status: 'marching', kind: { $ne: 'return' } },
      {
        $set: {
          kind: 'return',
          fromTile: m.toTile,
          toTile: m.fromTile,
          departAt: t,
          arriveAt: backArrive,
        },
        $inc: { rev: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!claimed) throw new SlgError('MARCH_NOT_FOUND', 'March has already arrived or been recalled');
    await this.scheduleMarch(worldId, mid, backArrive); // update score on the same member (ZSET)
    const view = this.marchView(claimed);
    void this.pushMarch(accountId, view);
    return view;
  }

  /** List of all in-transit marches in the player's current world (the scheduler deletes them on arrival, so all results are marches that have not yet arrived). */
  async getMarches(worldId: string, accountId: string): Promise<MarchView[]> {
    const { cols, mapW, mapH, now } = this.deps;
    const own = await cols.marches.find({ worldId, ownerId: accountId }).sort({ arriveAt: 1 }).toArray();
    const result: MarchView[] = own.map((d) => ({ ...this.marchView(d), mine: true }));

    // G5: enemy marches within vision (after reverse-push, the client renders these via refreshMarches). Family ally marches are excluded
    // (ally determination relies on the family set); only genuinely non-family others' in-transit marches whose interpolated current position falls within our vision are included.
    const family = await this.familyMemberIds(worldId, accountId);
    const sources = await this.computeVisionSources(worldId, accountId, 0, mapW - 1, 0, mapH - 1);
    const t = now();
    const others = await cols.marches.find({ worldId, status: 'marching' }).toArray();
    for (const d of others) {
      if (family.has(d.ownerId)) continue; // own / family — no duplicate and not treated as enemy
      const pos = marchInterpPos(
        this.coordX(d.fromTile), this.coordY(d.fromTile),
        this.coordX(d.toTile), this.coordY(d.toTile),
        d.departAt, d.arriveAt, t,
      );
      if (isInVision(sources, pos.x, pos.y)) result.push({ ...this.marchView(d), mine: false });
    }
    return result;
  }

  /**
   * Arrival processing: scan all in-transit marches with arriveAt ≤ now, atomically claim them (findOneAndDelete), then apply effects by kind.
   * The Mongo `arriveAt` index scan is authoritative (works across worlds and without Redis); the Redis ZSET is only a precise wake-up hint
   * (maintained by scheduleMarch, §14.4). Returns the number of marches processed. worldsvc single-consumer (U12; single-process is acceptable for early stage).
   */
  async processDueArrivals(nowMs?: number): Promise<number> {
    const { cols } = this.deps;
    const t = nowMs ?? this.deps.now();
    const due = await cols.marches
      .find({ status: 'marching', arriveAt: { $lte: t } })
      .limit(500)
      .toArray();
    let n = 0;
    for (const m of due) {
      // Atomic claim + delete (transient document consumed on arrival); skip if lost to a recall or concurrent processor.
      const claimed = await cols.marches.findOneAndDelete({ _id: m._id, status: 'marching' });
      if (!claimed) continue;
      await this.unscheduleMarch(claimed.worldId, claimed._id);
      await this.applyArrival(claimed, t);
      n++;
    }
    return n;
  }

  /**
   * ADR-026: settle due delayed building-HP hits (scheduler, every tick; mirrors processDueArrivals). Each SiegeDamageDoc whose
   * dueAt has passed deducts its attacking team's siege value from the target building's HP; at HP≤0 the building is captured
   * (main base → passiveRelocate; other buildings → hand over). Atomic claim-and-delete makes it single-consumer safe.
   */
  async processDueSiegeDamage(nowMs?: number): Promise<number> {
    const { cols } = this.deps;
    const t = nowMs ?? this.deps.now();
    const due = await cols.siegeDamage.find({ dueAt: { $lte: t } }).limit(500).toArray();
    let n = 0;
    for (const d of due) {
      const claimed = await cols.siegeDamage.findOneAndDelete({ _id: d._id });
      if (!claimed) continue; // lost to a concurrent processor
      await this.unscheduleSiegeDamage(claimed.worldId, claimed._id);
      try {
        await this.settleSiegeDamage(claimed, t);
      } catch (e) {
        console.error('[worldsvc] settleSiegeDamage failed:', { id: claimed._id, err: (e as Error).message });
      }
      n++;
    }
    return n;
  }

  /**
   * Apply one delayed building-HP hit (ADR-026 §4/§6). Deducts damage from the target building's HP (anchor for a base);
   * HP survives → persist reduced HP + refund attacker survivors; HP≤0 → capture (loot + main-base passiveRelocate, or
   * hand over a non-base building). If the target is no longer the same owner / is protected / gone, the hit is voided and
   * attacker survivors are refunded.
   */
  private async settleSiegeDamage(d: SiegeDamageDoc, t: number): Promise<void> {
    const { cols } = this.deps;
    const defenderId = d.defenderId;
    const tile = await cols.tiles.findOne({ _id: d.tile });
    const attacker = await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, d.attackerId) });

    // Target must still be the same owner and unprotected; otherwise the siege is stale → void damage, return besiegers.
    const stale = !tile || !defenderId || tile.ownerId !== defenderId || (tile.protectedUntil != null && tile.protectedUntil > t);
    if (stale) {
      if (attacker && d.attackerSurvivors > 0) await this.refundTroops(attacker, d.attackerSurvivors, t);
      return;
    }

    const maxHp = buildingMaxHp(tile.level ?? 1);
    const curHp = tile.hp ?? maxHp;
    const newHp = curHp - Math.max(0, Math.floor(d.damage));

    if (newHp > 0) {
      // Building survives: reduce HP; besiegers return to the pool.
      await cols.tiles.updateOne({ _id: d.tile }, { $set: { hp: newHp }, $inc: { rev: 1 } });
      if (attacker && d.attackerSurvivors > 0) await this.refundTroops(attacker, d.attackerSurvivors, t);
      const after = await cols.tiles.findOne({ _id: d.tile });
      if (after) { void this.pushTile(d.attackerId, after); void this.pushTile(defenderId, after); }
      return;
    }

    // HP depleted → capture. Loot first (settles both sides' resources).
    const defender = await cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, defenderId) });
    if (attacker && defender) await this.transferLoot(defender, attacker, t);

    if (d.isBase) {
      // Main base captured: it cannot be permanently held → besiegers return; sect-leader penalty; passive relocation
      // (all territory lost + shield + a fresh full-HP base at a random tile).
      if (attacker && d.attackerSurvivors > 0) await this.refundTroops(attacker, d.attackerSurvivors, t);
      await this.applySectLeaderPenalty(d.worldId, defenderId, t);
      await this.passiveRelocate(d.worldId, defenderId, t);
    } else {
      // Non-base building handed over: survivors become the new garrison; HP resets to full for the new owner.
      await cols.tiles.updateOne(
        { _id: d.tile },
        {
          $set: { type: 'territory', ownerId: d.attackerId, garrison: d.attackerSurvivors, hp: maxHp },
          $unset: { protectedUntil: '' },
          $inc: { rev: 1 },
        },
      );
      const atkYield = await this.recomputeYield(d.worldId, d.attackerId);
      if (attacker) await cols.playerWorld.updateOne({ _id: attacker._id }, { $set: { yieldRate: atkYield, lastTickAt: t }, $inc: { rev: 1 } });
      const defYield = await this.recomputeYield(d.worldId, defenderId);
      await cols.playerWorld.updateOne({ _id: playerWorldId(d.worldId, defenderId) }, { $set: { yieldRate: defYield }, $inc: { rev: 1 } });
      void this.applyNationChange(d.worldId, tile.x, tile.y, d.attackerId, attacker?.familyId);
    }

    const after = await cols.tiles.findOne({ _id: d.tile });
    if (after) { void this.pushTile(d.attackerId, after); void this.pushTile(defenderId, after); }
  }

  /** Apply the effects of a single arrived march (already removed from marches collection). */
  /**
   * Increment family activity by delta and refresh prosperity (§17.4, server-authoritative, no client write path).
   * Best-effort: failure is logged but does not block the main occupy/siege flow. familyId absent (solo player) → skip.
   */
  private async bumpFamilyActivity(worldId: string, familyId: string | undefined, delta: number): Promise<void> {
    if (!familyId) return;
    try {
      await this.socialsvc.bumpActivity(familyId, delta);
      await refreshFamilyProsperity(this.deps.cols, this.socialsvc, worldId, familyId);
    } catch (e) {
      console.error('[worldsvc] bumpFamilyActivity failed', { worldId, familyId, err: (e as Error).message });
    }
  }

  private async applyArrival(m: MarchDoc, t: number): Promise<void> {
    const { cols } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(m.worldId, m.ownerId) });
    if (!pw) return; // player state missing (should not happen); troops are lost with it; exit safely.

    if (m.kind === 'return') {
      await this.refundTroops(pw, m.troops, t);
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'recalled' }));
      return;
    }

    if (m.kind === 'attack') {
      await this.applySiege(m, pw, t);
      return;
    }

    if (m.kind === 'sweep') {
      await this.applySweep(m, pw, t);
      return;
    }

    if (m.kind === 'scout') {
      await this.autoReturnScout(m, t);
      return;
    }

    if (m.kind === 'occupy') {
      const proc = proceduralTile(m.worldId, this.coordX(m.toTile), this.coordY(m.toTile));
      const occ = await cols.tiles.findOne({ _id: m.toTile });
      const blocked =
        proc.type === 'center' ||
        (occ?.ownerId && occ.ownerId !== m.ownerId) ||
        (occ?.ownerId === m.ownerId && occ.type !== 'base'); // already own territory (base is the exception, but the march would never reach here for base)
      if (blocked) {
        // Target is occupied or non-occupiable on arrival → troops refunded to the pool immediately (S8-3 could instead use a return march).
        await this.refundTroops(pw, m.troops, t);
        void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'recalled' }));
        return;
      }
      const x = this.coordX(m.toTile);
      const y = this.coordY(m.toTile);
      const tileDoc: TileDoc = {
        _id: m.toTile,
        worldId: m.worldId,
        x,
        y,
        type: 'territory',
        level: proc.level,
        ...(proc.resType ? { resType: proc.resType } : {}),
        ownerId: m.ownerId,
        garrison: m.troops,
        rev: 0,
      };
      await cols.tiles.updateOne({ _id: m.toTile }, { $set: tileDoc }, { upsert: true });
      // Troops were already deducted on departure → do not modify the pool again; only update the yield rate.
      const resources = this.settle(pw, t);
      const yieldRate = await this.recomputeYield(m.worldId, m.ownerId);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, yieldRate, lastTickAt: t }, $inc: { rev: 1 } },
      );
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'arrived' }));
      void this.pushTile(m.ownerId, tileDoc);
      await this.pushTileToObservers(tileDoc, new Set([m.ownerId])); // G5-2: occupation arrival is visible to observers
      // Capital tile occupied → trigger nation founding (S8-6.5)
      void this.applyNationChange(m.worldId, x, y, m.ownerId, pw.familyId);
      // §17.4 activity increment: occupying new territory → occupier's family +1 (including prosperity refresh).
      void this.bumpFamilyActivity(m.worldId, pw.familyId, 1);
      return;
    }

    // reinforce
    const target = await cols.tiles.findOne({ _id: m.toTile });
    if (!target || target.ownerId !== m.ownerId) {
      // Reinforcement target is no longer own territory (captured / abandoned) → refund troops.
      await this.refundTroops(pw, m.troops, t);
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'recalled' }));
      return;
    }
    await cols.tiles.updateOne({ _id: m.toTile }, { $inc: { garrison: m.troops, rev: 1 } });
    void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'arrived' }));
    const after = await cols.tiles.findOne({ _id: m.toTile });
    if (after) void this.pushTile(m.ownerId, after);
  }

  // ── S8-3: siege / sweep arrival settlement (cheap formula, §5.3; decisive battles use engine re-computation in S8-3b via judge) ──

  /**
   * Siege another player's territory/capital (attack arrival). On arrival, re-validate that the target is still enemy-owned and unprotected; otherwise refund troops.
   * Cheap linear settlement resolveSiege(attacker troops, garrison):
   *   - attacker_win + territory → tile changes hands (survivors become the new garrison) + loot defeated player's resources + both sides recompute yield;
   *   - attacker_win + base      → capital cannot be permanently taken: garrison wiped + defeated player gets a protection shield + loot taken + attacker survivors return to troop pool;
   *   - defender_win             → all attacker committed troops destroyed (already deducted on departure, not refunded) + defender garrison takes casualties.
   */
  private async applySiege(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
    const { cols } = this.deps;
    const target = await cols.tiles.findOne({ _id: m.toTile });
    // Stronghold PvE capture (G8 §3.1): target has no owner and procedural type is stronghold → fight the ultra-strong system NPC garrison;
    // victory captures it as territory + grants a one-time rich reward; defeat causes surviving attackers to retreat and return. Intercept before the "miss and refund" branch.
    if (!target?.ownerId) {
      const proc = proceduralTile(m.worldId, this.coordX(m.toTile), this.coordY(m.toTile));
      if (proc.type === 'stronghold') {
        await this.applyStrongholdSiege(m, pw, t, proc);
        return;
      }
    }
    // On arrival, target is no longer enemy-owned (abandoned / transferred to own / ownerless) or is now protected → treat as a miss; refund and return troops.
    if (
      !target?.ownerId ||
      target.ownerId === m.ownerId ||
      (target.protectedUntil && target.protectedUntil > t)
    ) {
      await this.refundTroops(pw, m.troops, t);
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'recalled' }));
      return;
    }

    const defenderId = target.ownerId;
    // ADR-025 unified defense: attacking ANY of the 9 base cells besieges the whole base. If the attacker
    // landed on a ring cell, resolve garrison + defense config against the ANCHOR (which holds them); the
    // attacker still marched to m.toTile. Falls back to target if the anchor is somehow missing.
    const baseTile = target.baseRing
      ? ((await cols.tiles.findOne({ _id: target.baseAnchor })) ?? target)
      : target;
    // Nation defense bonus (§2.4 / G1): if the garrison tile is within the Voronoi region of a capital the defender occupies → effective garrison strength is increased.
    const capIdx = nearestCapitalIdx(baseTile.x, baseTile.y, this.capitals);
    const nation = await cols.nations.findOne({ _id: `nation:${m.worldId}:${capIdx}` });
    const inOwnNation = !!nation?.ownerId && nation.ownerId === defenderId;
    const effGarrison = nationDefenseStrength(baseTile.garrison ?? 0, inOwnNation);

    // E8/CC-3: fetch attacker's progression snapshot early (needed for card army resolution + blueprint injection).
    const attackerSave = await this.meta.getSaveFields(m.ownerId).catch(() => null);

    // Attacker formation (G3-2c): marched with a team → use the real formation snapshot (m.army); otherwise synthesize from flat troop count as fallback (v1 bridge).
    // CC-3: when army entries carry cardInstanceId, resolve to engine GarrisonEntry[] via cardState.currentTroops + CARD_DEFS.unitType.
    const rawArmy = m.army ?? [];
    const hasCardArmy = rawArmy.some((e) => !!e.cardInstanceId);
    const attackerArmy: GarrisonEntry[] =
      hasCardArmy
        ? resolveCardArmy(rawArmy, pw.cardState ?? {}, attackerSave?.cardInv ?? {})
        : (rawArmy.length > 0 ? (rawArmy as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker'));
    // CC-3: extract EngineCardInstance[] from the attacker's card army for blueprint injection (level + gear); shared by both paths.
    let cardInstances: EngineCardInstance[] | undefined;
    let cardEquipInv: EngineEquipInv | undefined;
    if (hasCardArmy && attackerSave) {
      const { cardInstances: ci, engEquipInv } = toEngineCardInstances(rawArmy, attackerSave.cardInv, attackerSave.equipmentInv);
      cardInstances = ci;
      cardEquipInv = engEquipInv;
    }
    // P2 academy: attacker's academy building gives a seasonal blueprint HP/damage buff (both paths).
    const atkAcademy = academyBuff(pw.buildings);
    const siegeAcademy = (atkAcademy.hp > 0 || atkAcademy.damage > 0) ? atkAcademy : undefined;

    // Fetch defender world state before the battle (wave teams, wall/academy buffs, cabinet loot protection).
    const defender = await cols.playerWorld.findOne({ _id: playerWorldId(m.worldId, defenderId) });

    // C7/§17.9: mid-season engine drift detection (non-blocking; warning only — replays may drift frame by frame; ops treatment in §17.9).
    const wv = await cols.worlds.findOne({ _id: m.worldId }, { projection: { engineVersion: 1 } });
    if (wv?.engineVersion != null && wv.engineVersion !== ENGINE_VERSION) {
      console.warn('[worldsvc] siege engineVersion drift (engine upgraded mid-season without reopening the shard)', {
        worldId: m.worldId, pinned: wv.engineVersion, runtime: ENGINE_VERSION,
      });
    }

    // ADR-026: a main base uses the wave-defender + building-HP + delayed-siege-value model. Attacking any of the 9
    // footprint cells lands here with target.type==='base' (anchor resolution already done above); territory tiles keep
    // the pre-ADR-026 single-battle instant path below.
    if (target.type === 'base') {
      await this.applyBaseSiege(
        m, pw, baseTile, defenderId, defender, inOwnNation,
        attackerArmy, cardInstances, cardEquipInv, siegeAcademy, t,
      );
      return;
    }

    // ── Territory tile (non-base): single deterministic battle + immediate settlement (unchanged, §16) ──
    const defenderConfig = this.buildDefenderConfig(baseTile, effGarrison, inOwnNation);
    const tileLevel = baseTile.level ?? 1;
    const seed = siegeSeedFromId(m._id);

    // Bad formation / engine error → fall back to cheap resolveSiege; a single siege must never stall a march.
    let res: SiegeResolution;
    let replay: SiegeReplayInputs | null = { seed, attackerArmy, defenderConfig, tileLevel };
    try {
      res = runSiegeBattle({ attackerArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv, siegeAcademy });
    } catch (err) {
      console.error('[worldsvc] siege engine failed — fallback to cheap resolve', { tile: m.toTile, err: (err as Error).message });
      res = resolveSiege(m.troops, effGarrison);
      replay = null; // cheap fallback result is inconsistent with engine replay → do not store replay inputs (replay button degrades to hidden).
    }
    // Replay inputs: persisted to SiegeDoc; the client uses seed + both sides' formations to replay the battle locally for spectating (§16.3).
    await this.landSiege(m, pw, target, defenderId, defender, res, t, replay);
  }

  /**
   * ADR-026 main-base siege: in-base, non-injured defender teams (t1..t5) fight the attacker in waves; the attacker's
   * surviving troops carry over between waves. Clearing all defenders (or none present) is a garrison win → schedule a
   * delayed building-HP hit (SiegeDamageDoc, +SLG_SIEGE_DAMAGE_DELAY_MS) equal to the attacking team's siege value.
   * Each defeated defender team is injured for SLG_TEAM_INJURY_MS (never defends until healed). An attacker wiped
   * mid-waves fails the siege (no HP damage) and retreats immediately. The real building HP (TileDoc.hp on the anchor)
   * is only reduced later by processDueSiegeDamage → capture (passiveRelocate) at HP≤0.
   */
  private async applyBaseSiege(
    m: MarchDoc,
    pw: PlayerWorldDoc,
    baseTile: TileDoc,
    defenderId: string,
    defender: PlayerWorldDoc | null,
    inOwnNation: boolean,
    attackerArmy: GarrisonEntry[],
    cardInstances: EngineCardInstance[] | undefined,
    cardEquipInv: EngineEquipInv | undefined,
    siegeAcademy: { hp: number; damage: number } | undefined,
    t: number,
  ): Promise<void> {
    const { cols } = this.deps;
    const tileLevel = baseTile.level ?? 1;
    const wallMult = wallDefenseMult(defender?.buildings);

    // Teams currently out on active (non-recalled) marches are skipped as defenders (ADR-026 §2).
    const activeMarches = await cols.marches
      .find({ worldId: m.worldId, ownerId: defenderId, status: { $ne: 'recalled' }, teamId: { $exists: true } })
      .toArray();
    const outTeams = new Set(activeMarches.map((x) => x.teamId).filter((id): id is string => !!id));

    // Defender card inventory (resolve team card armies → unit type + troop count). v1: defender cards use base blueprints on defence (no per-card level/gear buff; follow-up).
    const defenderSave = await this.meta.getSaveFields(defenderId).catch(() => null);
    const defCardInv = defenderSave?.cardInv ?? {};
    const defCardState = defender?.cardState ?? {};
    const teamState = defender?.teamState ?? {};

    // In-base, non-injured teams in t1..t5 order.
    const defenders = (defender?.teams ?? [])
      .filter((tm) => tm.army.length > 0 && !outTeams.has(tm.id))
      .filter((tm) => !((teamState[tm.id]?.injuredUntil ?? 0) > t))
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));

    // Wave battle: attacker survivors carry over between waves (scaled by survival ratio).
    let survivorArmy: GarrisonEntry[] = attackerArmy.map((e) => ({ ...e }));
    let attackerSurvivors = sumArmyHp(survivorArmy);
    const defeatedTeamIds: string[] = [];
    const replays: SiegeReplayInputs[] = [];
    let cleared = true;

    for (let i = 0; i < defenders.length; i++) {
      const tm = defenders[i]!;
      if (survivorArmy.length === 0 || attackerSurvivors <= 0) { cleared = false; break; }
      let defArmy = resolveCardArmy(tm.army, defCardState, defCardInv);
      if (inOwnNation) defArmy = scaleArmyHp(defArmy, 1 + NATION_BONUS_DEFENSE); // §2.4 nation defence bonus
      if (wallMult > 1) defArmy = scaleArmyHp(defArmy, wallMult);               // P2 wall HP buff
      if (defArmy.length === 0) { defeatedTeamIds.push(tm.id); continue; }      // empty/stale team → already cleared (still injured)
      const defenderConfig = { garrison: defArmy };
      const seed = waveSeed(m._id, i);
      const deployedHp = sumArmyHp(survivorArmy);
      let res: SiegeResolution;
      try {
        res = runSiegeBattle({ attackerArmy: survivorArmy, defenderConfig, tileLevel, seed, cardInstances, equipmentInv: cardEquipInv, siegeAcademy });
      } catch (err) {
        console.error('[worldsvc] base wave siege engine failed — cheap fallback', { tile: baseTile._id, wave: i, err: (err as Error).message });
        res = resolveSiege(deployedHp, sumArmyHp(defArmy));
      }
      replays.push({ seed, attackerArmy: survivorArmy, defenderConfig, tileLevel });
      attackerSurvivors = res.attackerSurvivors;
      if (res.outcome === 'attacker_win') {
        defeatedTeamIds.push(tm.id);
        const ratio = deployedHp > 0 ? res.attackerSurvivors / deployedHp : 0;
        survivorArmy = scaleArmyByRatio(survivorArmy, ratio);
        if (survivorArmy.length === 0) { cleared = false; break; } // attacker spent — cleared some waves but cannot continue
      } else {
        cleared = false; // repelled by this wave
        break;
      }
    }

    // Persist defender team injuries (each defeated team locked for SLG_TEAM_INJURY_MS).
    if (defeatedTeamIds.length > 0 && defender) {
      const injSet: Record<string, unknown> = {};
      for (const id of defeatedTeamIds) injSet[`teamState.${id}.injuredUntil`] = t + SLG_TEAM_INJURY_MS;
      await cols.playerWorld.updateOne({ _id: playerWorldId(m.worldId, defenderId) }, { $set: injSet, $inc: { rev: 1 } });
    }

    const outcome: SiegeOutcome = cleared ? 'attacker_win' : 'defender_win';
    const replay = replays.length > 0 ? (replays[replays.length - 1] ?? null) : null;
    const siege = await this.recordSiege(m, defenderId, outcome, t, replay);

    // CC-3: attacker card post-battle state (uniform survival over the whole siege).
    const attackArmy = m.army ?? [];
    if (attackArmy.some((e) => !!e.cardInstanceId)) {
      const cardUpdates = computeCardStateUpdates(attackArmy, pw.cardState ?? {}, attackerSurvivors, t);
      const cardStateSet: Record<string, unknown> = {};
      for (const [id, update] of Object.entries(cardUpdates)) {
        cardStateSet[`cardState.${id}.currentTroops`] = update.currentTroops;
        cardStateSet[`cardState.${id}.injuredUntil`] = update.injuredUntil != null ? update.injuredUntil : null;
      }
      if (Object.keys(cardStateSet).length > 0) {
        await cols.playerWorld.updateOne({ _id: pw._id }, { $set: cardStateSet, $inc: { rev: 1 } });
      }
    }

    if (cleared) {
      // Garrison cleared (or no defenders present): schedule the delayed building-HP hit = attacking team's siege value.
      // Attacker keeps besieging; survivors are refunded at settlement (processDueSiegeDamage). Card-less flat-troop attacks deal 0 (bases require a real card team).
      const damage = teamSiegeValue(m.army ?? []);
      const dmg: SiegeDamageDoc = {
        _id: siege._id,
        worldId: m.worldId,
        attackerId: m.ownerId,
        defenderId,
        tile: baseTile._id,
        isBase: true,
        damage,
        attackerSurvivors,
        ...(pw.familyId ? { familyId: pw.familyId } : {}),
        dueAt: t + SLG_SIEGE_DAMAGE_DELAY_MS,
      };
      await cols.siegeDamage.updateOne({ _id: dmg._id }, { $setOnInsert: dmg }, { upsert: true });
      await this.scheduleSiegeDamage(m.worldId, dmg._id, dmg.dueAt);
    } else {
      // Attacker repelled: survivors retreat and return to the troop pool immediately.
      if (attackerSurvivors > 0) await this.refundTroops(pw, attackerSurvivors, t);
    }

    // Activity + battle-report push (loot only happens at capture, in settleSiegeDamage → empty here).
    void this.bumpFamilyActivity(m.worldId, pw.familyId, 1);
    void this.bumpFamilyActivity(m.worldId, defender?.familyId, 1);
    const lootStr = lootSummary(emptyResources());
    void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'arrived' }));
    void this.pushSiege(m.ownerId, siege, lootStr);
    void this.pushSiege(defenderId, siege, lootStr);
  }

  /**
   * Stronghold PvE siege capture (G8 §3.1): an ownerless stronghold tile; the system derives an ultra-strong NPC garrison + high base from the tile level.
   * Uses the authoritative engine siege (bad formation / error → cheap fallback). Victory → write territory (survivors become garrison) + one-time rich resource reward + nation founding / activity refresh;
   * Defeat → surviving attackers retreat and return (NPC garrison is not persisted — procedural, not stored in DB; resets next time).
   * Defender is NPC throughout: no defenderId, no player loot, no protection shield.
   */
  private async applyStrongholdSiege(
    m: MarchDoc,
    pw: PlayerWorldDoc,
    t: number,
    proc: ProceduralTile,
  ): Promise<void> {
    const { cols } = this.deps;
    const x = this.coordX(m.toTile);
    const y = this.coordY(m.toTile);
    // Re-validate on arrival: already occupied by another player or self (including simultaneous captures) → skip NPC fight; refund troops as a miss.
    const occ = await cols.tiles.findOne({ _id: m.toTile });
    if (occ?.ownerId) {
      await this.refundTroops(pw, m.troops, t);
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'recalled' }));
      return;
    }

    const garrison = strongholdGarrison(proc.level);
    const attackerArmy: GarrisonEntry[] =
      m.army && m.army.length > 0 ? (m.army as GarrisonEntry[]) : synthesizeArmy(m.troops, 'attacker');
    // System ultra-strong default garrison + elevated base (defenderBaseLevel is derived and clamped by buildSiegeLevel from tileLevel).
    const defenderConfig = { garrison: synthesizeArmy(garrison, 'defender') };
    const tileLevel = proc.level;
    const seed = siegeSeedFromId(m._id);

    // E8: stronghold is also a PvE-like siege; attacker equipment applies in the same way.
    const attackerSave = await this.meta.getSaveFields(m.ownerId).catch(() => null);
    const siegeEquip: EngineEquipmentInput | undefined =
      attackerSave ? { gear: attackerSave.gear, inv: attackerSave.equipmentInv } : undefined;
    let res: SiegeResolution;
    let replay: SiegeReplayInputs | null = { seed, attackerArmy, defenderConfig, tileLevel };
    try {
      res = runSiegeBattle({
        attackerArmy, defenderConfig, tileLevel, seed,
        pveUpgrades: attackerSave?.pveUpgrades,
        unitLevels: attackerSave?.unitLevels,
        equipment: siegeEquip,
      });
    } catch (err) {
      console.error('[worldsvc] stronghold siege engine failed — fallback to cheap resolve', {
        tile: m.toTile,
        err: (err as Error).message,
      });
      res = resolveSiege(m.troops, garrison);
      replay = null;
    }

    if (res.outcome === 'attacker_win') {
      const tileDoc: TileDoc = {
        _id: m.toTile,
        worldId: m.worldId,
        x,
        y,
        type: 'territory',
        level: proc.level,
        ...(proc.resType ? { resType: proc.resType } : {}),
        ownerId: m.ownerId,
        garrison: res.attackerSurvivors,
        rev: 0,
      };
      await cols.tiles.updateOne({ _id: m.toTile }, { $set: tileDoc }, { upsert: true });
      // One-time capture reward (§3.1 "substantial resources"): add to the attacker's resource pool by tile level + resource type (capped).
      const rt: ResourceType = proc.resType ?? 'ink';
      const reward = emptyResources();
      reward[rt] = STRONGHOLD_LOOT_PER_LEVEL * Math.max(1, proc.level);
      const resources = this.settle(pw, t);
      for (const r of RESOURCE_TYPES) resources[r] = Math.min(RESOURCE_CAP, (resources[r] ?? 0) + reward[r]);
      const yieldRate = await this.recomputeYield(m.worldId, m.ownerId);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, yieldRate, lastTickAt: t }, $inc: { rev: 1 } },
      );
      // Extra progression material drop (§19.5 + G4 §15.6): sent to meta SaveData.materials unified pool (cross-process,
      // best-effort, orderId idempotent; march is settled once — (worldId, toTile, arriveAt) is stable as idempotent key).
      const matLoot = strongholdMaterialLoot(proc.level);
      void this.meta.grantMaterial(m.ownerId, matLoot.material, matLoot.qty, `stronghold_loot:${m.worldId}:${m.toTile}:${m.arriveAt}`);
      void this.applyNationChange(m.worldId, x, y, m.ownerId, pw.familyId);
      void this.bumpFamilyActivity(m.worldId, pw.familyId, 1);
      const siege = await this.recordSiege(m, undefined, res.outcome, t, replay);
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'arrived' }));
      void this.pushSiege(m.ownerId, siege, `${lootSummary(reward)},${matLoot.material}+${matLoot.qty}`);
      void this.pushTile(m.ownerId, tileDoc);
      await this.pushTileToObservers(tileDoc, new Set([m.ownerId])); // G5-2: stronghold capture arrival is visible to observers
    } else {
      // Capture failed: surviving attacker troops retreat and return to the troop pool (troops were deducted on departure; casualties are a permanent loss). NPC garrison is not persisted; no casualty write.
      if (res.attackerSurvivors > 0) await this.refundTroops(pw, res.attackerSurvivors, t);
      void this.bumpFamilyActivity(m.worldId, pw.familyId, 1);
      const siege = await this.recordSiege(m, undefined, res.outcome, t, replay);
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'arrived' }));
      void this.pushSiege(m.ownerId, siege, '');
    }
  }

  /**
   * Build the defender's formation for a siege (G3-2b): a custom formation (`tile.defense` contains a garrison array, written by the G3-2c editor) takes priority;
   * otherwise, synthesize a deterministic default formation from the effective garrison size (including nation bonus). Empty garrison (no custom + 0 troops) → null;
   * buildSiegeBattle derives a token base defense.
   *
   * Nation bonus (§2.4 / G1 item②, completed in G3-2c): when the garrison tile is within the defender's own capital Voronoi region (inOwnNation):
   * **synthesis path** already benefits by having extra units from effGarrison (troop count amplified by nationDefenseStrength);
   * **custom formation path** scales each unit's initialHp by (1+NATION_BONUS_DEFENSE) (scaleArmyHp, engine caps at full HP).
   */
  private buildDefenderConfig(
    target: TileDoc,
    effGarrison: number,
    inOwnNation: boolean,
  ): { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown } | null {
    const custom = target.defense as DefenseConfig | undefined;
    const customGarrison = custom && (custom as { garrison?: unknown }).garrison;
    if (Array.isArray(customGarrison) && customGarrison.length > 0) {
      const garrison = inOwnNation
        ? scaleArmyHp(customGarrison as GarrisonEntry[], 1 + NATION_BONUS_DEFENSE)
        : (customGarrison as GarrisonEntry[]);
      return { ...custom, garrison };
    }
    return effGarrison > 0 ? { garrison: synthesizeArmy(effGarrison, 'defender') } : null;
  }

  /**
   * Apply a single siege settlement result (G3-1 extraction, §16.4): write tile hand-off / loot / garrison / nation founding / passive relocation (attacker_win)
   * or defender garrison casualties (defender_win) according to res + record SiegeDoc + push march/siege/tile events.
   * Currently called immediately by `applySiege` (cheap settlement path unchanged); after G3-2 delayed settlement, both the judge re-computation confirmation and
   * the timeout fallback paths will share this single landing point.
   */
  private async landSiege(
    m: MarchDoc,
    pw: PlayerWorldDoc,
    target: TileDoc,
    defenderId: string,
    defender: PlayerWorldDoc | null,
    res: SiegeResolution,
    t: number,
    replay: SiegeReplayInputs | null,
  ): Promise<void> {
    const { cols } = this.deps;
    let loot = emptyResources();

    if (res.outcome === 'attacker_win') {
      // Loot the defeated player's resources (transfer a proportion from defender to attacker).
      if (defender) loot = await this.transferLoot(defender, pw, t);

      if (target.type === 'base') {
        // The capital cannot be permanently taken, but being defeated triggers passive relocation (§3.4/§8.2, applies to all players):
        //   1) attacker survivors return to the troop pool; 2) if the defender is a sect leader, all sect members lose 50% of resources (§8.2 major penalty);
        //   3) defender's capital is randomly relocated to a new empty tile + all currently occupied territory is lost (passiveRelocate).
        await this.refundTroops(pw, res.attackerSurvivors, t);
        await this.applySectLeaderPenalty(m.worldId, defenderId, t);
        await this.passiveRelocate(m.worldId, defenderId, t);
      } else {
        // Territory changes hands: survivors become the new garrison (troops were deducted on departure; do not modify the attacker pool again); both sides recompute yield.
        await cols.tiles.updateOne(
          { _id: m.toTile },
          {
            $set: { type: 'territory', ownerId: m.ownerId, garrison: res.attackerSurvivors },
            $unset: { protectedUntil: '' },
            $inc: { rev: 1 },
          },
        );
        const atkYield = await this.recomputeYield(m.worldId, m.ownerId);
        await cols.playerWorld.updateOne(
          { _id: pw._id },
          { $set: { yieldRate: atkYield, lastTickAt: t }, $inc: { rev: 1 } },
        );
        const defYield = await this.recomputeYield(m.worldId, defenderId);
        await cols.playerWorld.updateOne(
          { _id: playerWorldId(m.worldId, defenderId) },
          { $set: { yieldRate: defYield }, $inc: { rev: 1 } },
        );
        // Capital tile captured → nation changes hands (S8-6.5)
        void this.applyNationChange(m.worldId, target.x, target.y, m.ownerId, pw.familyId);
      }
    } else {
      // Defender wins: garrison reduced to survivors; attacker survivors retreat and return to the troop pool (§16.5 survivor refund; engine provides real survivors);
      // fallen troops are permanently lost. On the cheap fallback path where attackerSurvivors=0, there is naturally no return march; behavior is unchanged.
      await cols.tiles.updateOne(
        { _id: m.toTile },
        { $set: { garrison: res.defenderSurvivors }, $inc: { rev: 1 } },
      );
      if (res.attackerSurvivors > 0) await this.refundTroops(pw, res.attackerSurvivors, t);
    }

    const siege = await this.recordSiege(m, defenderId, res.outcome, t, replay);

    // CC-3: write post-battle cardState (currentTroops + injuredUntil) for attacker card army.
    const attackArmy = m.army ?? [];
    if (attackArmy.some((e) => !!e.cardInstanceId)) {
      const cardUpdates = computeCardStateUpdates(attackArmy, pw.cardState ?? {}, res.attackerSurvivors, t);
      const cardStateSet: Record<string, unknown> = {};
      for (const [id, update] of Object.entries(cardUpdates)) {
        cardStateSet[`cardState.${id}.currentTroops`] = update.currentTroops;
        if (update.injuredUntil != null) cardStateSet[`cardState.${id}.injuredUntil`] = update.injuredUntil;
        else cardStateSet[`cardState.${id}.injuredUntil`] = null; // clear stale injury
      }
      if (Object.keys(cardStateSet).length > 0) {
        await cols.playerWorld.updateOne({ _id: pw._id }, { $set: cardStateSet, $inc: { rev: 1 } });
      }
    }

    // §17.4 activity increment: siege (attacker / defender) → both sides' families +1 (landing point for decisive battles).
    void this.bumpFamilyActivity(m.worldId, pw.familyId, 1);
    void this.bumpFamilyActivity(m.worldId, defender?.familyId, 1);
    const lootStr = lootSummary(loot);
    void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'arrived' }));
    void this.pushSiege(m.ownerId, siege, lootStr);
    void this.pushSiege(defenderId, siege, lootStr);
    const after = await cols.tiles.findOne({ _id: m.toTile });
    if (after) {
      void this.pushTile(m.ownerId, after);
      void this.pushTile(defenderId, after);
      await this.pushTileToObservers(after, new Set([m.ownerId, defenderId])); // G5-2: tile hand-off is visible to observers within vision
    }
  }

  /**
   * Sweep NPC garrison from a neutral / resource tile (sweep arrival). No occupation: on success, loot resources + surviving troops return to the pool;
   * on failure, attacker troop losses (survivors still return to the pool, possibly 0). If the tile is already player-occupied on arrival → refund troops (miss).
   */
  /**
   * Scout march arrives at the target: no fighting or occupation; automatically flip to a return leg (same troops take the same route back to the origin tile, providing vision along the way);
   * on return arrival, troops are refunded to the troop pool. Return travel time = outbound travel time (symmetric approximation; avoids recomputing the path).
   */
  private async autoReturnScout(m: MarchDoc, t: number): Promise<void> {
    const { cols } = this.deps;
    const back: MarchDoc = {
      _id: marchId(m.worldId, m.ownerId, t, ++this.marchSeq),
      worldId: m.worldId,
      ownerId: m.ownerId,
      fromTile: m.toTile,
      toTile: m.fromTile,
      kind: 'return',
      troops: m.troops,
      departAt: t,
      arriveAt: t + Math.max(0, m.arriveAt - m.departAt),
      status: 'marching',
      rev: 0,
    };
    await cols.marches.insertOne(back);
    await this.scheduleMarch(m.worldId, back._id, back.arriveAt);
    void this.pushMarch(m.ownerId, this.marchView(back));
  }

  private async applySweep(m: MarchDoc, pw: PlayerWorldDoc, t: number): Promise<void> {
    const { cols } = this.deps;
    const occ = await cols.tiles.findOne({ _id: m.toTile });
    if (occ?.ownerId) {
      // Already occupied (should use attack) → miss; refund troops.
      await this.refundTroops(pw, m.troops, t);
      void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'recalled' }));
      return;
    }
    const proc = proceduralTile(m.worldId, this.coordX(m.toTile), this.coordY(m.toTile));
    const res = resolveSiege(m.troops, npcGarrison(proc.level));
    let loot = emptyResources();
    if (res.outcome === 'attacker_win') {
      const rt: ResourceType = proc.resType ?? 'ink';
      loot = emptyResources();
      loot[rt] = SWEEP_LOOT_PER_LEVEL * Math.max(1, proc.level);
    }
    // Surviving troops return (loot merged into attacker resources, capped).
    await this.refundTroops(pw, res.attackerSurvivors, t, loot);
    const siege = await this.recordSiege(m, undefined, res.outcome, t, null);
    void this.pushMarch(m.ownerId, this.marchView({ ...m, status: 'arrived' }));
    void this.pushSiege(m.ownerId, siege, lootSummary(loot));
  }

  /**
   * Record a siege battle report (transient record, §14.3 sieges). When replay is non-null (decisive siege ran through the engine), persist seed + both sides'
   * formations + tile level for client-side replay spectating (getSiegeReplay); cheap fallback / NPC sweep → replay=null (no replay available).
   */
  private async recordSiege(
    m: MarchDoc,
    defenderId: string | undefined,
    outcome: SiegeOutcome,
    t: number,
    replay: SiegeReplayInputs | null,
  ): Promise<SiegeDoc> {
    const doc: SiegeDoc = {
      _id: siegeId(m.worldId, m.ownerId, t, ++this.siegeSeq),
      worldId: m.worldId,
      attackerId: m.ownerId,
      ...(defenderId ? { defenderId } : {}),
      tile: m.toTile,
      outcome,
      recomputed: false,
      ts: t,
      ...(replay
        ? {
            seed: replay.seed,
            attackerArmy: replay.attackerArmy as ArmyEntry[],
            defenderConfig: (replay.defenderConfig as DefenseConfig | null) ?? null,
            tileLevel: replay.tileLevel,
          }
        : {}),
    };
    await this.deps.cols.sieges.insertOne(doc);
    return doc;
  }

  /** Transfer SIEGE_LOOT_RATE proportion of resources from the defeated player to the attacker (both sides settle + cap). Returns the actual amount looted. */
  private async transferLoot(
    defender: PlayerWorldDoc,
    attacker: PlayerWorldDoc,
    t: number,
  ): Promise<Record<ResourceType, number>> {
    const defRes = this.settle(defender, t);
    const loot = emptyResources();
    // P2 cabinet: protects a fraction of the defender's resources from being looted.
    const protection = cabinetLootProtect(defender.buildings);
    const effectiveLootRate = SIEGE_LOOT_RATE * (1 - protection);
    for (const rt of RESOURCE_TYPES) loot[rt] = Math.floor((defRes[rt] ?? 0) * effectiveLootRate);
    const defAfter = emptyResources();
    for (const rt of RESOURCE_TYPES) defAfter[rt] = Math.max(0, (defRes[rt] ?? 0) - loot[rt]);
    await this.deps.cols.playerWorld.updateOne(
      { _id: defender._id },
      { $set: { resources: defAfter, lastTickAt: t }, $inc: { rev: 1 } },
    );
    // Attacker receives the loot (merged after settling own production, capped).
    const atkRes = this.settle(attacker, t);
    for (const rt of RESOURCE_TYPES) atkRes[rt] = Math.min(RESOURCE_CAP, (atkRes[rt] ?? 0) + loot[rt]);
    await this.deps.cols.playerWorld.updateOne(
      { _id: attacker._id },
      { $set: { resources: atkRes, lastTickAt: t }, $inc: { rev: 1 } },
    );
    // Sync the in-memory attacker copy so subsequent code within the same settlement sees consistent state without re-settling (attacker is not read again after this point).
    attacker.resources = atkRes;
    attacker.lastTickAt = t;
    return loot;
  }

  /** Refund troops to the pool (capped at troopCap) + settle resources; optionally merge loot into resources (capped at RESOURCE_CAP). */
  private async refundTroops(
    pw: PlayerWorldDoc,
    troops: number,
    t: number,
    loot?: Record<ResourceType, number>,
  ): Promise<void> {
    const resources = this.settle(pw, t);
    if (loot) {
      for (const rt of RESOURCE_TYPES) {
        resources[rt] = Math.min(RESOURCE_CAP, (resources[rt] ?? 0) + (loot[rt] ?? 0));
      }
    }
    const next = Math.min(pw.troopCap, pw.troops + troops);
    await this.deps.cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { resources, troops: next, lastTickAt: t }, $inc: { rev: 1 } },
    );
  }

  /**
   * Sect leader capital-destruction penalty (§8.2): if defenderId is a sect leader, all sect members' current resources are multiplied by (1-RATE).
   * Each member is settled then reduced individually (large-scale write; U13 atomicity risk — single-process is acceptable for early stage; batch / transaction at scale).
   * Not a sect leader / no sect → no-op.
   */
  private async applySectLeaderPenalty(worldId: string, defenderId: string, t: number): Promise<void> {
    const { cols } = this.deps;
    const defPw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, defenderId) });
    if (!defPw?.familyId) return;
    const [fam] = await this.socialsvc.getFamiliesByIds([defPw.familyId]);
    if (!fam?.sectId) return;
    const sect = await cols.sects.findOne({ _id: fam.sectId });
    if (!sect || sect.leaderId !== defenderId) return; // only triggers when the sect leader's base is destroyed

    const memberFamilies = await this.socialsvc.getFamiliesBySect(sect._id);
    const famIds = memberFamilies.map((f) => f.familyId);
    if (famIds.length === 0) return;
    const members = await cols.playerWorld.find({ worldId, familyId: { $in: famIds } }).toArray();
    const keep = 1 - SECT_LEADER_PENALTY_RATE;
    for (const mm of members) {
      const resources = this.settle(mm, t);
      for (const rt of RESOURCE_TYPES) resources[rt] = Math.floor((resources[rt] ?? 0) * keep);
      await cols.playerWorld.updateOne(
        { _id: mm._id },
        { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
      );
    }
  }

  /**
   * Passive relocation (§3.4/§8.2): after the capital is destroyed, the defender's capital is randomly relocated to a new empty tile, and **all currently occupied territory is lost**.
   * Delete all of the player's own tiles (old capital + territory) → randomly pick a legal empty tile and write a new capital (with a protection shield) → update mainBaseTile +
   * recompute yield (only the new capital remains at this point). Garrison troops in lost territory are not refunded (losing territory means losing those troops — a severe penalty).
   */
  private async passiveRelocate(worldId: string, defenderId: string, t: number): Promise<void> {
    const { cols } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, defenderId) });
    if (!pw) return;

    // Lose territory: delete all of the player's own tiles (old capital + all territory); revert to procedural neutral.
    await cols.tiles.deleteMany({ worldId, ownerId: defenderId });

    // Place the new capital at a random legal empty tile. In the extreme case where none is found → skip relocation (territory already lost; player can still voluntarily relocate later).
    const spot = await this.pickRandomEmptyTile(worldId);
    if (!spot) {
      const yieldRate = await this.recomputeYield(worldId, defenderId);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { yieldRate, lastTickAt: t }, $unset: { mainBaseTile: '' }, $inc: { rev: 1 } },
      );
      return;
    }

    const newTid = tileId(worldId, spot.x, spot.y);
    // ADR-025: write the full 3×3 footprint (anchor garrison:0 + protection shield); ring cells carry the same shield.
    const baseDocs = this.baseTileDocs(worldId, spot.x, spot.y, defenderId, {
      garrison: 0,
      level: spot.level,
      ...(spot.resType ? { resType: spot.resType } : {}),
      protectedUntil: t + PROTECTION_SEC * 1000, // relocated to safety: apply protection shield
      ...(pw.familyId ? { familyId: pw.familyId } : {}),
    });
    await Promise.all(
      baseDocs.map((d) => cols.tiles.updateOne({ _id: d._id }, { $set: d }, { upsert: true })),
    );

    const yieldRate = await this.recomputeYield(worldId, defenderId);
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { yieldRate, mainBaseTile: newTid, lastTickAt: t }, $inc: { rev: 1 } },
    );
    const after = await cols.tiles.findOne({ _id: newTid });
    if (after) {
      void this.pushTile(defenderId, after);
      await this.pushTileToObservers(after, new Set([defenderId])); // G5-2: new capital after passive relocation is visible to observers
    }
  }

  /**
   * Pick a random legal empty tile (in bounds, not center/obstacle/gate/stronghold, unoccupied). Used for passive relocation placement and auto-spawn fallback.
   * When `minDr`>0, only accept tiles where dr (normalized distance to center, 0..1) > minDr (outer ring), keeping auto-spawns away from the central contest zone.
   * Server-authoritative random (not a replay path; Math.random is safe); tries up to a fixed number of times before returning null.
   */
  private async pickRandomEmptyTile(
    worldId: string,
    minDr = 0,
  ): Promise<{ x: number; y: number; level: number; resType?: ResourceType } | null> {
    const { mapW, mapH } = this.deps;
    const cx = mapW / 2;
    const cy = mapH / 2;
    const maxDist = Math.sqrt(cx * cx + cy * cy);
    for (let i = 0; i < 200; i++) {
      const x = Math.floor(Math.random() * mapW);
      const y = Math.floor(Math.random() * mapH);
      if (minDr > 0) {
        const dx = x - cx;
        const dy = y - cy;
        if (Math.sqrt(dx * dx + dy * dy) / maxDist <= minDr) continue; // too close to the center, skip
      }
      const proc = proceduralTile(worldId, x, y);
      if (
        proc.type === 'center' ||
        proc.type === 'obstacle' ||
        proc.type === 'gate' ||
        proc.type === 'stronghold' // stronghold system strongpoint; cannot be used as a capital respawn location (G8)
      ) {
        continue;
      }
      // ADR-025: a candidate anchor must host the whole 3×3 footprint (in bounds + all 9 cells free).
      if (!(await this.footprintFree(worldId, x, y, mapW, mapH))) continue;
      return { x, y, level: proc.level, ...(proc.resType ? { resType: proc.resType } : {}) };
    }
    return null;
  }

  /**
   * Auto-spawn point selection (§3.4, decided 2026-06-24; system auto-placement on first entry; placement strategy = prefer near family):
   *  1) Has a family → search outward ring by ring (Chebyshev distance) around each family member's capital for the first legal empty tile (radius ≤ SPAWN_NEAR_FAMILY_RADIUS);
   *     member order is randomly shuffled so new players don't always crowd the same member (core SLG clustering mechanic).
   *  2) Fall back to outer newbie ring random (dr > SPAWN_OUTER_MIN_DR, away from the central contest zone).
   *  3) Whole-map random fallback. If none found, return null (treated as world full / no empty tile).
   */
  private async pickSpawnTile(
    worldId: string,
    accountId: string,
    familyId?: string,
  ): Promise<{ x: number; y: number; level: number; resType?: ResourceType } | null> {
    const { cols } = this.deps;
    if (familyId) {
      const mates = await cols.playerWorld.find({ worldId, familyId }).project<{ accountId: string }>({ accountId: 1 }).toArray();
      const mateIds = mates.map((m) => m.accountId).filter((id): id is string => !!id && id !== accountId);
      if (mateIds.length > 0) {
        const bases = await cols.tiles.find({ worldId, type: 'base', ownerId: { $in: mateIds } }).toArray();
        for (const b of this.shuffled(bases)) {
          const spot = await this.spiralFindEmpty(worldId, b.x, b.y, SPAWN_NEAR_FAMILY_RADIUS);
          if (spot) return spot;
        }
      }
    }
    return (await this.pickRandomEmptyTile(worldId, SPAWN_OUTER_MIN_DR)) ?? (await this.pickRandomEmptyTile(worldId));
  }

  /**
   * Starting from (ox,oy), search ring by ring (Chebyshev distance 1..maxR) for the first legal empty tile (in bounds, not center/obstacle/gate/stronghold, unoccupied).
   * Candidates within each ring are randomly shuffled so new family members don't line up in a fixed direction. Used by auto-spawn near family.
   */
  private async spiralFindEmpty(
    worldId: string,
    ox: number,
    oy: number,
    maxR: number,
  ): Promise<{ x: number; y: number; level: number; resType?: ResourceType } | null> {
    for (let r = 1; r <= maxR; r++) {
      const ring: [number, number][] = [];
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // only include tiles on this ring's border
          ring.push([ox + dx, oy + dy]);
        }
      }
      for (const [x, y] of this.shuffled(ring)) {
        if (!this.inBounds(x, y)) continue;
        const proc = proceduralTile(worldId, x, y);
        if (proc.type === 'center' || proc.type === 'obstacle' || proc.type === 'gate' || proc.type === 'stronghold') {
          continue;
        }
        // ADR-025: the candidate anchor must host the whole 3×3 footprint.
        if (!(await this.footprintFree(worldId, x, y, this.deps.mapW, this.deps.mapH))) continue;
        return { x, y, level: proc.level, ...(proc.resType ? { resType: proc.resType } : {}) };
      }
    }
    return null;
  }

  /** Fisher–Yates shuffle (not a replay path; Math.random is safe). Returns a new array; does not mutate the original. */
  private shuffled<T>(arr: T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }

  // ── Main-base 3×3 footprint helpers (ADR-025) ────────────────────

  /**
   * Build the 9 TileDocs for a base anchored (centered) at (ax,ay). The anchor is a full type:'base' tile
   * (garrison + level + optional resType), the 8 ring cells are type:'base' placeholders (ownerId + protection,
   * baseRing:true, baseAnchor→anchor tileId, level:1, no garrison/resType/yield). All are indivisible (ADR-025).
   */
  private baseTileDocs(
    worldId: string,
    ax: number,
    ay: number,
    ownerId: string,
    opts: { garrison?: number; level: number; resType?: ResourceType; protectedUntil?: number; familyId?: string },
  ): TileDoc[] {
    const anchorTid = tileId(worldId, ax, ay);
    const docs: TileDoc[] = [];
    for (const { x, y } of baseFootprintCells(ax, ay)) {
      const isAnchor = x === ax && y === ay;
      if (isAnchor) {
        docs.push({
          _id: anchorTid,
          worldId,
          x,
          y,
          type: 'base',
          level: opts.level,
          ...(opts.resType ? { resType: opts.resType } : {}),
          ownerId,
          ...(opts.familyId ? { familyId: opts.familyId } : {}),
          garrison: opts.garrison ?? GARRISON_PER_TILE,
          // ADR-026: the anchor holds the whole capital's building HP (= level × SLG_BASE_HP_PER_LEVEL).
          hp: buildingMaxHp(opts.level),
          ...(opts.protectedUntil ? { protectedUntil: opts.protectedUntil } : {}),
          rev: 0,
        });
      } else {
        docs.push({
          _id: tileId(worldId, x, y),
          worldId,
          x,
          y,
          type: 'base',
          level: 1,
          ownerId,
          ...(opts.familyId ? { familyId: opts.familyId } : {}),
          ...(opts.protectedUntil ? { protectedUntil: opts.protectedUntil } : {}),
          baseRing: true,
          baseAnchor: anchorTid,
          rev: 0,
        });
      }
    }
    return docs;
  }

  /**
   * True iff the whole 3×3 block anchored at (ax,ay) can host a base: fully in bounds, no cell is a
   * blocking/reserved procedural type (center/obstacle/gate/stronghold), and no cell is occupied by another
   * player. `ignoreOwnerId` excludes a player's own existing tiles (belt-and-suspenders for relocate).
   */
  private async footprintFree(
    worldId: string,
    ax: number,
    ay: number,
    mapW: number,
    mapH: number,
    opts?: { ignoreOwnerId?: string },
  ): Promise<boolean> {
    if (!baseFootprintInBounds(ax, ay, mapW, mapH)) return false;
    const cells = baseFootprintCells(ax, ay);
    for (const { x, y } of cells) {
      const proc = proceduralTile(worldId, x, y);
      if (proc.type === 'center' || proc.type === 'obstacle' || proc.type === 'gate' || proc.type === 'stronghold') {
        return false;
      }
    }
    const ids = cells.map(({ x, y }) => tileId(worldId, x, y));
    const existing = await this.deps.cols.tiles
      .find({ _id: { $in: ids } })
      .project<{ ownerId?: string }>({ ownerId: 1 })
      .toArray();
    for (const e of existing) {
      if (e.ownerId && e.ownerId !== opts?.ignoreOwnerId) return false;
    }
    return true;
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /** Lazy resource settlement: resources += yieldRate × dt (hours), capped at the cabinet-adjusted storage cap (SLG_CITY_DESIGN). */
  private settle(doc: PlayerWorldDoc, now: number): Record<ResourceType, number> {
    const dtHours = Math.max(0, (now - doc.lastTickAt) / 3_600_000);
    const cap = resourceCapFor(doc.buildings);
    const out = emptyResources();
    for (const rt of RESOURCE_TYPES) {
      const settled = (doc.resources[rt] ?? 0) + (doc.yieldRate[rt] ?? 0) * dtHours;
      out[rt] = Math.min(cap, Math.floor(settled));
    }
    return out;
  }

  /** Aggregate a list of {type,level,resType} tiles into an hourly yield record. */
  private yieldRecord(
    tiles: { type: TileType; level: number; resType?: ResourceType }[],
  ): Record<ResourceType, number> {
    const acc = emptyResources();
    for (const tl of tiles) {
      const y = tileYield(tl.type, tl.level, tl.resType);
      for (const rt of RESOURCE_TYPES) acc[rt] += y[rt] ?? 0;
    }
    return acc;
  }

  /**
   * Recompute the aggregated yield from all currently owned tiles in the DB (called after occupy / abandon / build completion).
   * Single exit for yield (SLG_CITY_DESIGN §5): tile yields → nation production bonus → home-city building multipliers + sticker self-production.
   */
  private async recomputeYield(
    worldId: string,
    accountId: string,
    buildingsOverride?: Partial<Record<BuildingKey, number>>,
    hasBattlePassOverride?: boolean,
  ): Promise<Record<ResourceType, number>> {
    const owned = await this.deps.cols.tiles.find({ worldId, ownerId: accountId }).toArray();
    // Nation production bonus (§2.4 / G1): capitals occupied by this player → own tiles within those capitals' Voronoi regions receive +NATION_BONUS_PRODUCTION.
    const ownedNations = await this.deps.cols.nations.find({ worldId, ownerId: accountId }).toArray();
    const ownedCapIdx = new Set(ownedNations.map((n) => n.capitalIdx));
    // Building levels (SLG_CITY_DESIGN): land resources get a global yield multiplier; sticker is self-produced by the stickerShop (民居模型).
    // buildingsOverride lets a build-completion path compute the post-upgrade rate before the new levels are persisted (avoids a write-then-read ordering hazard).
    let buildings: Partial<Record<BuildingKey, number>> | undefined = buildingsOverride;
    let hasBattlePass = hasBattlePassOverride ?? false;
    if (!buildingsOverride) {
      const doc = await this.deps.cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
      buildings = doc?.buildings;
      hasBattlePass = doc?.hasBattlePass ?? false;
    }

    const acc = emptyResources();
    for (const tl of owned) {
      // ADR-025: only the base anchor contributes yield; the 8 ring cells are type:'base' too and would
      // otherwise each add the base ink trickle (9× inflation), so skip them.
      if (tl.baseRing) continue;
      const nationMult = ownedCapIdx.size > 0 && ownedCapIdx.has(nearestCapitalIdx(tl.x, tl.y, this.capitals))
        ? 1 + NATION_BONUS_PRODUCTION : 1;
      const y = tileYield(tl.type, tl.level, tl.resType);
      for (const rt of RESOURCE_TYPES) acc[rt] += (y[rt] ?? 0) * nationMult;
    }
    for (const rt of RESOURCE_TYPES) {
      acc[rt] = Math.floor(acc[rt] * buildingYieldMult(buildings, rt) + buildingSelfYield(buildings, rt));
    }
    // Battle pass production bonus (S8-8 产率加成档): +10% resource yield for holders.
    if (hasBattlePass) {
      for (const rt of RESOURCE_TYPES) acc[rt] = Math.floor(acc[rt] * BP_YIELD_MULT);
    }
    return acc;
  }

  private tileDocView(o: TileDoc, accountId: string, ownerProfile?: PlayerProfile): WorldTileView {
    return {
      x: o.x,
      y: o.y,
      type: o.type,
      level: o.level,
      ...(o.resType ? { resType: o.resType } : {}),
      ...(o.ownerId ? { occupied: true } : {}),
      ...(o.ownerId === accountId ? { mine: true } : {}),
      ...(ownerProfile?.publicId ? { ownerPublicId: ownerProfile.publicId } : {}),
      ...(ownerProfile?.displayName ? { ownerName: ownerProfile.displayName } : {}),
      ...(o.familyId ? { familyId: o.familyId } : {}),
      ...(o.garrison ? { garrison: o.garrison } : {}),
      ...(o.protectedUntil ? { protectedUntil: o.protectedUntil } : {}),
      ...(o.watchtower ? { watchtower: true } : {}),
    };
  }

  private proceduralView(worldId: string, x: number, y: number): WorldTileView {
    const d = proceduralTile(worldId, x, y);
    return { x, y, type: d.type, level: d.level, ...(d.resType ? { resType: d.resType } : {}) };
  }

  // tileId = `{worldId}:{x}:{y}`; extract coordinates (worldId itself contains no ':', so take the last two segments).
  private coordX(tid: string): number {
    const p = tid.split(':');
    return Number(p[p.length - 2]);
  }
  private coordY(tid: string): number {
    const p = tid.split(':');
    return Number(p[p.length - 1]);
  }

  private marchView(m: MarchDoc): MarchView {
    return {
      marchId: m._id,
      kind: m.kind,
      fromTile: m.fromTile,
      toTile: m.toTile,
      troops: m.troops,
      departAt: m.departAt,
      arriveAt: m.arriveAt,
      status: m.status,
    };
  }

  // ── Redis scheduling (best-effort, §14.4 `world:{worldId}:march` ZSET, score=arriveAt) ──
  // Processing uses the Mongo arriveAt scan as authoritative; the ZSET is only for future precise wake-ups; silently skipped when Redis is absent.
  private marchZsetKey(worldId: string): string {
    return `world:${worldId}:march`;
  }
  private async scheduleMarch(worldId: string, mid: string, arriveAt: number): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zadd(this.marchZsetKey(worldId), arriveAt, mid);
    } catch {
      /* best-effort: failure only loses the precise wake-up; the Mongo scan still processes arrivals */
    }
  }
  private async unscheduleMarch(worldId: string, mid: string): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zrem(this.marchZsetKey(worldId), mid);
    } catch {
      /* best-effort */
    }
  }

  // ── ADR-026: delayed building-HP settlement scheduling (best-effort ZSET, score=dueAt; Mongo dueAt scan is authoritative) ──
  private siegeDamageZsetKey(worldId: string): string {
    return `world:${worldId}:siegeDamage`;
  }
  private async scheduleSiegeDamage(worldId: string, id: string, dueAt: number): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zadd(this.siegeDamageZsetKey(worldId), dueAt, id);
    } catch {
      /* best-effort: failure only loses the precise wake-up; the Mongo dueAt scan still settles the hit */
    }
  }
  private async unscheduleSiegeDamage(worldId: string, id: string): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zrem(this.siegeDamageZsetKey(worldId), id);
    } catch {
      /* best-effort */
    }
  }

  // ── Real-time push (best-effort, §14.5) ──
  private async pushMarch(accountId: string, v: MarchView): Promise<void> {
    await this.gateway.push(accountId, {
      kind: 'march_update',
      marchId: v.marchId,
      marchKind: v.kind,
      fromTile: v.fromTile,
      toTile: v.toTile,
      arriveAt: v.arriveAt,
      status: v.status,
    });
  }
  private async pushTile(accountId: string, t: TileDoc): Promise<void> {
    const ownerProfile = (t.ownerId && this.meta.available)
      ? await this.meta.getProfile(t.ownerId).catch(() => null)
      : null;
    await this.gateway.push(accountId, {
      kind: 'tile_update',
      tileId: t._id,
      type: t.type,
      level: t.level,
      ownerPublicId: ownerProfile?.publicId ?? '',
      ownerName: ownerProfile?.displayName ?? '',
      familyId: t.familyId ?? '',
      protectedUntil: t.protectedUntil ?? 0,
    });
  }
  private async pushSiege(accountId: string, s: SiegeDoc, lootSummaryStr: string): Promise<void> {
    await this.gateway.push(accountId, {
      kind: 'siege_result',
      siegeId: s._id,
      tile: s.tile,
      outcome: s.outcome,
      lootSummary: lootSummaryStr,
      replayRef: s.replayRef ?? '',
    });
  }

  // ── S8-2: training queue ────────────────────────────────────────

  /**
   * Enqueue a training batch. Consumes ink; scheduled at TROOP_TRAIN_TIME_SEC × qty.
   * Validation: joined world + qty is valid + queue slots not full + troops after training would not exceed troopCap + enough ink.
   */
  async trainTroops(worldId: string, accountId: string, qty: number): Promise<PlayerWorldView> {
    const { cols, now } = this.deps;
    qty = Math.max(1, Math.min(TROOP_TRAIN_BATCH_MAX, Math.floor(qty)));
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const queue = pw.trainingQueue ?? [];
    // drillYard raises the training queue slot count (SLG_CITY_DESIGN); falls back to TROOP_TRAIN_QUEUE_MAX with no buildings.
    if (queue.length >= trainQueueMaxFor(pw.buildings)) throw new SlgError('BAD_REQUEST', 'Training queue is full');

    const inTraining = queue.reduce((s, e) => s + e.qty, 0);
    if (pw.troops + inTraining + qty > pw.troopCap) throw new SlgError('TROOP_CAP_REACHED', 'Troops after training would exceed the cap');

    const t = now();
    const resources = this.settle(pw, t);
    const inkCost = qty * TROOP_TRAIN_INK_COST;
    if ((resources.ink ?? 0) < inkCost) throw new SlgError('INSUFFICIENT_RESOURCES', 'Insufficient ink');
    resources.ink = (resources.ink ?? 0) - inkCost;

    // Training starts immediately after the previous batch finishes (chained queue); if no batch is in progress, start immediately.
    const lastComplete = queue.length > 0 ? queue[queue.length - 1]!.completeAt : t;
    // Battle pass bonus (S8-8): hasBattlePass → training speed +20% (duration ×0.8). drillYard further speeds training (SLG_CITY_DESIGN, ×drillTrainMult).
    const trainSpeedMult = (pw.hasBattlePass ? 0.8 : 1) * drillTrainMult(pw.buildings);
    const duration = Math.round(qty * TROOP_TRAIN_TIME_SEC * 1000 * trainSpeedMult);
    const entry: TrainingEntry = {
      qty,
      inkCost,
      startAt: lastComplete,
      completeAt: lastComplete + duration,
    };
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      {
        $set: { resources, lastTickAt: t },
        $push: { trainingQueue: entry } as never,
        $inc: { rev: 1 },
      },
    );
    return this.getMe(worldId, accountId);
  }

  /**
   * Spend coins to speed up training. Coins are converted to reduced duration (TROOP_SPEEDUP_SECS_PER_COIN seconds/coin);
   * time is subtracted from the front of the queue, with overflow carrying to the next batch. Expired batches are immediately dequeued and added to troops.
   * Calls commercial.spend() to deduct coins (no speedup if this fails).
   */
  async speedupTraining(worldId: string, accountId: string, coins: number): Promise<PlayerWorldView> {
    const { cols, now } = this.deps;
    coins = Math.max(1, Math.floor(coins));
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    const queue = pw.trainingQueue ?? [];
    if (queue.length === 0) throw new SlgError('BAD_REQUEST', 'No training queue in progress');

    // Battle pass bonus (S8-8): hasBattlePass → speedup costs 15% fewer coins (time per coin ÷0.85).
    const speedupDiscountMult = pw.hasBattlePass ? 1 / 0.85 : 1;
    const speedSec = coins * TROOP_SPEEDUP_SECS_PER_COIN * speedupDiscountMult;
    const orderId = `slg_speedup:${worldId}:${accountId}:${now()}`;
    await this.commercial.spend(accountId, coins, orderId);

    // Re-fetch latest doc from Mongo (may have changed during the spend call; ensures idempotency)
    const fresh = await cols.playerWorld.findOne({ _id: pw._id });
    if (!fresh) return this.getMe(worldId, accountId);

    const t = now();
    const resources = this.settle(fresh, t);
    const newQueue = (fresh.trainingQueue ?? []).slice();
    let remaining = speedSec * 1000;
    let troopsReady = 0;

    for (let i = 0; i < newQueue.length && remaining > 0; ) {
      const e = newQueue[i]!;
      const left = e.completeAt - t;
      if (remaining >= left) {
        remaining -= left;
        troopsReady += e.qty;
        newQueue.splice(i, 1);
      } else {
        newQueue[i] = { ...e, completeAt: e.completeAt - remaining };
        remaining = 0;
        i++;
      }
    }

    // Update startAt for remaining batches (cascade after compressing completeAt)
    for (let i = 1; i < newQueue.length; i++) {
      const prev = newQueue[i - 1]!;
      const cur = newQueue[i]!;
      const dur = cur.completeAt - cur.startAt;
      newQueue[i] = { ...cur, startAt: prev.completeAt, completeAt: prev.completeAt + dur };
    }

    const newTroops = Math.min(fresh.troopCap, fresh.troops + troopsReady);
    await cols.playerWorld.updateOne(
      { _id: fresh._id },
      { $set: { resources, troops: newTroops, trainingQueue: newQueue, lastTickAt: t }, $inc: { rev: 1 } },
    );
    return this.getMe(worldId, accountId);
  }

  /**
   * Process completed training batches (called by the scheduler every 2s).
   * Iterate all playerWorld documents with a trainingQueue; extract batches where completeAt ≤ now;
   * atomically $inc troops + $pull completed entries. Returns the number of entries processed.
   */
  async processCompletedTraining(nowMs?: number): Promise<number> {
    const { cols } = this.deps;
    const t = nowMs ?? this.deps.now();
    // Find all players with a non-empty queue whose first entry has completed (the first entry finishes earliest)
    const docs = await cols.playerWorld
      .find({ 'trainingQueue.0.completeAt': { $lte: t } })
      .project<{ _id: string; troops: number; troopCap: number; trainingQueue: TrainingEntry[] }>({
        _id: 1, troops: 1, troopCap: 1, trainingQueue: 1,
      })
      .toArray();

    let n = 0;
    for (const doc of docs) {
      const queue = doc.trainingQueue ?? [];
      const done = queue.filter((e) => e.completeAt <= t);
      if (done.length === 0) continue;
      const troopsReady = done.reduce((s, e) => s + e.qty, 0);
      const newTroops = Math.min(doc.troopCap, doc.troops + troopsReady);
      // Atomic: $inc troops + remove completed batches (matched precisely by completeAt)
      for (const e of done) {
        await cols.playerWorld.updateOne(
          { _id: doc._id },
          { $pull: { trainingQueue: { completeAt: e.completeAt } } as never },
        );
      }
      await cols.playerWorld.updateOne(
        { _id: doc._id },
        { $set: { troops: newTroops }, $inc: { rev: 1 } },
      );
      n += done.length;
    }
    return n;
  }

  // ── SLG home-city buildings (SLG_CITY_DESIGN P1) ─────────────────────────────────

  /**
   * Enqueue a building upgrade. Consumes season resources up-front; scheduled at buildTimeSec(key, toLevel).
   * Validation: joined world + key buildable + desk gate (toLevel ≤ desk level, desk ≤ DESK_MAX_LEVEL) + build queue not full + enough resources.
   * The target level chains on top of any pending upgrade of the same key already queued (forward-compatible with >1 build slot).
   */
  async upgradeBuilding(worldId: string, accountId: string, key: BuildingKey): Promise<PlayerWorldView> {
    const { cols, now } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const buildings = pw.buildings ?? { desk: 1 };
    const queue = pw.buildQueue ?? [];
    if (queue.length >= BUILD_QUEUE_SLOTS) throw new SlgError('BAD_REQUEST', 'Build queue is full');

    const pending = queue.filter((e) => e.key === key).length;
    const toLevel = buildingLevel(buildings, key) + pending + 1;
    const gate = buildGateReason(buildings, key, toLevel);
    if (gate) throw new SlgError('BAD_REQUEST', gate);

    const t = now();
    const resources = this.settle(pw, t);
    const cost = buildCost(key, toLevel);
    for (const rt of RESOURCE_TYPES) {
      if ((resources[rt] ?? 0) < (cost[rt] ?? 0)) throw new SlgError('INSUFFICIENT_RESOURCES', `Insufficient ${rt}`);
    }
    for (const rt of RESOURCE_TYPES) resources[rt] = (resources[rt] ?? 0) - (cost[rt] ?? 0);

    // Chain after the last queued build (or start now if idle), mirroring the training queue.
    const lastComplete = queue.length > 0 ? queue[queue.length - 1]!.completeAt : t;
    const duration = buildTimeSec(key, toLevel) * 1000;
    const entry: BuildQueueEntry = { key, toLevel, startAt: lastComplete, completeAt: lastComplete + duration };
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { resources, lastTickAt: t }, $push: { buildQueue: entry } as never, $inc: { rev: 1 } },
    );
    return this.getMe(worldId, accountId);
  }

  /**
   * Spend coins to speed up the build queue (mirrors speedupTraining): coins → reduced duration (BUILD_SPEEDUP_SECS_PER_COIN s/coin,
   * hasBattlePass discount), time subtracted from the front with overflow cascading. Builds whose completeAt reaches now are applied immediately.
   */
  async speedupBuild(worldId: string, accountId: string, coins: number): Promise<PlayerWorldView> {
    const { cols, now } = this.deps;
    coins = Math.max(1, Math.floor(coins));
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    if (!pw.buildQueue || pw.buildQueue.length === 0) throw new SlgError('BAD_REQUEST', 'No build queue in progress');

    const speedupDiscountMult = pw.hasBattlePass ? 1 / 0.85 : 1;
    const speedSec = coins * BUILD_SPEEDUP_SECS_PER_COIN * speedupDiscountMult;
    const orderId = `slg_build_speedup:${worldId}:${accountId}:${now()}`;
    await this.commercial.spend(accountId, coins, orderId);

    const fresh = await cols.playerWorld.findOne({ _id: pw._id });
    if (!fresh) return this.getMe(worldId, accountId);

    const t = now();
    const resources = this.settle(fresh, t);
    const newQueue = (fresh.buildQueue ?? []).slice();
    let remaining = speedSec * 1000;
    for (let i = 0; i < newQueue.length && remaining > 0; ) {
      const e = newQueue[i]!;
      const left = e.completeAt - t;
      if (remaining >= left) {
        remaining -= left;
        newQueue[i] = { ...e, completeAt: t }; // mark as due-now; applyDueBuilds will finalize it
        i++;
      } else {
        newQueue[i] = { ...e, completeAt: e.completeAt - remaining };
        remaining = 0;
        i++;
      }
    }
    // Cascade startAt/completeAt for remaining batches after compression.
    for (let i = 1; i < newQueue.length; i++) {
      const prev = newQueue[i - 1]!;
      const cur = newQueue[i]!;
      const dur = cur.completeAt - cur.startAt;
      newQueue[i] = { ...cur, startAt: prev.completeAt, completeAt: prev.completeAt + dur };
    }
    await cols.playerWorld.updateOne(
      { _id: fresh._id },
      { $set: { resources, buildQueue: newQueue, lastTickAt: t }, $inc: { rev: 1 } },
    );
    await this.applyDueBuilds(fresh._id, worldId, accountId);
    return this.getMe(worldId, accountId);
  }

  /**
   * Process completed builds (scheduler, every tick). Mirrors processCompletedTraining: finds players whose first queued build is due,
   * applies the new levels + refreshes derived state (yield / troopCap). Returns the number of builds applied.
   */
  async processCompletedBuilds(nowMs?: number): Promise<number> {
    const { cols } = this.deps;
    const t = nowMs ?? this.deps.now();
    const docs = await cols.playerWorld
      .find({ 'buildQueue.0.completeAt': { $lte: t } })
      .project<{ _id: string; worldId: string; accountId: string }>({ _id: 1, worldId: 1, accountId: 1 })
      .toArray();
    let n = 0;
    for (const doc of docs) {
      n += await this.applyDueBuilds(doc._id, doc.worldId, doc.accountId, t);
    }
    return n;
  }

  /**
   * Apply all builds whose completeAt ≤ t for one player: $set the new building levels, drop completed entries,
   * settle resources at the pre-upgrade rate, then refresh yieldRate (resource buildings + stickerShop) and troopCap (drillYard).
   * Returns the number of builds applied. Idempotent: re-entry after the entries are removed is a no-op.
   */
  private async applyDueBuilds(docId: string, worldId: string, accountId: string, nowMs?: number): Promise<number> {
    const { cols } = this.deps;
    const t = nowMs ?? this.deps.now();
    const fresh = await cols.playerWorld.findOne({ _id: docId });
    if (!fresh) return 0;
    const done = (fresh.buildQueue ?? []).filter((e) => e.completeAt <= t);
    if (done.length === 0) return 0;

    const next: Partial<Record<BuildingKey, number>> = { ...(fresh.buildings ?? { desk: 1 }) };
    for (const e of done) next[e.key] = Math.max(next[e.key] ?? buildingLevel(fresh.buildings, e.key), e.toLevel);
    const newQueue = (fresh.buildQueue ?? []).filter((e) => e.completeAt > t);
    const resources = this.settle(fresh, t); // settle at the old rate/cap up to now, before the rate changes
    // Compute the post-upgrade yield from the new levels directly (buildings not yet persisted).
    const yieldRate = await this.recomputeYield(worldId, accountId, next, fresh.hasBattlePass);
    await cols.playerWorld.updateOne(
      { _id: docId },
      {
        $set: { buildings: next, buildQueue: newQueue, resources, yieldRate, troopCap: troopCapFor(next), lastTickAt: t },
        $inc: { rev: 1 },
      },
    );
    return done.length;
  }

  // ── S8-4 residual: defense config ────────────────────────────────

  /**
   * Set the defense config for a territory tile or capital (player editing the defense).
   * tileKey='base' → write to the capital's playerWorld.defense; otherwise write to the corresponding tile.defense.
   * Defense config contents are not validated at this layer (P2 deferred validation, §14.9); levelSchema validation on the engine side is added in S8-3b.
   */
  async setDefense(
    worldId: string,
    accountId: string,
    tileKey: string,
    defenseConfig: Record<string, unknown>,
  ): Promise<void> {
    const { cols } = this.deps;
    // G3-2c: editor writes a structured formation → validated against the engine levelSchema on save (invalid unitType/column/row → rejected).
    try {
      validateDefenseConfig(defenseConfig);
    } catch (err) {
      throw new SlgError('BAD_REQUEST', `Invalid defense formation: ${(err as Error).message}`);
    }
    if (tileKey === 'base') {
      const pwId = playerWorldId(worldId, accountId);
      const pw = await cols.playerWorld.findOne({ _id: pwId });
      if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
      await cols.playerWorld.updateOne(
        { _id: pwId },
        { $set: { defense: defenseConfig }, $inc: { rev: 1 } },
      );
    } else {
      const tile = await cols.tiles.findOne({ _id: tileKey });
      if (!tile?.ownerId) throw new SlgError('TILE_NOT_OWNED', 'Not your territory');
      // Own territory, or same-family ally territory (§4 proxy defense; allied sect passage pending alliance system) can both be set for defense.
      if (tile.ownerId !== accountId && !(await this.sameFamily(worldId, accountId, tile.ownerId))) {
        throw new SlgError('TILE_NOT_OWNED', 'Not your own or allied territory');
      }
      await cols.tiles.updateOne(
        { _id: tileKey },
        { $set: { defense: defenseConfig }, $inc: { rev: 1 } },
      );
    }
  }

  /** Whether two accounts belong to the same family (ally determination for §4 proxy defense / gate passage, consistent with computeMarchPath). */
  private async sameFamily(worldId: string, a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const { cols } = this.deps;
    const [pa, pb] = await Promise.all([
      cols.playerWorld.findOne({ _id: playerWorldId(worldId, a) }),
      cols.playerWorld.findOne({ _id: playerWorldId(worldId, b) }),
    ]);
    return !!pa?.familyId && pa.familyId === pb?.familyId;
  }

  // ── G3-2c: attack formation templates (teams) ─────────────────────────────

  /** Read the player's list of attack formation templates in a given world (editor / pre-fill on departure). Throws TILE_NOT_OWNED if the player has not joined the world. */
  async getTeams(worldId: string, accountId: string): Promise<TeamTemplate[]> {
    const pw = await this.deps.cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    return pw.teams ?? [];
  }

  /**
   * Overwrite the player's attack formation templates (editor save, §16.2).
   * CC-3: validates cardInstanceId uniqueness across all teams, max CARD_TEAM_MAX_SIZE slots per team, and injured card check.
   * Card removal: when a card's teamId disappears from the new teams, clear its currentTroops and refund 80% training resources.
   * Full-set overwrite (frontend sends the complete list).
   */
  async setTeams(worldId: string, accountId: string, teams: TeamTemplate[]): Promise<void> {
    if (!Array.isArray(teams)) throw new SlgError('BAD_REQUEST', 'teams must be an array');
    if (teams.length > SIEGE_TEAM_CAP) throw new SlgError('BAD_REQUEST', `Team count exceeds the cap of ${SIEGE_TEAM_CAP}`);
    const teamIds = new Set<string>();
    const cardIds = new Set<string>();
    for (const team of teams) {
      if (!team || typeof team.id !== 'string' || !team.id) throw new SlgError('BAD_REQUEST', 'Team id is invalid');
      if (teamIds.has(team.id)) throw new SlgError('BAD_REQUEST', `Duplicate team id: ${team.id}`);
      teamIds.add(team.id);
      if (team.army.length > CARD_TEAM_MAX_SIZE) throw new SlgError('BAD_REQUEST', `Team ${team.id} exceeds max size of ${CARD_TEAM_MAX_SIZE}`);
      for (const entry of team.army) {
        if (entry.cardInstanceId) {
          if (cardIds.has(entry.cardInstanceId)) throw new SlgError('BAD_REQUEST', `Card ${entry.cardInstanceId} assigned to multiple teams`);
          cardIds.add(entry.cardInstanceId);
        }
      }
      try {
        validateAttackerArmy(team.army);
      } catch (err) {
        throw new SlgError('BAD_REQUEST', `Team ${team.id} formation is invalid: ${(err as Error).message}`);
      }
    }
    const pwId = playerWorldId(worldId, accountId);
    const pw = await this.deps.cols.playerWorld.findOne({ _id: pwId });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const now = this.deps.now();
    const cardState = pw.cardState ?? {};
    // Injured card check: a card with injuredUntil > now cannot be assigned to a team.
    for (const id of cardIds) {
      const cs = cardState[id];
      if (cs?.injuredUntil && cs.injuredUntil > now) {
        throw new SlgError('BAD_REQUEST', `Card ${id} is injured and cannot be assigned until ${cs.injuredUntil}`);
      }
    }

    // Detect cards removed from all teams compared to current teams (their teamId no longer appears in the new list).
    const prevCardTeams: Record<string, string> = {};
    for (const cs of Object.entries(cardState)) {
      if (cs[1].teamId) prevCardTeams[cs[0]] = cs[1].teamId;
    }
    const removedCards = Object.keys(prevCardTeams).filter((id) => !cardIds.has(id));

    // Build cardState patch: update teamId for all assigned cards; clear currentTroops + teamId for removed cards.
    const cardStateSet: Record<string, unknown> = {};
    for (const team of teams) {
      for (const entry of team.army) {
        if (entry.cardInstanceId) {
          cardStateSet[`cardState.${entry.cardInstanceId}.teamId`] = team.id;
        }
      }
    }
    let paperRefund = 0;
    let graphiteRefund = 0;
    let metalRefund = 0;
    for (const id of removedCards) {
      const troops = cardState[id]?.currentTroops ?? 0;
      if (troops > 0) {
        paperRefund += Math.floor(troops * CARD_TROOP_PAPER_COST * CARD_TROOP_REFUND_RATE);
        graphiteRefund += Math.floor(troops * CARD_TROOP_GRAPHITE_COST * CARD_TROOP_REFUND_RATE);
        metalRefund += Math.floor(troops * CARD_TROOP_METAL_COST * CARD_TROOP_REFUND_RATE);
      }
      cardStateSet[`cardState.${id}.currentTroops`] = 0;
      cardStateSet[`cardState.${id}.teamId`] = null;
    }

    const update: Record<string, unknown> = { $set: { teams, ...cardStateSet }, $inc: { rev: 1 } };
    if (paperRefund > 0 || graphiteRefund > 0 || metalRefund > 0) {
      (update as Record<string, Record<string, unknown>>)['$inc']!['resources.paper'] = paperRefund;
      (update as Record<string, Record<string, unknown>>)['$inc']!['resources.graphite'] = graphiteRefund;
      (update as Record<string, Record<string, unknown>>)['$inc']!['resources.metal'] = metalRefund;
    }
    await this.deps.cols.playerWorld.updateOne({ _id: pwId }, update);
  }

  /**
   * Distribute troops from baseTroopStock to card slots (CC-3, CHARACTER_CARDS_DESIGN §6.3).
   * allocations: { [cardInstanceId]: troopsToAdd }. Each card must have a teamId (be in a team).
   * Deducts total from baseTroopStock; updates cardState[id].currentTroops.
   */
  async distributeTroops(worldId: string, accountId: string, allocations: Record<string, number>): Promise<void> {
    const { cols, now } = this.deps;
    const pwId = playerWorldId(worldId, accountId);
    const pw = await cols.playerWorld.findOne({ _id: pwId });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const cardState = pw.cardState ?? {};
    const stock = pw.baseTroopStock ?? 0;
    let totalCost = 0;
    const cardStateSet: Record<string, unknown> = {};

    for (const [id, amount] of Object.entries(allocations)) {
      if (typeof amount !== 'number' || amount < 0 || !Number.isInteger(amount)) {
        throw new SlgError('BAD_REQUEST', `Invalid troop count for card ${id}`);
      }
      if (amount === 0) continue;
      const cs = cardState[id];
      if (!cs?.teamId) throw new SlgError('BAD_REQUEST', `Card ${id} is not assigned to a team`);
      totalCost += amount;
      cardStateSet[`cardState.${id}.currentTroops`] = (cs.currentTroops ?? 0) + amount;
    }

    if (totalCost === 0) return;
    if (totalCost > stock) throw new SlgError('NO_TROOPS', `Not enough troop stock (have ${stock}, need ${totalCost})`);

    await cols.playerWorld.updateOne(
      { _id: pwId },
      { $set: cardStateSet, $inc: { baseTroopStock: -totalCost, rev: 1 } },
    );
    void now; // suppress unused warning
  }

  /**
   * Recover an injured card by spending CARD_RECOVER_COIN_COST coins (CC-3, CHARACTER_CARDS_DESIGN §7.2).
   * Clears injuredUntil. Throws CARD_NOT_INJURED if card is not currently injured.
   */
  async recoverCard(worldId: string, accountId: string, cardInstanceId: string): Promise<void> {
    const { cols, now } = this.deps;
    const pwId = playerWorldId(worldId, accountId);
    const pw = await cols.playerWorld.findOne({ _id: pwId });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const cs = pw.cardState?.[cardInstanceId];
    const nowMs = now();
    if (!cs?.injuredUntil || cs.injuredUntil <= nowMs) throw new SlgError('BAD_REQUEST', `Card ${cardInstanceId} is not injured`);

    // Deduct coins via commercial client (spend throws INSUFFICIENT_FUNDS if not enough).
    await this.commercial.spend(accountId, CARD_RECOVER_COIN_COST, `recover:${cardInstanceId}`);

    await cols.playerWorld.updateOne(
      { _id: pwId },
      { $set: { [`cardState.${cardInstanceId}.injuredUntil`]: null }, $inc: { rev: 1 } },
    );
  }

  /**
   * Read the current defense config for a territory tile or capital (C3 editor pre-fill).
   * tileKey='base' → capital's playerWorld.defense; otherwise the tile's tile.defense.
   * Returns null if not set; throws TILE_NOT_OWNED for non-own territory.
   */
  async getDefense(
    worldId: string,
    accountId: string,
    tileKey: string,
  ): Promise<Record<string, unknown> | null> {
    const { cols } = this.deps;
    if (tileKey === 'base') {
      const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
      if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
      return (pw.defense as Record<string, unknown> | undefined) ?? null;
    }
    const tile = await cols.tiles.findOne({ _id: tileKey });
    if (!tile || tile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', 'Not your territory');
    return (tile.defense as Record<string, unknown> | undefined) ?? null;
  }

  // ── G3-2c: siege replay spectating ───────────────────────────────────

  /**
   * Retrieve the "replay spectating" level for a decisive siege (G3-2c, §16.3). Both attacker and defender can read it (spectating is not authoritative; purely visual).
   * Reconstructs buildSiegeBattle from the seed + both sides' formations + tile level persisted by landSiege → shape aligned with the client's LevelDefinition.
   * The client reruns the same siege headless in siege mode using an empty ReplayInputSource and the same seed, reproducing exactly what worldsvc ran.
   * If replay inputs are missing (cheap fallback / NPC sweep / old battle report) → REPLAY_UNAVAILABLE.
   */
  async getSiegeReplay(
    worldId: string,
    accountId: string,
    sid: string,
  ): Promise<{ siegeId: string; seed: number; outcome: SiegeOutcome; level: Record<string, unknown> }> {
    const siege = await this.deps.cols.sieges.findOne({ _id: sid, worldId });
    if (!siege) throw new SlgError('NOT_FOUND', 'Battle report not found');
    if (siege.attackerId !== accountId && siege.defenderId !== accountId) {
      throw new SlgError('NO_PERMISSION', 'Only the attacker or defender can spectate this battle');
    }
    if (typeof siege.seed !== 'number' || !Array.isArray(siege.attackerArmy)) {
      throw new SlgError('NOT_FOUND', 'This battle report has no replayable record');
    }
    const level = buildSiegeBattle(
      { army: siege.attackerArmy },
      siege.defenderConfig ?? null,
      siege.tileLevel ?? 1,
      siege.seed,
    );
    return { siegeId: sid, seed: siege.seed, outcome: siege.outcome, level };
  }

  // ── S8-6.5: nation system ──────────────────────────────────────

  /**
   * Initialize the 10 capital documents for a world (called when a season opens; idempotent).
   * Skips existing documents ($setOnInsert + unique _id prevents duplicates).
   */
  async initNations(worldId: string): Promise<void> {
    const caps = this.capitals;
    for (let i = 0; i < caps.length; i++) {
      const [x, y] = caps[i]!;
      const id = `nation:${worldId}:${i}`;
      const doc: NationDoc = { _id: id, worldId, capitalIdx: i, x, y, rev: 0 };
      await this.deps.cols.nations.updateOne({ _id: id }, { $setOnInsert: doc }, { upsert: true });
    }
  }

  /** Get the state of all nations in a world. */
  async getNations(worldId: string): Promise<NationDoc[]> {
    return this.deps.cols.nations.find({ worldId }).toArray();
  }

  /**
   * Check whether the target tile on siege/occupation arrival is a capital tile; trigger nation founding or conquest.
   * winnerAccountId = the occupier; if this tile previously belonged to another nation, that nation falls.
   * Returns whether a nation state change was triggered.
   */
  private async applyNationChange(
    worldId: string,
    x: number,
    y: number,
    winnerAccountId: string,
    winnerFamilyId?: string,
  ): Promise<boolean> {
    const idx = capitalIdxAt(x, y, this.capitals);
    if (idx < 0) return false; // not a capital tile
    const nationId = `nation:${worldId}:${idx}`;
    await this.deps.cols.nations.updateOne(
      { _id: nationId },
      {
        $set: {
          ownerId: winnerAccountId,
          ...(winnerFamilyId ? { familyId: winnerFamilyId } : {}),
          foundedAt: this.deps.now(),
          rev: 1, // overwrite, not incremented (simplified; can be changed to $inc later)
        },
        $unset: { nationName: '' }, // clear the old nation name before the new occupier renames it
      },
    );
    return true;
  }

  /** Set the nation name (only the capital occupier may name it). */
  async setNationName(worldId: string, accountId: string, capitalIdx: number, name: string): Promise<void> {
    if (!name || name.length < 1 || name.length > 10) throw new SlgError('BAD_REQUEST', 'Nation name must be 1–10 characters');
    const nationId = `nation:${worldId}:${capitalIdx}`;
    const nation = await this.deps.cols.nations.findOne({ _id: nationId });
    if (!nation?.ownerId) throw new SlgError('TILE_NOT_OWNED', 'This capital has no nation yet');
    if (nation.ownerId !== accountId) throw new SlgError('NO_PERMISSION', 'Only the capital occupier can name the nation');
    await this.deps.cols.nations.updateOne({ _id: nationId }, { $set: { nationName: name } });
  }

  /**
   * Query the nation corresponding to (x,y) (nearest capital by Voronoi partition).
   * Returns null if the nearest capital currently has no nation (ownerless).
   */
  async getNationAt(worldId: string, x: number, y: number): Promise<NationDoc | null> {
    const idx = nearestCapitalIdx(x, y, this.capitals);
    const nationId = `nation:${worldId}:${idx}`;
    return this.deps.cols.nations.findOne({ _id: nationId });
  }

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
    const w = await this.deps.cols.worlds.findOne({ _id: worldId });
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
    const w = await this.deps.cols.worlds.findOne(
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
    const { cols, now } = this.deps;
    await cols.worlds.updateOne(
      { _id: worldId },
      {
        $setOnInsert: {
          _id: worldId,
          season,
          shard,
          mapW: this.deps.mapW,
          mapH: this.deps.mapH,
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
    await this.initNations(worldId);
  }

  /**
   * Expand a ranking entity to the set of all player accounts it covers (§17.5 reward recipients).
   * sect → all members of its member families; family → all family members; solo → the occupier themselves. Deduped.
   */
  private async expandToAccounts(worldId: string, scope: 'sect' | 'family' | 'solo', id: string): Promise<string[]> {
    const { cols } = this.deps;
    if (scope === 'solo') return [id];
    const familyIds = scope === 'sect'
      ? (await this.socialsvc.getFamiliesBySect(id)).map((f) => f.familyId)
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
    const { cols, now } = this.deps;

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
    const fams = await this.socialsvc.getFamiliesByIds(occupyingFamilyIds);
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
          const memberFams = await this.socialsvc.getFamiliesBySect(r.familyId);
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
          void this.mail.sendSystemMail(acct, dispatchKey, {
            subject: 'slg.settle.subject',
            body: `slg.settle.body|rank=${r.rank}|tier=${tier}|nations=${r.nationCount}`,
            attachments,
            expireDays: 30,
          });
          if (base.titleId) {
            void this.meta.grantTitle(acct, base.titleId).catch((e) =>
              console.error('[worldsvc] settle grantTitle failed', { acct, titleId: base.titleId, err: (e as Error).message }),
            );
          }
        }
      }

      // Extra settlement reward for battle-pass holders (S8-8 额外结算奖励档): sent once per holder regardless of tier.
      const bpPlayers = await cols.playerWorld
        .find({ worldId, hasBattlePass: true }, { projection: { accountId: 1 } })
        .toArray();
      const bpDispatchKey = `slg-settle-bp:${worldId}:s${w.season}`;
      const bpAttachments = Object.entries(BP_SETTLE_EXTRA.items)
        .filter(([, n]) => n > 0)
        .map(([id, count]) => ({ kind: 'material' as const, id, count }));
      for (const pw of bpPlayers) {
        void this.mail.sendSystemMail(pw.accountId, bpDispatchKey, {
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
    const { cols, now } = this.deps;
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
    await Promise.all(activeFamilyIds.map((fid) => this.socialsvc.resetSlgState(fid)));

    // ⑤ Reopen (re-pin engineVersion to the current process version, C7).
    await cols.worlds.updateOne(
      { _id: worldId },
      { $set: { status: 'open' as const, population: 0, resetAt: now(), engineVersion: ENGINE_VERSION }, $inc: { rev: 1 } },
    );
    // Re-initialize capital documents
    await this.initNations(worldId);
    return { deleted };
  }

  /** List all shard world operational summaries (G7/§17.7 admin backend, internal endpoint). */
  async listWorlds(): Promise<Array<{
    worldId: string; season: number; shard: number; status: string;
    population: number; capacity: number; openAt: number; resetAt?: number; engineVersion?: number;
  }>> {
    const worlds = await this.deps.cols.worlds.find({}).sort({ season: -1, shard: 1 }).toArray();
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
    await this.deps.cols.worlds.updateOne(
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
    const { cols, now } = this.deps;
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
    const { cols } = this.deps;

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
      return await this.joinWorld(worldId, accountId);
    } catch (e) {
      if (e instanceof SlgError && e.code === 'WORLD_FULL') {
        worldId = await this.resolveShardForJoin(season, accountId);
        return await this.joinWorld(worldId, accountId);
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
    const { cols } = this.deps;
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

  // ── S8-8: SLG shop ────────────────────────────────────────

  /**
   * SLG shop purchase (item definitions in SLG_SHOP_ITEMS).
   * Deducts coins → takes effect immediately (speedup/resource pack/protection shield/battle pass written to playerWorld).
   */
  async buySlgShopItem(worldId: string, accountId: string, itemId: string): Promise<PlayerWorldView> {
    const item = SLG_SHOP_ITEMS.find((i) => i.id === itemId);
    if (!item) throw new SlgError('NOT_FOUND', 'Item not found');

    const { cols, now } = this.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const orderId = `slg_shop:${worldId}:${accountId}:${itemId}:${now()}`;
    await this.commercial.spend(accountId, item.cost, orderId);

    const t = now();
    const resources = this.settle(pw, t);

    if (item.kind === 'troop_speedup') {
      const secToSpeed = Number(item.effect['duration_sec'] ?? 0);
      // Simplified version of speedupTraining logic (coins already deducted; operate on queue directly)
      const queue = (pw.trainingQueue ?? []).slice();
      let remaining = secToSpeed * 1000;
      let troopsReady = 0;
      for (let i = 0; i < queue.length && remaining > 0; ) {
        const e = queue[i]!;
        const left = e.completeAt - t;
        if (remaining >= left) {
          remaining -= left;
          troopsReady += e.qty;
          queue.splice(i, 1);
        } else {
          queue[i] = { ...e, completeAt: e.completeAt - remaining };
          remaining = 0;
          i++;
        }
      }
      const newTroops = Math.min(pw.troopCap, pw.troops + troopsReady);
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, troops: newTroops, trainingQueue: queue, lastTickAt: t }, $inc: { rev: 1 } },
      );
    } else if (item.kind === 'resource_pack') {
      const each = Number(item.effect['each'] ?? 0);
      for (const rt of RESOURCE_TYPES) {
        resources[rt] = Math.min(RESOURCE_CAP, (resources[rt] ?? 0) + each);
      }
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
      );
    } else if (item.kind === 'protection') {
      const durSec = Number(item.effect['duration_sec'] ?? 0);
      const baseId = pw.mainBaseTile;
      if (baseId) {
        const existingProtection = await cols.tiles.findOne({ _id: baseId });
        const currentProtectUntil = existingProtection?.protectedUntil ?? t;
        const newProtectUntil = Math.max(currentProtectUntil, t) + durSec * 1000;
        await cols.tiles.updateOne(
          { _id: baseId },
          { $set: { protectedUntil: newProtectUntil }, $inc: { rev: 1 } },
        );
      }
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
      );
    } else if (item.kind === 'battle_pass') {
      await cols.playerWorld.updateOne(
        { _id: pw._id },
        { $set: { resources, hasBattlePass: true, lastTickAt: t }, $inc: { rev: 1 } },
      );
    }

    return this.getMe(worldId, accountId);
  }

  /** SLG shop item list (for client display). */
  getSlgShopItems(): typeof SLG_SHOP_ITEMS {
    return SLG_SHOP_ITEMS;
  }
}

/** Human-readable loot summary (non-zero items only, e.g. "ink+250,metal+40"; empty string if nothing looted). Used directly in siege_result push payloads. */
function lootSummary(loot: Record<ResourceType, number>): string {
  return RESOURCE_TYPES.filter((rt) => (loot[rt] ?? 0) > 0)
    .map((rt) => `${rt}+${loot[rt]}`)
    .join(',');
}
