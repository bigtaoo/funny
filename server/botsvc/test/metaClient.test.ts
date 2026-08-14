// botsvc's MetaClient unit tests (previously 0% coverage — bot.test.ts's fakeMeta() is a plain object
// literal, never touching the real fetch-based deviceLogin implementation). Mocks globalThis.fetch.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { MetaClient } from '../src/metaClient';

const BASE = 'http://meta:18080';

function install(status: number, body: unknown): { url: string; method: string | undefined; body: unknown }[] {
  const calls: { url: string; method: string | undefined; body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body ?? '{}')) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  }) as typeof fetch;
  return calls;
}

describe('MetaClient.deviceLogin', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('POSTs deviceId to /auth/device and returns the login result on success', async () => {
    const calls = install(200, { ok: true, data: { token: 'jwt-1', accountId: 'acc-a', isNew: false } });
    const result = await new MetaClient(BASE).deviceLogin('device-1');
    expect(result).toEqual({ token: 'jwt-1', accountId: 'acc-a', isNew: false });
    expect(calls).toEqual([{ url: `${BASE}/auth/device`, method: 'POST', body: { deviceId: 'device-1' } }]);
  });

  it('a non-2xx HTTP response throws with the status + body text', async () => {
    install(503, {});
    await expect(new MetaClient(BASE).deviceLogin('device-1')).rejects.toThrow(/503/);
  });

  it('a 2xx response with ok:false in the envelope still throws', async () => {
    install(200, { ok: false });
    await expect(new MetaClient(BASE).deviceLogin('device-1')).rejects.toThrow(/ok:false/);
  });
});
