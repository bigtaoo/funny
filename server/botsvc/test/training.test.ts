// BOTSVC_DESIGN §3.4 rule 8: how many troops a bot trains. The planner is pure, so each server rule it
// mirrors (worldsvc city/training.ts) is pinned here on its own; worldsvc's bot-expansion.e2e posts
// its answer to the real trainTroops and checks one troop more is refused.
import { describe, it, expect } from 'vitest';
import { RESOURCE_TYPES, TROOP_CAP_BASE, TROOP_TRAIN_BATCH_MAX, troopCapFor, troopTrainCost } from '@nw/shared';
import { EXPAND_MARCH_MIN_POOL } from '../src/expansion';
import { TRAIN_MIN_BATCH, planTraining, troopsFirst } from '../src/training';
import type { PlayerWorldView } from '../src/worldClient';

const NOW = 1_000_000;
const RICH = { ink: 1e9, paper: 1e9, graphite: 1e9, metal: 1e9, sticker: 1e9 };
const me = (over: Partial<PlayerWorldView> = {}): PlayerWorldView =>
  ({ joined: true, troops: 0, troopCap: TROOP_CAP_BASE, buildings: { desk: 1 }, resources: RICH, ...over });
/** Exactly enough of every resource for `n` troops. */
const fundsFor = (n: number) => troopTrainCost(n) as Record<string, number>;
const batch = (qty: number, completeAt = NOW + 60_000) => ({ qty, startAt: NOW - 1, completeAt });

describe('planTraining — how many', () => {
  it('fills the pool up to troopCap', () => {
    expect(planTraining(me({ troops: 1200 }), NOW)).toBe(TROOP_CAP_BASE - 1200);
  });

  it('counts troops already in training against the cap, like the server', () => {
    // drillYard L4 for a second slot, so the batch in training does not simply block the next one.
    const view = me({ troops: 1000, buildings: { desk: 4, drillYard: 4 }, troopCap: 8000, trainingQueue: [batch(3000)] });
    expect(planTraining(view, NOW)).toBe(8000 - 1000 - 3000);
  });

  it('falls back to troopCapFor(buildings) when the view carries no troopCap', () => {
    const buildings = { desk: 3, drillYard: 2 };
    // Enough troops that the answer stays under TROOP_TRAIN_BATCH_MAX and really shows the cap.
    const troops = troopCapFor(buildings) - 2000;
    expect(troopCapFor(buildings)).toBeGreaterThan(TROOP_CAP_BASE);
    expect(planTraining(me({ troops, troopCap: undefined, buildings }), NOW)).toBe(2000);
  });

  it('never more than one batch may hold', () => {
    expect(planTraining(me({ troopCap: TROOP_TRAIN_BATCH_MAX * 3 }), NOW)).toBe(TROOP_TRAIN_BATCH_MAX);
  });

  it('is bounded by each of the five resources on its own', () => {
    for (const rt of RESOURCE_TYPES) {
      const resources = { ...RICH, [rt]: fundsFor(700)[rt] };
      expect(planTraining(me({ resources }), NOW), rt).toBe(700);
    }
  });

  it('a resource it has none of means no batch at all', () => {
    expect(planTraining(me({ resources: { ...RICH, sticker: 0 } }), NOW)).toBe(0);
    expect(planTraining(me({ resources: { ink: 1e9 } }), NOW)).toBe(0);
  });

  it(`waits for a batch of at least TRAIN_MIN_BATCH (${TRAIN_MIN_BATCH}) rather than posting a handful`, () => {
    expect(planTraining(me({ resources: fundsFor(TRAIN_MIN_BATCH) }), NOW)).toBe(TRAIN_MIN_BATCH);
    expect(planTraining(me({ resources: fundsFor(TRAIN_MIN_BATCH - 1) }), NOW)).toBe(0);
    expect(planTraining(me({ troops: TROOP_CAP_BASE - TRAIN_MIN_BATCH + 1 }), NOW)).toBe(0);
  });

  it('a pool over the cap (a garrison came home) trains nothing, not a negative batch', () => {
    expect(planTraining(me({ troops: TROOP_CAP_BASE + 500 }), NOW)).toBe(0);
  });
});

describe('planTraining — training slots', () => {
  it('one slot without a drillYard: a running batch blocks the next', () => {
    expect(planTraining(me({ trainingQueue: [batch(100)] }), NOW)).toBe(0);
  });

  it('a batch past its completeAt no longer holds the slot (worldsvc frees it on read)', () => {
    expect(planTraining(me({ trainingQueue: [batch(100, NOW)] }), NOW)).toBe(TROOP_CAP_BASE - 100);
  });

  it('drillYard L4 opens a second slot', () => {
    const view = me({ buildings: { desk: 4, drillYard: 4 }, troopCap: 20_000, trainingQueue: [batch(100)] });
    expect(planTraining(view, NOW)).toBe(Math.min(TROOP_TRAIN_BATCH_MAX, 20_000 - 100));
  });
});

describe('troopsFirst — training before the building upgrade', () => {
  it('while the pool cannot send a march', () => {
    expect(troopsFirst(me({ troops: EXPAND_MARCH_MIN_POOL - 1 }))).toBe(true);
    expect(troopsFirst(me({ troops: EXPAND_MARCH_MIN_POOL }))).toBe(false);
  });

  it('counting batches already in training, so a queued refill does not keep starving the buildings', () => {
    expect(troopsFirst(me({ troops: EXPAND_MARCH_MIN_POOL - 100, trainingQueue: [batch(100)] }))).toBe(false);
  });
});
