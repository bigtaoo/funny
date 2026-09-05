// worldsvc march domain: the arrival tick's batching plan (2026-09-05, `sched:arrivals` deep batching).
//
// Why this file exists. `processDueArrivals` used to walk its due list one march at a time, and each march
// cost a handful of strictly serial round trips: re-read the march, read its playerWorld, then per stepped
// cell clearOccupancy + getOccupancy + getCover + setOccupancy, then persist the cursor. The 200-bot load
// test (2026-09-05, WORLDSVC_CONCURRENCY_AUDIT §5.4) measured the tick at p50 1761ms / p90 6705ms against
// its own 2000ms interval — the first bottleneck left once the event loop had been unblocked.
//
// Why it is not simply "run the marches concurrently". A field encounter (`resolveFieldEncounter`) writes
// the DEFENDER's ledger — their `cardState`, their StationedDoc/MarchDoc — so two marches settled
// concurrently can be two writers on one stranger's documents. That is a real cross-player race, and the
// comment history in arrival.ts shows this code has already been bitten by narrower versions of it. So
// nothing here makes settlement concurrent.
//
// What it does instead: separate the marches that CANNOT fight this tick from the ones that might, and
// batch only the former.
//
//   fast   — a stepping march that (a) does not reach its destination this tick, so no arrival settlement
//            runs, (b) enters no cell holding an occupant or covered by a garrison/tower, and (c) shares no
//            cell with any other march in this tick's batch. Such a march provably only moves: vacate, occupy,
//            advance the cursor. Every one of them together costs one HMGET + one guarded HDEL + one HSET +
//            one Mongo bulkWrite, no matter how many there are.
//   serial — everything else, settled by the untouched per-march code path in arrival.ts. Anything that can
//            fight, arrive, park, or interact with another march in the same tick stays exactly as it was.
//
// Under real load almost every due march is `fast`: MARCH_SPEED_SEC_PER_TILE is 6 and the tick is 2s, so a
// march spends the overwhelming majority of its ticks taking one uneventful step across an empty map.
//
// The planning and classification half is pure — no I/O, no service dependencies — so the rules that decide
// what may be batched can be tested directly instead of only through a live Mongo/Redis fixture. The two
// functions below the second divider are the I/O half: the tick's batched read and its batched write.
import { marchStepArriveAt, playerWorldId, tileId } from '@nw/shared';
import type { MarchDoc } from '../db';
import type { WorldCore } from '../core';
import type { CoverEntry, OccEntry } from '../core/push';

/** What one stepping march will do this tick, derived from its cursor and the clock — no I/O. */
export interface StepPlan {
  march: MarchDoc;
  /** Cells entered this tick, in order: path[stepIndex+1 .. endIndex]. Empty when no step is actually due. */
  entered: string[];
  /** Cells left behind, in order: path[stepIndex .. endIndex-1]. The first is the march's current cell. */
  vacated: string[];
  /** The path index the march sits on after this tick's steps. */
  endIndex: number;
  /** True when `endIndex` is the final path cell — the march must settle its arrival, so it is never `fast`. */
  reachesEnd: boolean;
  /** Distinct cells this march touches this tick (entered ∪ vacated) — the unit of the contention check. */
  cells: string[];
}

/**
 * Replay `advanceMarch`'s stepping loop without doing any work, to learn which cells a march would touch.
 * Returns null for a march that is not stepping (legacy doc / recalled to a 'return' leg) — those settle
 * through the single-arrival model and are never batched.
 *
 * Uses `m.speedMult` and not a fresh lookup, for the same reason advanceMarch does: the cadence has to match
 * the one `arriveAt` was computed from at dispatch (ADR-074 §8.3).
 */
export function planMarchSteps(m: MarchDoc, t: number): StepPlan | null {
  const path = m.path;
  if (!path || m.stepIndex == null || m.nextStepAt == null) return null;
  const last = path.length - 1;
  let idx = m.stepIndex;
  const entered: string[] = [];
  const vacated: string[] = [];
  while (idx < last && marchStepArriveAt(m.departAt, idx + 1, m.speedMult) <= t) {
    const left = path[idx]!;
    vacated.push(tileId(m.worldId, left.x, left.y));
    idx++;
    const cell = path[idx]!;
    entered.push(tileId(m.worldId, cell.x, cell.y));
  }
  return {
    march: m,
    entered,
    vacated,
    endIndex: idx,
    reachesEnd: idx >= last,
    cells: [...new Set([...vacated, ...entered])],
  };
}

export interface ArrivalBatchInput {
  /** Step plans for every stepping march in this tick's due list. */
  plans: StepPlan[];
  /** Legacy / 'return' marches in the same tick: never batched, but their destination cell still contends. */
  legacy: MarchDoc[];
  /** Occupants of every cell any plan enters (one HMGET). */
  occ: Map<string, OccEntry>;
  /** Coverage sources over every cell any plan enters (one HMGET). */
  cover: Map<string, CoverEntry[]>;
  /** Owners that have a playerWorld doc in this world. A march whose owner has none keeps the serial path,
   *  which has its own (odd, pre-existing) handling for that case — see advanceMarch's `if (pw)`. */
  hasPlayerWorld: (m: MarchDoc) => boolean;
}

export interface ArrivalBatchSplit {
  /** Marches that provably only move this tick. Settled by the batched writer. */
  fast: StepPlan[];
  /** Marches that keep the per-march settlement path, in their original due order. */
  serial: MarchDoc[];
  /**
   * Why each serial march is serial. Reported because "the tick is slow" and "the tick is slow FOR THIS
   * REASON" are different findings, and the next lever depends on which: settling arrivals (each one a real
   * battle, not batchable by any amount of cleverness) is a different problem from marches demoted because
   * the ground around them was busy. The first 200-bot run after the batching landed showed 796 batched
   * against 1300 serial, and this is what tells those 1300 apart.
   */
  stats: {
    /** Stepping marches that reach their destination this tick and must settle (fight, park, take ground). */
    arriving: number;
    /** Stepping marches demoted by an occupant, coverage, a shared cell, or a missing playerWorld. */
    blocked: number;
    /** Legacy docs and 'return' legs, which have no stepping cursor and settle by arriveAt. */
    legacy: number;
  };
}

/**
 * Split a tick's due marches into the batchable and the not.
 *
 * The contention rule is deliberately coarse: a march is disqualified if ANY other march in this tick's batch
 * touches ANY of its cells — entered or vacated, hostile or friendly, stepping or arriving. Two marches
 * sharing a cell is precisely the shape of an encounter (someone steps onto someone else's cell), and the
 * whole point of the fast path is that it can be applied without asking who is standing where. A cheaper,
 * cleverer rule would have to reason about arrival order within the tick, which is how this code gets bitten
 * again. Collisions are rare in practice — a few hundred marches on a 1500×1500 map — so the coarse rule
 * costs almost nothing and the demoted marches simply settle the way they always did.
 */
export function splitArrivalBatch(input: ArrivalBatchInput): ArrivalBatchSplit {
  const { plans, legacy, occ, cover, hasPlayerWorld } = input;

  // How many marches in this batch touch each cell. A legacy/return march contributes its destination: that
  // is where applyArrival clears occupancy and where tryParkTeam / a spawned return leg may write it again.
  const touchCount = new Map<string, number>();
  const bump = (cell: string) => touchCount.set(cell, (touchCount.get(cell) ?? 0) + 1);
  for (const p of plans) for (const c of p.cells) bump(c);
  for (const m of legacy) bump(m.toTile);

  const fast: StepPlan[] = [];
  const serial: MarchDoc[] = [];
  let arriving = 0;
  for (const p of plans) {
    const batchable =
      !p.reachesEnd &&
      hasPlayerWorld(p.march) &&
      p.cells.every((c) => touchCount.get(c) === 1) &&
      p.entered.every((c) => !occ.has(c) && !cover.has(c));
    if (batchable) {
      fast.push(p);
      continue;
    }
    if (p.reachesEnd) arriving++;
    serial.push(p.march);
  }
  return { fast, serial, stats: { arriving, blocked: serial.length - arriving, legacy: legacy.length } };
}

/**
 * The occupancy entry a `fast` march ends the tick holding.
 *
 * Only the LAST cell entered gets one. The serial path writes (and then clears) an entry on every
 * intermediate cell as it hops, but on the fast path those writes are unobservable by construction: no other
 * march in the batch touches those cells, and the occ index has exactly one reader — advanceMarch's
 * tile-entry encounter check. Collapsing them keeps the batch's write set one entry per march rather than
 * one per stepped cell.
 *
 * `leaveAt` matches the serial path: when the march moves on, or MAX_SAFE_INTEGER on its final cell (which a
 * fast march never occupies — `reachesEnd` disqualifies it — but the expression is kept identical so the two
 * paths cannot drift).
 */
export function fastOccEntry(p: StepPlan, familyId: string | undefined): OccEntry | null {
  const tile = p.entered[p.entered.length - 1];
  if (!tile) return null;
  const last = (p.march.path?.length ?? 1) - 1;
  return {
    kind: 'march',
    id: p.march._id,
    ownerId: p.march.ownerId,
    ...(familyId ? { familyId } : {}),
    teamId: p.march.teamId,
    tile,
    leaveAt: p.endIndex < last ? marchStepArriveAt(p.march.departAt, p.endIndex + 1, p.march.speedMult) : Number.MAX_SAFE_INTEGER,
  };
}

// ── I/O side: the two batched calls processDueArrivals makes per tick ────────────────────────────────────

/**
 * Everything the split needs, read in a constant number of round trips regardless of how many marches are
 * due: one projected playerWorld query, and one HMGET each for occupancy and coverage per world in the batch
 * (a tick is normally one world). Contrast the per-march path, which reads one playerWorld per march and one
 * occupancy + one coverage per stepped cell.
 *
 * The playerWorld read is projected down to `familyId` on purpose. That is the only field the fast path
 * needs — friend/foe on the occ entry it writes — and a full playerWorld doc carries the whole `cardState`
 * ledger, so pulling hundreds of them would trade a round-trip problem for a payload one. The serial path
 * still loads its own full doc per march, unchanged: it can fight, and combat reads and writes cardState.
 */
export async function collectArrivalBatch(
  core: WorldCore,
  due: MarchDoc[],
  t: number,
): Promise<ArrivalBatchSplit & { familyOf: Map<string, string | undefined> }> {
  const { cols } = core.deps;
  const plans: StepPlan[] = [];
  const legacy: MarchDoc[] = [];
  for (const m of due) {
    const plan = planMarchSteps(m, t);
    if (plan) plans.push(plan);
    else legacy.push(m);
  }

  const pwIds = [...new Set(plans.map((p) => playerWorldId(p.march.worldId, p.march.ownerId)))];
  const pwDocs = pwIds.length
    ? await cols.playerWorld.find({ _id: { $in: pwIds } }, { projection: { familyId: 1 } }).toArray()
    : [];
  const familyOf = new Map<string, string | undefined>(pwDocs.map((d) => [d._id, d.familyId]));

  // Cells to inspect, grouped by world: only the cells marches ENTER. A vacated cell needs no read — the
  // batched clear is match-guarded server-side (clearOccupancyMany), and any contention over it is already
  // caught by the cell-touch count.
  const enteredByWorld = new Map<string, Set<string>>();
  for (const p of plans) {
    if (p.entered.length === 0) continue;
    let set = enteredByWorld.get(p.march.worldId);
    if (!set) enteredByWorld.set(p.march.worldId, (set = new Set()));
    for (const c of p.entered) set.add(c);
  }
  const occ = new Map<string, OccEntry>();
  const cover = new Map<string, CoverEntry[]>();
  for (const [worldId, set] of enteredByWorld) {
    const tiles = [...set];
    const [o, c] = await Promise.all([core.getOccupancyMany(worldId, tiles), core.getCoverMany(worldId, tiles)]);
    for (const [k, v] of o) occ.set(k, v);
    for (const [k, v] of c) cover.set(k, v);
  }

  const split = splitArrivalBatch({
    plans,
    legacy,
    occ,
    cover,
    hasPlayerWorld: (m) => familyOf.has(playerWorldId(m.worldId, m.ownerId)),
  });
  // Legacy / 'return' marches settle through the untouched single-arrival path, ahead of the stepping ones
  // demoted to serial, which is the order processDueArrivals walked the due list in before.
  return { fast: split.fast, serial: [...legacy, ...split.serial], stats: split.stats, familyOf };
}

/**
 * Settle every `fast` march: advance its cursor, vacate the cells it left, occupy the one it reached.
 *
 * Mongo first, Redis second, and that order is the point. The cursor update carries the same guard the
 * per-march path uses (`status:'marching'` AND `kind ≠ 'return'`), so a recall that landed since the due
 * scan fails to match — and only marches whose update actually matched get an occupancy entry written. A
 * recalled march clears its own occ entry as it flips to a return leg (recallMarch), so writing one for it
 * afterwards would strand an entry that nothing will ever clear: the exact leak the per-march path's
 * re-read guards against, closed here for the whole batch in one query instead of one per march.
 */
export async function applyFastSteps(
  core: WorldCore,
  fast: StepPlan[],
  familyOf: Map<string, string | undefined>,
): Promise<void> {
  if (fast.length === 0) return;
  const { cols } = core.deps;

  const res = await cols.marches.bulkWrite(
    fast.map((p) => ({
      updateOne: {
        filter: { _id: p.march._id, status: 'marching' as const, kind: { $ne: 'return' as const } },
        update: {
          $set: { stepIndex: p.endIndex, nextStepAt: marchStepArriveAt(p.march.departAt, p.endIndex + 1, p.march.speedMult) },
          $inc: { rev: 1 },
        },
      },
    })),
    { ordered: false },
  );

  // Fast path for the overwhelmingly common case: every cursor landed, so every march is still ours to move.
  // Only when one did not do we pay a second query to find out which.
  let confirmed = fast;
  if (res.matchedCount < fast.length) {
    const live = await cols.marches
      .find(
        { _id: { $in: fast.map((p) => p.march._id) }, status: 'marching', kind: { $ne: 'return' } },
        { projection: { stepIndex: 1 } },
      )
      .toArray();
    const at = new Map(live.map((d) => [d._id, d.stepIndex]));
    confirmed = fast.filter((p) => at.get(p.march._id) === p.endIndex);
  }

  const byWorld = new Map<string, StepPlan[]>();
  for (const p of confirmed) {
    const list = byWorld.get(p.march.worldId);
    if (list) list.push(p);
    else byWorld.set(p.march.worldId, [p]);
  }
  for (const [worldId, list] of byWorld) {
    const vacated = list.flatMap((p) => p.vacated.map((tile) => ({ tile, id: p.march._id })));
    const entries = list
      .map((p) => fastOccEntry(p, familyOf.get(playerWorldId(p.march.worldId, p.march.ownerId))))
      .filter((e): e is OccEntry => e !== null);
    // Clear before set: within a world the two sets are disjoint (a march never re-enters a cell it vacated
    // this tick, and the contention rule guarantees no two batched marches share a cell), so this only has to
    // be right for one march at a time.
    await core.clearOccupancyMany(worldId, vacated);
    await core.setOccupancyMany(worldId, entries);
  }
}
