// botsvc's SocialClient unit tests (previously 0% coverage — bot.test.ts's fakeSocial() is a plain
// object literal, never touching the real fetch-based implementation). Mocks globalThis.fetch.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SocialClient } from '../src/socialClient';
import { BotApiError } from '../src/apiError';

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

  it('getFamily GETs /social/family/:id with the id path-encoded (fam:TAG contains a colon)', async () => {
    const calls = install({ ok: true, data: null });
    expect(await new SocialClient(BASE).getFamily(TOKEN, 'fam:REQU')).toBeNull();
    expect(calls[0]!.url).toBe(`${BASE}/social/family/fam%3AREQU`);
  });

  it('createFamily POSTs /social/family with name + tag', async () => {
    const calls = install({ ok: true, data: { familyId: 'fam:REQU' } });
    await new SocialClient(BASE).createFamily(TOKEN, 'Red Quills', 'REQU');
    expect(calls).toEqual([{ url: `${BASE}/social/family`, method: 'POST', auth: `Bearer ${TOKEN}`, body: { name: 'Red Quills', tag: 'REQU' } }]);
  });

  it('requestJoin POSTs /social/family/:familyId/join (by id, not by TAG)', async () => {
    const calls = install({ ok: true, data: { requestId: 'r1' } });
    expect(await new SocialClient(BASE).requestJoin(TOKEN, 'fam:REQU')).toEqual({ requestId: 'r1' });
    expect(calls[0]!.url).toBe(`${BASE}/social/family/fam%3AREQU/join`);
    expect(calls[0]!.method).toBe('POST');
  });

  it('listJoinRequests unwraps { requests }', async () => {
    install({ ok: true, data: { requests: [{ requestId: 'r1', accountId: 'a2', createdAt: 1 }] } });
    expect(await new SocialClient(BASE).listJoinRequests(TOKEN)).toEqual([{ requestId: 'r1', accountId: 'a2', createdAt: 1 }]);
  });

  it('respondJoinRequest POSTs { accept } to /requests/:id/respond', async () => {
    const calls = install({ ok: true, data: {} });
    await new SocialClient(BASE).respondJoinRequest(TOKEN, 'r1', false);
    expect(calls).toEqual([{ url: `${BASE}/social/family/requests/r1/respond`, method: 'POST', auth: `Bearer ${TOKEN}`, body: { accept: false } }]);
  });

  it('setRole POSTs { targetId, role }', async () => {
    const calls = install({ ok: true, data: {} });
    await new SocialClient(BASE).setRole(TOKEN, 'a2', 'elder');
    expect(calls[0]!.body).toEqual({ targetId: 'a2', role: 'elder' });
  });

  it('a failed call surfaces the {code, message} envelope as a BotApiError, not "[object Object]"', async () => {
    install({ ok: false, error: { code: 'FAMILY_FULL', message: 'family is full' } });
    const e = await new SocialClient(BASE).requestJoin(TOKEN, 'fam:REQU').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BotApiError);
    expect((e as BotApiError).code).toBe('FAMILY_FULL');
    expect((e as Error).message).toBe('FAMILY_FULL: family is full');
  });

  it('a failed call with no error at all falls back to a generic description', async () => {
    install({ ok: false });
    await expect(new SocialClient(BASE).myFamily(TOKEN)).rejects.toThrow(/social call failed: GET \/social\/family\/mine/);
  });
});
