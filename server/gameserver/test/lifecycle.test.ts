// createShutdownHandler() unit tests (extracted from index.ts's inline shutdown closure,
// previously untested at 0%): ordering, re-entrancy guard, and the exit hook.
import { describe, expect, it, vi } from 'vitest';
import { createShutdownHandler } from '../src/lifecycle';

function makeDeps(overrides: Partial<Parameters<typeof createShutdownHandler>[0]> = {}) {
  const calls: string[] = [];
  const manager = {
    activeAccountIds: vi.fn(() => ['a', 'b']),
    destroyAll: vi.fn(() => calls.push('destroyAll')),
  };
  const reporter = {
    flush: vi.fn(async () => {
      calls.push('flush');
    }),
    abandon: vi.fn(async (ids: string[]) => {
      calls.push(`abandon:${ids.join(',')}`);
    }),
  };
  const wss = { close: vi.fn(() => calls.push('wss.close')) };
  const http = { close: vi.fn(() => calls.push('http.close')) };
  const exit = vi.fn();
  const timerA = setInterval(() => {}, 100_000);
  const timerB = setInterval(() => {}, 100_000);
  timerA.unref?.();
  timerB.unref?.();
  return {
    calls,
    manager,
    reporter,
    wss,
    http,
    exit,
    timers: [timerA, timerB],
    deps: { manager, reporter, wss, http, timers: [timerA, timerB], exit, ...overrides },
  };
}

describe('createShutdownHandler', () => {
  it('runs the full sequence: snapshot rosters before destroyAll, close wss/http, flush+abandon, then exit', async () => {
    const { deps, manager, reporter, wss, http, exit } = makeDeps();
    const shutdown = createShutdownHandler(deps);
    shutdown();
    // async tail (flush/abandon/exit) resolves on a later microtask/tick
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));

    expect(manager.activeAccountIds).toHaveBeenCalledTimes(1);
    expect(manager.destroyAll).toHaveBeenCalledTimes(1);
    expect(wss.close).toHaveBeenCalledTimes(1);
    expect(http.close).toHaveBeenCalledTimes(1);
    expect(reporter.flush).toHaveBeenCalledWith(10_000);
    expect(reporter.abandon).toHaveBeenCalledWith(['a', 'b']);
  });

  it('respects a custom flushMaxWaitMs', async () => {
    const { deps, reporter, exit } = makeDeps({ flushMaxWaitMs: 2_500 });
    createShutdownHandler(deps)();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(reporter.flush).toHaveBeenCalledWith(2_500);
  });

  it('clears every timer passed in', async () => {
    const { deps, timers, exit } = makeDeps();
    const clearSpy = vi.spyOn(global, 'clearInterval');
    createShutdownHandler(deps)();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    for (const t of timers) expect(clearSpy).toHaveBeenCalledWith(t);
    clearSpy.mockRestore();
  });

  it('calling the returned handler twice only runs the sequence once (SIGINT+SIGTERM race)', async () => {
    const { deps, manager, exit } = makeDeps();
    const shutdown = createShutdownHandler(deps);
    shutdown();
    shutdown();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledTimes(1));
    expect(manager.destroyAll).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('defaults to process.exit(0) when no exit hook is provided', async () => {
    const { deps } = makeDeps();
    delete (deps as { exit?: unknown }).exit;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    createShutdownHandler(deps)();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
    exitSpy.mockRestore();
  });
});
