// SocialsvcClient unit tests (P3, previously 0% coverage): notifyOnline/notifyOffline POST to the correct
// socialsvc internal endpoint with the correct body; when baseUrl is absent (socialsvc not configured),
// no request is sent at all (fallback: gateway broadcasts directly via meta — see presenceBroadcaster.ts).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SocialsvcClient } from '../src/socialsvcClient';

const KEY = 'test-internal-key';
const BASE = 'http://social:18084';

interface Call {
  url: string;
  method: string | undefined;
  body: Record<string, unknown>;
  key: string | undefined;
}

function install(): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      key: headers['x-internal-key'],
    });
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  return calls;
}

describe('SocialsvcClient', () => {
  let calls: Call[];
  beforeEach(() => {
    calls = install();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('available reflects whether baseUrl is configured', () => {
    expect(new SocialsvcClient(BASE, KEY).available).toBe(true);
    expect(new SocialsvcClient(null, KEY).available).toBe(false);
  });

  it('notifyOnline POSTs to /internal/presence/online with the accountId + internal key', async () => {
    await new SocialsvcClient(BASE, KEY).notifyOnline('acc-a');
    expect(calls).toEqual([{ url: `${BASE}/internal/presence/online`, method: 'POST', body: { accountId: 'acc-a' }, key: KEY }]);
  });

  it('notifyOffline POSTs to /internal/presence/offline with the accountId + internal key', async () => {
    await new SocialsvcClient(BASE, KEY).notifyOffline('acc-b');
    expect(calls).toEqual([{ url: `${BASE}/internal/presence/offline`, method: 'POST', body: { accountId: 'acc-b' }, key: KEY }]);
  });

  it('baseUrl absent (socialsvc not configured) -> no-op, no request sent', async () => {
    const c = new SocialsvcClient(null, KEY);
    await c.notifyOnline('acc-a');
    await c.notifyOffline('acc-a');
    expect(calls).toEqual([]);
  });
});
