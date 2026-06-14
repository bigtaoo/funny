// ApiClient 密码账号方法单测（SA-1/SA-3）：register/login 发对端点+体、成功持有 token；
// changePassword 带 Authorization；失败包络 → ApiError(code)。用假全局 fetch，不触网。
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
  it('register: POST /auth/register 带 loginId/password/displayName，成功后持有 token', async () => {
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

  it('register 省略 displayName 时不带该字段', async () => {
    const calls = installFetch(() => ({ json: { ok: true, data: authData() } }));
    const api = new ApiClient('https://h/api');
    await api.register('bob', 'secret123');
    expect(calls[0]!.body).toEqual({ loginId: 'bob', password: 'secret123' });
  });

  it('login: POST /auth/login，成功后持有 token', async () => {
    const calls = installFetch(() => ({ json: { ok: true, data: authData({ token: 'tok-2', isNew: false }) } }));
    const api = new ApiClient('https://h/api');
    const res = await api.login('bob', 'secret123');
    expect(res.isNew).toBe(false);
    expect(api.getToken()).toBe('tok-2');
    expect(calls[0]!.url).toBe('https://h/api/auth/login');
    expect(calls[0]!.body).toEqual({ loginId: 'bob', password: 'secret123' });
  });

  it('login 失败包络 → 抛 ApiError(INVALID_CREDENTIALS)，不持有 token', async () => {
    installFetch(() => ({ status: 401, json: { ok: false, error: { code: 'INVALID_CREDENTIALS', message: 'bad' } } }));
    const api = new ApiClient('https://h/api');
    await expect(api.login('bob', 'wrong')).rejects.toMatchObject({
      name: 'ApiError', code: 'INVALID_CREDENTIALS',
    });
    expect(api.getToken()).toBeNull();
  });

  it('register 占用 → 抛 ApiError(LOGIN_ID_TAKEN)', async () => {
    installFetch(() => ({ status: 409, json: { ok: false, error: { code: 'LOGIN_ID_TAKEN', message: 'taken' } } }));
    const api = new ApiClient('https://h/api');
    const e = await api.register('bob', 'secret123').catch((x) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('LOGIN_ID_TAKEN');
  });

  it('changePassword: POST /auth/password/change 带 Authorization 头', async () => {
    const calls = installFetch(() => ({ json: { ok: true, data: { ok: true } } }));
    const api = new ApiClient('https://h/api');
    api.setToken('tok-9');
    await api.changePassword('old1', 'new12345');
    expect(calls[0]!.url).toBe('https://h/api/auth/password/change');
    expect(calls[0]!.headers['authorization']).toBe('Bearer tok-9');
    expect(calls[0]!.body).toEqual({ oldPassword: 'old1', newPassword: 'new12345' });
  });
});
