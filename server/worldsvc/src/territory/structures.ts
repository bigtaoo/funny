// ADR-051 (P5) player-built map structures: watchtower (§18 G5 V2 vision source) + arrowTower / blocker.
//
// Split out of `territory.ts` (2026-08-25, "单文件 500 行收敛"): ADR-074 P0's city-ground guards pushed that
// file past 500 lines, and this trio was the clean cut — it shares no state with join/occupy/abandon/
// relocate, only reads `core` and the shared cost/HP constants, and all three follow the identical
// settle -> validate -> deduct -> mark shape. Independent-function-module form (form①, split-priority order:
// independent modules > composition > chain); `TerritoryService` keeps three one-line forwarders so every
// call site is unchanged. Bodies moved verbatim.
import {
  tileId,
  playerWorldId,
  WATCHTOWER_COST,
  ARROW_TOWER_COST,
  BLOCKER_COST,
  ARROW_TOWER_HP,
  BLOCKER_HP,
  RESOURCE_TYPES,
  SlgError,
} from '@nw/shared';
import type { TileStructure } from '../db';
import type { WorldTileView } from '../worldTypes';
import { WorldCore } from '../core';

/**
 * Build a watchtower (§18 G5 V2): spend resources on a player-owned non-capital tile to upgrade it to a
 * large-radius (VISION_WATCHTOWER_RADIUS) persistent vision source. Persisted with TileDoc — losing the tile
 * also destroys the tower; no separate refund.
 * Validation: joined + own territory + not capital (capital has built-in vision). Idempotent: if tower already exists, return current view without charging again.
 */
export async function buildWatchtower(core: WorldCore, worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
  const { cols, now } = core.deps;
  const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
  if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

  const tid = tileId(worldId, x, y);
  const tile = await cols.tiles.findOne({ _id: tid });
  if (!tile || tile.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', 'Not your territory');
  if (tile.type === 'base') throw new SlgError('BAD_REQUEST', 'The capital has built-in vision; a watchtower cannot be built here');
  if (tile.watchtower) return core.tileDocView(tile, accountId); // idempotent

  // Settle resources first, then validate sufficiency, then deduct (insufficient resources throw INSUFFICIENT_RESOURCES; map state is not modified).
  const t = now();
  const resources = core.settle(pw, t);
  for (const rt of RESOURCE_TYPES) {
    if ((resources[rt] ?? 0) < (WATCHTOWER_COST[rt] ?? 0)) {
      throw new SlgError('INSUFFICIENT_RESOURCES', 'Insufficient resources to build a watchtower');
    }
  }
  for (const rt of RESOURCE_TYPES) resources[rt] -= WATCHTOWER_COST[rt] ?? 0;

  // Deduct resources first, guarded on rev (computed from this exact `pw` read): a concurrent build/upgrade
  // call that lands first bumps rev, so this write must fail rather than silently overwrite it with a
  // stale-computed resources object. Deduct BEFORE marking the tile so a losing race (REV_CONFLICT) never
  // leaves a free, un-paid-for watchtower on the tile.
  const deducted = await cols.playerWorld.updateOne(
    { _id: pw._id, rev: pw.rev },
    { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
  );
  if (deducted.matchedCount === 0) throw new SlgError('REV_CONFLICT', 'Concurrent update, please retry');

  await cols.tiles.updateOne({ _id: tid }, { $set: { watchtower: true }, $inc: { rev: 1 } });

  const after = await cols.tiles.findOne({ _id: tid });
  if (after) {
    void core.pushTile(accountId, after); // owner refetch → expanded vision from the new tower takes effect on next getMap
    await core.pushTileToObservers(after, new Set([accountId])); // tower is a visible structure; observers within vision also see it
  }
  return core.tileDocView(after!, accountId);
}

/**
 * ADR-051 (P5): build a player structure (arrowTower / blocker) on own or same-family territory (§8-O2). Mirrors
 * buildWatchtower's settle→validate→deduct flow. arrowTower registers its 3×3 coverage in the `cover` reverse
 * index (kind:'tower') so advanceMarch's tile-entry check chips passing enemies; blocker registers no coverage —
 * it is enforced at pathfinding time (findMarchPath) instead. One structure per tile.
 */
export async function buildStructure(core: WorldCore, worldId: string, accountId: string, x: number, y: number, kind: 'arrowTower' | 'blocker'): Promise<WorldTileView> {
  const { cols, now } = core.deps;
  const pw = await cols.playerWorld.findOne({ _id: playerWorldId(worldId, accountId) });
  if (!pw) throw new SlgError('TILE_NOT_OWNED', 'Not yet in the world');

  const tid = tileId(worldId, x, y);
  const tile = await cols.tiles.findOne({ _id: tid });
  if (!tile) throw new SlgError('TILE_NOT_OWNED', 'Not your territory');
  // §8-O2: own or same-family territory only (prevents malicious choke-point building on neutral/enemy land).
  const family = await core.familyMemberIds(worldId, accountId);
  const friendly = tile.ownerId === accountId || (!!tile.ownerId && family.has(tile.ownerId));
  if (!friendly) throw new SlgError('TILE_NOT_OWNED', 'Structures can only be built on your own or family territory');
  if (tile.type === 'base') throw new SlgError('BAD_REQUEST', 'Cannot build a structure on the capital');
  if (tile.structure) throw new SlgError('TILE_OCCUPIED', 'This tile already has a structure'); // one structure per tile

  const cost = kind === 'arrowTower' ? ARROW_TOWER_COST : BLOCKER_COST;
  const hpMax = kind === 'arrowTower' ? ARROW_TOWER_HP : BLOCKER_HP;
  const t = now();
  const resources = core.settle(pw, t);
  for (const rt of RESOURCE_TYPES) {
    if ((resources[rt] ?? 0) < (cost[rt] ?? 0)) throw new SlgError('INSUFFICIENT_RESOURCES', 'Insufficient resources to build this structure');
  }
  for (const rt of RESOURCE_TYPES) resources[rt] -= cost[rt] ?? 0;

  const structure: TileStructure = {
    kind, level: 1, hp: hpMax, hpMax, ownerId: accountId,
    ...(pw.familyId ? { familyId: pw.familyId } : {}), builtAt: t,
  };
  // Deduct resources first, guarded on rev (same reasoning as buildWatchtower above): a concurrent build/
  // upgrade call landing first must fail this write rather than silently double-spend, and it must fail
  // BEFORE the tile is marked with the structure so a losing race never leaves a free structure.
  const deducted = await cols.playerWorld.updateOne(
    { _id: pw._id, rev: pw.rev },
    { $set: { resources, lastTickAt: t }, $inc: { rev: 1 } },
  );
  if (deducted.matchedCount === 0) throw new SlgError('REV_CONFLICT', 'Concurrent update, please retry');
  await cols.tiles.updateOne({ _id: tid }, { $set: { structure }, $inc: { rev: 1 } });

  if (kind === 'arrowTower') {
    await core.addCover(worldId, x, y, {
      kind: 'tower', sourceTile: tid, ownerId: accountId, ...(pw.familyId ? { familyId: pw.familyId } : {}),
    });
  }

  const after = await cols.tiles.findOne({ _id: tid });
  if (after) {
    void core.pushTile(accountId, after);
    await core.pushTileToObservers(after, new Set([accountId]));
  }
  return core.tileDocView(after!, accountId);
}

/** ADR-051 (P5): demolish one's own structure. Clears the arrowTower's 3×3 coverage; blocker just drops off the tile. */
export async function demolishStructure(core: WorldCore, worldId: string, accountId: string, x: number, y: number): Promise<WorldTileView> {
  const { cols } = core.deps;
  const tid = tileId(worldId, x, y);
  const tile = await cols.tiles.findOne({ _id: tid });
  if (!tile || !tile.structure) throw new SlgError('TILE_NOT_OWNED', 'No structure here');
  if (tile.structure.ownerId !== accountId) throw new SlgError('TILE_NOT_OWNED', 'Not your structure');

  const wasTower = tile.structure.kind === 'arrowTower';
  await cols.tiles.updateOne({ _id: tid }, { $unset: { structure: '' }, $inc: { rev: 1 } });
  if (wasTower) await core.removeCover(worldId, x, y, tid);

  const after = await cols.tiles.findOne({ _id: tid });
  if (after) {
    void core.pushTile(accountId, after);
    await core.pushTileToObservers(after, new Set([accountId]));
  }
  return core.tileDocView(after!, accountId);
}
