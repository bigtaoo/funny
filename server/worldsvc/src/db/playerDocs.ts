// Split 2026-08-10 out of worldsvc/src/db.ts (server.md "单文件 500 行收敛", independent-function-modules
// shape). Player/city domain: per-player world state (resources/troops/teams/training/build queues) plus
// the pure queue-bookkeeping helpers that keep PlayerWorldDoc's indexed "next due" mirror fields in sync,
// and the one-time troop-pool-unification migration that reads/writes this same collection.
import type { Collection, Filter } from 'mongodb';
import type { ResourceType, BuildingKey } from '@nw/shared';
import { troopCapFor, TRAIN_SPEEDUP_BUFF_MULT } from '@nw/shared';
import type { DefenseConfig } from './worldDocs';

/**
 * SLG run-time state for a single card instance in a world season (CHARACTER_CARDS_DESIGN §8.4).
 * Stored in PlayerWorldDoc.cardState; cleared on season reset with the playerWorld document.
 */
export interface CardSLGState {
  /** Current card troop count (0 ~ troopCap). Derived from base-pool (playerWorld.troops) allocation + battle casualties. */
  currentTroops: number;
  /** Injury lock expiry (ms). Card cannot be added to a team until this timestamp passes. Absent = healthy. */
  injuredUntil?: number;
  /** Team slot this card belongs to (t1..t5). Absent = not in any team. */
  teamId?: string;
}

/**
 * Army placement unit. Two shapes share this type depending on where it's stored:
 * - `TeamTemplate.army` (player-authored): `cardInstanceId` only — `unitType`/`initialHp` are derived by
 *   `resolveCardArmy` from CARD_DEFS + `cardState[cardInstanceId].currentTroops` at siege time. An entry
 *   without a resolvable `cardInstanceId` is invalid and never persisted (`sanitizeCardArmy` drops it on
 *   save/read — no raw unitType format is accepted here).
 * - `MarchDoc.army` / `SiegeDoc.attackerArmy` (resolved snapshots): `unitType`/`initialHp` populated directly
 *   by `synthesizeArmy` for flat-troop marches that never attached a team (no `cardInstanceId` involved).
 */
export interface ArmyEntry {
  /** Card instance id. When present, unitType is derived from CARD_DEFS at siege time. */
  cardInstanceId?: string;
  /** Unit type string; populated on synthesized (flat-troop) army snapshots, absent on card-based entries. */
  unitType?: string;
  col: number;
  row: number;
  /** Troop allocation; populated on synthesized army snapshots. On card-based entries, derived from cardState at siege time. */
  initialHp?: number;
}

/** Attack formation template (team, §16.2). Up to SIEGE_TEAM_CAP teams; one team is attached on march → army snapshot goes into MarchDoc. */
export interface TeamTemplate {
  id: string;   // slot id ('t1'..'t5')
  name: string;
  army: ArmyEntry[];
  /**
   * 'move' / occupy post-battle disposition (2026-07-23): when FALSE or absent (default), a team that arrives
   * on a tile — via a 'move' order, or by winning an occupy hold — STAYS stationed on that tile (idle in the
   * field). When TRUE, the team instead marches home after the objective completes (a 'return' leg refunds its
   * troops to the pool and frees the slot). Default off because "stay in place" is the more natural 三国-style
   * behavior (user decision 2026-07-23).
   */
  autoReturn?: boolean;
  /**
   * Team leader (2026-07-25): a `cardInstanceId` that must also appear in `army` — `setTeams`/`getTeams`
   * clear it otherwise (card sold, moved to another team, or removed from the formation). Today it carries
   * no combat effect: it only picks which card's portrait represents the team in the city / world-map team
   * lists. Absent = the client falls back to the strongest card in the army, so every team has an icon
   * without the player having to choose one.
   */
  leaderCardId?: string;
}

/** Training queue entry (S8-2). Each batch queues independently; scheduler converts to troop strength when completeAt is reached. */
export interface TrainingEntry {
  qty: number;       // quantity trained in this batch
  inkCost: number;   // ink already deducted (no refund needed on dequeue)
  startAt: number;   // ms epoch
  completeAt: number; // ms epoch (scheduler adds troops to troops and removes entry when reached)
}

/**
 * Every write to `trainingQueue` must mirror its head (earliest completeAt, the queue is always kept
 * sorted — chained scheduling) onto this scalar so `processCompletedTraining`'s due-scan can use a real
 * index instead of `trainingQueue.0.completeAt` (unindexable in practice, was a full COLLSCAN every
 * scheduler tick — 2026-07-26 VPS CPU investigation). Returns the `$set`/`$unset` fragments to merge into
 * the caller's update; `unset` is only non-empty once the queue drains, since a missing field (not `null`)
 * is what keeps it out of the partial index and out of the due-scan's match.
 */
export function trainingQueueOps(queue: TrainingEntry[]): { set: Record<string, number>; unset: Record<string, ''> } {
  return queue.length > 0 ? { set: { nextTrainingCompleteAt: queue[0]!.completeAt }, unset: {} } : { set: {}, unset: { nextTrainingCompleteAt: '' } };
}

/**
 * S8-8 fix (2026-08-08): fold the train-speedup buff's effect for the real-time window [fromT, toT] into
 * `queue`'s completeAt/startAt. While `speedupUntil` is in the future, the WHOLE queue advances
 * TRAIN_SPEEDUP_BUFF_MULT× faster than real time — every entry's clock shifts earlier by the same amount
 * (`extra`), which preserves both each entry's own duration (completeAt-startAt) and the
 * startAt(i+1)===completeAt(i) chain invariant, so no cascade re-link is needed afterward (contrast with
 * speedupTraining's coin-based instant-skip, which changes each entry's duration and must re-chain).
 *
 * Callers must persist the returned queue AND advance a `speedupSettledAt` bookkeeping field to `toT`
 * together (same $set) — this is the incremental high-water mark that lets the buff apply continuously
 * (purchase → every later trainTroops/speedupTraining/shop call → the 2s scheduler tick) without
 * double-crediting the same real-time window twice. `fromT` is normally the caller's
 * `doc.speedupSettledAt ?? toT` (nothing to catch up on a doc the buff has never touched).
 *
 * Pure — never mutates `queue`. Returns the SAME array reference (not a copy) when there is no overlap:
 * the common case for players with no active buff, or ones already caught up — callers rely on this
 * identity to cheaply skip a wasted write (see ShopService/CityService/processCompletedTraining).
 */
export function applyTrainingSpeedupCatchup(
  queue: TrainingEntry[],
  speedupUntil: number | undefined,
  fromT: number,
  toT: number,
): TrainingEntry[] {
  if (!speedupUntil || queue.length === 0 || toT <= fromT) return queue;
  const overlap = Math.min(toT, speedupUntil) - fromT;
  if (overlap <= 0) return queue;
  const extra = overlap * (TRAIN_SPEEDUP_BUFF_MULT - 1);
  return queue.map((e) => ({ ...e, startAt: e.startAt - extra, completeAt: e.completeAt - extra }));
}

/** Build queue entry (SLG_CITY_DESIGN §4). Mirrors TrainingEntry: chained scheduling, scheduler applies the level when completeAt is reached. */
export interface BuildQueueEntry {
  key: BuildingKey;   // which building is being upgraded
  toLevel: number;    // target level after this upgrade completes
  startAt: number;    // ms epoch
  completeAt: number; // ms epoch (scheduler $inc buildings[key] and removes entry when reached)
}

/** Same fix as `trainingQueueOps`, for `buildQueue` (identical unindexed-`.0.completeAt`-scan bug, same scheduler). */
export function buildQueueOps(queue: BuildQueueEntry[]): { set: Record<string, number>; unset: Record<string, ''> } {
  return queue.length > 0 ? { set: { nextBuildCompleteAt: queue[0]!.completeAt }, unset: {} } : { set: {}, unset: { nextBuildCompleteAt: '' } };
}

/** Player state in a given world (lazy resource settlement: stores aggregate yieldRate + lastTickAt, computes delta on read, no per-tile tick). */
export interface PlayerWorldDoc {
  _id: string; // `{worldId}:{accountId}`
  worldId: string;
  accountId: string;
  troops: number;
  troopCap: number;
  resources: Record<ResourceType, number>;
  yieldRate: Record<ResourceType, number>; // hourly yield rate (updated on tile capture/loss)
  lastTickAt: number; // ms, lazy settlement anchor
  mainBaseTile?: string;
  defense?: DefenseConfig; // main base defense (P5, embedded)
  teams?: TeamTemplate[];  // attack formation templates (G3-2c, ≤ SIEGE_TEAM_CAP teams)
  /**
   * ADR-026: per-team defence run-time state. A team that loses a defensive wave is marked injured (injuredUntil = now + SLG_TEAM_INJURY_MS)
   * and never defends until healed. Keyed by team id ('t1'..'t5'). Distinct from CC-3 card-level cardState[].injuredUntil.
   */
  teamState?: Record<string, { injuredUntil?: number }>;
  familyId?: string;
  /**
   * Sect the family belonged to at joinWorld time (comm-audit batch F item 8b) — same SS7 read-only-mirror
   * tradeoff as familyId above (resolved once up front, subsequent sect changes are not written back; live
   * value lives in socialsvc's FamilyDoc.sectId). Lets vision/penalty code read sectId locally instead of an
   * extra getFamiliesByIds([familyId]) round trip.
   */
  sectId?: string;
  trainingQueue?: TrainingEntry[]; // training queue (S8-2, ≤ TROOP_TRAIN_QUEUE_MAX entries)
  /** Mirror of `trainingQueue[0].completeAt`, absent when the queue is empty — see `trainingQueueOps`. Indexed; scheduler-only, never read by clients. */
  nextTrainingCompleteAt?: number;
  /**
   * S8-8 fix (2026-08-08): train-speedup shop buff end time (ms epoch) — while `now < speedupUntil`, the
   * training queue advances at TRAIN_SPEEDUP_BUFF_MULT× real-time speed (applyTrainingSpeedupCatchup).
   * Stacks additively across repeat purchases from max(current speedupUntil, now) — same pattern as
   * TileDoc.protectedUntil, never wasting overlap. Returned to the client (PlayerWorldView) so the HUD can
   * render a countdown; the client compares against Date.now() itself (present-but-expired is harmless).
   */
  speedupUntil?: number;
  /**
   * S8-8 fix: high-water mark up to which the speedup buff's time-compression has already been folded
   * into `trainingQueue`'s completeAt/startAt (applyTrainingSpeedupCatchup) — incremental bookkeeping so
   * the buff applies continuously without double-crediting the same real-time window twice. Absent =
   * nothing to catch up yet (no buff has ever touched this doc). Indexed alongside speedupUntil;
   * scheduler-only, never read by clients.
   */
  speedupSettledAt?: number;
  hasBattlePass?: boolean;         // current season battle pass (S8-8, cleared on season reset)
  /** Home-city building levels (SLG_CITY_DESIGN; desk defaults to 1, others to 0 when absent). Season-scoped — cleared with the doc on resetSeason. */
  buildings?: Partial<Record<BuildingKey, number>>;
  /** Build queue (SLG_CITY_DESIGN §4, ≤ BUILD_QUEUE_SLOTS entries; chained by completeAt). */
  buildQueue?: BuildQueueEntry[];
  /** Mirror of `buildQueue[0].completeAt`, absent when the queue is empty — see `buildQueueOps` (same reasoning as `nextTrainingCompleteAt`). Indexed; scheduler-only, never read by clients. */
  nextBuildCompleteAt?: number;
  /** CC-3: per-card SLG run-time state (currentTroops / injuredUntil / teamId). Cleared on season reset. */
  cardState?: Record<string, CardSLGState>;
  /** Per-shop-item daily purchase counter (SLG_DESIGN §7.2, 2026-07-15). day = UTC calendar day number (floor(ms / 86400000)); count resets whenever day advances. Absent = 0 purchases so far. */
  shopPurchaseCounts?: Record<string, { day: number; count: number }>;
  rev: number;
}

/** Player/city-domain indexes. */
export async function ensurePlayerIndexes(playerWorld: Collection<PlayerWorldDoc>): Promise<void> {
  await playerWorld.createIndex({ worldId: 1, accountId: 1 });
  await playerWorld.createIndex({ familyId: 1 });
  // settleSeason's battle-pass payout scan (`find({worldId, hasBattlePass:true})`) had no supporting index —
  // COLLSCAN over every playerWorld doc in the world. Partial: only battle-pass holders are indexed (2026-07-27 audit).
  await playerWorld.createIndex(
    { worldId: 1, hasBattlePass: 1 },
    { partialFilterExpression: { hasBattlePass: true } },
  );
  // Due-training scan (processCompletedTraining, every 2s): was `trainingQueue.0.completeAt` with no
  // supporting index — a full COLLSCAN every tick, cost scaling with total playerWorld doc count rather
  // than online-player count (2026-07-26 VPS CPU investigation). Partial: only docs with an active queue
  // carry the field, so the index stays small regardless of how many players have never trained.
  await playerWorld.createIndex(
    { nextTrainingCompleteAt: 1 },
    { partialFilterExpression: { nextTrainingCompleteAt: { $exists: true } } },
  );
  // Same fix, same reasoning, for processCompletedBuilds' `buildQueue.0.completeAt` due-scan.
  await playerWorld.createIndex(
    { nextBuildCompleteAt: 1 },
    { partialFilterExpression: { nextBuildCompleteAt: { $exists: true } } },
  );
  // Speedup-buff catch-up scan (processCompletedTraining, every 2s, S8-8 fix 2026-08-08): finds players
  // with an active/recently-active train-speedup buff so their trainingQueue's completeAt can be
  // continuously compressed (applyTrainingSpeedupCatchup) even between the player's own actions.
  // Partial: only docs that have ever bought a speedup carry the field, so it stays small.
  await playerWorld.createIndex(
    { speedupUntil: 1 },
    { partialFilterExpression: { speedupUntil: { $exists: true } } },
  );
}

/**
 * One-time data migration run once at boot after ensureIndexes.
 *
 * Troop-pool unification (2026-07-21): the old `baseTroopStock` (card-army reserve, init 10000) and
 * `troops` (map pool, init/cap = troopCapFor) were two disconnected buckets — training filled `troops`
 * while distributeTroops drew from `baseTroopStock`, so trained troops could never reach cards. They are
 * now unified onto `troops` (basecap raised to 10000). Fold any legacy `baseTroopStock` into `troops`
 * (clamped to a freshly-recomputed troopCap, which also picks up the raised TROOP_CAP_BASE for existing
 * docs whose stored troopCap froze at the old 2000) and drop the field. Near-lossless; no back-compat shim.
 */
export async function migratePlayerWorldTroopPool(playerWorld: Collection<PlayerWorldDoc>): Promise<void> {
  const legacyFilter = { baseTroopStock: { $exists: true } } as unknown as Filter<PlayerWorldDoc>;
  const cursor = playerWorld.find(legacyFilter);
  let migrated = 0;
  for await (const doc of cursor) {
    const legacyStock = (doc as { baseTroopStock?: number }).baseTroopStock ?? 0;
    const newCap = troopCapFor(doc.buildings);
    const newTroops = Math.min(newCap, (doc.troops ?? 0) + legacyStock);
    // Unguarded on purpose (2026-08-24 sweep): runMigrations (db/client.ts) runs once at boot, before the
    // service accepts traffic or starts its scheduler, so there is no concurrent writer to lose here.
    await playerWorld.updateOne(
      { _id: doc._id },
      {
        $set: { troops: newTroops, troopCap: newCap },
        $unset: { baseTroopStock: '' } as never,
        $inc: { rev: 1 },
      },
    );
    migrated++;
  }
  if (migrated > 0) console.log(`[world-mongo] troop-pool unification: folded baseTroopStock into troops for ${migrated} players`);
}
