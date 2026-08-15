// startScheduler() unit tests (previously 0% coverage). Uses fake timers + a fake WorldService (method
// signatures only — no real Mongo needed) to exercise: the default 2s tick calling all five always-on
// tasks, the autoSettleSeasons opt-in sixth task, per-task rejection isolation (Promise.allSettled
// semantics: one task failing logs and doesn't block the others), the re-entrant-tick guard (a slow tick
// causes the next tick to be skipped entirely), and stop() halting further ticks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  it('autoSettleSeasons:true -> also calls processDueSeasonSettlement each tick', async () => {
    const svc = makeSvc();
    const sched = startScheduler(svc, { autoSettleSeasons: true });
    await vi.advanceTimersByTimeAsync(2000);
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
    await vi.advanceTimersByTimeAsync(2000);

    expect(svc.processDueArrivals).toHaveBeenCalledTimes(1);
    expect(svc.processCompletedTraining).toHaveBeenCalledTimes(1);
    expect(svc.processCompletedBuilds).toHaveBeenCalledTimes(1);
    expect(svc.processDueSiegeDamage).toHaveBeenCalledTimes(1);
    expect(svc.processDueOccupations).toHaveBeenCalledTimes(1);
    expect(svc.processDueSeasonSettlement).toHaveBeenCalledTimes(1);

    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] processDueArrivals failed:', 'arrivals boom');
    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] processCompletedTraining failed:', 'training boom');
    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] processCompletedBuilds failed:', 'builds boom');
    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] processDueSiegeDamage failed:', 'siege boom');
    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] processDueOccupations failed:', 'occ boom');
    expect(errorSpy).toHaveBeenCalledWith('[world-scheduler] processDueSeasonSettlement failed:', 'season boom');

    sched.stop();
  });

  it('re-entrant guard: a tick still in flight causes the next tick to be skipped entirely', async () => {
    // A deferred promise we control manually, so processDueArrivals stays pending across the second tick.
    let releaseFirstTick!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseFirstTick = resolve;
    });
    const svc = makeSvc({ processDueArrivals: vi.fn().mockReturnValue(pending) });
    const sched = startScheduler(svc);

    // First tick fires; processDueArrivals is now pending (running=true).
    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueArrivals).toHaveBeenCalledTimes(1);
    expect(svc.processCompletedTraining).toHaveBeenCalledTimes(1);

    // Second tick fires while the first is still in flight -> should be skipped (running guard).
    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueArrivals).toHaveBeenCalledTimes(1);
    expect(svc.processCompletedTraining).toHaveBeenCalledTimes(1);

    // Release the first tick's pending task, letting `running` reset to false.
    releaseFirstTick();
    await vi.advanceTimersByTimeAsync(0);

    // Now a subsequent tick runs normally again.
    await vi.advanceTimersByTimeAsync(2000);
    expect(svc.processDueArrivals).toHaveBeenCalledTimes(2);
    expect(svc.processCompletedTraining).toHaveBeenCalledTimes(2);

    sched.stop();
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
