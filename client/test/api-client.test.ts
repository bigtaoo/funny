// ApiClient password account method unit tests (SA-1/SA-3): register/login sends correct endpoint + body, success retains token;
// changePassword carries Authorization; failure wraps to ApiError(code). Uses a fake global fetch, no network calls.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient, ApiError, type AuthResult } from '../src/net/ApiClient';

interface Captured { url: string; method: string; headers: Record<string, string>; body: unknown; }

/** Install a fake global fetch that responds with `responder(captured)`. */
function installFetch(
  responder: (c: Captured) => { status?: number; json: unknown },
): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const c: Captured = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: (init.headers as Record<string, string>) ?? {},
      body: init.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(c);
    const r = responder(c);
    return {
      status: r.status ?? 200,
      json: async () => r.json,
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const authData = (over: Partial<AuthResult> = {}): AuthResult => ({
  token: 'tok-1', accountId: 'acc-1', isNew: true, isAnonymous: false, ...over,
});

afterEach(() => { vi.restoreAllMocks(); });

describe('ApiClient password auth (SA-1/SA-3)', () => {
  it('register: POST /auth/register with loginId/password/displayName, success retains token', async () => {
    const calls = installFetch(() => ({ json: { ok: true, data: authData() } }));
    const api = new ApiClient('https://h/api');
    const res = await api.register('Alice@x.com', 'secret123', 'Alice');

    expect(res.accountId).toBe('acc-1');
    expect(res.isAnonymous).toBe(false);
    expect(api.getToken()).toBe('tok-1');
    expect(calls[0]!.url).toBe('https://h/api/auth/register');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({ loginId: 'Alice@x.com', password: 'secret123', displayName: 'Alice' });
  });

  it('register omits displayName field when not provided', async () => {
    const calls = installFetch(() => ({ json: { ok: true, data: authData() } }));
    const api = new ApiClient('https://h/api');
    await api.register('bob', 'secret123');
    expect(calls[0]!.body).toEqual({ loginId: 'bob', password: 'secret123' });
  });

  it('login: POST /auth/login, success retains token', async () => {
    const calls = installFetch(() => ({ json: { ok: true, data: authData({ token: 'tok-2', isNew: false }) } }));
    const api = new ApiClient('https://h/api');
    const res = await api.login('bob', 'secret123');
    expect(res.isNew).toBe(false);
    expect(api.getToken()).toBe('tok-2');
    expect(calls[0]!.url).toBe('https://h/api/auth/login');
    expect(calls[0]!.body).toEqual({ loginId: 'bob', password: 'secret123' });
  });

  it('login failure wraps to ApiError(INVALID_CREDENTIALS), does not retain token', async () => {
    installFetch(() => ({ status: 401, json: { ok: false, error: { code: 'INVALID_CREDENTIALS', message: 'bad' } } }));
    const api = new ApiClient('https://h/api');
    await expect(api.login('bob', 'wrong')).rejects.toMatchObject({
      name: 'ApiError', code: 'INVALID_CREDENTIALS',
    });
    expect(api.getToken()).toBeNull();
  });

  it('register with taken login id → throws ApiError(LOGIN_ID_TAKEN)', async () => {
    installFetch(() => ({ status: 409, json: { ok: false, error: { code: 'LOGIN_ID_TAKEN', message: 'taken' } } }));
    const api = new ApiClient('https://h/api');
    const e = await api.register('bob', 'secret123').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('LOGIN_ID_TAKEN');
  });

  it('changePassword: POST /auth/password/change with Authorization header', async () => {
    const calls = installFetch(() => ({ json: { ok: true, data: { ok: true } } }));
    const api = new ApiClient('https://h/api');
    api.setToken('tok-9');
    await api.changePassword('old1', 'new12345');
    expect(calls[0]!.url).toBe('https://h/api/auth/password/change');
    expect(calls[0]!.headers['authorization']).toBe('Bearer tok-9');
    expect(calls[0]!.body).toEqual({ oldPassword: 'old1', newPassword: 'new12345' });
  });
});
