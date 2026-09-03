// B-track city-pacing model cover. `city.ts` had no test file at all — it feeds a printed report
// (`npm run --workspace @nw/econ-sim sim`, cityRun.ts) rather than a gate, so nothing ever pinned it.
//
// That gap is exactly how the ADR-079 bug survived: `armyPacing` modelled the troop-pool fill as SERIAL
// while `citySiegeRosters.trainPerHour`, one file over, modelled the same mechanic as PARALLEL — and
// worldsvc was a third opinion. Two of the three have since been corrected against the one the ADR-074
// siege gates were calibrated with; the point of this file is that the disagreement can no longer be
// silent. The last case is the cross-check between the two models, and its worldsvc counterpart
// ("training throughput scales with the drillYard slot count") measures the same number off the real
// scheduler.
import { describe, expect, it } from 'vitest';
import {
  DESK_MAX_LEVEL,
  TROOP_TRAIN_TIME_SEC,
  TROOP_TRAIN_BATCH_MAX,
  TROOP_SPEEDUP_SECS_PER_COIN,
  TRAIN_SPEEDUP_BUFF_MULT,
  troopCapFor,
  drillTrainMult,
  trainQueueMaxFor,
} from '@nw/shared';
import { armyPacing } from './city';
import { trainPerHour, TIER_WHALE } from './citySiegeRosters';

const maxed = { drillYard: DESK_MAX_LEVEL };

describe('armyPacing — filling the troop pool at max drillYard', () => {
  const a = armyPacing();

  it('splits the cap into TROOP_TRAIN_BATCH_MAX-sized batches that add back up to the cap', () => {
    expect(a.troopCap).toBe(troopCapFor(maxed));
    expect(a.batches).toBe(Math.ceil(a.troopCap / TROOP_TRAIN_BATCH_MAX));
    expect(a.secPerTroop).toBe(TROOP_TRAIN_TIME_SEC * drillTrainMult(maxed));
  });

  it('runs those batches trainQueueMaxFor at a time — rounds, not one long line', () => {
    expect(a.slots).toBe(trainQueueMaxFor(maxed));
    expect(a.rounds).toBe(Math.ceil(a.batches / a.slots));
    // Today: 4 batches over 3 slots = 2 rounds, each round costing one full batch.
    expect(a.wallClockSec).toBe(a.rounds * TROOP_TRAIN_BATCH_MAX * a.secPerTroop);
  });

  it('wall clock is the troop-work divided by the slots (strictly less, since there is >1 slot)', () => {
    expect(a.totalTrainSec).toBe(a.troopCap * a.secPerTroop);
    expect(a.wallClockSec).toBeLessThan(a.totalTrainSec);
    // Never better than perfect packing, never worse than serial — the bound that makes "divided by the
    // slots" an honest description rather than a slogan.
    expect(a.wallClockSec).toBeGreaterThanOrEqual(a.totalTrainSec / a.slots);
    expect(a.wallClockHours).toBeCloseTo(a.wallClockSec / 3600, 9);
    expect(a.totalTrainHours).toBeCloseTo(a.totalTrainSec / 3600, 9);
  });

  it('coins-to-skip prices the TROOP-WORK, not the wall clock — the slots must not discount coins', () => {
    // The pricing invariant ADR-079 deliberately left alone: a coin buys TROOP_SPEEDUP_SECS_PER_COIN
    // seconds off ONE slot, so parallelism does not make the instant-finish cheaper. Dividing this by the
    // slot count would silently multiply the coin->troops rate that gate ③ of the ADR-074 calibration
    // records as the residual pay-to-win risk.
    expect(a.coinsToSkip).toBe(Math.ceil(a.totalTrainSec / TROOP_SPEEDUP_SECS_PER_COIN));
    expect(a.coinsToSkip).not.toBe(Math.ceil(a.wallClockSec / TROOP_SPEEDUP_SECS_PER_COIN));
  });

  it('agrees with trainPerHour: both describe slots x perSlot, one as elapsed time and one as a rate', () => {
    // TIER_WHALE is the maxed drillYard too, so the two functions are talking about the same city.
    // While every slot is loaded, one round delivers `slots x batchMax` troops in `batchMax x secPerTroop`
    // seconds — turn that into troops/hour and it must be the rate the siege gates were calibrated on.
    const impliedPerHour = ((a.slots * TROOP_TRAIN_BATCH_MAX) / (TROOP_TRAIN_BATCH_MAX * a.secPerTroop)) * 3600;
    const modelledPerHour = trainPerHour(TIER_WHALE) / (TIER_WHALE.speedup ? TRAIN_SPEEDUP_BUFF_MULT : 1);
    expect(impliedPerHour).toBeCloseTo(modelledPerHour, 6);
    // Serial would have made this ratio 1 instead of the slot count — the shape of the original bug.
    expect(impliedPerHour / (3600 / a.secPerTroop)).toBeCloseTo(a.slots, 6);
  });
});
