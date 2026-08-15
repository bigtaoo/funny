// startEtlScheduler() unit tests (previously 0% line coverage — run() itself was never called by any
// test). Uses fake timers + a fake AnalyticsService (only needs runFunnelEtl(dateStr): Promise<void>) to
// exercise: the immediate run-on-startup call (with today's + yesterday's UTC date strings), the hourly
// re-fire, the re-entrant-tick guard (a slow run causes an in-flight tick to be skipped), error swallowing
// (console.error, no throw), and the returned cleanup function halting further ticks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startEtlScheduler } from '../src/scheduler';
import type { AnalyticsService } from '../src/service';

const HOUR_MS = 60 * 60 * 1000;

function utcDateStr(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

function makeSvc(impl?: (dateStr: string) => Promise<void>): AnalyticsService {
  return {
    runFunnelEtl: vi.fn(impl ?? (() => Promise.resolve())),
  } as unknown as AnalyticsService;
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

describe('startEtlScheduler', () => {
  it('fires immediately on startup with both today\'s and yesterday\'s UTC date strings', async () => {
    const svc = makeSvc();
    const stop = startEtlScheduler(svc);
    await vi.advanceTimersByTimeAsync(0);

    expect(svc.runFunnelEtl).toHaveBeenCalledTimes(2);
    expect(svc.runFunnelEtl).toHaveBeenCalledWith(utcDateStr(0));
    expect(svc.runFunnelEtl).toHaveBeenCalledWith(utcDateStr(-1));

    stop();
  });

  it('fires again after advancing 1 hour', async () => {
    const svc = makeSvc();
    const stop = startEtlScheduler(svc);
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.runFunnelEtl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(svc.runFunnelEtl).toHaveBeenCalledTimes(4);

    stop();
  });

  it('re-entrant guard: a tick still in flight causes the next tick to be skipped entirely', async () => {
    let releaseFirstRun!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseFirstRun = resolve;
    });
    const svc = makeSvc(() => pending);
    const stop = startEtlScheduler(svc);

    // Initial immediate run fires; runFunnelEtl is now pending (running=true).
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.runFunnelEtl).toHaveBeenCalledTimes(2);

    // An hour passes while the first run is still in flight -> skipped (running guard).
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(svc.runFunnelEtl).toHaveBeenCalledTimes(2);

    // Release the first run's pending promise, letting `running` reset to false.
    releaseFirstRun();
    await vi.advanceTimersByTimeAsync(0);

    // Now a subsequent tick runs normally again.
    await vi.advanceTimersByTimeAsync(HOUR_MS);
    expect(svc.runFunnelEtl).toHaveBeenCalledTimes(4);

    stop();
  });

  it('errors from runFunnelEtl are caught and swallowed (logged, not thrown/propagated)', async () => {
    const svc = makeSvc(() => Promise.reject(new Error('etl boom')));
    const stop = startEtlScheduler(svc);

    await vi.advanceTimersByTimeAsync(0);

    expect(errorSpy).toHaveBeenCalledWith('[analyticsvc] ETL failed', expect.any(Error));

    stop();
  });

  it('the returned cleanup function stops the interval -- no more calls after invoking it', async () => {
    const svc = makeSvc();
    const stop = startEtlScheduler(svc);
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.runFunnelEtl).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(HOUR_MS * 5);
    expect(svc.runFunnelEtl).toHaveBeenCalledTimes(2);
  });
});
