// Unit tests for WorldApiClient.checkHealth().
// Coverage: empty base URL, HTTP 200/503, network errors, 3-second timeout abort.
// Uses a fake global fetch — no real network; base URL is controlled via globalThis.__NW_WORLD_BASE__
// (getWorldBaseUrl() reads that value at call time, so vi.mock is not needed).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorldApiClient } from '../src/net/WorldApiClient';

// ── Helpers ─────────────────────────────────────────────────────────────────

const noopStorage = {
  getItem: (_k: string): string | null => null,
  setItem: (_k: string, _v: string): void => {},
  removeItem: (_k: string): void => {},
};

function setWorldBase(base: string): void {
  (globalThis as Record<string, unknown>).__NW_WORLD_BASE__ = base;
}

function clearWorldBase(): void {
  delete (globalThis as Record<string, unknown>).__NW_WORLD_BASE__;
}

/** Replace global fetch with a minimal stub. */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response>): void {
  (globalThis as Record<string, unknown>).fetch = handler;
}

function stubFetchStatus(status: number): void {
  stubFetch(async () => ({ ok: status >= 200 && status < 300, status }) as Response);
}

afterEach(() => {
  clearWorldBase();
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).fetch;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('WorldApiClient.available', () => {
  it('returns true under same-origin proxy (empty base)', () => {
    setWorldBase('');
    expect(new WorldApiClient(noopStorage).available).toBe(true);
  });

  it('returns true with an explicit dev URL', () => {
    setWorldBase('http://localhost:18084');
    expect(new WorldApiClient(noopStorage).available).toBe(true);
  });
});

describe('WorldApiClient.checkHealth()', () => {
  it('returns true immediately without a request when worldBase is empty (same-origin proxy)', async () => {
    setWorldBase('');
    const fetchSpy = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchSpy;
    const client = new WorldApiClient(noopStorage);

    // '' = Docker/prod same-origin nginx proxy; worldsvc is guaranteed up by healthcheck.
    expect(await client.checkHealth()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('also returns true as same-origin proxy when __NW_WORLD_BASE__ is not set', async () => {
    clearWorldBase(); // key absent from globalThis → getWorldBaseUrl() returns ''
    const fetchSpy = vi.fn();
    (globalThis as Record<string, unknown>).fetch = fetchSpy;
    const client = new WorldApiClient(noopStorage);

    expect(await client.checkHealth()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('server answers (opaque no-cors response) → true', async () => {
    setWorldBase('http://localhost:18084');
    stubFetchStatus(200);
    const client = new WorldApiClient(noopStorage);

    expect(await client.checkHealth()).toBe(true);
  });

  it('uses mode:no-cors and the correct path (base + /health)', async () => {
    setWorldBase('http://localhost:18084');
    let capturedUrl = '';
    let capturedMode: string | undefined;
    stubFetch(async (url, init) => {
      capturedUrl = url;
      capturedMode = init.mode;
      return { ok: false, status: 0, type: 'opaque' } as Response;
    });
    const client = new WorldApiClient(noopStorage);

    await client.checkHealth();
    expect(capturedUrl).toBe('http://localhost:18084/health');
    // no-cors is required to keep the browser from logging a red CORS error; the
    // resulting opaque response can't be read, so a resolved fetch alone = reachable.
    expect(capturedMode).toBe('no-cors');
  });

  it('opaque response (unreadable status under no-cors) still → true', async () => {
    setWorldBase('http://localhost:18084');
    // Under no-cors the browser hands back an opaque Response: ok=false, status=0.
    stubFetch(async () => ({ ok: false, status: 0, type: 'opaque' }) as Response);
    const client = new WorldApiClient(noopStorage);

    expect(await client.checkHealth()).toBe(true);
  });

  it('fetch throws (connection refused / network error) → true (inconclusive, no false offline report)', async () => {
    setWorldBase('http://localhost:18084');
    stubFetch(async () => { throw new TypeError('Failed to fetch'); });
    const client = new WorldApiClient(noopStorage);

    // Network errors are inconclusive (CORS in dev can reject /health even when
    // the actual feature routes work) — return true to avoid false offline badge.
    expect(await client.checkHealth()).toBe(true);
  });

  it('trailing slash on base URL is stripped so /health is not duplicated', async () => {
    setWorldBase('http://localhost:18084/'); // URL with trailing slash
    let capturedUrl = '';
    stubFetch(async (url) => { capturedUrl = url; return { ok: true, status: 200 } as Response; });
    const client = new WorldApiClient(noopStorage);

    await client.checkHealth();
    expect(capturedUrl).toBe('http://localhost:18084/health');
  });

  it('AbortController cancels fetch after 3 seconds → true (inconclusive, no false offline report)', async () => {
    setWorldBase('http://localhost:18084');

    // fetch only rejects after signal.abort, simulating worldsvc not responding
    stubFetch(async (_url, init) =>
      new Promise<Response>((_res, rej) => {
        init.signal!.addEventListener('abort', () => rej(new Error('AbortError')));
      }),
    );

    vi.useFakeTimers();
    const client = new WorldApiClient(noopStorage);
    const promise = client.checkHealth();

    // Advance to the 3-second timeout, flushing microtasks at the same time
    await vi.advanceTimersByTimeAsync(3001);

    // Timeout is also treated as inconclusive (same CORS-false-negative rationale).
    expect(await promise).toBe(true);
  });

  it('normal response within 3 seconds does not trigger abort, returns true', async () => {
    setWorldBase('http://localhost:18084');
    let aborted = false;

    stubFetch(async (_url, init) => {
      init.signal!.addEventListener('abort', () => { aborted = true; });
      return { ok: true, status: 200 } as Response;
    });

    vi.useFakeTimers();
    const client = new WorldApiClient(noopStorage);
    const promise = client.checkHealth();

    // Do not advance time → normal response already resolved, timer never fired
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;

    expect(result).toBe(true);
    expect(aborted).toBe(false);
  });
});
