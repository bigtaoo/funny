// ApiClientBase.fetchRaw timeout + rate-gate wiring (ADR-058). Before this, fetchRaw had no
// timeout at all — a hung metaserver request would wait forever. Uses a fake global fetch (same
// pattern as api-client.test.ts) — no real network calls.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient } from '../src/net/ApiClient';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).fetch;
});

describe('ApiClientBase.fetchRaw — 10s timeout', () => {
  it('aborts and rejects an unresponsive request after 10 seconds', async () => {
    let aborted = false;
    globalThis.fetch = (async (_url: string, init: RequestInit) => new Promise((_res, rej) => {
      init.signal!.addEventListener('abort', () => { aborted = true; rej(new Error('AbortError')); });
    })) as unknown as typeof fetch;

    vi.useFakeTimers();
    const api = new ApiClient('https://h/api');
    const result = api.login('bob', 'secret123').catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(9999);
    expect(aborted).toBe(false); // not yet — under the 10s deadline

    await vi.advanceTimersByTimeAsync(2);
    expect(aborted).toBe(true);
    expect(await result).toBeInstanceOf(Error);
  });

  it('does not abort a request that resolves within the timeout', async () => {
    let aborted = false;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      init.signal!.addEventListener('abort', () => { aborted = true; });
      return {
        status: 200,
        json: async () => ({ ok: true, data: { token: 'tok-1', accountId: 'acc-1', isNew: false, isAnonymous: false } }),
      } as Response;
    }) as unknown as typeof fetch;

    vi.useFakeTimers();
    const api = new ApiClient('https://h/api');
    const promise = api.login('bob', 'secret123');

    await vi.advanceTimersByTimeAsync(0); // fetch already resolved; timer never fires
    const res = await promise;

    expect(aborted).toBe(false);
    expect(res.accountId).toBe('acc-1');
  });
});

describe('ApiClientBase.fetchRaw — rate gate wiring', () => {
  it('acquires a slot from the global gate before issuing the fetch', async () => {
    vi.resetModules();
    const acquire = vi.fn().mockResolvedValue(undefined);
    vi.doMock('../src/net/rateGate', () => ({ globalRequestGate: { acquire, tryAcquire: vi.fn(() => true) } }));

    const order: string[] = [];
    globalThis.fetch = (async () => {
      order.push('fetch');
      return { status: 200, json: async () => ({ ok: true, data: { token: 't', accountId: 'a', isNew: false, isAnonymous: false } }) } as Response;
    }) as unknown as typeof fetch;
    acquire.mockImplementation(async () => { order.push('acquire'); });

    const { ApiClient: MockedApiClient } = await import('../src/net/ApiClient');
    const api = new MockedApiClient('https://h/api');
    await api.login('bob', 'secret123');

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['acquire', 'fetch']); // gate is awaited before the network call
    vi.doUnmock('../src/net/rateGate');
  });
});
