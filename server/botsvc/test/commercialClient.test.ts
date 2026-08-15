// CommercialClient unit tests (BOTSVC_DESIGN §5, previously 0% coverage — bot.test.ts always fakes this
// client out with a plain `vi.fn()` stub, so the real POST-with-internal-key implementation was never
// exercised). Mocks globalThis.fetch, same convention as gateway/matchsvcClient.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PRODUCT_STARTER_GROWTH } from '@nw/shared';
import { CommercialClient } from '../src/commercialClient';

const KEY = 'test-internal-key';
const BASE = 'http://commercial:18082';

interface Call { url: string; method: string | undefined; body: Record<string, unknown>; key: string | undefined }

function install(response: unknown = { ok: true }): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>, key: headers['x-internal-key'] });
    return { ok: true, json: async () => response } as Response;
  }) as typeof fetch;
  return calls;
}

describe('CommercialClient', () => {
  beforeEach(() => { install(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('buyMonthlyCard POSTs to /internal/monthly-card/buy with accountId + orderId + internal key', async () => {
    const calls = install({ ok: true });
    const result = await new CommercialClient(BASE, KEY).buyMonthlyCard('acc-a', 'order-1');
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ url: `${BASE}/internal/monthly-card/buy`, method: 'POST', body: { accountId: 'acc-a', orderId: 'order-1' }, key: KEY }]);
  });

  it('buyStarterGrowth POSTs to /internal/starter/buy with the starter-growth productId', async () => {
    const calls = install({ ok: true });
    const result = await new CommercialClient(BASE, KEY).buyStarterGrowth('acc-a', 'order-2');
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ url: `${BASE}/internal/starter/buy`, method: 'POST', body: { accountId: 'acc-a', productId: PRODUCT_STARTER_GROWTH, orderId: 'order-2' }, key: KEY }]);
  });

  it('propagates ok:false from the backend without throwing (idempotent dedupe is commercial\'s job)', async () => {
    install({ ok: false });
    const result = await new CommercialClient(BASE, KEY).buyMonthlyCard('acc-a', 'order-1');
    expect(result).toEqual({ ok: false });
  });
});
