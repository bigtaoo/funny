// Unit tests for the arrival tick's batching rules (2026-09-05, `sched:arrivals` deep batching).
//
// These pin down WHICH marches may be settled by the batched writer. That is the whole safety argument of
// the change: a march only qualifies when it provably cannot fight, arrive, or interact with another march
// this tick, because the serial path it skips is the one that resolves field encounters — and a field
// encounter writes the DEFENDER's ledger, so batching one by mistake is a cross-player corruption, not a
// slow tick. The rules are pure functions precisely so they can be tested here rather than only inferred
// from a live-stack e2e.
import { describe, expect, it } from 'vitest';
import { MARCH_SPEED_SEC_PER_TILE, marchStepArriveAt, playerWorldId, tileId } from '@nw/shared';
import type { MarchDoc } from '../src/db';
import type { CoverEntry, OccEntry } from '../src/core/push';
import { fastOccEntry, planMarchSteps, splitArrivalBatch } from '../src/combatMarch/arrivalBatch';

const W = 's1-split';
const DEPART = 1_000_000;
const STEP_MS = MARCH_SPEED_SEC_PER_TILE * 1000;

/** A stepping march walking east along y from (x0,y) for `len` cells, currently sitting on `stepIndex`. */
function march(id: string, ownerId: string, x0: number, y: number, len: number, stepIndex = 0): MarchDoc {
  const path = Array.from({ length: len }, (_, i) => ({ x: x0 + i, y }));
  return {
    _id: id,
    worldId: W,
    ownerId,
    fromTile: tileId(W, x0, y),
    toTile: tileId(W, x0 + len - 1, y),
    kind: 'occupy',
    troops: 500,
    departAt: DEPART,
    arriveAt: marchStepArriveAt(DEPART, len - 1),
    path,
    stepIndex,
    nextStepAt: marchStepArriveAt(DEPART, stepIndex + 1),
    status: 'marching',
    rev: 1,
  } as MarchDoc;
}

function cell(x: number, y: number): string {
  return tileId(W, x, y);
}

/** Every owner in `ms` has a playerWorld doc, with no family. */
function allJoined(ms: MarchDoc[]): { hasPlayerWorld: (m: MarchDoc) => boolean; familyOf: Map<string, string | undefined> } {
  const familyOf = new Map<string, string | undefined>(ms.map((m) => [playerWorldId(m.worldId, m.ownerId), undefined]));
  return { hasPlayerWorld: (m) => familyOf.has(playerWorldId(m.worldId, m.ownerId)), familyOf };
}

function split(ms: MarchDoc[], t: number, opts: { occ?: Map<string, OccEntry>; cover?: Map<string, CoverEntry[]>; legacy?: MarchDoc[]; joined?: MarchDoc[] } = {}) {
  const plans = ms.map((m) => planMarchSteps(m, t)!);
  return splitArrivalBatch({
    plans,
    legacy: opts.legacy ?? [],
    occ: opts.occ ?? new Map(),
    cover: opts.cover ?? new Map(),
    hasPlayerWorld: allJoined(opts.joined ?? ms).hasPlayerWorld,
  });
}

function occAt(tile: string, ownerId: string): Map<string, OccEntry> {
  return new Map([[tile, { kind: 'stationed', id: tile, ownerId, tile, leaveAt: Number.MAX_SAFE_INTEGER }]]);
}

describe('planMarchSteps', () => {
  it('reports the cells a march enters and vacates, without touching anything', () => {
    const m = march('m1', 'a', 10, 10, 6);
    const plan = planMarchSteps(m, DEPART + 2 * STEP_MS)!;
    expect(plan.vacated).toEqual([cell(10, 10), cell(11, 10)]);
    expect(plan.entered).toEqual([cell(11, 10), cell(12, 10)]);
    expect(plan.endIndex).toBe(2);
    expect(plan.reachesEnd).toBe(false);
    // The contention unit is the DISTINCT set — the shared middle cell counts once.
    expect(plan.cells.sort()).toEqual([cell(10, 10), cell(11, 10), cell(12, 10)].sort());
  });

  it('takes no step when the clock has not reached the next cell yet', () => {
    const plan = planMarchSteps(march('m1', 'a', 10, 10, 6), DEPART + STEP_MS - 1)!;
    expect(plan.entered).toEqual([]);
    expect(plan.vacated).toEqual([]);
    expect(plan.endIndex).toBe(0);
  });

  it('flags the tick that reaches the final path cell', () => {
    const plan = planMarchSteps(march('m1', 'a', 10, 10, 4), DEPART + 99 * STEP_MS)!;
    expect(plan.endIndex).toBe(3);
    expect(plan.reachesEnd).toBe(true);
  });

  it('returns null for a march with no stepping cursor (legacy doc / recalled return leg)', () => {
    const m = march('m1', 'a', 10, 10, 4);
    delete m.path;
    delete m.stepIndex;
    delete m.nextStepAt;
    expect(planMarchSteps(m, DEPART + STEP_MS)).toBeNull();
  });
});

describe('splitArrivalBatch', () => {
  const t = DEPART + STEP_MS;

  it('batches an ordinary mid-route step across empty ground', () => {
    const m = march('m1', 'a', 10, 10, 6);
    const s = split([m], t);
    expect(s.fast.map((p) => p.march._id)).toEqual(['m1']);
    expect(s.serial).toEqual([]);
  });

  it('keeps the arrival tick serial — that is where combat and parking happen', () => {
    const m = march('m1', 'a', 10, 10, 2); // one step and it is there
    const s = split([m], t);
    expect(s.fast).toEqual([]);
    expect(s.serial.map((x) => x._id)).toEqual(['m1']);
  });

  it('keeps a march serial when the cell it enters is occupied (a possible encounter)', () => {
    const m = march('m1', 'a', 10, 10, 6);
    const s = split([m], t, { occ: occAt(cell(11, 10), 'enemy') });
    expect(s.fast).toEqual([]);
    expect(s.serial.map((x) => x._id)).toEqual(['m1']);
  });

  it('keeps a march serial for a FRIENDLY occupant too — the serial path leaves that entry alone, the batch would overwrite it', () => {
    const m = march('m1', 'a', 10, 10, 6);
    const s = split([m], t, { occ: occAt(cell(11, 10), 'a') });
    expect(s.fast).toEqual([]);
  });

  it('keeps a march serial when the cell it enters is covered by a garrison or tower', () => {
    const m = march('m1', 'a', 10, 10, 6);
    const cover = new Map<string, CoverEntry[]>([
      [cell(11, 10), [{ kind: 'tower', sourceTile: cell(11, 11), ownerId: 'enemy' }]],
    ]);
    const s = split([m], t, { cover });
    expect(s.fast).toEqual([]);
  });

  it('demotes BOTH marches when two of them touch the same cell this tick', () => {
    // m2 currently sits on (11,10) — exactly the cell m1 steps onto. Head-on, and neither may be batched.
    const m1 = march('m1', 'a', 10, 10, 6);
    const m2 = march('m2', 'b', 11, 10, 6);
    const s = split([m1, m2], t);
    expect(s.fast).toEqual([]);
    expect(s.serial.map((x) => x._id).sort()).toEqual(['m1', 'm2']);
  });

  it('leaves unrelated marches in the same tick batched', () => {
    const m1 = march('m1', 'a', 10, 10, 6);
    const m2 = march('m2', 'b', 40, 40, 6);
    const s = split([m1, m2], t);
    expect(s.fast.map((p) => p.march._id).sort()).toEqual(['m1', 'm2']);
    expect(s.serial).toEqual([]);
  });

  it('counts a legacy / return march\'s destination as contention — it settles there', () => {
    const m1 = march('m1', 'a', 10, 10, 6);
    const legacy = { ...march('m2', 'b', 80, 80, 2), toTile: cell(11, 10) } as MarchDoc;
    delete legacy.path;
    const s = split([m1], t, { legacy: [legacy] });
    expect(s.fast).toEqual([]);
  });

  it('keeps a march serial when its owner has no playerWorld doc', () => {
    const m = march('m1', 'a', 10, 10, 6);
    const s = split([m], t, { joined: [] });
    expect(s.fast).toEqual([]);
    expect(s.serial.map((x) => x._id)).toEqual(['m1']);
  });
});

describe('fastOccEntry', () => {
  it('registers only the last cell entered, with the time the march leaves it', () => {
    const m = march('m1', 'a', 10, 10, 6);
    const plan = planMarchSteps(m, DEPART + 2 * STEP_MS)!;
    const e = fastOccEntry(plan, 'fam1')!;
    expect(e.tile).toBe(cell(12, 10));
    expect(e.id).toBe('m1');
    expect(e.ownerId).toBe('a');
    expect(e.familyId).toBe('fam1');
    expect(e.leaveAt).toBe(marchStepArriveAt(DEPART, 3));
  });

  it('omits familyId for a player in no family (the field is absent, not undefined-valued)', () => {
    const plan = planMarchSteps(march('m1', 'a', 10, 10, 6), DEPART + STEP_MS)!;
    expect('familyId' in fastOccEntry(plan, undefined)!).toBe(false);
  });

  it('has nothing to register when no step was actually due', () => {
    const plan = planMarchSteps(march('m1', 'a', 10, 10, 6), DEPART)!;
    expect(fastOccEntry(plan, undefined)).toBeNull();
  });
});
