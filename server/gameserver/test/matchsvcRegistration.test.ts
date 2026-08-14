// registerWithMatchsvc() unit tests (extracted from index.ts, previously untested at 0%):
// no-op guard, success, retry-then-success, and the 4xx-gives-up-immediately branch.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { GameEnv } from '../src/config';
import { registerWithMatchsvc, reportLoadHeartbeat } from '../src/matchsvcRegistration';

const BASE_ENV: GameEnv = {
  internalKey: 'k',
  port: 8081,
  host: '0.0.0.0',
  metaBaseUrl: null,
  publicWsUrl: 'ws://game-1/ws',
  matchsvcInternalUrl: 'http://matchsvc:8091',
  gameId: 'game-1',
  capacity: 100,
};

describe('registerWithMatchsvc', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('matchsvcInternalUrl not configured -> no-op, no fetch', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    await registerWithMatchsvc({ ...BASE_ENV, matchsvcInternalUrl: null });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('publicWsUrl not configured -> no-op, no fetch', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    await registerWithMatchsvc({ ...BASE_ENV, publicWsUrl: null });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('200 OK on first attempt -> registers once, returns', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await registerWithMatchsvc(BASE_ENV);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://matchsvc:8091/mm/game/register');
    expect(JSON.parse(init.body)).toEqual({ gameId: 'game-1', wsUrl: 'ws://game-1/ws', capacity: 100 });
    expect(init.headers['x-internal-caller']).toBe('gameserver');
  });

  it('4xx response -> gives up immediately, no retry', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await registerWithMatchsvc(BASE_ENV);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('network error then success -> retries with backoff and eventually registers', async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error('ECONNREFUSED');
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const p = registerWithMatchsvc(BASE_ENV);
    // Let the first (failing) attempt's catch block run, then advance past its backoff delay.
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('5xx response -> retries (not a 4xx) until it eventually succeeds', async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      return new Response('{}', { status: call < 3 ? 503 : 200 });
    }) as unknown as typeof fetch;

    const p = registerWithMatchsvc(BASE_ENV);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await p;
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('res.body.cancel() rejecting on a 200 is swallowed — registration still completes', async () => {
    global.fetch = vi.fn(async () => {
      const res = new Response('{}', { status: 200 });
      vi.spyOn(res.body!, 'cancel').mockRejectedValue(new Error('already closed'));
      return res;
    }) as unknown as typeof fetch;
    await expect(registerWithMatchsvc(BASE_ENV)).resolves.toBeUndefined();
  });
});

describe('reportLoadHeartbeat', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('matchsvcInternalUrl not configured -> no-op, no fetch', async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    await reportLoadHeartbeat({ ...BASE_ENV, matchsvcInternalUrl: null }, 5);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POSTs the current load to /mm/game/heartbeat', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await reportLoadHeartbeat(BASE_ENV, 7);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://matchsvc:8091/mm/game/heartbeat');
    expect(JSON.parse(init.body)).toEqual({ gameId: 'game-1', load: 7 });
  });

  it('fetch rejecting is swallowed (best-effort, self-heals next tick)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(reportLoadHeartbeat(BASE_ENV, 1)).resolves.toBeUndefined();
  });

  it('non-ok response is swallowed too (no retry logic here, next interval tick self-heals)', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof fetch;
    await expect(reportLoadHeartbeat(BASE_ENV, 1)).resolves.toBeUndefined();
  });
});
