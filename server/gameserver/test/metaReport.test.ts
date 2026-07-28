// MetaReporter unit tests. Previously zero coverage on this class; added alongside the new
// abandon() method (login-reconnect-prompt, 2026-07-28) — a fake global fetch stands in for meta,
// same technique as matchsvc/test/gatewayClient.test.ts.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MetaReporter } from '../src/metaReport';
import type { MatchReport } from '../src/Room';

const BASE_REPORT: MatchReport = {
  roomId: 'R1',
  seed: 1,
  mode: 'friendly',
  reason: 'base',
  winnerSide: -1,
  hashOk: true,
  players: [{ side: 0, accountId: 'a' }, { side: 1, accountId: 'b' }],
  results: [],
  replay: {
    engineVersion: 0,
    mode: 'friendly',
    seed: 1,
    endFrame: 0,
    frames: [],
    meta: { recordedAt: 0, winner: -1 },
  },
};

describe('MetaReporter.abandon (login-reconnect-prompt shutdown cleanup, 2026-07-28)', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('no baseUrl configured → no-op, no fetch call', async () => {
    const reporter = new MetaReporter(null, 'key');
    await reporter.abandon(['a', 'b']);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('empty accountIds → no-op even with a configured baseUrl', async () => {
    const reporter = new MetaReporter('http://meta:8080', 'key');
    await reporter.abandon([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('POSTs to /internal/match/abandon with the accountIds body + internal auth headers', async () => {
    const reporter = new MetaReporter('http://meta:8080', 'secret-key');
    await reporter.abandon(['a', 'b']);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://meta:8080/internal/match/abandon');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ accountIds: ['a', 'b'] });
    expect(init.headers['x-internal-key']).toBeTruthy();
    expect(init.headers['x-internal-caller']).toBe('gameserver');
  });

  it('fetch rejects (meta unreachable) → swallowed, does not throw (best-effort, TTL bounds the miss)', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const reporter = new MetaReporter('http://meta:8080', 'key');
    await expect(reporter.abandon(['a'])).resolves.toBeUndefined();
  });

  it('fetch resolves non-ok (e.g. 401) → swallowed, does not throw', async () => {
    global.fetch = vi.fn(async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const reporter = new MetaReporter('http://meta:8080', 'key');
    await expect(reporter.abandon(['a'])).resolves.toBeUndefined();
  });
});

// report()/flush() had zero prior coverage either; a minimal smoke test alongside abandon()'s new
// harness so a future change to the shared `post()` helper (used by both) doesn't silently break one.
describe('MetaReporter.report (smoke — existing behavior, no prior test file)', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('no baseUrl configured → returns null without calling fetch', async () => {
    const reporter = new MetaReporter(null, 'key');
    const result = await reporter.report(BASE_REPORT);
    expect(result).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('successful POST to /internal/match/report returns elo (null when absent)', async () => {
    const reporter = new MetaReporter('http://meta:8080', 'key');
    const result = await reporter.report(BASE_REPORT);
    expect(result).toBeNull(); // friendly match report has no elo field
    const [url] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://meta:8080/internal/match/report');
  });
});
