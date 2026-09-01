// net/transport.ts — the outbound REST seam itself (ASSET_PACKAGING §4.4 item 1).
//
// Two things are worth pinning here, and they are the two ways this seam could quietly stop
// working:
//
//  1. **The web path must build the exact same request object the call sites used to build by
//     hand.** Every fetch-faking suite in this repo (api-client*.test.ts, anomaly-chain.test.ts,
//     analyticsQueue.test.ts) reads `init.keepalive` / `init.credentials` / `init.body` off the
//     captured call, so a drifted mapping shows up there as a pile of confusing failures rather
//     than as one clear one. This file is the clear one.
//  2. **The REST layer must actually go through the seam.** A future edit that reaches for the
//     global `fetch` again would pass every existing test (Node has fetch) and only fail on a
//     WeChat device. The last case here fails immediately instead.
//
// The WeChat implementation lives in test/wechatTransport.test.ts, which deletes the browser
// globals first — that separation is deliberate: this file needs a real `fetch` to exist.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  fetchTransport,
  netTransport,
  setNetTransport,
  type NetRequest,
  type NetTransport,
} from '../src/net/transport';

type Captured = [url: string, init: RequestInit];

function installFetch(res: Partial<Response> = { ok: true, status: 200 }): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push([String(url), init]);
    return res as Response;
  }));
  return calls;
}

afterEach(() => {
  setNetTransport(fetchTransport);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('seam: install / read back', () => {
  it('defaults to the fetch-backed transport', () => {
    expect(netTransport()).toBe(fetchTransport);
  });

  it('setNetTransport swaps it for the platform one (this is the entries/wechat.ts line)', () => {
    const fake: NetTransport = { request: vi.fn() };
    setNetTransport(fake);
    expect(netTransport()).toBe(fake);
  });
});

describe('FetchTransport: the NetRequest → fetch init mapping', () => {
  const base: NetRequest = { method: 'POST', url: 'https://h/api/x', headers: { a: '1' } };

  it('passes method / url / headers / body through unchanged', async () => {
    const calls = installFetch();
    await fetchTransport.request({ ...base, body: '{"k":1}' });
    expect(calls[0]![0]).toBe('https://h/api/x');
    expect(calls[0]![1].method).toBe('POST');
    expect(calls[0]![1].headers).toEqual({ a: '1' });
    expect(calls[0]![1].body).toBe('{"k":1}');
  });

  it('forwards signal / keepalive / credentials (the three fields the telemetry paths depend on)', async () => {
    const calls = installFetch();
    const ctrl = new AbortController();
    await fetchTransport.request({ ...base, signal: ctrl.signal, keepalive: true, credentials: 'omit' });
    expect(calls[0]![1].signal).toBe(ctrl.signal);
    expect(calls[0]![1].keepalive).toBe(true);
    expect(calls[0]![1].credentials).toBe('omit');
  });

  it('OMITS the optional fields rather than passing them as undefined', async () => {
    // Not cosmetic: `keepalive: undefined` and no `keepalive` key are the same to fetch but not to
    // a test asserting on the captured init, and not to every non-fetch client we may map onto
    // later (wx.request treats a present-but-undefined `data` as a body).
    const calls = installFetch();
    await fetchTransport.request(base);
    const init = calls[0]![1];
    expect('body' in init).toBe(false);
    expect('signal' in init).toBe(false);
    expect('keepalive' in init).toBe(false);
    expect('credentials' in init).toBe(false);
  });

  it('hands the Response straight back — it already satisfies NetResponse', async () => {
    const res = { ok: false, status: 503, json: async () => ({ ok: false }), text: async () => '{}' };
    installFetch(res as unknown as Response);
    const out = await fetchTransport.request(base);
    expect(out).toBe(res);
    expect(out.ok).toBe(false);
    expect(out.status).toBe(503);
  });

  it('rejects (never throws synchronously) in a runtime without fetch — fire-and-forget callers must not blow up', async () => {
    // analytics' flushSync and anomaly's flushBeacon both do `void request(...).catch(...)`, which
    // only catches a rejection. A synchronous throw there would escape into a lifecycle handler.
    vi.stubGlobal('fetch', undefined);
    await expect(fetchTransport.request(base)).rejects.toThrow();
  });
});

describe('the REST layer really goes through the seam (not the global fetch)', () => {
  it('ApiClient calls the installed transport and leaves the global fetch untouched', async () => {
    const globalFetch = installFetch();
    const request = vi.fn(async (_req: NetRequest) => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, data: { token: 't', accountId: 'a', isNew: false, isAnonymous: false } }),
      text: async () => '',
    }));
    setNetTransport({ request });

    const { ApiClient } = await import('../src/net/ApiClient');
    const res = await new ApiClient('https://h/api').login('bob', 'secret123');

    expect(res.accountId).toBe('a');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toMatchObject({ method: 'POST', url: 'https://h/api/auth/login' });
    expect(globalFetch).toHaveLength(0); // ← the regression guard
  });

  it('WorldApiClient does too, health probe included', async () => {
    const globalFetch = installFetch();
    const request = vi.fn(async (_req: NetRequest) => ({ ok: true, status: 200, json: async () => ({ ok: true, data: 1 }), text: async () => '' }));
    setNetTransport({ request });
    vi.stubGlobal('__NW_WORLD_BASE__', 'https://w');

    const { WorldApiCore } = await import('../src/net/WorldApiClient/core');
    const core = new WorldApiCore({ getItem: () => 'tok', setItem: () => {}, removeItem: () => {} });
    expect(await core.checkHealth()).toBe(true);
    await core.req('GET', '/world/me');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![0]).toMatchObject({ method: 'GET', url: 'https://w/health' });
    expect(request.mock.calls[1]![0]!.headers['Authorization']).toBe('Bearer tok');
    expect(globalFetch).toHaveLength(0);
  });
});
