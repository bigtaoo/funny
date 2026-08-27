// worldsvc territory domain (S8-1): enter world / occupy / abandon / relocate.
// The ADR-051 player-built structures (watchtower / arrowTower / blocker) live in ./territory/structures.ts.
// Peeled out of the WorldService god-class (2026-07-03). Depends only on WorldCore. No behavior change.
import {
  proceduralTile,
  tileId,
  playerWorldId,
  PROTECTION_SEC,
  GARRISON_PER_TILE,
  troopCapFor,
  RELOCATE_COST,
  SlgError,
  buildingLevel,
  type ResourceType,
  type BuildingKey,
} from '@nw/shared';
import { WorldCore, emptyResources } from './core';
import { buildWatchtower, buildStructure, demolishStructure } from './territory/structures';
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
    // comm-audit batch F item 8b: use getMember (not getFamilyId) so sectId can be captured in the same
    // one-time snapshot, letting vision/penalty code read it locally instead of a separate round trip later.
    const mem = await this.core.socialsvc.getMember(accountId).catch(() => null);
    const familyId = mem?.familyId ?? undefined;
    const sectId = mem?.sectId;

    let spawn: { x: number; y: number; level: number; resType?: ResourceType };
    if (x !== undefined && y !== undefined) {
      // Manual placement (internal/test): retain the original validation rules.
      if (!this.core.inBounds(x, y)) throw new SlgError('OUT_OF_RANGE', 'Capital coordinates out of bounds');
      const proc = proceduralTile(worldId, x, y);
      if (proc.type === 'center') throw new SlgError('TILE_OCCUPIED', 'Cannot place capital at the world center');
      // City ground (ADR-074): a wild city's footprint is not buildable land. Before ADR-074 only the
      // single city anchor was `familyKeep` and nothing rejected it, so a manually placed capital could
      // land on top of a city.
      if (proc.type === 'familyKeep') throw new SlgError('BAD_REQUEST', 'Cannot place capital on city ground');
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
      now: t, // fresh capital: no buildings yet → wallLevel 0 → full base-durability
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
      ...(familyId ? { familyId } : {}),
      // ADR-074 P3: `sectSince` starts §8.5's clock here too, not only at the sect transitions — otherwise
      // an account that joins the world while its family is ALREADY in a sect would collect the city yield
      // bonus from its first second, which is the same hop this delay exists to price.
      ...(sectId ? { sectId, sectSince: t } : {}),
      rev: 0,
    };
    await cols.playerWorld.insertOne(pw);
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Occupy a tile (S8-1 direct occupation, no march travel, no combat).
   * ⚠ Internal/test-only since ADR-037 (§5.4): the product client no longer calls this — occupying a tile is now
   * `startMarch(kind:'occupy')`, which fights the target's system garrison and settles through a delayed
   * occupation hold (combatSiege/occupation.ts). This endpoint is kept only because a large number of existing
   * e2e tests use it to cheaply set up "player already owns this tile" preconditions; its instant/no-combat
   * behavior is not a bug relative to the new model — it coincides with the `garrison<=0` defensive fallback
   * branch of applyOccupy (never hit in practice given resourceDensity=1.0, but kept consistent rather than
   * contradictory). Do not wire this into any new client-facing occupy flow.
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
    // City ground (ADR-074) — mirrors the `occupy` march branch in startMarchValidation. This direct
    // occupy path had the same hole: nothing rejected `familyKeep`, so every cell of a city plot was
    // claimable land (SLG_CITY_SIEGE_DESIGN §1.3).
    if (proc.type === 'familyKeep') throw new SlgError('TILE_OCCUPIED', 'Cities cannot be occupied; use attack siege to capture');
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
    // The `pw.troops < GARRISON_PER_TILE` check above is only a fast-fail on a possibly-stale read; guard
    // the actual deduction atomically too — two concurrent occupyTile calls (or occupy + startMarch racing
    // on the same pool) could otherwise both pass the early check and both $inc, driving troops negative.
    // 2026-08-24 (unguarded-write sweep): the troop debit was always atomic, but the `resources` beside it
    // was an absolute value settled from the `pw` snapshot — published after a tiles upsert and
    // recomputeYield's scans, with nothing stopping it overwriting whatever landed in between (a teams.ts
    // `$inc` refund, another settle). settleExpr computes the accrual from the live document instead, so the
    // write commutes; the `$gte` filter is the real precondition and is unchanged.
    const deducted = await cols.playerWorld.updateOne(
      { _id: pw._id, troops: { $gte: GARRISON_PER_TILE } },
      [
        {
          $set: {
            resources: this.core.settleExpr(pw.buildings, t),
            yieldRate,
            lastTickAt: t,
            troops: { $subtract: ['$troops', GARRISON_PER_TILE] },
            rev: { $add: ['$rev', 1] },
          },
        },
      ],
    );
    if (deducted.matchedCount === 0) {
      // Lost the race: roll back the tile claim just written so the account isn't left owning a tile with
      // no garrison ever actually deducted from its pool.
      await cols.tiles.deleteOne({ _id: tid });
      throw new SlgError('NO_TROOPS', 'Insufficient troops to garrison the tile');
    }
    const after = await cols.tiles.findOne({ _id: tid });
    if (after) await this.core.pushTileToObservers(after, new Set([accountId])); // G5-2: new territory is visible to observers within vision
    // §17.4 activity increment: direct occupation (S8-1 path) → occupier's family +1 (including prosperity refresh).
    void this.core.bumpFamilyActivity(worldId, pw.familyId, 1);
    return this.core.tileDocView(after!, accountId);
  }

  /**
   * List all tiles the player currently owns (territory + captured stronghold; excludes the 3×3 capital
   * footprint, which is managed via relocate, not jump/abandon). Backs the client Territory Overview panel
   * (design/game/SLG_DESIGN_LOG.md §26) — the HUD's `territoryCount` is only an aggregate, this returns the rows.
   */
  async listTerritories(worldId: string, accountId: string): Promise<WorldTileView[]> {
    const { cols } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    const owned = await cols.tiles.find({ worldId, ownerId: accountId, type: { $ne: 'base' } }).toArray();
    return owned.map((t) => this.core.tileDocView(t, accountId));
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
    const refund = tile.garrison ?? 0;
    await cols.tiles.deleteOne({ _id: tid }); // abandon → revert to procedural neutral (sparse storage leaves no empty shell)
    // 2026-07-23: giving up the tile frees any team stationed on it (the team pops back to idle-at-home). Recall
    // would also work, but abandon is a deliberate surrender — just release the "out" lock so the slot is usable.
    const freedStationed = await cols.stationed.findOneAndDelete({ _id: tid });
    await this.core.clearOccupancy(worldId, tid, tid); // ADR-051 (P2): drop the freed team's occupancy entry
    // ADR-051 (P3a): a freed garrison also drops its 9-cell coverage from the reverse index.
    if (freedStationed?.mode === 'garrison') await this.core.removeCover(worldId, freedStationed.x, freedStationed.y, freedStationed.tile);
    // ADR-051 (P5): an abandoned tile's arrow tower is destroyed with it — clear its 3×3 coverage too (the TileDoc
    // is deleted above, so the structure is gone; only the Redis cover index needs the explicit sweep).
    if (tile.structure?.kind === 'arrowTower') await this.core.removeCover(worldId, x, y, tid);
    const yieldRate = await this.core.recomputeYield(worldId, accountId);
    // 2026-08-24 (unguarded-write sweep): same fix as occupyTile, and this site had no filter at all — a
    // blind write of a snapshot-derived `resources` after a tile delete, a stationed claim, up to two
    // removeCover calls and recomputeYield: the widest lost-update window in the file. `troops` stays an
    // unclamped add (`$inc` semantics preserved) — a garrison refund may exceed troopCap, same as before.
    await cols.playerWorld.updateOne({ _id: pw._id }, [
      {
        $set: {
          resources: this.core.settleExpr(pw.buildings, t),
          yieldRate,
          lastTickAt: t,
          troops: { $add: ['$troops', refund] },
          rev: { $add: ['$rev', 1] },
        },
      },
    ]);
    return this.core.getMe(worldId, accountId);
  }

  /**
   * Voluntary relocation (§3.4 / §8.2, available to all players): spend RELOCATE_COST coins to move the capital to a chosen legal empty tile.
   * Validation: joined + target in bounds + not center/obstacle/bridge/plankway + unoccupied by anyone. All territory is retained (only passive relocation loses territory).
   * Effect: deduct coins → delete old base tile → write base tile at new location (carrying old garrison and remaining protection shield) → update mainBaseTile + recompute yield.
   */
  async relocateBase(worldId: string, accountId: string, x: number, y: number, clientPlatform?: string): Promise<PlayerWorldView> {
    const { cols, now } = this.core.deps;
    const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
    if (!pw || !pw.mainBaseTile) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');
    if (!this.core.inBounds(x, y)) throw new SlgError('OUT_OF_RANGE', 'Relocation coordinates out of bounds');

    const newTid = tileId(worldId, x, y);
    if (newTid === pw.mainBaseTile) return this.core.getMe(worldId, accountId); // relocating to the same tile = no-op, no charge

    const proc = proceduralTile(worldId, x, y);
    // Relocate rule (§3.4, changed): the capital may only move onto a 3×3 block the player ALREADY fully
    // owns — occupy the centre tile *and all 8 surrounding tiles* first, then relocate onto the centre.
    // (Previously any free/clear 3×3 was allowed.) The old base's 9 cells are released back to neutral by
    // the deleteMany below, so relocating does surrender the former footprint.
    if (!(await this.core.footprintOwnedBy(worldId, x, y, this.core.deps.mapW, this.core.deps.mapH, accountId))) {
      throw new SlgError('TILE_NOT_OWNED', 'Relocation target must be a 3×3 block you already fully own — occupy the surrounding tiles first');
    }

    // Atomically claim this rev generation BEFORE spending coins or touching any tile: two concurrent
    // relocateBase calls for the same account both read the same `pw.rev` above, but only one CAS here can
    // win — the loser fails fast (no charge, no tile mutation) instead of both proceeding to interleave
    // their base-tile deleteMany/insert into a corrupted mixed-location footprint.
    const claim = await cols.playerWorld.updateOne({ _id: pw._id, rev: pw.rev }, { $inc: { rev: 1 } });
    if (claim.matchedCount === 0) throw new SlgError('REV_CONFLICT', 'Concurrent update, please retry');

    // Deduct coins first (failure throws INSUFFICIENT_FUNDS; map state is not modified).
    const orderId = `slg_relocate:${worldId}:${accountId}:${now()}`;
    await this.core.commercial.spend(accountId, RELOCATE_COST, orderId, clientPlatform);

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
      // D-CITY-8: voluntary relocation carries over durability/damage taken (like garrison), not a free heal.
      wallLevel: buildingLevel(pw.buildings, 'wall'),
      ...(oldBase?.durability != null ? { durability: oldBase.durability } : {}),
      ...(oldBase?.durabilityRegenAt != null ? { durabilityRegenAt: oldBase.durabilityRegenAt } : {}),
      now: t,
    });
    await Promise.all(
      baseDocs.map((d) => cols.tiles.updateOne({ _id: d._id }, { $set: d }, { upsert: true })),
    );

    const yieldRate = await this.core.recomputeYield(worldId, accountId);
    // 2026-08-24: this write is unconditional, and must be. It used to be guarded on `rev: claimedRev` and
    // throw REV_CONFLICT — but by here the coins are spent AND the 9 base tiles are already moved, so a throw
    // left the account charged, relocated, and `mainBaseTile` pointing at a deleted tile: a lost update
    // traded for a far worse inconsistency. The guard is also unnecessary now — settleExpr computes the
    // accrual from the live document, and `yieldRate` (recomputed from the tiles table after the swap),
    // `mainBaseTile` and `lastTickAt` are all values this command owns. Mutual exclusion between two
    // concurrent relocations is unchanged: that is the rev CAS claim above, which still fails the loser
    // before any coin is spent.
    await cols.playerWorld.updateOne({ _id: pw._id }, [
      {
        $set: {
          resources: this.core.settleExpr(pw.buildings, t),
          yieldRate,
          mainBaseTile: newTid,
          lastTickAt: t,
          rev: { $add: ['$rev', 1] },
        },
      },
    ]);

    // Push changes for both the old and new tiles (old address reverts to neutral, new address becomes the capital).
    const after = await cols.tiles.findOne({ _id: newTid });
    if (after) {
      void this.core.pushTile(accountId, after);
      await this.core.pushTileToObservers(after, new Set([accountId])); // G5-2: new capital after relocation is visible to observers
    }
    return this.core.getMe(worldId, accountId);
  }

  // ── ADR-051 (P5) player-built structures ────────────────────────────────────────────────────
  // Bodies live in ./territory/structures.ts (2026-08-25, "单文件 500 行收敛"): the watchtower + arrowTower/
  // blocker trio only ever reads `core` and shared cost/HP constants — no shared state with join/occupy/
  // abandon/relocate above — so it is the clean independent-function-module cut (split-priority order:
  // independent modules > composition > chain). The service keeps the three methods so every call site
  // (service.ts facade, httpApi, e2e) is unchanged.
  buildWatchtower(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    return buildWatchtower(this.core, worldId, accountId, x, y);
  }
  buildStructure(worldId: string, accountId: string, x: number, y: number, kind: 'arrowTower' | 'blocker'): Promise<WorldTileView> {
    return buildStructure(this.core, worldId, accountId, x, y, kind);
  }
  demolishStructure(worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
    return demolishStructure(this.core, worldId, accountId, x, y);
  }
}
