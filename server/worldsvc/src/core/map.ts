// worldsvc core — map/tile/player-state reads (WorldCore split, 2026-07-03).
// The top layer of the WorldCore chain: full & sparse viewport reads with fog-of-war,
// single-tile reads, the settled player-state read (getMe), and the tile→view mappers.
// No behavior change — methods copied verbatim from the original core.ts.
//
// 2026-08-11 (mixin-chain re-audit, claudedocs/server.md "拆分形态的优先级" 形态②): converted from an
// `extends WorldCoreVision` inheritance-chain link to composition — cross-layer calls go to the vision
// sibling (`computeVisionSources`/`familyMemberIds`/`sectMateMemberIds`/`allySectMemberIds`), the yield
// sibling (`settle`), and the kernel primitives (`coordX`/`coordY`), so this takes `core: WorldCore` +
// narrow `yieldSvc: YieldService` + `vision: VisionService` sibling references.
import { allCityNodes, proceduralTile, tileId, playerWorldId, isInVision, sliceRuns, tileAtX, type MapEditorCityNode, type ProceduralTile } from '@nw/shared';
import type { WorldCore } from '../core';
import type { YieldService } from './yield';
import type { VisionService } from './vision';
import { siegeHpView } from './helpers';
import type { TileDoc } from '../db';
import type { PlayerProfile } from '../metaClient';
import {
  MAP_VIEW_MAX_RADIUS,
  type WorldTileView,
  type WorldMapView,
  type WorldTileSparseView,
  type WorldMapSparseView,
  type PlayerWorldView,
} from '../worldTypes';

export class MapService {
  constructor(
    private readonly core: WorldCore,
    private readonly yieldSvc: YieldService,
    private readonly vision: VisionService,
  ) {}

  async getMap(
    worldId: string,
    accountId: string,
    cx: number,
    cy: number,
    r: number,
  ): Promise<WorldMapView> {
    const { cols, mapW, mapH } = this.core.deps;
    const rad = Math.max(0, Math.min(MAP_VIEW_MAX_RADIUS, Math.floor(r)));
    const x0 = Math.max(0, Math.floor(cx) - rad);
    const x1 = Math.min(mapW - 1, Math.floor(cx) + rad);
    const y0 = Math.max(0, Math.floor(cy) - rad);
    const y1 = Math.min(mapH - 1, Math.floor(cy) + rad);

    const overrides = await cols.tiles
      .find({ worldId, x: { $gte: x0, $lte: x1 }, y: { $gte: y0, $lte: y1 } })
      .toArray();
    const byKey = new Map(overrides.map((t) => [`${t.x}:${t.y}`, t]));

    // §24 Layer A: batch-fetch the per-world terrain baseline rows for the viewport's y-range (cloned from the
    // active map template at world-open — carries admin map-editor edits; run-length-encoded, 2026-07-27
    // storage redesign — see shared/src/slg/mapRle.ts). A tile with no baseline row falls back to
    // proceduralTile(). Decoded + sliced to the x-range in-memory per row, off the per-tile query path.
    const baselineRows = await cols.mapBaselineRows
      .find({ worldId, y: { $gte: y0, $lte: y1 } })
      .toArray();
    const baseByKey = new Map<string, ProceduralTile>();
    for (const row of baselineRows) {
      for (const r of sliceRuns(row.runs, x0, x1)) {
        for (let x = r.x0; x <= r.x1; x++) {
          baseByKey.set(`${x}:${row.y}`, { type: r.type, level: r.level, ...(r.resType ? { resType: r.resType } : {}), ...(r.obstacleKind ? { obstacleKind: r.obstacleKind } : {}) });
        }
      }
    }

    const now = this.core.deps.now(); // D-CITY-8: shared `now` for lazy durability regen across the whole viewport batch
    // G5 vision: compute the requester's currently visible tile set (own/family territory + capitals + in-transit marches).
    // Fog now gates only INTEL (garrison / HP / watchtower) per tile — the static structure layer (location /
    // ownership / base identity / level / occupation state) is public map-wide (2026-07-24 fog-model change, see gateIntel).
    const sources = await this.vision.computeVisionSources(worldId, accountId, x0, x1, y0, y1);
    const vis = (x: number, y: number): boolean => isInVision(sources, x, y);
    // Family member set (including self): visible family ally territory is tagged ally (client renders in friendly color, not enemy color).
    const family = await this.vision.familyMemberIds(worldId, accountId);
    // Own sect's OTHER families (not own family, not allied sects): visible territory is tagged sectmate
    // (client renders a third "friendly but not family" colour, 2026-08-08).
    const sectMates = await this.vision.sectMateMemberIds(worldId, accountId);
    // Allied sect member set (≤2 allied sects): visible allied territory is tagged allySect (client renders yellow border, §8.2).
    const allySect = await this.vision.allySectMemberIds(worldId, accountId);

    // Batch-resolve display names for every other player's territory in the viewport. Ownership is now public
    // map-wide (fog gates only marching troops + garrison/HP intel), so owner names show regardless of vision —
    // no `vis()` filter here.
    const otherOwnerIds = [...new Set(
      overrides
        .filter((o) => o.ownerId && o.ownerId !== accountId)
        .map((o) => o.ownerId!),
    )];
    // comm-audit batch F item 7: was N individual getProfile round trips (one per distinct owner in the
    // viewport); meta's /internal/account/batch-profiles resolves them all in one call.
    const profileMap = otherOwnerIds.length > 0 && this.core.meta.available
      ? await this.core.meta.batchProfiles(otherOwnerIds)
      : new Map<string, PlayerProfile>();

    const tiles: WorldTileView[] = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const o = byKey.get(`${x}:${y}`);
        const ownerProfile = (o?.ownerId && o.ownerId !== accountId)
          ? profileMap.get(o.ownerId) : undefined;
        const view = o ? this.tileDocView(o, accountId, ownerProfile, now) : this.terrainView(worldId, x, y, baseByKey.get(`${x}:${y}`));
        const ally = !!o?.ownerId && o.ownerId !== accountId && family.has(o.ownerId);
        // Sect-mate tag: not own tile, not family, belongs to a fellow member of the requester's own sect (mutually exclusive with ally/allied).
        const sectmate = !ally && !!o?.ownerId && o.ownerId !== accountId && sectMates.has(o.ownerId);
        // Alliance tag: not own tile, not family, not sect-mate, belongs to an allied sect member (mutually exclusive with the other two).
        const allied = !ally && !sectmate && !!o?.ownerId && o.ownerId !== accountId && allySect.has(o.ownerId);
        // Static structure layer is public map-wide; only intel (garrison/HP/watchtower) is fog-gated (see gateIntel).
        tiles.push({
          ...this.gateIntel(view, vis(x, y)),
          visible: true,
          ...(ally ? { ally: true } : {}),
          ...(sectmate ? { sectmate: true } : {}),
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
    const { cols, mapW, mapH } = this.core.deps;
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
    let sectMateSet = new Set<string>();
    let allySectSet = new Set<string>();
    if (lod === 'mid') {
      family = await this.vision.familyMemberIds(worldId, accountId);
      sectMateSet = await this.vision.sectMateMemberIds(worldId, accountId);
      allySectSet = await this.vision.allySectMemberIds(worldId, accountId);
    }

    const tiles: WorldTileSparseView[] = owned.map((o) => {
      const mine = o.ownerId === accountId;
      const tile: WorldTileSparseView = { x: o.x, y: o.y, type: o.type };
      if (mine) {
        tile.mine = true;
      } else if (lod === 'mid' && o.ownerId) {
        if (family.has(o.ownerId)) tile.ally = true;
        else if (sectMateSet.has(o.ownerId)) tile.sectmate = true;
        else if (allySectSet.has(o.ownerId)) tile.allySect = true;
      }
      return tile;
    });

    return { worldId, cx: Math.floor(cx), cy: Math.floor(cy), r: rad, lod, tiles };
  }

  /** Single-tile details. DB override takes priority; otherwise falls back to the §24 terrain baseline (then proceduralTile). G5: outside vision, returns only the terrain baseline (same as getMap, prevents getTile from bypassing the fog of war). */
  async getTile(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    // Fetch the override (single-tile, keyed by tileId) and the §24 terrain baseline row (keyed by worldId:y,
    // run-length-encoded — see shared/src/slg/mapRle.ts) together, then pick out this x from the row's runs.
    const [o, baselineRow] = await Promise.all([
      this.core.deps.cols.tiles.findOne({ _id: tileId(worldId, x, y) }),
      this.core.deps.cols.mapBaselineRows.findOne({ _id: `${worldId}:${y}` }),
    ]);
    if (!o) return this.terrainView(worldId, x, y, baselineRow ? tileAtX(baselineRow.runs, x) : undefined);
    const sources = await this.vision.computeVisionSources(worldId, accountId, x, x, y, y);
    const ownerProfile = (o.ownerId && o.ownerId !== accountId && this.core.meta.available)
      ? await this.core.meta.getProfile(o.ownerId).catch(() => null) : undefined;
    // Structure/ownership is public map-wide; only intel (garrison/HP/watchtower) needs vision (same gate as getMap).
    return { ...this.gateIntel(this.tileDocView(o, accountId, ownerProfile ?? undefined), isInVision(sources, x, y)), visible: true };
  }

  /**
   * The world's city siege-point nodes (ADR-034 §3; ~64), for the client's city sprite layer. Cloned onto
   * the WorldDoc from the active map template at world-open (see MapTemplateService.cloneActiveTemplateInto),
   * so a city the designer dragged in tools/map-editor has its SPRITE here and its GROUND in the terrain
   * baseline, in agreement.
   *
   * `allCityNodes(worldId)` is the fallback for a world opened before 2026-08-19 (no stored list) — the
   * old client-side behavior, and correct for a world with no active template, since then its terrain
   * really is `proceduralTile(worldId, …)`. Not cached: it rides along on `POST /world/enter`, one read
   * per world-map entry.
   */
  async getCities(worldId: string): Promise<MapEditorCityNode[]> {
    const world = await this.core.deps.cols.worlds.findOne({ _id: worldId });
    return world?.cities ?? allCityNodes(worldId);
  }

  /** Player state in the world: resources are lazily settled (computed on read as yieldRate × dt, capped at RESOURCE_CAP). §14.3. */
  async getMe(worldId: string, accountId: string): Promise<PlayerWorldView> {
    const doc = await this.core.deps.cols.playerWorld.findOne({
      _id: playerWorldId(worldId, accountId),
    });
    if (!doc) return { joined: false, worldId };
    const resources = this.yieldSvc.settle(doc, this.core.deps.now());
    // D-CITY-8: surface the main base's persistent durability under the same hp/maxHp field
    // names as WorldTileView (siegeHpView), so CityScene's military-page durability panel and
    // WorldMapScene's tile HP bar read the identical contract. Best-effort: a missing/racing
    // anchor tile (e.g. mid-relocate) just omits hp/maxHp rather than failing the whole getMe().
    const baseAnchor = doc.mainBaseTile
      ? await this.core.deps.cols.tiles.findOne({
          _id: tileId(worldId, this.core.coordX(doc.mainBaseTile), this.core.coordY(doc.mainBaseTile)),
        })
      : null;
    return {
      joined: true,
      worldId, // G6 (§20 R3): the shard worldId resolved by join-season is returned to the client for map entry
      troops: doc.troops,
      troopCap: doc.troopCap,
      resources,
      yieldRate: doc.yieldRate,
      territoryCount: await this.core.deps.cols.tiles.countDocuments({ worldId, ownerId: accountId }),
      ...(doc.hasBattlePass ? { hasBattlePass: true } : {}),
      ...(doc.mainBaseTile ? { mainBaseTile: doc.mainBaseTile } : {}),
      // S8-8 UI fix (2026-08-08): mirror the anchor tile's protection-shield end time onto the player view,
      // same reasoning as hp/maxHp below — the HUD needs this regardless of whether the base tile happens
      // to be in the current map viewport (tileCache), so it can't rely on WorldTileView.protectedUntil alone.
      ...(baseAnchor?.protectedUntil ? { baseProtectedUntil: baseAnchor.protectedUntil } : {}),
      ...(baseAnchor ? siegeHpView(baseAnchor, this.core.deps.now()) : {}),
      ...(doc.familyId ? { familyId: doc.familyId } : {}),
      ...(doc.trainingQueue && doc.trainingQueue.length > 0
        ? { trainingQueue: doc.trainingQueue.map((e) => ({ qty: e.qty, startAt: e.startAt, completeAt: e.completeAt })) }
        : {}),
      ...(doc.speedupUntil ? { speedupUntil: doc.speedupUntil } : {}),
      ...(doc.buildings ? { buildings: doc.buildings } : {}),
      ...(doc.buildQueue && doc.buildQueue.length > 0
        ? { buildQueue: doc.buildQueue.map((e) => ({ key: e.key, toLevel: e.toLevel, startAt: e.startAt, completeAt: e.completeAt })) }
        : {}),
      ...(doc.cardState && Object.keys(doc.cardState).length > 0 ? { cardState: doc.cardState } : {}),
      ...(doc.teamState && Object.keys(doc.teamState).length > 0 ? { teamState: doc.teamState } : {}),
    };
  }

  tileDocView(o: TileDoc, accountId: string, ownerProfile?: PlayerProfile, now: number = this.core.deps.now()): WorldTileView {
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
      ...siegeHpView(o, now),
      ...(o.protectedUntil ? { protectedUntil: o.protectedUntil } : {}),
      ...(o.contestedUntil ? { contestedUntil: o.contestedUntil } : {}),
      ...(o.contestedBy === accountId ? { contestedByMe: true } : {}),
      ...(o.watchtower ? { watchtower: true } : {}),
      ...(o.structure ? { structure: {
        kind: o.structure.kind,
        level: o.structure.level,
        hp: o.structure.hp,
        hpMax: o.structure.hpMax,
        ...(o.structure.ownerId === accountId ? { mine: true } : {}),
      } } : {}),
      ...(o.deskLevel ? { deskLevel: o.deskLevel } : {}),
    };
  }

  /**
   * Fog of war hides only marching troops, not static structures (2026-07-24 fog-model change): a tile's
   * location / ownership / base identity / level / occupation state is public map-wide — a player can always
   * see WHERE others are. Only the *intel* fields — garrison strength, siege durability (hp/maxHp), and
   * watchtower presence — stay vision-gated, preserving the value of scouting. In vision → returned as-is;
   * out of vision → intel stripped (the structure still renders, just without troop/durability readouts).
   */
  private gateIntel(view: WorldTileView, inVision: boolean): WorldTileView {
    if (inVision) return view;
    const gated = { ...view };
    delete gated.garrison;
    delete gated.hp;
    delete gated.maxHp;
    delete gated.watchtower;
    // Structure stays visible (public static layer) but its durability readout is intel — strip hp/hpMax.
    if (gated.structure) gated.structure = { kind: gated.structure.kind, level: gated.structure.level, ...(gated.structure.mine ? { mine: true } : {}) };
    return gated;
  }

  /**
   * Terrain baseline for a tile that has no TileDoc override. Prefers the per-world baseline (§24 Layer A,
   * cloned from the active map template at world-open — carries admin map-editor edits: painted rivers/mountains,
   * moved cities; already decoded from its run-length-encoded row by the caller); falls back to proceduralTile()
   * when there is no baseline for this cell (no template was active at open time). Vision/fog gating is
   * unchanged: terrain is never fog-gated, so callers add `visible` exactly as before.
   */
  private terrainView(worldId: string, x: number, y: number, baseline?: ProceduralTile): WorldTileView {
    if (baseline) {
      return { x, y, type: baseline.type, level: baseline.level, ...(baseline.resType ? { resType: baseline.resType } : {}), ...(baseline.obstacleKind ? { obstacleKind: baseline.obstacleKind } : {}) };
    }
    const d = proceduralTile(worldId, x, y);
    return { x, y, type: d.type, level: d.level, ...(d.resType ? { resType: d.resType } : {}), ...(d.obstacleKind ? { obstacleKind: d.obstacleKind } : {}) };
  }
}
