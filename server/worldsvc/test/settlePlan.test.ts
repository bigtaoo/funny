// combatMarch/settlePlan.ts — the pure half of concurrent settlement (WORLDSVC_CONCURRENCY_AUDIT §12.11).
//
// Every rule that decides "may this settlement overlap others" is pinned here, because the failure mode of a
// wrong rule is silent: two settlements writing one stranger's documents at once, visible only as a rare lost
// update under load.
import { describe, expect, it } from 'vitest';
import { isCityGroundTile, proceduralTile, SLG_MAP_H, SLG_MAP_W, tileId } from '@nw/shared';
import type { MarchDoc } from '../src/db';
import type { CoverEntry, OccEntry } from '../src/core/push';
import { planMarchSteps } from '../src/combatMarch/arrivalBatch';
import { concurrentEligible, settlementKeys, type SettleInput } from '../src/combatMarch/settlePlan';

const W = 's1-settle-plan';
/** Pass clock: late enough that every stepping march below has walked its whole path. */
const T = 10_000_000;

function march(extra: Partial<MarchDoc> = {}): MarchDoc {
  return {
    _id: 'm1', worldId: W, ownerId: 'atk',
    fromTile: tileId(W, 10, 10), toTile: tileId(W, 20, 20),
    kind: 'attack', teamId: 't1', troops: 100, army: [],
    departAt: 0, arriveAt: 0, status: 'marching',
    minX: 10, maxX: 20, minY: 10, maxY: 20, rev: 1,
    ...extra,
  };
}

function input(extra: Partial<SettleInput> = {}): SettleInput {
  return { march: march(), plan: null, target: null, familyId: undefined, occ: new Map(), cover: new Map(), t: T, ...extra };
}

/** A two-cell stepping march at (20,20) → (21,20), due to enter the destination by T. */
function stepping(extra: Partial<MarchDoc> = {}): MarchDoc {
  return march({
    toTile: tileId(W, 21, 20),
    path: [{ x: 20, y: 20 }, { x: 21, y: 20 }],
    stepIndex: 0, nextStepAt: 1, departAt: 0,
    ...extra,
  });
}

const occ = (ownerId: string, familyId?: string, leaveAt = Number.MAX_SAFE_INTEGER): OccEntry => ({
  kind: 'stationed', id: `occ-${ownerId}`, ownerId, ...(familyId ? { familyId } : {}), teamId: 'x', tile: tileId(W, 21, 20), leaveAt,
});

describe('settlementKeys', () => {
  it('locks the marcher, the target owner, the pending occupier and the 3×3 around the destination', () => {
    const k = settlementKeys(input({ target: { ownerId: 'def', contestedBy: 'occ' } }));
    expect(k.exclusive).toBe(false);
    expect(k.keys).toEqual(expect.arrayContaining(['a:atk', 'a:def', 'a:occ']));
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) expect(k.keys).toContain(`t:${tileId(W, 20 + dx, 20 + dy)}`);
    expect(k.keys).toHaveLength(3 + 9);
  });

  it('adds a base anchor (a ring-cell siege reads it) and a move\'s home 3×3 (its fallback parks there)', () => {
    expect(settlementKeys(input({ target: { ownerId: 'def', baseAnchor: tileId(W, 50, 50) } })).keys).toContain(`t:${tileId(W, 50, 50)}`);
    const mv = settlementKeys(input({ march: march({ kind: 'move' }) }));
    expect(mv.keys).toContain(`t:${tileId(W, 9, 9)}`);
    expect(mv.keys).toContain(`t:${tileId(W, 11, 11)}`);
  });

  it('treats an unknown kind as exclusive rather than parallelising it by default', () => {
    expect(settlementKeys(input({ march: march({ kind: 'teleport' as MarchDoc['kind'] }) })).exclusive).toBe(true);
  });

  it('makes an attack on wild-city ground exclusive (its defenders are resolved inside the siege)', () => {
    let city: { x: number; y: number } | null = null;
    for (let y = 0; y < SLG_MAP_H && !city; y += 3) {
      for (let x = 0; x < SLG_MAP_W; x += 3) {
        if (isCityGroundTile(proceduralTile(W, x, y).type)) { city = { x, y }; break; }
      }
    }
    expect(city).not.toBeNull();
    const toTile = tileId(W, city!.x, city!.y);
    expect(settlementKeys(input({ march: march({ toTile }) })).exclusive).toBe(true);
    // Not every kind: a garrison moving onto city ground is predictable (its own cell and coverage).
    expect(settlementKeys(input({ march: march({ toTile, kind: 'move' }) })).exclusive).toBe(false);
  });

  it('makes a walk into an ENEMY occupant or ENEMY coverage exclusive — a field encounter', () => {
    const m = stepping();
    const plan = planMarchSteps(m, T);
    expect(plan?.entered).toEqual([tileId(W, 21, 20)]);
    const cell = tileId(W, 21, 20);
    const enemyCover: CoverEntry = { kind: 'garrison', sourceTile: tileId(W, 22, 21), ownerId: 'def' };

    expect(settlementKeys(input({ march: m, plan })).exclusive).toBe(false);
    expect(settlementKeys(input({ march: m, plan, occ: new Map([[cell, occ('def')]]) })).exclusive).toBe(true);
    expect(settlementKeys(input({ march: m, plan, cover: new Map([[cell, [enemyCover]]]) })).exclusive).toBe(true);
  });

  it('walks past friends and stale occupants without going exclusive — the same friend/foe rule as the walk', () => {
    const m = stepping();
    const plan = planMarchSteps(m, T);
    const cell = tileId(W, 21, 20);
    expect(settlementKeys(input({ march: m, plan, occ: new Map([[cell, occ('atk')]]) })).exclusive).toBe(false);
    expect(settlementKeys(input({ march: m, plan, familyId: 'fam', occ: new Map([[cell, occ('ally', 'fam')]]) })).exclusive).toBe(false);
    expect(settlementKeys(input({ march: m, plan, occ: new Map([[cell, occ('def', undefined, T - 1)]]) })).exclusive).toBe(false);
    const ownCover: CoverEntry = { kind: 'tower', sourceTile: tileId(W, 22, 21), ownerId: 'ally', familyId: 'fam' };
    expect(settlementKeys(input({ march: m, plan, familyId: 'fam', cover: new Map([[cell, [ownCover]]]) })).exclusive).toBe(false);
  });

  it('locks every cell the walk touches, not just the destination', () => {
    const m = stepping({ path: [{ x: 5, y: 5 }, { x: 6, y: 5 }, { x: 21, y: 20 }], toTile: tileId(W, 21, 20) });
    const plan = planMarchSteps(m, T);
    const k = settlementKeys(input({ march: m, plan }));
    expect(k.keys).toContain(`t:${tileId(W, 5, 5)}`);
    expect(k.keys).toContain(`t:${tileId(W, 6, 5)}`);
  });
});

describe('concurrentEligible', () => {
  it('clears only settlements that share no key with any other one', () => {
    expect(
      concurrentEligible([
        { keys: ['a:1', 't:x'], exclusive: false },
        { keys: ['a:2', 't:y'], exclusive: false },
        { keys: ['a:3', 't:x'], exclusive: false },
      ]),
    ).toEqual([false, true, false]);
  });

  it('never clears an exclusive settlement, and still counts its keys against the others', () => {
    expect(
      concurrentEligible([
        { keys: ['a:1'], exclusive: true },
        { keys: ['a:1', 't:z'], exclusive: false },
        { keys: ['a:9'], exclusive: false },
      ]),
    ).toEqual([false, false, true]);
  });

  it('does not let a settlement collide with itself over a repeated key', () => {
    expect(concurrentEligible([{ keys: ['a:1', 'a:1'], exclusive: false }])).toEqual([true]);
  });
});
