// worldsvc territory domain (S8-1): enter world / occupy / abandon / relocate / watchtower.
// Peeled out of the WorldService god-class (2026-07-03). Depends only on WorldCore. No behavior change.
import {
  proceduralTile,
  tileId,
  playerWorldId,
  PROTECTION_SEC,
  GARRISON_PER_TILE,
  troopCapFor,
  BASE_TROOP_STOCK_INITIAL,
  RELOCATE_COST,
  WATCHTOWER_COST,
  RESOURCE_TYPES,
  SlgError,
  type ResourceType,
  type BuildingKey,
} from '@nw/shared';
import { WorldCore, emptyResources } from './core';
import type { TileDoc, PlayerWorldDoc } from './db';
import type { WorldTileView, PlayerWorldView } from './worldTypes';

export class TerritoryService {
  constructor(private readonly core: WorldCore) {}

  /**
   * Enter the world: place the capital. Idempotent (returns current state immediately if already joined, no second placement).
   *
   * Spawn point (§3.4, decided 2026-06-24): **first entry uses system auto-placement** (prefer near family → fall back to outer newbie ring → whole-map fallback).
   * Players no longer choose coordinates — only paid relocation (`relocateBase`) / passive relocation after base destruction (`passiveRelocate`) can change position.
   * The optional `(x,y)` manual placement is retained for internal/test use only (public endpoints never pass coordinates; always auto-place).
   * Validation: world open + not full (+ manual path: coordinates in bounds / not center/obstacle/bridge/plankway/stronghold / unoccupied).
   * Effect: write base TileDoc (with newbie protection shield PROTECTION_SEC) + create playerWorld (full troops + initial yield).
   */
  async joinWorld(worldId: string, accountId: string, x?: number, y?: number): Promise<PlayerWorldView> {
    const { cols, now } = this.core.deps;
    const existing = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (existing) {
      // Idempotent for a healthy player. But if the stored capital is corrupt/legacy (not a complete
      // same-owner 3×3, ADR-025) — e.g. a pre-ADR-025 single-tile base — purge all their world data
      // and fall through to a fresh placement, so they re-enter as a brand-new user. A player with no
      // mainBaseTile (awaiting voluntary relocation) is treated as healthy and left untouched.
      const intact = existing.mainBaseTile
        ? await this.core.isBaseIntact(worldId, accountId, existing.mainBaseTile)
        : true;
      if (intact) return this.core.getMe(worldId, accountId);
      await this.core.purgePlayerWorld(worldId, accountId);
    }

    // SS7: resolve the familyId read-only mirror once up front (subsequent family changes are not written back;
    // clients read from /social/family/mine). Used for both auto-spawn placement and the playerWorld mirror below.
    const familyId = await this.core.socialsvc.getFamilyId(accountId).catch(() => null) ?? undefined;

    let spawn: { x: number; y: number; level: number; resType?: ResourceType };
    if (x !== undefined && y !== undefined) {
      // Manual placement (internal/test): retain the original validation rules.
      if (!this.core.inBounds(x, y)) throw new SlgError('OUT_OF_RANGE', 'Capital coordinates out of bounds');
      const proc = proceduralTile(worldId, x, y);
      if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'Cannot place capital at the world center');
      if (proc.type === 'obstacle' || proc.type === 'bridge' || proc.type === 'plankway') throw new SlgError('BAD_REQUEST', 'Cannot place capital on obstacle or crossing (bridge/plankway) terrain');
      if (proc.type === 'stronghold') throw new SlgError('BAD_REQUEST', 'Cannot place capital on stronghold terrain');
      const occ = await cols.tiles.findOne({ _id: tileId(worldId, x, y) });
      if (occ?.ownerId) throw new SlgError('TILE_OCCUPIED', 'This tile is already occupied');
      // ADR-025: the capital is a 3×3 building — the whole footprint must fit + be free.
      if (!(await this.core.footprintFree(worldId, x, y, this.core.deps.mapW, this.core.deps.mapH))) {
        throw new SlgError('TILE_OCCUPIED', 'The 3×3 capital footprint does not fit / is occupied here');
      }
      spawn = { x, y, level: proc.level, ...(proc.resType ? { resType: proc.resType } : {}) };
    } else {
      // Auto-placement: prefer near family members → outer newbie ring → whole-map fallback.
      const spot = await this.core.pickSpawnTile(worldId, accountId, familyId);
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
    const yieldRate = this.core.yieldRecord([{ type: 'base', level: spawn.level }]);
    // Write all 9 footprint tiles (anchor + 8 ring), idempotent via $setOnInsert like the old single-tile write.
    const baseDocs = this.core.baseTileDocs(worldId, spawn.x, spawn.y, accountId, {
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
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Occupy a tile (S8-1 direct occupation, no march travel; S8-2 switches to march occupy).
   * Validation: joined + coordinates in bounds + not center + enough troops for one garrison unit + target unoccupied by others.
   * Effect: settle resources first → deduct GARRISON_PER_TILE troops → write territory TileDoc (preserve resource type) → recompute yieldRate.
   */
  async occupyTile(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    const { cols, now } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    if (!this.core.inBounds(x, y)) throw new SlgError('OUT_OF_RANGE', 'Coordinates out of bounds');

    const proc = proceduralTile(worldId, x, y);
    if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'World center is contested by sects and cannot be directly occupied');
    if (proc.type === 'obstacle') throw new SlgError('BAD_REQUEST', 'Obstacle terrain cannot be occupied');

    const tid = tileId(worldId, x, y);
    const occ = await cols.tiles.findOne({ _id: tid });
    // ADR-025: a base is a 3×3 indivisible building — no cell (anchor or ring) can be occupied. Take it via siege.
    if (occ?.type === 'base') throw new SlgError('TILE_OCCUPIED', 'Cannot occupy a capital (siege the base instead)');
    if (occ?.ownerId === accountId) return this.core.tileDocView(occ, accountId); // idempotent
    if (occ?.ownerId) {
      // Another player's territory: S8-1 has no siege; if protected or otherwise occupied, always reject (take via S8-3 siege).
      if (occ.protectedUntil && occ.protectedUntil > now()) {
        throw new SlgError('PROTECTED', 'Target tile is under protection');
      }
      throw new SlgError('TILE_OCCUPIED', 'This tile is already occupied (use siege to take it, S8-3)');
    }

    if (pw.troops < GARRISON_PER_TILE) throw new SlgError('NO_TROOPS', 'Insufficient troops to garrison the tile');

    const t = now();
    const resources = this.core.settle(pw, t);

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

    const yieldRate = await this.core.recomputeYield(worldId, accountId);
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      {
        $set: { resources, yieldRate, lastTickAt: t },
        $inc: { troops: -GARRISON_PER_TILE, rev: 1 },
      },
    );
    const after = await cols.tiles.findOne({ _id: tid });
    if (after) await this.core.pushTileToObservers(after, new Set([accountId])); // G5-2: new territory is visible to observers within vision
    // §17.4 activity increment: direct occupation (S8-1 path) → occupier's family +1 (including prosperity refresh).
    void this.core.bumpFamilyActivity(worldId, pw.familyId, 1);
    return this.core.tileDocView(after!, accountId);
  }

  /**
   * Abandon a tile: refund garrison troops + recompute yield. The capital cannot be abandoned.
   */
  async abandonTile(worldId: string, accountId: string, x: number, y: number): Promise<PlayerWorldView> {
    const { cols, now } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const tid = tileId(worldId, x, y);
    const tile = await cols.tiles.findOne({ _id: tid });
    if (!tile || tile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', 'Not your territory');
    // ADR-025: all 9 footprint cells are type:'base', so this single check rejects abandoning anchor OR ring — no change needed.
    if (tile.type === 'base') throw new SlgError('TILE_NOT_OWNED', 'Cannot abandon the capital');

    const t = now();
    const resources = this.core.settle(pw, t);
    const refund = tile.garrison ?? 0;
    await cols.tiles.deleteOne({ _id: tid }); // abandon → revert to procedural neutral (sparse storage leaves no empty shell)
    const yieldRate = await this.core.recomputeYield(worldId, accountId);
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      {
        $set: { resources, yieldRate, lastTickAt: t },
        $inc: { troops: refund, rev: 1 },
      },
    );
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Voluntary relocation (§3.4 / §8.2, available to all players): spend RELOCATE_COST coins to move the capital to a chosen legal empty tile.
   * Validation: joined + target in bounds + not center/obstacle/bridge/plankway + unoccupied by anyone. All territory is retained (only passive relocation loses territory).
   * Effect: deduct coins → delete old base tile → write base tile at new location (carrying old garrison and remaining protection shield) → update mainBaseTile + recompute yield.
   */
  async relocateBase(worldId: string, accountId: string, x: number, y: number): Promise<PlayerWorldView> {
    const { cols, now } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw || !pw.mainBaseTile) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    if (!this.core.inBounds(x, y)) throw new SlgError('OUT_OF_RANGE', 'Relocation coordinates out of bounds');

    const newTid = tileId(worldId, x, y);
    if (newTid === pw.mainBaseTile) return this.core.getMe(worldId, accountId); // relocating to the same tile = no-op, no charge

    const proc = proceduralTile(worldId, x, y);
    if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'Cannot place capital at the world center');
    if (proc.type === 'obstacle' || proc.type === 'bridge' || proc.type === 'plankway') throw new SlgError('BAD_REQUEST', 'Cannot place capital on obstacle or crossing (bridge/plankway) terrain');
    if (proc.type === 'stronghold') throw new SlgError('BAD_REQUEST', 'Cannot place capital on stronghold terrain');
    const occ = await cols.tiles.findOne({ _id: newTid });
    if (occ?.ownerId) throw new SlgError('TILE_OCCUPIED', 'This tile is already occupied');
    // ADR-025: the whole 3×3 footprint must fit + be free at the new anchor (ignore our own old base cells).
    if (!(await this.core.footprintFree(worldId, x, y, this.core.deps.mapW, this.core.deps.mapH, { ignoreOwnerId: accountId }))) {
      throw new SlgError('TILE_OCCUPIED', 'The 3×3 capital footprint does not fit / is occupied at the new location');
    }

    // Deduct coins first (failure throws INSUFFICIENT_FUNDS; map state is not modified).
    const orderId = `slg_relocate:${worldId}:${accountId}:${now()}`;
    await this.core.commercial.spend(accountId, RELOCATE_COST, orderId);

    const t = now();
    const oldBase = await cols.tiles.findOne({ _id: pw.mainBaseTile });
    const carryGarrison = oldBase?.garrison ?? GARRISON_PER_TILE;
    const carryProtect = oldBase?.protectedUntil; // carry over the old capital's remaining protection shield (voluntary relocation grants no extension)
    // ADR-025: a player has exactly one base = its 9 footprint tiles; delete them all.
    await cols.tiles.deleteMany({ worldId, ownerId: accountId, type: 'base' });

    const baseDocs = this.core.baseTileDocs(worldId, x, y, accountId, {
      garrison: carryGarrison,
      level: proc.level,
      ...(proc.resType ? { resType: proc.resType } : {}),
      ...(carryProtect ? { protectedUntil: carryProtect } : {}),
      ...(pw.familyId ? { familyId: pw.familyId } : {}),
    });
    await Promise.all(
      baseDocs.map((d) => cols.tiles.updateOne({ _id: d._id }, { $set: d }, { upsert: true })),
    );

    const resources = this.core.settle(pw, t);
    const yieldRate = await this.core.recomputeYield(worldId, accountId);
    await cols.playerWorld.updateOne(
      { _id: pw._id },
      { $set: { resources, yieldRate, mainBaseTile: newTid, lastTickAt: t }, $inc: { rev: 1 } },
    );

    // Push changes for both the old and new tiles (old address reverts to neutral, new address becomes the capital).
    const after = await cols.tiles.findOne({ _id: newTid });
    if (after) {
      void this.core.pushTile(accountId, after);
      await this.core.pushTileToObservers(after, new Set([accountId])); // G5-2: new capital after relocation is visible to observers
    }
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Build a watchtower (§18 G5 V2): spend resources on a player-owned non-capital tile to upgrade it to a
   * large-radius (VISION_WATCHTOWER_RADIUS) persistent vision source. Persisted with TileDoc — losing the tile
   * also destroys the tower; no separate refund.
   * Validation: joined + own territory + not capital (capital has built-in vision). Idempotent: if tower already exists, return current view without charging again.
   */
  async buildWatchtower(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    const { cols, now } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

    const tid = tileId(worldId, x, y);
    const tile = await cols.tiles.findOne({ _id: tid });
    if (!tile || tile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', 'Not your territory');
    if (tile.type === 'base') throw new SlgError('BAD_REQUEST', 'The capital has built-in vision; a watchtower cannot be built here');
    if (tile.watchtower) return this.core.tileDocView(tile, accountId); // idempotent

    // Settle resources first, then validate sufficiency, then deduct (insufficient resources throw INSUFFICIENT_RESOURCES; map state is not modified).
    const t = now();
    const resources = this.core.settle(pw, t);
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
      void this.core.pushTile(accountId, after); // owner refetch → expanded vision from the new tower takes effect on next getMap
      await this.core.pushTileToObservers(after, new Set([accountId])); // tower is a visible structure; observers within vision also see it
    }
    return this.core.tileDocView(after!, accountId);
  }
}
