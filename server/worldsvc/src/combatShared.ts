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
  marchDurationFromPath,
  baseFootprintCells,
  regenTeamStamina,
  SLG_TEAM_STAMINA_COST,
  SLG_TEAM_STAMINA_MAX,
  SlgError,
  type ResourceType,
  type PathCell,
  type EmblemKey,
} from '@nw/shared';
import type { PlayerWorldDoc, MarchDoc, StationedDoc, ArmyEntry, TileDoc } from './db';
import type { WorldCore } from './core';
import { legBox } from './core/helpers';
import { getComputeBackend } from './compute';

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
 *
 * 2026-09-05 (worldsvc-concurrency): the A* itself no longer runs here. It ran synchronously on worldsvc's
 * one event loop, and the concurrency audit measured it blocking that loop for 2-6 SECONDS whenever the
 * destination turned out to be unreachable (rivers and mountain rings cut the map into 20 components joined
 * by only 75 crossings, and a crossing is passable only to whoever holds it — so "unreachable" is the
 * common case, not the exotic one). That is the whole explanation for "my fifth team's order lags": five
 * orders in a row queue behind each other's pathfinding. Everything above this line — the three Mongo
 * obstacle scans — still happens on the main thread, because it is I/O; only the pure computation is handed
 * to the compute backend (worker thread today, a separate service later; see compute/types.ts).
 */
export async function computeMarchPath(
  core: WorldCore,
  worldId: string,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  requesterId: string,
  /**
   * The requester's already-loaded world doc, when the caller has one (2026-09-05, phase 2). Only
   * `familyId` and `mainBaseTile` are read from it, both of which every caller on the dispatch path has
   * already fetched — startMarch reads `pw` as its first statement. Omit it and this re-reads, exactly as
   * before; passing it removes one Mongo round trip from the middle of a ~20-hop command.
   */
  requesterPwDoc?: PlayerWorldDoc | null,
  /** The destination tile, when the caller already holds it (2026-09-17; startMarch batches both march
   *  endpoints, so this was a second read of it). `undefined` = read it here; `null` = no override. */
  destTileDoc?: TileDoc | null,
): Promise<PathCell[]> {
  const requesterPw = requesterPwDoc ?? await core.deps.cols.playerWorld.findOne({ _id: playerWorldId(worldId, requesterId) });
  const allyFamilyId = requesterPw?.familyId;

  const box = legBox(fromX, fromY, toX, toY);
  const xRange = { $gte: box.minX - PATHFIND_QUERY_PAD, $lte: box.maxX + PATHFIND_QUERY_PAD };
  const yRange = { $gte: box.minY - PATHFIND_QUERY_PAD, $lte: box.maxY + PATHFIND_QUERY_PAD };

  // 2026-09-17: one wave, where these four reads used to be four. Three were independent all along; the
  // enemy-base scan depended on the destination tile only because it narrowed the query with
  // `ownerId: {$nin: [requester, siegeTargetOwner]}` — and that exclusion is just as well a predicate on
  // the rows that come back (applied below), which unchains it. A handful of extra projected rows inside
  // the same leg box against one fewer serial wave: on a shared-tier Atlas a wave carries the full stall
  // tail and the rows carry nothing. See design/game/WORLDSVC_CONCURRENCY_AUDIT_2026-09-05.md §11.4.
  const [gateTiles, destTile, baseTiles, blockerTiles] = await Promise.all([
    core.deps.cols.tiles
      .find({ worldId, type: { $in: ['bridge', 'plankway'] }, x: xRange, y: yRange })
      .project<{ _id: string; x: number; y: number; ownerId: string | undefined; familyId: string | undefined }>({
        _id: 1, x: 1, y: 1, ownerId: 1, familyId: 1,
      })
      .toArray(),
    destTileDoc !== undefined ? Promise.resolve(destTileDoc) : core.deps.cols.tiles.findOne({ _id: tileId(worldId, toX, toY) }),
    core.deps.cols.tiles
      .find({ worldId, type: 'base', ownerId: { $ne: requesterId }, x: xRange, y: yRange })
      .project<{ x: number; y: number; ownerId: string | undefined }>({ x: 1, y: 1, ownerId: 1 })
      .toArray(),
    core.deps.cols.tiles
      .find({ worldId, 'structure.kind': 'blocker', x: xRange, y: yRange })
      .project<{ x: number; y: number; structure?: { ownerId?: string; familyId?: string } }>({ x: 1, y: 1, 'structure.ownerId': 1, 'structure.familyId': 1 })
      .toArray(),
  ]);
  const passableGateKeys = new Set<string>(
    gateTiles
      .filter((g) =>
        g.ownerId === requesterId ||
        (allyFamilyId && g.familyId === allyFamilyId),
      )
      .map((g) => `${g.x}:${g.y}`),
  );
  // A siege march may end ON the defender's base, so that owner's tiles must not block it.
  const siegeBaseOwner = destTile?.type === 'base' ? destTile.ownerId : undefined;
  const blockedBaseKeys = new Set<string>(
    baseTiles.filter((b) => !siegeBaseOwner || b.ownerId !== siegeBaseOwner).map((b) => `${b.x}:${b.y}`),
  );
  if (requesterPw?.mainBaseTile) {
    const bx = core.coordX(requesterPw.mainBaseTile), by = core.coordY(requesterPw.mainBaseTile);
    if (Number.isFinite(bx) && Number.isFinite(by)) {
      for (const c of baseFootprintCells(bx, by)) blockedBaseKeys.delete(`${c.x}:${c.y}`);
    }
  }
  for (const b of blockerTiles) {
    const so = b.structure;
    const friendly = so?.ownerId === requesterId || (!!allyFamilyId && so?.familyId === allyFamilyId);
    if (!friendly) blockedBaseKeys.add(`${b.x}:${b.y}`);
  }
  const path = await getComputeBackend().findPath({
    world: worldId,
    mapW: core.deps.mapW,
    mapH: core.deps.mapH,
    fx: fromX,
    fy: fromY,
    tx: toX,
    ty: toY,
    passableGateKeys: [...passableGateKeys],
    blockedBaseKeys: [...blockedBaseKeys],
  });
  if (!path) throw new SlgError('PATH_BLOCKED', 'No viable path found');
  return path;
}

/** What a settled `SiegeDamageDoc` still knows about the force that was besieging. */
export interface SiegeHoldForce {
  worldId: string;
  attackerId: string;
  tile: string;
  attackerSurvivors: number;
  teamId?: string;
  leaderUnitType?: string;
  army?: ArmyEntry[];
}

/**
 * Open the NEXT round of a siege instead of walking home (2026-09-12, user decision: 「攻打完之后，不要
 * 自动回城了，自动开始打下一轮」). A siege now continues until something actually stops it.
 *
 * This does NOT hand-roll a second durability hit. It re-enters the WHOLE attack pipeline by inserting a
 * zero-length attack march that is already due: `processDueArrivalSettlements` claims it on the next
 * scheduler tick and `applySiege` runs exactly as it did for the first round. That is what makes a round a
 * round rather than a repeating timer — the defender's teams heal (SLG_TEAM_INJURY_MS) or get re-crewed
 * between rounds and can repel one, and the attacker's own survivors carry into it through
 * `cardState.currentTroops`.
 *
 * It also means every stop condition already in that pipeline ends the siege on its own, with no new
 * bookkeeping here: repelled or wiped → `applyBaseSiege` starts the return leg; target captured, gone or
 * protected → the settlement branch calling this one walks the team home instead; connectivity lost in the
 * meantime → `applySiege` parks the team where it stands. The one case that does not terminate is a target
 * whose durability regenerates faster than the team can chip it — which is a balance fact about that
 * matchup, not a loop bug: nothing about walking home would have taken it either.
 *
 * **Every round is an order and costs the team's stamina** (2026-09-12 user decision: 「每次开始战斗，
 * 都需要扣除体力的。确实不花时间因为队伍已经在城边了，主要还是靠体力控制平衡」). A round skips the travel leg, not the
 * budget: `SLG_TEAM_STAMINA_COST` per round against `SLG_TEAM_STAMINA_REGEN_PER_MIN` over the delay is
 * what bounds how long one dispatch can grind, and running the budget out ends the siege — the team
 * walks home. A flat-troop assault carries no team and therefore no budget, so it keeps the old
 * one-hit-and-home behaviour instead of looping unbounded.
 *
 * Failing to insert falls back to the old behaviour (walk home) rather than stranding the team: the hold
 * document has already been claimed and deleted by the caller, so returning without doing either would
 * lose the force entirely.
 */
export async function startNextSiegeRound(core: WorldCore, d: SiegeHoldForce, t: number): Promise<void> {
  // Nothing left to fight with (a flat army whose survivors are all gone): there is no round to open, and
  // dispatching one would hand `applySiege` a zero-troop synthesized army. Fall through to the go-home
  // path, whose own empty case announces the hold ended instead of walking anyone anywhere.
  const hasForce = (d.army ?? []).some((e) => !!e.cardInstanceId) || d.attackerSurvivors > 0;
  if (!hasForce) {
    await startSiegeReturnMarch(core, d, t);
    return;
  }
  // No team → no stamina budget → no brake. A flat-troop siege ends after its one hit, as before.
  if (!d.teamId) {
    await startSiegeReturnMarch(core, d, t);
    return;
  }
  const pw = await core.deps.cols.playerWorld.findOne({ _id: playerWorldId(d.worldId, d.attackerId) });
  if (!pw) return; // attacker state gone (world reset under us); nothing to dispatch and nothing to walk home
  const teamState = pw.teamState?.[d.teamId];
  const stamina = regenTeamStamina(
    teamState?.stamina ?? SLG_TEAM_STAMINA_MAX,
    teamState?.staminaAt ?? 0,
    t,
  );
  if (stamina < SLG_TEAM_STAMINA_COST) {
    // Out of budget: the siege is over and the team goes home. This is the stop condition the player
    // actually plans around — see the doc comment above.
    await startSiegeReturnMarch(core, d, t);
    return;
  }
  const { worldId, attackerId, tile } = d;
  const x = core.coordX(tile);
  const y = core.coordY(tile);
  try {
    const next: MarchDoc = {
      _id: marchId(worldId, attackerId, t, ++core.marchSeq),
      worldId,
      ownerId: attackerId,
      // The team is standing on the target, so this leg has no distance to cover: it exists to re-run the
      // assault, not to travel. `arriveAt = t` puts it straight into the settlement queue.
      fromTile: tile,
      toTile: tile,
      kind: 'attack',
      troops: d.attackerSurvivors,
      ...(d.army && d.army.length > 0 ? { army: d.army } : {}),
      ...(d.teamId ? { teamId: d.teamId } : {}),
      ...(d.leaderUnitType ? { leaderUnitType: d.leaderUnitType } : {}),
      departAt: t,
      arriveAt: t,
      status: 'marching',
      ...legBox(x, y, x, y),
      rev: 0,
    };
    await core.deps.cols.marches.insertOne(next);
    // Charged only once the round is really dispatched, and as scoped dotted paths under this team's own
    // subdocument so the write commutes with every other playerWorld writer — the same shape and the same
    // reasoning as `startMarch`'s own stamina charge (combatMarch/command.ts).
    await core.deps.cols.playerWorld.updateOne(
      { _id: pw._id },
      {
        $set: {
          [`teamState.${d.teamId}.stamina`]: stamina - SLG_TEAM_STAMINA_COST,
          [`teamState.${d.teamId}.staminaAt`]: t,
        },
      },
    );
    // Deliberately NOT pushed: the client would see a zero-length march for the ~2s until the tick settles
    // it, i.e. one flicker per round from a document that exists only to re-enter the pipeline. The round's
    // own `pushMarch`/`pushSiege` (combatSiege/arrival/baseSiege.ts) announce it once it has really landed.
  } catch (err) {
    console.error('[worldsvc] startNextSiegeRound failed — walking the besiegers home instead', { worldId, attackerId, tile, err: (err as Error).message });
    await startSiegeReturnMarch(core, d, t);
  }
}

/**
 * Walk a finished siege hold's besiegers home (围攻驻留, 2026-09-12). Every settlement branch of a
 * `SiegeDamageDoc` — the hit landed, the wall fell, or the whole thing went stale — ends the same way: the
 * team that has been standing on the target for five minutes now leaves, and it must leave AS THE TEAM. The
 * four settlement sites used to build this call by hand from `attackerSurvivors` alone, which walked a
 * faceless troop count home and left the team slot pinned to a hold document that was about to be deleted.
 *
 * A card army's survivors are already persisted to `cardState.currentTroops` at the end of the battle, so its
 * return leg carries `troops: 0` — the same rule `applyBaseSiege`/`applyCitySiege` apply to the repelled
 * branch, and without it the pool would be credited a second time for troops the cards already hold.
 */
export async function startSiegeReturnMarch(core: WorldCore, d: SiegeHoldForce, t: number): Promise<void> {
  const hasCardArmy = (d.army ?? []).some((e) => !!e.cardInstanceId);
  if (!hasCardArmy && d.attackerSurvivors <= 0) {
    // Nothing survived to walk home, so no march is pushed — and the hold document the client is
    // rendering a besieging token and a countdown from has just been deleted. Announce it directly, the
    // same rule every other order-ending deletion follows (core/push.ts pushOrderEnded, and the
    // order-end-push-audit test that enumerates these sites).
    void core.pushOrderEnded(d.attackerId, { tile: d.tile, kind: 'attack', status: 'arrived', at: t });
    return;
  }
  await startReturnMarch(core, {
    worldId: d.worldId,
    ownerId: d.attackerId,
    fromTile: d.tile,
    x: core.coordX(d.tile),
    y: core.coordY(d.tile),
    troops: hasCardArmy ? 0 : d.attackerSurvivors,
    ...(d.army && d.army.length > 0 ? { army: d.army } : {}),
    ...(d.teamId ? { teamId: d.teamId } : {}),
    ...(d.leaderUnitType ? { leaderUnitType: d.leaderUnitType } : {}),
  }, t);
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
    const path = await computeMarchPath(core, worldId, x, y, bx, by, ownerId, pw);
    // ADR-074 §8.3 applies to the walk home too — it is the same march clock, and exempting return legs
    // would make the discount depend on which direction a team is facing.
    const speedMult = (await core.sectPayoff(pw.sectId)).marchMult;
    const arriveAt = t + marchDurationFromPath(path, speedMult) * 1000;
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
      ...(speedMult !== 1 ? { speedMult } : {}),
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

/**
 * March/occupy/stationed map-token family-emblem badge (family-emblem-art-prompts.md, 2026-08-14
 * TODO list item 3 — see design/game/WORLD_MAP_ART_SPEC.md §五): given a list of `ownerId`s in the
 * same order as a `getMarches`/`getOccupations`/`getStationed` result array, resolves each owner's
 * family badge and returns a same-length array of `{emblemKey, emblemColor}` (or `undefined` for
 * an owner with no family / no badge chosen) to spread onto each corresponding view entry.
 *
 * Two round trips regardless of list size: one local `playerWorld` query for the ownerId→familyId
 * mirror (same "resolved once at joinWorld, read-only" mirror `familyMemberIds`/`allySectMemberIds`
 * already rely on — a family change after joinWorld is not reflected here, an accepted tradeoff
 * shared with every other consumer of this mirror), then one `getFamiliesByIds` batch call for the
 * distinct familyIds. Never throws — a socialsvc hiccup degrades to "no badges this response" rather
 * than failing the whole list (badges are cosmetic; the unit-rig token itself never depends on this).
 */
export async function resolveOwnerEmblems(
  core: WorldCore,
  worldId: string,
  ownerIds: string[],
): Promise<Array<{ emblemKey: EmblemKey; emblemColor: number } | undefined>> {
  if (ownerIds.length === 0) return [];
  try {
    const distinctOwners = Array.from(new Set(ownerIds));
    const pwDocs = await core.deps.cols.playerWorld
      .find(
        { _id: { $in: distinctOwners.map((id) => playerWorldId(worldId, id)) } },
        { projection: { accountId: 1, familyId: 1 } },
      )
      .toArray();
    const familyIdByOwner = new Map(pwDocs.filter((d) => d.familyId).map((d) => [d.accountId, d.familyId!]));
    const familyIds = Array.from(new Set(familyIdByOwner.values()));
    if (familyIds.length === 0) return ownerIds.map(() => undefined);
    const fams = await core.socialsvc.getFamiliesByIds(familyIds);
    const embByFamily = new Map(
      fams
        .filter((f) => f.emblemKey)
        .map((f) => [f.familyId, { emblemKey: f.emblemKey as EmblemKey, emblemColor: f.emblemColor ?? 0 }]),
    );
    return ownerIds.map((id) => {
      const fid = familyIdByOwner.get(id);
      return fid ? embByFamily.get(fid) : undefined;
    });
  } catch {
    return ownerIds.map(() => undefined); // best-effort — badges are cosmetic, never fail the list for this
  }
}
