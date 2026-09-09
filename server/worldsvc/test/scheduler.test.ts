// startScheduler() unit tests. Uses fake timers + a fake WorldService (method signatures only — no real
// Mongo needed) to exercise: the default 2s tick calling all six always-on tasks, the autoSettleSeasons
// opt-in seventh task (on its own slower timer), per-task rejection isolation, the re-entrancy guard, and
// stop() halting further ticks.
//
// 2026-09-09 (WORLDSVC_CONCURRENCY_AUDIT §6.7 item 1): the arrival tick is two tasks. `sched:arrivals`
// walks marches (cheap, batched); `sched:arrivalSettle` settles the ones that arrived (a capture battle
// plus a metaserver round trip each) on a FASTER timer, so the same work arrives in smaller bites. The
// cadence relationship is pinned below rather than left implied — putting settlements back on the SAME
// interval would silently undo the split while every call-count assertion here still passed.
//
// 2026-09-05 (worldsvc-concurrency phase 3): the guard used to be shared — one slow task skipped EVERY
// task's next tick, so the slowest task set the cadence for all of them. It is per-task now, which is the
// point of the change, so that is pinned explicitly below rather than left implied by call counts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RouteTimings } from '@nw/shared';
import { startScheduler } from '../src/scheduler';
import type { WorldService } from '../src/service';

function makeSvc(overrides: Partial<Record<
  'processDueArrivalSteps' | 'processDueArrivalSettlements' | 'processCompletedTraining' | 'processCompletedBuilds' | 'processDueSiegeDamage' | 'processDueOccupations' | 'processDueSeasonSettlement',
  () => Promise<unknown>
>> = {}): WorldService {
  return {
    processDueArrivalSteps: vi.fn().mockResolvedValue(0),
    processDueArrivalSettlements: vi.fn().mockResolvedValue(0),
    processCompletedTraining: vi.fn().mockResolvedValue(0),
    processCompletedBuilds: vi.fn().mockResolvedValue(0),
    processDueSiegeDamage: vi.fn().mockResolvedValue(0),
    processDueOccupations: vi.fn().mockResolvedValue(0),
    processDueSeasonSettlement: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as unknown as WorldService;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  errorSpy.mockRestore();
});

describe('startScheduler', () => {
  it('default tickMs=2000: after one tick, calls the 6 always-on tasks, and not the season task', async () => {
    const svc = makeSvc();
    const sched = startScheduler(svc);
    await vi.advanceTimersByTimeAsync(2000);

    expect(svc.processDueArrivalSteps).toHaveBeenCalledTimes(1);
    // Four settle passes in the same 2000ms: the whole point of the split is that the expensive half runs
    // more often and does less each time.
    expect(svc.processDueArrivalSettlements).toHaveBeenCalledTimes(4);
    expect(svc.processCompletedTraining).toHaveBeenCalledTimes(1);
    expect(svc.processCompletedBuilds).toHaveBeenCalledTimes(1);
    expect(svc.processDueSiegeDamage).toHaveBeenCalledTimes(1);
    expect(svc.processDueOccupations).toHaveBeenCalledTimes(1);
    expect(svc.processDueSeasonSettlement).not.toHaveBeenCalled();

    sched.stop();
  });

  it('autoSettleSeasons:true -> calls processDueSeasonSettlement on its own slower (30s) timer', async () => {
    const svc = makeSvc();
    const sched = startScheduler(svc, { autoSettleSeasons: true });
    // The season index is empty except in the minutes around a roll, so it deliberately does not ride the
    // 2s tick — polling it that often is pure waste, and 30s is far finer than anyone perceives.
    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueSeasonSettlement).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(28_000);
    expect(svc.processDueSeasonSettlement).toHaveBeenCalledTimes(1);
    sched.stop();
  });

  it('autoSettleSeasons:false (explicit) -> does not call processDueSeasonSettlement', async () => {
    const svc = makeSvc();
    const sched = startScheduler(svc, { autoSettleSeasons: false });
    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueSeasonSettlement).not.toHaveBeenCalled();
    sched.stop();
  });

  it('custom tickMs is honored', async () => {
    const svc = makeSvc();
    const sched = startScheduler(svc, { tickMs: 500 });
    await vi.advanceTimersByTimeAsync(500);
    expect(svc.processDueArrivalSteps).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(svc.processDueArrivalSteps).toHaveBeenCalledTimes(2);
    sched.stop();
  });

  it('the settle half runs on a quarter of the base tick, floored so it can never busy-loop', async () => {
    // 2s base -> 500ms settle: four passes per walking tick.
    const fast = makeSvc();
    const a = startScheduler(fast, { tickMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fast.processDueArrivalSettlements).toHaveBeenCalledTimes(4);
    a.stop();

    // A base tick already below the 250ms floor must not leave settlements RARER than steps: fixtures pass
    // a tiny tickMs and tick the scheduler a handful of times expecting the world settled, and a floor
    // applied blindly would make settlements 25x rarer there.
    const slow = makeSvc();
    const b = startScheduler(slow, { tickMs: 10 });
    await vi.advanceTimersByTimeAsync(100);
    expect(slow.processDueArrivalSteps).toHaveBeenCalledTimes(10);
    expect(slow.processDueArrivalSettlements).toHaveBeenCalledTimes(10);
    b.stop();
  });

  it('settleTickMs overrides the derived cadence', async () => {
    const svc = makeSvc();
    const sched = startScheduler(svc, { tickMs: 2000, settleTickMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueArrivalSettlements).toHaveBeenCalledTimes(2);
    sched.stop();
  });

  it('a rejecting task logs its own prefixed error and does not stop the other tasks from completing', async () => {
    const svc = makeSvc({
      processDueArrivalSteps: vi.fn().mockRejectedValue(new Error('arrivals boom')),
      processDueArrivalSettlements: vi.fn().mockRejectedValue(new Error('settle boom')),
      processCompletedTraining: vi.fn().mockRejectedValue(new Error('training boom')),
      processCompletedBuilds: vi.fn().mockRejectedValue(new Error('builds boom')),
      processDueSiegeDamage: vi.fn().mockRejectedValue(new Error('siege boom')),
      processDueOccupations: vi.fn().mockRejectedValue(new Error('occ boom')),
      processDueSeasonSettlement: vi.fn().mockRejectedValue(new Error('season boom')),
    });
    const sched = startScheduler(svc, { autoSettleSeasons: true });
    await vi.advanceTimersByTimeAsync(30_000); // long enough for the season timer to fire too

    expect(svc.processDueArrivalSteps).toHaveBeenCalled();
    expect(svc.processDueArrivalSettlements).toHaveBeenCalled();
    expect(svc.processCompletedTraining).toHaveBeenCalled();
    expect(svc.processCompletedBuilds).toHaveBeenCalled();
    expect(svc.processDueSiegeDamage).toHaveBeenCalled();
    expect(svc.processDueOccupations).toHaveBeenCalled();
    expect(svc.processDueSeasonSettlement).toHaveBeenCalledTimes(1);

    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] sched:arrivals failed:', 'arrivals boom');
    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] sched:arrivalSettle failed:', 'settle boom');
    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] sched:training failed:', 'training boom');
    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] sched:builds failed:', 'builds boom');
    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] sched:siegeDamage failed:', 'siege boom');
    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] sched:occupations failed:', 'occ boom');
    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] sched:season failed:', 'season boom');

    sched.stop();
  });

  it('re-entrancy guard: a task still in flight skips its OWN next tick, and only its own', async () => {
    // A deferred promise we control manually, so processDueArrivals stays pending across the second tick.
    let releaseFirstTick!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseFirstTick = resolve;
    });
    const svc = makeSvc({ processDueArrivalSteps: vi.fn().mockReturnValue(pending) });
    const sched = startScheduler(svc);

    // First tick fires; processDueArrivals is now pending (its own running=true).
    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueArrivalSteps).toHaveBeenCalledTimes(1);
    expect(svc.processCompletedTraining).toHaveBeenCalledTimes(1);

    // Second tick: arrivals is skipped because it is still in flight, but every other task runs. This is
    // the whole reason the shared guard was split — under the old single-flag scheduler, training would
    // still read 1 here, i.e. one slow task stalled settlement of everything else along with it.
    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueArrivalSteps).toHaveBeenCalledTimes(1);
    expect(svc.processCompletedTraining).toHaveBeenCalledTimes(2);
    expect(svc.processCompletedBuilds).toHaveBeenCalledTimes(2);

    // Release the pending task, letting arrivals' own guard reset.
    releaseFirstTick();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueArrivalSteps).toHaveBeenCalledTimes(2);
    expect(svc.processCompletedTraining).toHaveBeenCalledTimes(3);

    sched.stop();
  });

  it('records every task under its own label, and stays quiet when nothing is behind', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recorded: string[] = [];
    const timings = { record: (label: string) => { recorded.push(label); } } as unknown as RouteTimings;
    const svc = makeSvc();
    const sched = startScheduler(svc, { tickMs: 1000, timings });
    await vi.advanceTimersByTimeAsync(1000);

    expect(recorded).toContain('sched:arrivals');
    expect(recorded).toContain('sched:arrivalSettle');
    expect(recorded).toContain('sched:training');
    expect(recorded).toContain('sched:builds');
    expect(recorded).toContain('sched:siegeDamage');
    expect(recorded).toContain('sched:occupations');
    // Nothing overran, so nothing is reported as falling behind — the warning has to mean something.
    expect(warnSpy).not.toHaveBeenCalled();

    sched.stop();
    warnSpy.mockRestore();
  });

  it('stop() halts further ticks', async () => {
    const svc = makeSvc();
    const sched = startScheduler(svc);
    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueArrivalSteps).toHaveBeenCalledTimes(1);

    sched.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(svc.processDueArrivalSteps).toHaveBeenCalledTimes(1);
  });
});
