// ApiClient shop method unit tests (2026-08-10, shop bulk-buy): shopBuy's qty request-body assembly —
// omitted/1 must produce the exact same body as before qty existed (backward compat with every recorded
// request/replay fixture), qty>1 must include it. Same fake-fetch technique as api-client.test.ts.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiClient } from '../src/net/ApiClient';
import type { SaveData } from '../src/game/meta/SaveData';

interface Captured { url: string; method: string; body: unknown; }

function installFetch(json: unknown): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return { status: 200, json: async () => json } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('ApiClient.shopBuy (bulk-buy qty, 2026-08-10)', () => {
  it('qty omitted: POST /shop/buy body is exactly {itemId} — identical to every pre-qty caller/fixture', async () => {
    const calls = installFetch({ ok: true, data: { save: {} as SaveData, granted: 'protect_enhance' } });
    const api = new ApiClient('https://h/api');
    await api.shopBuy('protect_enhance');
    expect(calls[0]!.url).toBe('https://h/api/shop/buy');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ itemId: 'protect_enhance' });
  });

  it('qty=1 explicitly: body still omits qty (same wire shape as omitted, not {itemId, qty:1})', async () => {
    const calls = installFetch({ ok: true, data: { save: {} as SaveData, granted: 'protect_enhance' } });
    const api = new ApiClient('https://h/api');
    await api.shopBuy('protect_enhance', 1);
    expect(calls[0]!.body).toEqual({ itemId: 'protect_enhance' });
  });

  it('qty=10 (the shop\'s ×10 button): body includes qty, one request — not 10', async () => {
    const calls = installFetch({ ok: true, data: { save: {} as SaveData, granted: 'protect_enhance' } });
    const api = new ApiClient('https://h/api');
    await api.shopBuy('protect_enhance', 10);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ itemId: 'protect_enhance', qty: 10 });
  });

  it('qty=0: treated as falsy/no-op qty, body omits it (defensive — server would clamp/default to 1 anyway)', async () => {
    const calls = installFetch({ ok: true, data: { save: {} as SaveData, granted: 'protect_enhance' } });
    const api = new ApiClient('https://h/api');
    await api.shopBuy('protect_enhance', 0);
    expect(calls[0]!.body).toEqual({ itemId: 'protect_enhance' });
  });

  it('resolves with the server-returned save/granted', async () => {
    const save = { wallet: { coins: 500 } } as unknown as SaveData;
    installFetch({ ok: true, data: { save, granted: 'protect_enhance' } });
    const api = new ApiClient('https://h/api');
    const res = await api.shopBuy('protect_enhance', 10);
    expect(res.granted).toBe('protect_enhance');
    expect(res.save).toEqual(save);
  });
});
