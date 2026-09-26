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

describe('MetaClient PvE calls (BOTSVC_DESIGN §3.5) — the client\'s own endpoints, bearer-authenticated', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  function installAuthed(body: unknown, status = 200): { url: string; method?: string; auth?: string; body: unknown }[] {
    const calls: { url: string; method?: string; auth?: string; body: unknown }[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const h = init?.headers as Record<string, string>;
      calls.push({ url: String(url), method: init?.method, auth: h?.authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return { ok: status < 300, status, json: async () => body } as Response;
    }) as typeof fetch;
    return calls;
  }

  it('getSave reads GET /save and returns the save', async () => {
    const save = { progress: { cleared: ['ch1_lv1'], stars: { ch1_lv1: 2 } }, cardInv: {} };
    const calls = installAuthed({ ok: true, data: { save, displayName: 'x' } });
    expect(await new MetaClient(BASE).getSave('jwt')).toEqual(save);
    expect(calls).toEqual([{ url: `${BASE}/save`, method: 'GET', auth: 'Bearer jwt', body: undefined }]);
  });

  it('pveEnter / pveClear / pveVerify post the documented bodies', async () => {
    const calls = installAuthed({ ok: true, data: { capped: false, needsReplay: true, verifyId: 'v1', verified: true } });
    const meta = new MetaClient(BASE);
    await meta.pveEnter('jwt', 'ch1_lv2');
    expect(await meta.pveClear('jwt', 'ch1_lv2', 3, { 'kill.archer': 2 })).toMatchObject({ needsReplay: true, verifyId: 'v1' });
    const frames = [{ frame: 4, cmds: [{ side: 0, commands: 'AA==' }] }];
    expect(await meta.pveVerify('jwt', 'v1', 900, frames)).toMatchObject({ verified: true });
    expect(calls.map((c) => [c.method, c.url.slice(BASE.length), c.auth, c.body])).toEqual([
      ['POST', '/pve/enter', 'Bearer jwt', { levelId: 'ch1_lv2' }],
      ['POST', '/pve/clear', 'Bearer jwt', { levelId: 'ch1_lv2', stars: 3, stats: { 'kill.archer': 2 } }],
      ['POST', '/pve/verify', 'Bearer jwt', { verifyId: 'v1', endFrame: 900, frames }],
    ]);
  });

  it('an error envelope keeps its code, so the bot can tell "out of stamina" from a failure', async () => {
    installAuthed({ ok: false, error: { code: 'INSUFFICIENT_STAMINA', message: 'need 10' } }, 402);
    await expect(new MetaClient(BASE).pveEnter('jwt', 'ch1_lv1')).rejects.toMatchObject({ code: 'INSUFFICIENT_STAMINA' });
  });
});
