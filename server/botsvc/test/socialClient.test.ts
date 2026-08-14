// botsvc's SocialClient unit tests (previously 0% coverage — bot.test.ts's fakeSocial() is a plain
// object literal, never touching the real fetch-based implementation). Mocks globalThis.fetch.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SocialClient } from '../src/socialClient';

const BASE = 'http://social:8085';
const TOKEN = 'player-jwt';

function install(body: unknown): { url: string; method: string | undefined; auth: string | undefined; body: unknown }[] {
  const calls: { url: string; method: string | undefined; auth: string | undefined; body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), method: init?.method, auth: headers.authorization, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, json: async () => body } as Response;
  }) as typeof fetch;
  return calls;
}

describe('SocialClient', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('myFamily GETs /social/family/mine with a Bearer token, returns the family view', async () => {
    const calls = install({ ok: true, data: { familyId: 'f1', tag: 'ABC', memberCount: 5, prosperity: 100 } });
    const family = await new SocialClient(BASE).myFamily(TOKEN);
    expect(family).toEqual({ familyId: 'f1', tag: 'ABC', memberCount: 5, prosperity: 100 });
    expect(calls).toEqual([{ url: `${BASE}/social/family/mine`, method: 'GET', auth: `Bearer ${TOKEN}`, body: undefined }]);
  });

  it('myFamily returns null when the bot has no family (data: null)', async () => {
    install({ ok: true, data: null });
    expect(await new SocialClient(BASE).myFamily(TOKEN)).toBeNull();
  });

  it('searchFamilies GETs /social/family/search?tag= with the tag query-encoded', async () => {
    const calls = install({ ok: true, data: [{ familyId: 'f1', tag: 'A B', memberCount: 1, prosperity: 1 }] });
    const found = await new SocialClient(BASE).searchFamilies(TOKEN, 'A B');
    expect(found).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/social/family/search?tag=A%20B`);
  });

  it('joinFamily POSTs /social/family/:tag/join', async () => {
    const calls = install({ ok: true });
    await new SocialClient(BASE).joinFamily(TOKEN, 'ABC');
    expect(calls).toEqual([{ url: `${BASE}/social/family/ABC/join`, method: 'POST', auth: `Bearer ${TOKEN}`, body: undefined }]);
  });

  it('leaveFamily POSTs /social/family/leave', async () => {
    const calls = install({ ok: true });
    await new SocialClient(BASE).leaveFamily(TOKEN);
    expect(calls).toEqual([{ url: `${BASE}/social/family/leave`, method: 'POST', auth: `Bearer ${TOKEN}`, body: undefined }]);
  });

  it('a failed call (ok:false) throws the server-provided error message', async () => {
    install({ ok: false, error: 'family not found' });
    await expect(new SocialClient(BASE).joinFamily(TOKEN, 'GONE')).rejects.toThrow('family not found');
  });

  it('a failed call with no error message falls back to a generic description', async () => {
    install({ ok: false });
    await expect(new SocialClient(BASE).leaveFamily(TOKEN)).rejects.toThrow(/social call failed: POST \/social\/family\/leave/);
  });
});
