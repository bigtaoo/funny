// worldsvc combat domain: helpers shared across marches (combatMarch) and siege settlement (combatSiege).
// Peeled out of CombatService (2026-07-03) as free functions taking WorldCore explicitly, so both the
// march-arrival path and the siege-settlement path can refund committed troops without a class dependency.
// 2026-08-01 (SLG_DESIGN_LOG §46, "unified return travel time"): also home to computeMarchPath /
// startReturnMarch / parkMarchInPlace, for the same class-dependency reason — combatSiege/*.ts mixins only
// have `this.core`, never a MarchService instance (which itself already depends on SiegeService; a reverse
// dependency would be circular), so anything siege code needs to do with marches has to live here as a free
// function instead of a MarchService method.
import {
  RESOURCE_TYPES,
  RESOURCE_CAP,
  tileId,
  marchId,
  playerWorldId,
  findMarchPath,
  marchDurationFromPath,
  baseFootprintCells,
  SlgError,
  type ResourceType,
  type PathCell,
} from '@nw/shared';
import type { PlayerWorldDoc, MarchDoc, StationedDoc, ArmyEntry } from './db';
import type { WorldCore } from './core';
import { legBox } from './core/helpers';

/**
 * Refund troops to the pool (capped at troopCap) + settle resources; optionally merge loot into resources
 * (capped at RESOURCE_CAP).
 *
 * 2026-08-03 (worldsvc code review): the scheduler runs processDueArrivals/processDueSiegeDamage/
 * processDueOccupations concurrently every tick, and this is the single shared helper all of them call
 * to touch a player's `resources`/`troops` — a return-march refund and a same-tick siege loot capture for
 * the same account each used to read a `pw` snapshot and blind-`$set` from it, so whichever wrote second
 * silently clobbered the first's delta (lost update). Guarded on `rev` now, with a bounded refetch+retry
 * loop so the fix is transparent to the many call sites that just pass in whatever `pw` they already had.
 */
export async function refundTroops(
  core: WorldCore,
  pw: PlayerWorldDoc,
  troops: number,
  t: number,
  loot?: Record<ResourceType, number>,
): Promise<void> {
  const MAX_ATTEMPTS = 5;
  let doc = pw;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const resources = core.settle(doc, t);
    if (loot) {
      for (const rt of RESOURCE_TYPES) {
        resources[rt] = Math.min(RESOURCE_CAP, (resources[rt] ?? 0) + (loot[rt] ?? 0));
      }
    }
    const next = Math.min(doc.troopCap, doc.troops + troops);
    const result = await core.deps.cols.playerWorld.updateOne(
      { _id: doc._id, rev: doc.rev },
      { $set: { resources, troops: next, lastTickAt: t }, $inc: { rev: 1 } },
    );
    if (result.matchedCount > 0) return;
    if (attempt === MAX_ATTEMPTS - 1) {
      // Best-effort: refundTroops is called deep inside scheduler/settlement flows with no HTTP caller
      // to propagate a failure to — throwing here would just risk an unhandled rejection somewhere up
      // the chain. Losing a refund under sustained same-tick contention is a much smaller failure than
      // that, and this path should be vanishingly rare in practice.
      console.error('[worldsvc] refundTroops: giving up after rev-conflict retries', { docId: doc._id, troops });
      return;
    }
    const fresh = await core.deps.cols.playerWorld.findOne({ _id: doc._id });
    if (!fresh) return;
    doc = fresh;
  }
}

/**
 * computeMarchPath's 3 obstacle-scan queries (gates/enemy-bases/blockers) only ever need tiles that could
 * plausibly sit on or near an A*-found route between the two endpoints — a detour wide enough to need
 * anything further out would mean routing around an obstacle cluster far larger than any real terrain
 * feature or base footprint, which doesn't happen on these maps. Margin comfortably covers that (a base
 * footprint is 3×3; procedural obstacle clusters are small), while still shrinking `legBox` down from
 * "the whole map" for the vast majority of marches (occupy/reinforce/move legs are short by construction —
 * ADR-039 requires the target adjacent to owned territory; ADR-053's morale-budget soft-caps long ones too).
 */
const PATHFIND_QUERY_PAD = 60;

/**
 * A* pathfinding for marches, extracted verbatim (2026-08-01) from MarchService's former private
 * `computeMarchPath` (combatMarch.ts) — the body never touched MarchService's own state, only `core.deps`/
 * `core.coordX`/`core.coordY`, so it moves here unchanged to be reusable from combatSiege/*.ts too. See
 * MarchService.computeMarchPath (combatMarch.ts) for the thin wrapper kept for its existing call sites.
 *
 * 2026-08-02: the enemy-base scan (`type:'base'`) was found taking 12+ seconds on an older, populated world
 * (s1-0) — every capital ever founded is a permanent 9-cell `type:'base'` footprint that's never deleted, so
 * on a world with thousands of registered players, `type:'base'` now matches almost the entire `tiles`
 * collection; the 2026-07-29 index (db.ts) assumed that scan would stay small and no longer does at this
 * scale. All 3 obstacle queries are now scoped to a padded bounding box around the march's endpoints
 * (PATHFIND_QUERY_PAD above), using the existing `{worldId,x,y}` index, cutting them back down to "near the
 * route" instead of "the whole world".
 */
export async function computeMarchPath(
  core: WorldCore,
  worldId: string,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  requesterId: string,
): Promise<PathCell[]> {
  const requesterPw = await core.deps.cols.playerWorld.findOne({ _id: playerWorldId(worldId, requesterId) });
  const allyFamilyId = requesterPw?.familyId;

  const box = legBox(fromX, fromY, toX, toY);
  const xRange = { $gte: box.minX - PATHFIND_QUERY_PAD, $lte: box.maxX + PATHFIND_QUERY_PAD };
  const yRange = { $gte: box.minY - PATHFIND_QUERY_PAD, $lte: box.maxY + PATHFIND_QUERY_PAD };

  const gateTiles = await core.deps.cols.tiles
    .find({ worldId, type: { $in: ['bridge', 'plankway'] }, x: xRange, y: yRange })
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
  const destTile = await core.deps.cols.tiles.findOne({ _id: tileId(worldId, toX, toY) });
  const siegeBaseOwner = destTile?.type === 'base' ? destTile.ownerId : undefined;
  const excludeOwners = siegeBaseOwner ? [requesterId, siegeBaseOwner] : [requesterId];
  const blockedBaseTiles = await core.deps.cols.tiles
    .find({ worldId, type: 'base', ownerId: { $nin: excludeOwners }, x: xRange, y: yRange })
    .project<{ x: number; y: number }>({ x: 1, y: 1 })
    .toArray();
  const blockedBaseKeys = new Set<string>(blockedBaseTiles.map((b) => `${b.x}:${b.y}`));
  if (requesterPw?.mainBaseTile) {
    const bx = core.coordX(requesterPw.mainBaseTile), by = core.coordY(requesterPw.mainBaseTile);
    if (Number.isFinite(bx) && Number.isFinite(by)) {
      for (const c of baseFootprintCells(bx, by)) blockedBaseKeys.delete(`${c.x}:${c.y}`);
    }
  }
  const blockerTiles = await core.deps.cols.tiles
    .find({ worldId, 'structure.kind': 'blocker', x: xRange, y: yRange })
    .project<{ x: number; y: number; structure?: { ownerId?: string; familyId?: string } }>({ x: 1, y: 1, 'structure.ownerId': 1, 'structure.familyId': 1 })
    .toArray();
  for (const b of blockerTiles) {
    const so = b.structure;
    const friendly = so?.ownerId === requesterId || (!!allyFamilyId && so?.familyId === allyFamilyId);
    if (!friendly) blockedBaseKeys.add(`${b.x}:${b.y}`);
  }
  const path = findMarchPath(
    worldId,
    core.deps.mapW,
    core.deps.mapH,
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

/**
 * 2026-08-01 (SLG_DESIGN_LOG §46): send survivors home over a travel-time 'return' leg instead of crediting
 * the troop pool instantly from a remote tile — used by every "a real battle was fought at a remote tile and
 * some attacker force survived" site (siege/occupy losses, settleSiegeDamage, field-encounter losses) plus
 * the post-capture `autoReturn` disposition. Mirrors MarchService.recallStationed's fresh-MarchDoc
 * construction (combatMarch.ts) — no existing MarchDoc to flip here (the outbound leg already settled/was
 * deleted), so a brand-new 'return' leg is built from `fromTile` to the player's `mainBaseTile`.
 * No home to return to (should not happen) → falls back to the pre-2026-08-01 instant refund, same as
 * recallStationed's own `!pw.mainBaseTile` fallback.
 */
export async function startReturnMarch(
  core: WorldCore,
  args: {
    worldId: string;
    ownerId: string;
    fromTile: string;
    x: number;
    y: number;
    troops: number;
    army?: ArmyEntry[];
    teamId?: string;
    leaderUnitType?: string;
  },
  t: number,
): Promise<void> {
  const { worldId, ownerId, fromTile, x, y, troops, army, teamId, leaderUnitType } = args;
  const pw = await core.deps.cols.playerWorld.findOne({ _id: playerWorldId(worldId, ownerId) });
  if (!pw) return;
  if (!pw.mainBaseTile) {
    await refundTroops(core, pw, troops, t);
    return;
  }
  const bx = core.coordX(pw.mainBaseTile);
  const by = core.coordY(pw.mainBaseTile);
  try {
    const path = await computeMarchPath(core, worldId, x, y, bx, by, ownerId);
    const arriveAt = t + marchDurationFromPath(path) * 1000;
    const back: MarchDoc = {
      _id: marchId(worldId, ownerId, t, ++core.marchSeq),
      worldId,
      ownerId,
      fromTile,
      toTile: pw.mainBaseTile,
      kind: 'return',
      troops,
      ...(army && army.length > 0 ? { army } : {}),
      ...(teamId ? { teamId } : {}),
      ...(leaderUnitType ? { leaderUnitType } : {}),
      departAt: t,
      arriveAt,
      status: 'marching',
      ...legBox(x, y, bx, by),
      rev: 0,
    };
    await core.deps.cols.marches.insertOne(back);
    void core.pushMarch(ownerId, core.marchView(back));
  } catch (err) {
    // Defensive fallback (2026-08-01): this call sits in the middle of larger settlement flows (base capture →
    // sect-leader penalty → passiveRelocate → mail, siege-damage settlement, etc.) whose later steps must run
    // regardless of whether a travel-time return leg could be dispatched — a pathfinding failure (PATH_BLOCKED)
    // or an unexpected insert error here must never abort those. Falls back to the pre-2026-08-01 instant
    // credit, same "never worse than before" principle as the siege-replay degrade-safely fix earlier today.
    console.error('[worldsvc] startReturnMarch failed — falling back to instant refund', { worldId, ownerId, fromTile, err: (err as Error).message });
    await refundTroops(core, pw, troops, t);
  }
}

/**
 * 2026-08-01 (SLG_DESIGN_LOG §46): a march that reaches its destination only to find the target invalidated
 * (territory disconnected, already taken, contested race) parks in place as a StationedDoc instead of either
 * teleporting home instantly (pre-2026-08-01) or force-marching home (would contradict "stay put" intent) —
 * mirrors settleOccupation's existing "capturing team stays stationed by default" disposition (occupation.ts),
 * just triggered by a miss instead of a capture. Only meaningful for team-dispatched marches (StationedDoc is
 * keyed by teamId); a teamless/flat march has no team-slot identity to park under, so callers must keep using
 * refundTroops for that case (same pre-existing "散兵占领 never stations" carve-out).
 */
export async function parkMarchInPlace(core: WorldCore, m: MarchDoc, survivors: number, t: number): Promise<void> {
  if (!m.teamId) return; // callers must not call this without a teamId — nothing to park under
  const stDoc: StationedDoc = {
    _id: m.toTile,
    worldId: m.worldId,
    ownerId: m.ownerId,
    tile: m.toTile,
    x: core.coordX(m.toTile),
    y: core.coordY(m.toTile),
    teamId: m.teamId,
    army: m.army ?? [],
    troops: survivors,
    sinceAt: t,
    mode: 'idle',
    ...(m.leaderUnitType ? { leaderUnitType: m.leaderUnitType } : {}),
  };
  await core.deps.cols.stationed.updateOne({ _id: m.toTile }, { $set: stDoc }, { upsert: true });
  await core.setOccupancy(m.worldId, m.toTile, {
    kind: 'stationed',
    id: m.toTile,
    ownerId: m.ownerId,
    teamId: m.teamId,
    tile: m.toTile,
    leaveAt: Number.MAX_SAFE_INTEGER,
  });
  void core.pushMarch(m.ownerId, core.marchView({ ...m, status: 'arrived' }));
}
