// Regression coverage for NetSession.freshToken() (client/src/net/NetSession.ts).
//
// 2026-08-03 fix: freshToken() used to return the cached token whenever one existed, full stop —
// so once the gateway rejected it (JWT expired mid-session), every subsequent reconnect attempt kept
// retrying with the exact same dead token forever (stuck 'reconnecting', no recovery short of a
// manual logout/login). Now:
//   · No persisted password-login session (no TOKEN_KEY in storage, i.e. an anonymous device/wx
//     account) + the gateway just rejected the cached token (`gatewayAuthRejected`, set via
//     NetClient's onAuthRejected hook on close code 4401) → mint a fresh token via api.auth() — safe
//     here because the device/wx credential really IS that account's own identity.
//   · A real password-login session (TOKEN_KEY present) → must NOT call api.auth() (that would
//     authenticate the anonymous device identity instead, silently swapping accounts mid-session) —
//     keep the existing token and toast the player once instead of spinning forever with no feedback.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NetSession } from '../src/net/NetSession';
import type { IPlatform, IStorage } from '../src/platform/IPlatform';
import type { ApiClient } from '../src/net/ApiClient';
import { TOKEN_KEY } from '../src/app/appConstants';
import { setToastSink } from '../src/net/log';

function fakeStorage(): IStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
}

function fakePlatform(storage: IStorage): IPlatform {
  return {
    storage,
    connectSocket: () => { throw new Error('not exercised — freshToken is called directly'); },
    getAuthCredential: async () => ({ kind: 'device' as const, deviceId: 'dev-1' }),
  } as unknown as IPlatform;
}

function fakeApi(existingToken: string | null): ApiClient & { authCalls: number } {
  let token = existingToken;
  return {
    authCalls: 0,
    getToken: () => token,
    auth: vi.fn(async function (this: { authCalls: number }) {
      this.authCalls++;
      token = 'fresh-token';
      return { token: 'fresh-token' };
    }),
  } as unknown as ApiClient & { authCalls: number };
}

function buildSession(storage: IStorage, api: ApiClient): NetSession {
  return new NetSession(fakePlatform(storage), 'ws://x/gw', api, async () => ({ kind: 'device', deviceId: 'dev-1' }));
}

describe('NetSession.freshToken()', () => {
  let toastSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    toastSpy = vi.fn();
    setToastSink((text, kind) => toastSpy(text, kind));
  });

  it('the common fast path: an existing token with no rejection is returned as-is, no auth() call', async () => {
    const storage = fakeStorage();
    const api = fakeApi('cached-token');
    const session = buildSession(storage, api);

    const token = await (session as unknown as { freshToken(): Promise<string> }).freshToken();
    expect(token).toBe('cached-token');
    expect((api as unknown as { auth: ReturnType<typeof vi.fn> }).auth).not.toHaveBeenCalled();
  });

  it('no cached token at all (truly anonymous, first connect) → mints one via api.auth()', async () => {
    const storage = fakeStorage();
    const api = fakeApi(null);
    const session = buildSession(storage, api);

    const token = await (session as unknown as { freshToken(): Promise<string> }).freshToken();
    expect(token).toBe('fresh-token');
    expect((api as unknown as { auth: ReturnType<typeof vi.fn> }).auth).toHaveBeenCalledTimes(1);
  });

  it('regression: a rejected token with NO password-login session (TOKEN_KEY absent) re-authenticates via api.auth()', async () => {
    const storage = fakeStorage(); // no TOKEN_KEY set → anonymous device/wx session
    const api = fakeApi('expired-token');
    const session = buildSession(storage, api);
    (session as unknown as { gatewayAuthRejected: boolean }).gatewayAuthRejected = true;

    const token = await (session as unknown as { freshToken(): Promise<string> }).freshToken();
    expect(token).toBe('fresh-token'); // successfully self-healed
    expect((api as unknown as { auth: ReturnType<typeof vi.fn> }).auth).toHaveBeenCalledTimes(1);
    expect((session as unknown as { gatewayAuthRejected: boolean }).gatewayAuthRejected).toBe(false); // reset

    // Self-heals on the very next call too (no longer rejected) — no repeat auth() call needed.
    const token2 = await (session as unknown as { freshToken(): Promise<string> }).freshToken();
    expect(token2).toBe('fresh-token');
    expect((api as unknown as { auth: ReturnType<typeof vi.fn> }).auth).toHaveBeenCalledTimes(1);
  });

  it('regression: a rejected token WITH a real password-login session (TOKEN_KEY present) does NOT call api.auth(), and toasts once', async () => {
    const storage = fakeStorage();
    storage.setItem(TOKEN_KEY, 'the-real-login-token'); // marks this as a real password-login session
    const api = fakeApi('expired-login-token');
    const session = buildSession(storage, api);
    (session as unknown as { gatewayAuthRejected: boolean }).gatewayAuthRejected = true;

    const token = await (session as unknown as { freshToken(): Promise<string> }).freshToken();
    // Must NOT mint an anonymous device credential — that would silently swap the player's identity.
    expect((api as unknown as { auth: ReturnType<typeof vi.fn> }).auth).not.toHaveBeenCalled();
    expect(token).toBe('expired-login-token'); // still the same (still-broken) token — honest, not silently fixed
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][1]).toBe('error');

    // A second consecutive rejection must not spam the toast again.
    const token2 = await (session as unknown as { freshToken(): Promise<string> }).freshToken();
    void token2;
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });
});
