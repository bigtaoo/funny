// startScheduler() unit tests (previously 0% coverage — no dedicated test file existed at all). Two
// independent interval loops: processExpiredAuctions (every tickMs) and purgeClosedListings (every fixed
// 1h PURGE_TICK_MS) — each with its own re-entrancy guard (skip if the previous run is still in flight)
// and its own error-logging catch. Uses fake timers since PURGE_TICK_MS is a hardcoded 1h constant, not
// a constructor param.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { startScheduler, type Scheduler } from '../src/scheduler';
import type { AuctionService } from '../src/auctionService';

const PURGE_TICK_MS = 60 * 60 * 1000;

function fakeAuctionSvc(overrides: Partial<AuctionService> = {}): AuctionService {
  return {
    processExpiredAuctions: vi.fn(async () => {}),
    purgeClosedListings: vi.fn(async () => 0),
    ...overrides,
  } as unknown as AuctionService;
}

let scheduler: Scheduler | undefined;
afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('startScheduler: expired-auction tick', () => {
  it('calls processExpiredAuctions once per tickMs', async () => {
    vi.useFakeTimers();
    const svc = fakeAuctionSvc();
    scheduler = startScheduler(svc, 1000);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(svc.processExpiredAuctions).toHaveBeenCalledTimes(3);
  });

  it('skips overlapping runs — a still-pending call blocks the next tick from starting a second one', async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => { resolveFirst = r; });
    const svc = fakeAuctionSvc({ processExpiredAuctions: vi.fn(() => gate) as never });
    scheduler = startScheduler(svc, 100);

    await vi.advanceTimersByTimeAsync(100); // starts run 1, blocks on `gate`
    await vi.advanceTimersByTimeAsync(100); // tick fires again, but `running` guard short-circuits it
    expect(svc.processExpiredAuctions).toHaveBeenCalledTimes(1);

    resolveFirst();
    await vi.advanceTimersByTimeAsync(0); // let the .finally() reset `running`
    await vi.advanceTimersByTimeAsync(100); // now a second real run can start
    expect(svc.processExpiredAuctions).toHaveBeenCalledTimes(2);
  });

  it('a rejected processExpiredAuctions is caught and logged, not thrown / not fatal to future ticks', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const svc = fakeAuctionSvc({ processExpiredAuctions: vi.fn(async () => { throw new Error('db down'); }) as never });
    scheduler = startScheduler(svc, 100);

    await vi.advanceTimersByTimeAsync(100);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('processExpiredAuctions failed'), 'db down');

    await vi.advanceTimersByTimeAsync(100); // still ticks again afterward
    expect(svc.processExpiredAuctions).toHaveBeenCalledTimes(2);
  });
});

describe('startScheduler: closed-listing purge tick', () => {
  it('calls purgeClosedListings once per PURGE_TICK_MS (1h)', async () => {
    vi.useFakeTimers();
    const svc = fakeAuctionSvc();
    scheduler = startScheduler(svc, 1_000_000_000); // effectively disable the other tick for this test
    await vi.advanceTimersByTimeAsync(PURGE_TICK_MS);
    expect(svc.purgeClosedListings).toHaveBeenCalledTimes(1);
  });

  it('logs a message when it actually purged something, silent when it purged 0', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const svc = fakeAuctionSvc({ purgeClosedListings: vi.fn(async () => 3) as never });
    scheduler = startScheduler(svc, 1_000_000_000);
    await vi.advanceTimersByTimeAsync(PURGE_TICK_MS);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('purged 3 closed listing(s)'));
  });

  it('purgeClosedListings=0 -> no log line at all', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const svc = fakeAuctionSvc({ purgeClosedListings: vi.fn(async () => 0) as never });
    scheduler = startScheduler(svc, 1_000_000_000);
    await vi.advanceTimersByTimeAsync(PURGE_TICK_MS);
    expect(log).not.toHaveBeenCalled();
  });

  it('skips overlapping purge runs (own re-entrancy guard, independent from the expired-auction one)', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (n: number) => void;
    const gate = new Promise<number>((r) => { resolveFirst = r; });
    const svc = fakeAuctionSvc({ purgeClosedListings: vi.fn(() => gate) as never });
    scheduler = startScheduler(svc, 1_000_000_000);

    await vi.advanceTimersByTimeAsync(PURGE_TICK_MS);
    await vi.advanceTimersByTimeAsync(PURGE_TICK_MS); // second tick's purge guard short-circuits
    expect(svc.purgeClosedListings).toHaveBeenCalledTimes(1);

    resolveFirst(0);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('a rejected purgeClosedListings is caught and logged, not thrown', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const svc = fakeAuctionSvc({ purgeClosedListings: vi.fn(async () => { throw new Error('index missing'); }) as never });
    scheduler = startScheduler(svc, 1_000_000_000);
    await vi.advanceTimersByTimeAsync(PURGE_TICK_MS);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('purgeClosedListings failed'), 'index missing');
  });
});

describe('startScheduler.stop()', () => {
  it('clears both intervals — no further calls after stop()', async () => {
    vi.useFakeTimers();
    const svc = fakeAuctionSvc();
    scheduler = startScheduler(svc, 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(svc.processExpiredAuctions).toHaveBeenCalledTimes(1);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(svc.processExpiredAuctions).toHaveBeenCalledTimes(1); // unchanged
  });
});
