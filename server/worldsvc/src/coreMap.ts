// worldsvc core — map/tile/player-state reads (WorldCore split, 2026-07-03).
// The top layer of the WorldCore chain: full & sparse viewport reads with fog-of-war,
// single-tile reads, the settled player-state read (getMe), and the tile→view mappers.
// No behavior change — methods copied verbatim from the original core.ts.
import { proceduralTile, tileId, playerWorldId, isInVision } from '@nw/shared';
import { WorldCoreVision } from './coreVision';
import { siegeHpView } from './coreHelpers';
import type { TileDoc, MapBaselineTileDoc } from './db';
import type { PlayerProfile } from './metaClient';
import {
  MAP_VIEW_MAX_RADIUS,
  type WorldTileView,
  type WorldMapView,
  type WorldTileSparseView,
  type WorldMapSparseView,
  type PlayerWorldView,
} from './worldTypes';

export class WorldCoreMap extends WorldCoreVision {
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

    // §24 Layer A: batch-fetch the per-world terrain baseline for the viewport bbox (cloned from the active map
    // template at world-open — carries admin map-editor edits). A tile with no baseline row falls back to
    // proceduralTile(). Same viewport bbox shape as the tiles fetch above; keeps this off the per-tile query path.
    const baselines = await cols.mapBaselines
      .find({ worldId, x: { $gte: x0, $lte: x1 }, y: { $gte: y0, $lte: y1 } })
      .toArray();
    const baseByKey = new Map(baselines.map((b) => [`${b.x}:${b.y}`, b]));

    const now = this.deps.now(); // D-CITY-8: shared `now` for lazy durability regen across the whole viewport batch
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
          // Outside vision: return only the terrain baseline; all dynamic layers (including the "occupied" signal) are hidden.
          tiles.push({ ...this.terrainView(worldId, x, y, baseByKey.get(`${x}:${y}`)), visible: false });
          continue;
        }
        const o = byKey.get(`${x}:${y}`);
        const ownerProfile = (o?.ownerId && o.ownerId !== accountId)
          ? profileMap.get(o.ownerId) : undefined;
        const view = o ? this.tileDocView(o, accountId, ownerProfile, now) : this.terrainView(worldId, x, y, baseByKey.get(`${x}:${y}`));
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

  /** Single-tile details. DB override takes priority; otherwise falls back to the §24 terrain baseline (then proceduralTile). G5: outside vision, returns only the terrain baseline (same as getMap, prevents getTile from bypassing the fog of war). */
  async getTile(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    // Fetch the override and the §24 terrain baseline together (single-tile reads on both keyed by tileId).
    const [o, baseline] = await Promise.all([
      this.deps.cols.tiles.findOne({ _id: tileId(worldId, x, y) }),
      this.deps.cols.mapBaselines.findOne({ _id: tileId(worldId, x, y) }),
    ]);
    if (!o) return this.terrainView(worldId, x, y, baseline);
    const sources = await this.computeVisionSources(worldId, accountId, x, x, y, y);
    if (!isInVision(sources, x, y)) return { ...this.terrainView(worldId, x, y, baseline), visible: false };
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

  tileDocView(o: TileDoc, accountId: string, ownerProfile?: PlayerProfile, now: number = this.deps.now()): WorldTileView {
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
    };
  }

  /**
   * Terrain baseline for a tile that has no TileDoc override. Prefers the per-world mapBaselines row (§24 Layer A,
   * cloned from the active map template at world-open — carries admin map-editor edits: painted rivers/mountains,
   * moved cities); falls back to proceduralTile() when there is no baseline row (no template was active at open time).
   * Vision/fog gating is unchanged: terrain is never fog-gated, so callers add `visible` exactly as before.
   */
  private terrainView(worldId: string, x: number, y: number, baseline?: MapBaselineTileDoc | null): WorldTileView {
    if (baseline) {
      return { x, y, type: baseline.type, level: baseline.level, ...(baseline.resType ? { resType: baseline.resType } : {}), ...(baseline.obstacleKind ? { obstacleKind: baseline.obstacleKind } : {}) };
    }
    const d = proceduralTile(worldId, x, y);
    return { x, y, type: d.type, level: d.level, ...(d.resType ? { resType: d.resType } : {}), ...(d.obstacleKind ? { obstacleKind: d.obstacleKind } : {}) };
  }
}
