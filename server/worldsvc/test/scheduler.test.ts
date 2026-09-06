// startScheduler() unit tests. Uses fake timers + a fake WorldService (method signatures only — no real
// Mongo needed) to exercise: the default 2s tick calling all five always-on tasks, the autoSettleSeasons
// opt-in sixth task (on its own slower timer), per-task rejection isolation, the re-entrancy guard, and
// stop() halting further ticks.
//
// 2026-09-05 (worldsvc-concurrency phase 3): the guard used to be shared — one slow task skipped EVERY
// task's next tick, so the slowest task set the cadence for all of them. It is per-task now, which is the
// point of the change, so that is pinned explicitly below rather than left implied by call counts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RouteTimings } from '@nw/shared';
import { startScheduler } from '../src/scheduler';
import type { WorldService } from '../src/service';

function makeSvc(overrides: Partial<Record<
  'processDueArrivals' | 'processCompletedTraining' | 'processCompletedBuilds' | 'processDueSiegeDamage' | 'processDueOccupations' | 'processDueSeasonSettlement',
  () => Promise<unknown>
>> = {}): WorldService {
  return {
    processDueArrivals: vi.fn().mockResolvedValue(0),
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
  it('default tickMs=2000: after one tick, calls the 5 always-on tasks once each, and not the season task', async () => {
    const svc = makeSvc();
    const sched = startScheduler(svc);
    await vi.advanceTimersByTimeAsync(2000);

    expect(svc.processDueArrivals).toHaveBeenCalledTimes(1);
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
    expect(svc.processDueArrivals).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(svc.processDueArrivals).toHaveBeenCalledTimes(2);
    sched.stop();
  });

  it('a rejecting task logs its own prefixed error and does not stop the other tasks from completing', async () => {
    const svc = makeSvc({
      processDueArrivals: vi.fn().mockRejectedValue(new Error('arrivals boom')),
      processCompletedTraining: vi.fn().mockRejectedValue(new Error('training boom')),
      processCompletedBuilds: vi.fn().mockRejectedValue(new Error('builds boom')),
      processDueSiegeDamage: vi.fn().mockRejectedValue(new Error('siege boom')),
      processDueOccupations: vi.fn().mockRejectedValue(new Error('occ boom')),
      processDueSeasonSettlement: vi.fn().mockRejectedValue(new Error('season boom')),
    });
    const sched = startScheduler(svc, { autoSettleSeasons: true });
    await vi.advanceTimersByTimeAsync(30_000); // long enough for the season timer to fire too

    expect(svc.processDueArrivals).toHaveBeenCalled();
    expect(svc.processCompletedTraining).toHaveBeenCalled();
    expect(svc.processCompletedBuilds).toHaveBeenCalled();
    expect(svc.processDueSiegeDamage).toHaveBeenCalled();
    expect(svc.processDueOccupations).toHaveBeenCalled();
    expect(svc.processDueSeasonSettlement).toHaveBeenCalledTimes(1);

    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] sched:arrivals failed:', 'arrivals boom');
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
    const svc = makeSvc({ processDueArrivals: vi.fn().mockReturnValue(pending) });
    const sched = startScheduler(svc);

    // First tick fires; processDueArrivals is now pending (its own running=true).
    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueArrivals).toHaveBeenCalledTimes(1);
    expect(svc.processCompletedTraining).toHaveBeenCalledTimes(1);

    // Second tick: arrivals is skipped because it is still in flight, but every other task runs. This is
    // the whole reason the shared guard was split — under the old single-flag scheduler, training would
    // still read 1 here, i.e. one slow task stalled settlement of everything else along with it.
    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueArrivals).toHaveBeenCalledTimes(1);
    expect(svc.processCompletedTraining).toHaveBeenCalledTimes(2);
    expect(svc.processCompletedBuilds).toHaveBeenCalledTimes(2);

    // Release the pending task, letting arrivals' own guard reset.
    releaseFirstTick();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueArrivals).toHaveBeenCalledTimes(2);
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
    expect(svc.processDueArrivals).toHaveBeenCalledTimes(1);

    sched.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(svc.processDueArrivals).toHaveBeenCalledTimes(1);
  });
});
