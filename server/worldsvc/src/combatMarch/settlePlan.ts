// worldsvc march domain: which arrival settlements may run at the same time (2026-09-26,
// WORLDSVC_CONCURRENCY_AUDIT §12.7 phase 2 / §12.11).
//
// The settlement pass used to settle its due list strictly one march at a time, because a settlement can write
// other players' documents (the defender's ledger, their stationed team, their tile) and two settlements running
// together could be two writers on one stranger's doc (§6.1). That kept a 3000-player world to one settlement
// line whose throughput is "one battle's worth of serial Mongo/Redis round trips" at a time.
//
// What this module does instead: predict, BEFORE settling, the set of keys each settlement may write —
//   a:<accountId>  every player whose playerWorld / cardState / march / stationed docs it may touch
//   t:<tileId>     every cell whose TileDoc / StationedDoc / occupancy / coverage entry it may touch
// — and let a settlement run concurrently only when no OTHER settlement in the same pass shares any of its keys.
// Everything else keeps the old behaviour: it runs alone, in due order, as a barrier (nothing else in flight).
//
// Why static disjointness and not a runtime lock manager. Keys are known for the whole pass up front, so a
// settlement whose keys collide with anyone's simply is not a candidate; no lock is ever waited on, so there is
// no ordering to get wrong and nothing to deadlock. The cost is that two colliding settlements both go serial
// rather than one of them running in parallel — cheap, because in a big world almost every settlement in a pass
// is aimed at a different target by a different player.
//
// Why a prediction is safe to act on. The keys come from the pass's own snapshot (the march, its target TileDoc,
// the occupancy/coverage of the cells it enters). That snapshot can only be invalidated, inside the pass, by
// another settlement writing one of those keys — and any such settlement is either a collision (so both run
// serially) or an exclusive barrier that finishes before anything after it starts. What a barrier can change
// unpredictably (a field encounter's defender) only ever REMOVES units or strength; it never adds an occupant
// or coverage to a cell someone else was cleared to enter, because parking and cover writes are keyed on the
// barrier's own predicted cells.
//
// Exclusive (never concurrent), by rule:
//   - a stepping march that enters a cell holding an ENEMY occupant or ENEMY coverage: that is a field
//     encounter, and its defender (the occupant's owner, the cover's off-path source tile) is exactly the part
//     that cannot be locked in advance;
//   - an attack landing on wild-city ground: city defenders are whoever has a garrison parked anywhere in the
//     footprint (up to 9×9), resolved inside the siege;
//   - any kind this file does not know — a new kind must opt in here, not be parallelised by default.
//
// What this does NOT cover, and did not before either: the step scan, the siege-damage and occupation ticks and
// the HTTP commands all run concurrently with the settlement pass on their own timers, today as they did when the
// pass was serial. This file only makes settlements safe against EACH OTHER.
import { cachedProceduralTile, isCityGroundTile, playerWorldId, tileId } from '@nw/shared';
import type { MarchDoc, TileDoc } from '../db';
import type { WorldCore } from '../core';
import type { CoverEntry, OccEntry } from '../core/push';
import { planMarchSteps, type StepPlan } from './arrivalBatch';

/** The target fields a prediction reads — the settlement itself re-reads the full doc. */
export type SettleTarget = Pick<TileDoc, 'ownerId' | 'contestedBy' | 'baseAnchor'>;

export interface SettleInput {
  march: MarchDoc;
  /** Null for a legacy doc / return leg (no stepping cursor): nothing is walked, nothing can be encountered. */
  plan: StepPlan | null;
  /** The target TileDoc as of the pass snapshot; null when the cell has no doc (open land, city ground). */
  target: SettleTarget | null;
  /** The marcher's familyId (friend/foe on the encounter check), undefined when none or no playerWorld. */
  familyId: string | undefined;
  /** Occupancy / coverage of the cells this pass's stepping marches enter. */
  occ: Map<string, OccEntry>;
  cover: Map<string, CoverEntry[]>;
  /** Pass clock — an occupant whose `leaveAt` has passed no longer fights (same test as the walk). */
  t: number;
}

export interface SettleKeys {
  keys: string[];
  /** True when the write set could not be fully predicted: run alone, whatever the keys say. */
  exclusive: boolean;
}

function parseTile(tid: string): { world: string; x: number; y: number } {
  const p = tid.split(':');
  return { world: p.slice(0, -2).join(':'), x: Number(p[p.length - 2]), y: Number(p[p.length - 1]) };
}

/** The 3×3 around a cell: a garrison's and an arrow tower's coverage footprint, and a parked team's own cell. */
function ring3(tid: string): string[] {
  const { world, x, y } = parseTile(tid);
  const out: string[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push(tileId(world, x + dx, y + dy));
  return out;
}

/** The same friend/foe rule walkClaimed applies before it fights: not ours, not our family. */
function isEnemy(ownerId: string, familyId: string | undefined, m: MarchDoc, myFamily: string | undefined): boolean {
  return ownerId !== m.ownerId && !(myFamily && familyId === myFamily);
}

/**
 * Predict one settlement's write set. Pure.
 *
 * Tiles: the 3×3 around the destination for every kind — a miss parks the team there, a garrison adds coverage
 * over it, a razed tower removes coverage over it — plus every cell the walk enters, plus the 3×3 around the
 * departure tile for a move (whose fallback parks back home), plus a base's anchor (ring-cell sieges read it).
 * Accounts: the marcher, the target's owner and its pending occupier (the only players other than the marcher a
 * non-encounter settlement ever writes).
 */
export function settlementKeys(input: SettleInput): SettleKeys {
  const { march: m, plan, target, familyId, occ, cover, t } = input;
  const tiles = new Set<string>(ring3(m.toTile));
  const accounts = new Set<string>([m.ownerId]);
  let exclusive = false;

  if (target?.ownerId) accounts.add(target.ownerId);
  if (target?.contestedBy) accounts.add(target.contestedBy);
  if (target?.baseAnchor) tiles.add(target.baseAnchor);

  switch (m.kind) {
    case 'return':
    case 'reinforce':
    case 'sweep':
    case 'occupy':
      break;
    case 'move':
      if (m.fromTile) for (const c of ring3(m.fromTile)) tiles.add(c);
      break;
    case 'attack': {
      const { world, x, y } = parseTile(m.toTile);
      if (!target?.ownerId && isCityGroundTile(cachedProceduralTile(world, x, y).type)) exclusive = true;
      break;
    }
    default:
      exclusive = true;
  }

  if (plan) {
    for (const c of plan.cells) tiles.add(c);
    for (const c of plan.entered) {
      const o = occ.get(c);
      if (o && o.id !== m._id && o.leaveAt > t && isEnemy(o.ownerId, o.familyId, m, familyId)) exclusive = true;
      if ((cover.get(c) ?? []).some((e) => isEnemy(e.ownerId, e.familyId, m, familyId))) exclusive = true;
    }
  }

  return { keys: [...[...accounts].map((a) => `a:${a}`), ...[...tiles].map((c) => `t:${c}`)], exclusive };
}

/**
 * Which settlements of a pass may run concurrently: those that are not exclusive and share no key with ANY other
 * settlement of the pass (exclusive ones included — their predictable keys still count). Pure; index-aligned
 * with `all`.
 */
export function concurrentEligible(all: SettleKeys[]): boolean[] {
  const count = new Map<string, number>();
  for (const s of all) for (const k of new Set(s.keys)) count.set(k, (count.get(k) ?? 0) + 1);
  return all.map((s) => !s.exclusive && s.keys.every((k) => count.get(k) === 1));
}

// ── I/O side: the pass snapshot the prediction reads ─────────────────────────────────────────────────────

/**
 * Predict every settlement of a pass. A constant number of round trips however many marches are due: one
 * projected TileDoc query for the targets, one projected playerWorld query for the marchers' families, and one
 * HMGET each for occupancy and coverage per world over the cells the stepping marches enter — the same reads
 * collectArrivalBatch makes for the walking half, for the same reason.
 */
export async function collectSettlementKeys(core: WorldCore, due: MarchDoc[], t: number): Promise<SettleKeys[]> {
  const { cols } = core.deps;
  const plans = due.map((m) => planMarchSteps(m, t));

  const tileIds = [...new Set(due.map((m) => m.toTile))];
  const pwIds = [...new Set(due.filter((_, i) => plans[i]).map((m) => playerWorldId(m.worldId, m.ownerId)))];
  const [tileDocs, pwDocs] = await Promise.all([
    cols.tiles.find({ _id: { $in: tileIds } }, { projection: { ownerId: 1, contestedBy: 1, baseAnchor: 1 } }).toArray(),
    pwIds.length
      ? cols.playerWorld.find({ _id: { $in: pwIds } }, { projection: { familyId: 1 } }).toArray()
      : Promise.resolve([]),
  ]);
  const targetOf = new Map<string, SettleTarget>(tileDocs.map((d) => [d._id, d]));
  const familyOf = new Map<string, string | undefined>(pwDocs.map((d) => [d._id, d.familyId]));

  const enteredByWorld = new Map<string, Set<string>>();
  plans.forEach((p) => {
    if (!p || p.entered.length === 0) return;
    let set = enteredByWorld.get(p.march.worldId);
    if (!set) enteredByWorld.set(p.march.worldId, (set = new Set()));
    for (const c of p.entered) set.add(c);
  });
  const occ = new Map<string, OccEntry>();
  const cover = new Map<string, CoverEntry[]>();
  await Promise.all(
    [...enteredByWorld].map(async ([worldId, set]) => {
      const tiles = [...set];
      const [o, c] = await Promise.all([core.getOccupancyMany(worldId, tiles), core.getCoverMany(worldId, tiles)]);
      for (const [k, v] of o) occ.set(k, v);
      for (const [k, v] of c) cover.set(k, v);
    }),
  );

  return due.map((m, i) =>
    settlementKeys({
      march: m,
      plan: plans[i] ?? null,
      target: targetOf.get(m.toTile) ?? null,
      familyId: familyOf.get(playerWorldId(m.worldId, m.ownerId)),
      occ,
      cover,
      t,
    }),
  );
}
