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
  type CardInstance,
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
import { runSiegeBattle, synthesizeArmy, validateAttackerArmy, validateDefenseConfig, scaleArmyHp, scaleArmyByRatio, sumArmyHp, toDefenderFormation, resolveCardArmy, toEngineCardInstances, computeCardStateUpdates } from './siegeEngine';
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
import {
  MAP_VIEW_MAX_RADIUS,
  type SiegeReplayInputs,
  type WorldTileView,
  type WorldMapView,
  type WorldTileSparseView,
  type WorldMapSparseView,
  type PlayerWorldView,
  type MarchView,
  type WorldServiceDeps,
} from './worldTypes';

/** Maximum Chebyshev radius for ring-by-ring empty-tile search around family members' capitals when auto-spawning near the family (§3.4). */
const SPAWN_NEAR_FAMILY_RADIUS = 6;
/** Auto-spawn outer newbie zone threshold: only spawn randomly in the outer ring where dr (normalized distance to center) > this value, staying away from the central contest zone (§3.4). */
const SPAWN_OUTER_MIN_DR = 0.6;


/** Tile types that carry building HP (ADR-026 §1): the siege code writes TileDoc.hp on these; other types have no HP bar. */
const HP_BEARING_TILE_TYPES: ReadonlySet<TileType> = new Set(['base', 'territory', 'stronghold'] as TileType[]);

/**
 * ADR-026 §1: HP-bar fields for a tile view. Emits maxHp (= buildingMaxHp(level)) and current hp for HP-bearing
 * building types only; hp defaults to full when TileDoc.hp is unset. Non-building tiles get no HP fields.
 */
function siegeHpView(o: TileDoc): { hp?: number; maxHp?: number } {
  if (!HP_BEARING_TILE_TYPES.has(o.type)) return {};
  const maxHp = buildingMaxHp(o.level);
  return { maxHp, hp: o.hp ?? maxHp };
}


export const emptyResources = (): Record<ResourceType, number> => ({ ink: 0, paper: 0, graphite: 0, metal: 0, sticker: 0 });

/**
 * Batch deletion (§17.6): a single deleteMany on a collection with tens of thousands of records would hold
 * a lock for a long time and block the event loop. Instead, loop and delete by _id in batches of ≤ batch
 * documents, yielding the event loop between iterations. Idempotent: re-entry on already-deleted docs is a
 * no-op; eventually consistent. Returns the total number of deleted documents.
 */
export async function deleteInBatches(
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
export const MARCHABLE_KINDS: ReadonlySet<string> = new Set(['occupy', 'reinforce', 'attack', 'sweep', 'scout']);

/** Vision radius of an in-transit march: scout marches see farther (VISION_SCOUT_RADIUS); all others use normal march radius (VISION_MARCH_RADIUS). */
function marchVisionRadius(kind: MarchKind): number {
  return kind === 'scout' ? VISION_SCOUT_RADIUS : VISION_MARCH_RADIUS;
}

/** Vision radius of a static vision source (territory/capital/watchtower): watchtower > capital > normal territory (§18 G5 V2). */
function tileVisionRadius(t: { type: TileType; watchtower?: boolean }): number {
  if (t.watchtower) return VISION_WATCHTOWER_RADIUS;
  return t.type === 'base' ? VISION_BASE_RADIUS : VISION_TERRITORY_RADIUS;
}

export class WorldCore {
  readonly gateway: WorldGatewayClient;
  readonly meta: WorldMetaClient;
  readonly commercial: WorldCommercialClient;
  readonly mail: WorldMailClient;
  /** In-process monotonic sequence number — ensures marchIds do not collide when multiple marches depart within the same millisecond. */
  marchSeq = 0;
  /** In-process monotonic sequence number — ensures siegeIds do not collide when multiple sieges resolve within the same millisecond. */
  siegeSeq = 0;
  /** Cached capital coordinate list derived from the current mapW/mapH (lazy-initialized). */
  private _capitals: [number, number][] | null = null;

  readonly socialsvc: WorldSocialsvcClient;

  constructor(readonly deps: WorldServiceDeps) {
    this.gateway = deps.gateway ?? nullWorldGatewayClient;
    this.meta = deps.meta ?? nullWorldMetaClient;
    this.commercial = deps.commercial ?? nullWorldCommercialClient;
    this.mail = deps.mail ?? nullWorldMailClient;
    this.socialsvc = deps.socialsvc ?? nullWorldSocialsvcClient;
  }

  get capitals(): [number, number][] {
    if (!this._capitals) {
      this._capitals = capitalPositions(this.deps.mapW, this.deps.mapH);
    }
    return this._capitals;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.deps.mapW && y < this.deps.mapH;
  }

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
  async familyMemberIds(worldId: string, accountId: string): Promise<Set<string>> {
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
   * R-3 (§8.2 / §18.7): the set of accountIds the player must NOT siege — "friendly fire" prevention.
   * Covers three friendly tiers: self + own family (≤30) + own sect (all families sharing the sect) +
   * allied sects (`sect.allySectIds`, ≤2). Blocking only allied *other* sects while leaving same-sect
   * families attackable would be inconsistent (the sect is itself a cooperative grouping), so all three
   * are unioned here. Chain: familyId → sectId → {own sect ∪ allied sects} → member families → members
   * joined to this world. No family → just self. Read-only; runs only on the attack branch of startMarch.
   */
  async friendlyAccountIds(worldId: string, accountId: string): Promise<Set<string>> {
    const { cols } = this.deps;
    const result = new Set<string>([accountId]);
    const myPw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!myPw?.familyId) return result;
    const famIds = new Set<string>([myPw.familyId]); // own family always friendly
    const [myFam] = await this.socialsvc.getFamiliesByIds([myPw.familyId]);
    if (myFam?.sectId) {
      const mySect = await cols.sects.findOne({ _id: myFam.sectId });
      const sectIds = [myFam.sectId, ...(mySect?.allySectIds ?? [])]; // own sect + allied sects
      const fams = (await Promise.all(sectIds.map((sid) => this.socialsvc.getFamiliesBySect(sid)))).flat();
      for (const f of fams) famIds.add(f.familyId);
    }
    const members = await cols.playerWorld.find({ worldId, familyId: { $in: [...famIds] } }).toArray();
    for (const m of members) result.add(m.accountId);
    return result;
  }

  /**
   * G5: compute the set of vision sources for the requester within the given viewport (including the radius-padded border).
   * Sources = own + same-family members' territory (capital type:'base' gets large radius, other territory gets small radius) + own/family marches in transit
   * (current position linearly interpolated from departAt/arriveAt). Family members are looked up via familyMembers (tile.familyId is not written on the occupy path
   * and cannot be relied upon), ≤30 members. Vision is not persisted; computed fresh on each read (short-TTL cache deferred to G5 follow-up optimization).
   */
  async computeVisionSources(
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
  async visionObservers(
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
  async pushTileToObservers(t: TileDoc, exclude: ReadonlySet<string>): Promise<void> {
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
      ...(doc.cardState && Object.keys(doc.cardState).length > 0 ? { cardState: doc.cardState } : {}),
      ...(doc.baseTroopStock != null ? { baseTroopStock: doc.baseTroopStock } : {}),
      ...(doc.teamState && Object.keys(doc.teamState).length > 0 ? { teamState: doc.teamState } : {}),
    };
  }


  /**
   * Increment family activity by delta and refresh prosperity (§17.4, server-authoritative, no client write path).
   * Best-effort: failure is logged but does not block the main occupy/siege flow. familyId absent (solo player) → skip.
   */
  async bumpFamilyActivity(worldId: string, familyId: string | undefined, delta: number): Promise<void> {
    if (!familyId) return;
    try {
      await this.socialsvc.bumpActivity(familyId, delta);
      await refreshFamilyProsperity(this.deps.cols, this.socialsvc, worldId, familyId);
    } catch (e) {
      console.error('[worldsvc] bumpFamilyActivity failed', { worldId, familyId, err: (e as Error).message });
    }
  }

  async pickRandomEmptyTile(
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
  async pickSpawnTile(
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
  baseTileDocs(
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
  async footprintFree(
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

  /**
   * ADR-025 data integrity: is the capital anchored at `mainBaseTile` a complete, same-owner 3×3?
   * True iff all 9 footprint cells exist as `type:'base'` owned by `accountId` (anchor + 8 rings).
   * A player created by joinWorld/relocate/passiveRelocate always satisfies this; a stored base that
   * fails it is corrupt or legacy (e.g. a pre-ADR-025 single-tile capital) and must be purged rather
   * than tolerated — the client renders the city sprite only on a full 3×3 anchor.
   */
  async isBaseIntact(worldId: string, accountId: string, mainBaseTile: string): Promise<boolean> {
    const ax = this.coordX(mainBaseTile);
    const ay = this.coordY(mainBaseTile);
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) return false;
    if (!baseFootprintInBounds(ax, ay, this.deps.mapW, this.deps.mapH)) return false;
    const ids = baseFootprintCells(ax, ay).map(({ x, y }) => tileId(worldId, x, y));
    const cells = await this.deps.cols.tiles
      .find({ _id: { $in: ids } })
      .project<{ ownerId?: string; type?: string }>({ ownerId: 1, type: 1 })
      .toArray();
    if (cells.length !== ids.length) return false; // some footprint cell missing
    return cells.every((c) => c.type === 'base' && c.ownerId === accountId);
  }

  /**
   * Wipe a player's entire presence in a world: all owned tiles (capital + territory) + the
   * playerWorld doc. Used to discard a corrupt/legacy capital so the next joinWorld re-places the
   * player as a brand-new user with a proper 3×3 (ADR-025). Marches/sieges are left to expire
   * naturally (they reference tiles by id and no-op once the tiles are gone).
   */
  async purgePlayerWorld(worldId: string, accountId: string): Promise<void> {
    await this.deps.cols.tiles.deleteMany({ worldId, ownerId: accountId });
    await this.deps.cols.playerWorld.deleteOne({ _id: playerWorldId(worldId, accountId) });
  }

  // ── Internal helpers ─────────────────────────────────────────────

  /** Lazy resource settlement: resources += yieldRate × dt (hours), capped at the cabinet-adjusted storage cap (SLG_CITY_DESIGN). */
  settle(doc: PlayerWorldDoc, now: number): Record<ResourceType, number> {
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
  yieldRecord(
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
  async recomputeYield(
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

  tileDocView(o: TileDoc, accountId: string, ownerProfile?: PlayerProfile): WorldTileView {
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
      ...siegeHpView(o),
      ...(o.protectedUntil ? { protectedUntil: o.protectedUntil } : {}),
      ...(o.watchtower ? { watchtower: true } : {}),
    };
  }

  private proceduralView(worldId: string, x: number, y: number): WorldTileView {
    const d = proceduralTile(worldId, x, y);
    return { x, y, type: d.type, level: d.level, ...(d.resType ? { resType: d.resType } : {}) };
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
    };
  }

  // ── Redis scheduling (best-effort, §14.4 `world:{worldId}:march` ZSET, score=arriveAt) ──
  // Processing uses the Mongo arriveAt scan as authoritative; the ZSET is only for future precise wake-ups; silently skipped when Redis is absent.
  private marchZsetKey(worldId: string): string {
    return `world:${worldId}:march`;
  }
  async scheduleMarch(worldId: string, mid: string, arriveAt: number): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zadd(this.marchZsetKey(worldId), arriveAt, mid);
    } catch {
      /* best-effort: failure only loses the precise wake-up; the Mongo scan still processes arrivals */
    }
  }
  async unscheduleMarch(worldId: string, mid: string): Promise<void> {
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
  async scheduleSiegeDamage(worldId: string, id: string, dueAt: number): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zadd(this.siegeDamageZsetKey(worldId), dueAt, id);
    } catch {
      /* best-effort: failure only loses the precise wake-up; the Mongo dueAt scan still settles the hit */
    }
  }
  async unscheduleSiegeDamage(worldId: string, id: string): Promise<void> {
    if (!this.deps.redis) return;
    try {
      await this.deps.redis.zrem(this.siegeDamageZsetKey(worldId), id);
    } catch {
      /* best-effort */
    }
  }

  // ── Real-time push (best-effort, §14.5) ──
  async pushMarch(accountId: string, v: MarchView): Promise<void> {
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
  async pushTile(accountId: string, t: TileDoc): Promise<void> {
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
  async pushSiege(accountId: string, s: SiegeDoc, lootSummaryStr: string): Promise<void> {
    await this.gateway.push(accountId, {
      kind: 'siege_result',
      siegeId: s._id,
      tile: s.tile,
      outcome: s.outcome,
      lootSummary: lootSummaryStr,
      replayRef: s.replayRef ?? '',
    });
  }


  async sameFamily(worldId: string, a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    const { cols } = this.deps;
    const [pa, pb] = await Promise.all([
      cols.playerWorld.findOne({ _id: playerWorldId(worldId, a) }),
      cols.playerWorld.findOne({ _id: playerWorldId(worldId, b) }),
    ]);
    return !!pa?.familyId && pa.familyId === pb?.familyId;
  }


  /**
   * Read the current defense config for a territory tile or capital (C3 editor pre-fill).
   * tileKey='base' → capital's playerWorld.defense; otherwise the tile's tile.defense.
   * Returns null if not set; throws TILE_NOT_OWNED for non-own territory.
   */


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
  async applyNationChange(
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


}

/** Human-readable loot summary (non-zero items only, e.g. "ink+250,metal+40"; empty string if nothing looted). Used directly in siege_result push payloads. */
export function lootSummary(loot: Record<ResourceType, number>): string {
  return RESOURCE_TYPES.filter((rt) => (loot[rt] ?? 0) > 0)
    .map((rt) => `${rt}+${loot[rt]}`)
    .join(',');
}
