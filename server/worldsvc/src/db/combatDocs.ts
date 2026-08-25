// Split 2026-08-10 out of worldsvc/src/db.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Combat/march domain: in-transit marches, siege battle reports, the two delayed-settlement
// "pending hold" doc shapes (building-HP damage / occupation), and stationed (parked) teams.
import type { Collection } from 'mongodb';
import type { MarchKind, SiegeOutcome, ResourceType, TileType, PathCell } from '@nw/shared';
import type { EngineCardInstance, EngineEquipInv } from '@nw/engine';
import type { ArmyEntry } from './playerDocs';
import type { DefenseConfig } from './worldDocs';

export interface MarchDoc {
  _id: string; // marchId
  worldId: string;
  ownerId: string;
  fromTile: string;
  toTile: string;
  kind: MarchKind;
  troops: number;
  /** Attacker formation snapshot (G3-2c, copied from TeamTemplate.army when attaching a team; the team can be edited after marching without affecting troops already en route). */
  army?: ArmyEntry[];
  /** ADR-026: which team slot ('t1'..'t5') this march deployed. A team referenced by an active (non-recalled) march is "out" and skipped as a defender. */
  teamId?: string;
  /**
   * March-token art (2026-07-26): the team's leader card's unit-type, resolved once at dispatch (mirrors
   * team.leaderCardId if set and still in army, else the strongest card by cardPower — same rule as the
   * client's teamTroops.ts::teamLeaderCard(), see worldsvc/src/leaderUnit.ts::resolveLeaderUnitType) and
   * frozen onto the march so later card edits, or the requester lacking access to another player's cardInv
   * (enemy marches), never affect the rendered token. Absent on flat-troop marches (no team attached).
   */
  leaderUnitType?: string;
  /** Remaining morale (0..MARCH_MORALE_MAX) computed once at departure from path length (1 lost per tile moved). Bound to this march instance only; scales combat power on arrival (moraleCombatMultiplier). Absent on legacy docs → treated as full (MARCH_MORALE_MAX). */
  morale?: number;
  departAt: number;
  arriveAt: number;
  /**
   * ADR-051 (P1): the full A* path (start..end inclusive), persisted so the march can advance tile-by-tile for
   * real-time encounter checks (previously the path was computed at dispatch and discarded). Per-tile step time
   * is uniform: the march reaches `path[i]` at `departAt + i * MARCH_SPEED_SEC_PER_TILE * 1000` (so the final
   * cell's time == arriveAt, since marchDurationFromPath = (path.length-1) * MARCH_SPEED_SEC_PER_TILE). Absent on
   * legacy docs and on 'return' legs not yet migrated to stepping → those fall back to the single-arrival model.
   */
  path?: PathCell[];
  /** ADR-051 (P1): index into `path` of the cell the march currently occupies (0 = fromTile). Absent → not yet stepping. */
  stepIndex?: number;
  /** ADR-051 (P1): timestamp (ms) at which the march next advances one cell (reaches path[stepIndex+1]). The scheduler's step scan is keyed on this. Absent → legacy single-arrival march (driven by arriveAt). */
  nextStepAt?: number;
  status: 'marching' | 'arrived' | 'recalled';
  /**
   * ADR-051 (P3a): dispatch intent for a 'move' order — whether the team parks as idle (停留) or garrison (驻扎)
   * on arrival (applyMove writes it to StationedDoc.mode). Only meaningful for kind='move'; absent → 'idle'.
   */
  stationMode?: 'idle' | 'garrison';
  /**
   * Query-optimization (2026-07-29, worldsvc march/stationed query audit): bounding box of this leg's two
   * endpoints (fromTile/toTile), i.e. `[min(fromX,toX), max(fromX,toX)] × [min(fromY,toY), max(fromY,toY)]`.
   * getMarches' vision-gated "enemy march" branch used to pull EVERY in-transit march in the world
   * (`find({worldId,status:'marching'})`) and filter by interpolated position in JS; these four fields let
   * that query push a coarse "does this march's whole visited range even overlap the viewer's vision
   * bounding box" filter down into Mongo first. Deliberately a static per-leg box, not a live "current
   * position": getMarches' vision math (`marchInterpPos`) has always been a straight-line interpolation
   * between fromTile and toTile — never the bent A* `path` used for encounter-checking — so the true
   * position at any instant is guaranteed to lie inside this box for the box's entire lifetime; no per-tick
   * write-amplification is needed to keep it fresh. Computed once at creation (`legBox`, core/helpers.ts) by
   * every code path that inserts a MarchDoc (startMarch, autoReturnScout, recallStationed) and re-affirmed
   * (not recomputed — swapping the two endpoints yields the same box) by recallMarch's outbound→return flip
   * so a legacy doc missing these fields self-heals the moment it is recalled. Absent on pre-2026-07-29 docs
   * still in flight at deploy time — see migrateMarchBbox.ts for the one-time backfill.
   */
  minX?: number;
  maxX?: number;
  minY?: number;
  maxY?: number;
  rev: number;
}

export interface SiegeDoc {
  _id: string; // siegeId
  worldId: string;
  /** Attacking march's _id — lets the client correlate the resolved siege back to its march
   * token (e.g. to play an attack animation before tearing the token down). */
  marchId: string;
  attackerId: string;
  /** MarchKind of the attacking/occupying march (2026-08-02) — lets pushSiege tell the client whether
   * this was its own occupy-land-grab vs. an attack vs. a field encounter, without the client having
   * to remember what it dispatched (see core/push.pushSiege). */
  marchKind: MarchKind;
  defenderId?: string;
  tile: string;
  outcome: SiegeOutcome;
  replayRef?: string;
  recomputed: boolean;
  ts: number;
  /** TTL anchor (BSON Date; Mongo TTL only works on Date, `ts` above is a plain number) — SIEGE_RETENTION_SEC
   * safety net, 2026-07-27 audit finding (this collection previously had no expiry at all). */
  expireAt: Date;
  /**
   * G3-2c replay spectator: persists the inputs of the battle (seed + both sides' formations + tile level).
   * The client uses this to reconstruct buildSiegeBattle and headless-replay with the same seed (pure
   * presentation, not authoritative — see the outcome caveat below).
   * As of 2026-08-01, this is persisted unconditionally on every battle that builds an army/defenderConfig —
   * whether the actual settlement ran the full engine, the cheap linear formula (`shouldUseCheapSiege`), or hit
   * a genuine engine crash (the exact inputs that crashed `runSiegeBattle` are kept too, for offline
   * reproduction). A from-scratch replay of a cheap-resolved or crash-fallback battle can therefore show a
   * different winner than the recorded `outcome`, or fail to reconstruct at all — traceability was judged worth
   * that risk over silently losing the ability to inspect or reproduce a battle after the fact (see
   * combatSiege/arrival.ts applySiege). getSiegeReplay's fetch is wrapped in try/catch on both the server
   * (httpApi.ts's top-level handler → clean 500) and the client (world.ts's goSiegeReplay → falls back to the
   * map), so a replay that fails to reconstruct/re-run degrades safely rather than crashing either side.
   * Still absent only for legacy battle reports predating this field and no-combat instant occupies (empty NPC
   * garrison — no army was ever built to store).
   */
  seed?: number;
  attackerArmy?: ArmyEntry[];
  defenderConfig?: DefenseConfig | null;
  tileLevel?: number;
  /**
   * 2026-08-12 fix (replay-fidelity gap): the attacker's card instances/equipment/academy buff, the
   * SAME inputs `resolveOccupationBattle`/`applySiege` actually fed into `buildSiegeBlueprints` at
   * settlement time. Without these, a from-scratch replay of a card-army battle rebuilds every unit's
   * attack/armor/abilities from plain baseline blueprints instead of the attacker's real stats — this is
   * a much larger source of outcome divergence than the pre-existing cheap-formula/crash-fallback
   * caveat (seed/attackerArmy/defenderConfig/tileLevel's doc comment above), since it silently drops
   * data that was actually authoritative rather than skipping a step that never ran. Absent for a
   * flat/synthesized army (no card team attached) — same absence rule as `attackerArmy`'s per-entry
   * cardInstanceId.
   */
  cardInstances?: EngineCardInstance[];
  equipmentInv?: EngineEquipInv;
  siegeAcademy?: { hp: number; damage: number; siege: number };
}

/**
 * ADR-026: pending delayed building-HP hit. Written when an attacker clears a building's garrison (wave battle won, or no defenders present);
 * the scheduler settles it at `dueAt` (= win time + SLG_SIEGE_DAMAGE_DELAY_MS), deducting `damage` from the target building's HP and capturing it at HP≤0.
 * Idempotent by _id (siegeId of the winning siege). Deleted after settlement.
 */
export interface SiegeDamageDoc {
  _id: string;          // = siegeId of the victorious siege (idempotency key)
  worldId: string;
  attackerId: string;
  defenderId?: string;  // building owner (absent for ownerless PvE buildings)
  tile: string;         // target building tile (anchor for a main base); for a city hit, the footprint cell the march landed on
  isBase: boolean;      // true → main base (HP≤0 triggers passiveRelocate); false → territory/level tile (HP≤0 → hand over)
  /**
   * ADR-074 P1: set when the target is a WILD CITY (`CityDoc._id`) rather than a tile-scale building. The
   * settlement branch is entirely different — durability lives on the city document, ownership is by sect,
   * and capture posts announcements instead of relocating a base — so `settleSiegeDamage` dispatches on the
   * presence of this field (see combatSiege/cityDamage.ts). `isBase` is false for these.
   */
  cityId?: string;
  /**
   * Besieging sect at the moment the ladder was cleared, snapshotted rather than re-read at settlement:
   * ownership must go to the sect that actually did the work, not to whichever sect the attacker happens to
   * belong to five minutes later. Only set alongside `cityId`.
   */
  attackerSectId?: string;
  damage: number;       // attacking team's siege value to subtract from building HP
  attackerSurvivors: number; // attacker surviving troops, refunded / used as new garrison on capture
  familyId?: string;    // attacker family (activity/nation bookkeeping at settlement)
  dueAt: number;        // ms; scheduler settles when now ≥ dueAt
}

/**
 * ADR-037 (§5.4): pending occupation hold. Written when an occupy (or expelling attack/occupy) march wins its PvE
 * battle against a neutral tile's system garrison; the scheduler finalizes ownership at `dueAt` (= win time +
 * OCCUPY_HOLD_SEC*1000) via `processDueOccupations`. `_id` = the target tileId (mirrors the tile 1:1 — at most one
 * pending hold per tile at a time; an expelling march deletes/replaces this doc atomically instead of stacking).
 * Idempotency/race-safety mirrors SiegeDamageDoc: claimed via findOneAndDelete, re-validated against the tile's
 * current `contestedBy` before writing ownership.
 */
export interface OccupationDoc {
  _id: string;          // = tileId (one pending hold per tile)
  worldId: string;
  ownerId: string;       // pending occupier accountId
  familyId?: string;
  tile: string;          // same value as _id, kept for readability/parity with SiegeDamageDoc.tile
  x: number;
  y: number;
  level: number;
  resType?: ResourceType;
  /**
   * 2026-08-09: the TileType `settleOccupation` writes once this hold settles. Absent = 'territory'
   * (the pre-existing default — a captured neutral/stronghold tile always becomes plain territory).
   * Only ever 'bridge'/'plankway' in practice — a captured crossing must KEEP its passage type rather
   * than settle into 'territory' like every other capture (see writeContestedHold's settleType).
   */
  type?: TileType;
  garrison: number;      // surviving troops; becomes the tile's garrison on settlement
  dueAt: number;         // ms; scheduler settles when now >= dueAt
  /** ADR-026 §2 / idle-team gate (2026-07-15): team slot that won this hold, carried over from MarchDoc.teamId so the team stays "out" through the occupation countdown, not just in transit. */
  teamId?: string;
  /** Leader unit-type snapshot (march-token art, 2026-07-26), carried over from MarchDoc.leaderUnitType — see MarchDoc for the resolution rule. Absent when the march had no team (flat-troop march). */
  leaderUnitType?: string;
}

/**
 * Stationed team (2026-07-23): a team parked on a tile, standing idle "out in the field" until the owner
 * moves or recalls it. Written when a 'move' march arrives (combatMarch.applyMove) or when an occupy hold
 * settles for a team whose `autoReturn` is off (occupation.settleOccupation). Keyed by tileId (one stationed
 * team per tile). Keeps the team "busy" via the same partial-unique {worldId,ownerId,teamId} index the march
 * idle-gate relies on, so a stationed team can't accept a fresh order until recalled. The tile's own ownership
 * is orthogonal — a team may stand on its own territory OR on an unclaimed neutral tile it does not own.
 */
export interface StationedDoc {
  _id: string;          // = tileId (one stationed team per tile)
  worldId: string;
  ownerId: string;      // the team's owner accountId
  familyId?: string;
  tile: string;         // same value as _id (parity with OccupationDoc.tile)
  x: number;
  y: number;
  teamId: string;       // team slot ('t1'..'t5') parked here
  army: ArmyEntry[];    // army snapshot (card entries; strength lives in cardState.currentTroops)
  troops: number;       // committed troop count carried when the team arrived (display / recall refund for flat armies)
  sinceAt: number;      // ms the team arrived and became stationed
  /** Leader unit-type snapshot (march-token art, 2026-07-26), carried over from MarchDoc.leaderUnitType — see MarchDoc for the resolution rule. Absent when the march had no team (flat-troop march). */
  leaderUnitType?: string;
  /**
   * ADR-051 (P3a): 停留 idle vs 驻扎 garrison. idle = free (defends only its own cell, can be re-commanded);
   * garrison = busy, actively defends its 9-cell footprint (covered via the `cover` reverse index, intercepting
   * enemies that pass — P3b). Absent on legacy docs → treated as 'idle' (the pre-split behavior).
   */
  mode?: 'idle' | 'garrison';
}

/** Combat/march-domain indexes. */
export async function ensureCombatIndexes(
  marches: Collection<MarchDoc>,
  sieges: Collection<SiegeDoc>,
  siegeDamage: Collection<SiegeDamageDoc>,
  occupations: Collection<OccupationDoc>,
  stationed: Collection<StationedDoc>,
): Promise<void> {
  await marches.createIndex({ worldId: 1, ownerId: 1 });
  // getMarches' vision-gated "other players' marches" branch does `find({worldId, status:'marching'})`
  // with no supporting index (world scoping alone was not a usable prefix without status). Called on every
  // client poll (~5s), so worth indexing even though most live marches already carry status:'marching'.
  await marches.createIndex({ worldId: 1, status: 1 });
  // getMarches' enemy-march branch (2026-07-29 audit): narrows the `{worldId,status:'marching'}` scan above
  // by the viewer's territory/vision bounding box (minX/maxX/minY/maxY, see MarchDoc doc comment) before the
  // exact per-position `isInVision` filter runs in JS. Mongo can only treat one of these four as a true
  // range bound per index (the rest ride along as a residual filter on the already-narrowed candidate set),
  // but that is still a large win over the full per-world scan this replaces.
  await marches.createIndex({ worldId: 1, status: 1, minX: 1, maxX: 1, minY: 1, maxY: 1 });
  // Due-time scan (2026-07-27: sole arrival mechanism — the Redis wake-up ZSET this comment used to
  // describe was write-only and was removed as dead I/O, see redis.ts history).
  await marches.createIndex({ arriveAt: 1 });
  // ADR-051 (P1): stepping marches are driven off their next per-tile step time; the arrival scan matches on
  // nextStepAt for them (and falls back to arriveAt for legacy/return legs that carry no stepping cursor).
  await marches.createIndex({ nextStepAt: 1 });
  // Idle-team invariant (2026-07-22): a team may hold only ONE active state. Team-based marches are the only
  // docs carrying `teamId` (flat-pool marches have none; recall rewrites the SAME doc into a return leg; arrived
  // marches are deleted) — so a partial-unique index on {worldId,ownerId,teamId} atomically forbids a second
  // in-flight march for the same team, closing the check-then-insert race in combatMarch.startMarch that the
  // pre-insert findOne cannot. Wrapped best-effort: if a pre-existing duplicate (from the very bug this fixes)
  // blocks the build, log and continue — marches are transient (arrive within minutes) so a later boot succeeds;
  // startMarch's E11000→TEAM_BUSY catch and the findOne pre-check still guard in the meantime.
  try {
    await marches.createIndex(
      { worldId: 1, ownerId: 1, teamId: 1 },
      { unique: true, partialFilterExpression: { teamId: { $exists: true } } },
    );
  } catch (e) {
    console.warn('[worldsvc] marches team-unique index not built (duplicate active team march?); will retry on next boot:', e);
  }
  await sieges.createIndex({ worldId: 1, ts: -1 });
  await sieges.createIndex({ attackerId: 1 });
  // listSieges' `defenderId` branch of its $or had no supporting index — a full COLLSCAN on every
  // replay-browser open, growing with `sieges` (which has no TTL; 2026-07-26 VPS CPU investigation).
  await sieges.createIndex({ worldId: 1, defenderId: 1 });
  // TTL safety net (2026-07-27 audit finding): resetSeason already wipes this per-world at every season
  // reset; this only bounds growth if a reset is delayed/skipped. See SIEGE_RETENTION_SEC's comment.
  await sieges.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
  // ADR-026: delayed building-HP settlement scan (mirrors marches.arriveAt: due-time polling is the sole mechanism).
  await siegeDamage.createIndex({ dueAt: 1 });
  await siegeDamage.createIndex({ tile: 1 });
  // ADR-037 (§5.4): occupation-hold settlement scan (mirrors siegeDamage.dueAt: due-time polling is the sole mechanism).
  await occupations.createIndex({ dueAt: 1 });
  // TEAM_BUSY gate (`findOne({worldId,ownerId,teamId})`, every march dispatch) and getStationed's
  // `find({worldId,ownerId})` had no supporting index beyond {dueAt} — COLLSCAN on the hottest occupation
  // read path. Compound covers both (teamId optional trailing key still lets the {worldId,ownerId} prefix
  // serve the two-field query). Found 2026-07-27 audit.
  await occupations.createIndex({ worldId: 1, ownerId: 1, teamId: 1 });
  // Stationed teams (2026-07-23): listed per owner (getStationed); the partial-unique {worldId,ownerId,teamId}
  // is the counterpart of the marches team-unique index — together they enforce "a team holds ONE active state"
  // across in-transit marches, occupation holds, and now field stationing. Wrapped best-effort like the marches one.
  await stationed.createIndex({ worldId: 1, ownerId: 1 });
  // getStationed's enemy-team branch (2026-07-29 audit): used to be `find({worldId, ownerId:{$ne:accountId}})`
  // — `$ne` falls outside the {worldId,ownerId} index prefix, so it degenerated to a per-world scan of every
  // stationed team in the world. Replaced by a viewer territory/vision bounding-box range filter on the
  // team's fixed (x,y) (stationed teams don't move, unlike marches — no derived box needed); self-exclusion
  // is now a cheap in-memory check on the already box-narrowed result instead of driving the index.
  await stationed.createIndex({ worldId: 1, x: 1, y: 1 });
  try {
    await stationed.createIndex({ worldId: 1, ownerId: 1, teamId: 1 }, { unique: true });
  } catch (e) {
    console.warn('[worldsvc] stationed team-unique index not built (duplicate stationed team?); will retry on next boot:', e);
  }
}
