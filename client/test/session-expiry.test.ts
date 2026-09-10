// Session lifetime end-to-end on the client (ACCOUNT_DESIGN.md §5, 2026-09-10).
//
// Two independent problems, one field report (iPhone 13 / Capacitor): the lobby showed
// "登录已失效，请重新登录" as a toast and then did nothing at all, leaving the player parked in a
// lobby where every request 401s.
//
//   A. Nothing ever renewed a token, so the 30d TTL ran from the last password entry regardless of
//      how active the account was. Fixed server-side (metaserver attaches `x-nw-token`) plus the
//      adoption half tested here: ApiClientCore.fetchRaw is the single choke point every REST call
//      passes through, so reading the header there covers every endpoint at once.
//   B. When a token really is dead, the client has to go back to the login screen. net/log.ts's
//      session-expired sink + nav/auth.ts's forceLogout, with three gates that each turn a fix into
//      a new bug if missed (concurrent 401 burst, the logout teardown's own 401, and guests).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ApiClient } from '../src/net/ApiClient';
import { WorldApiClient } from '../src/net/WorldApiClient';
import {
  setSessionExpiredSink,
  notifySessionExpired,
  maybeNotifySessionExpired,
} from '../src/net/log';
import { createAuthNav } from '../src/app/nav/auth';
import { uncaughtErrorMessage } from '../src/net/apiErrorMessage';
import { ApiError } from '../src/net/ApiClient/core';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { LoginSceneCallbacks } from '../src/scenes/LoginScene';

const RENEWED_HEADER = 'x-nw-token';

/** A NetResponse-shaped fetch fake whose `headers` behaves like the real (case-insensitive) Headers. */
function response(body: unknown, headers: Record<string, string> = {}): Response {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => lower.get(n.toLowerCase()) ?? null },
    json: async () => body,
  } as unknown as Response;
}

/**
 * A plain success envelope. The renewal tests deliberately drive `changePassword` (an ordinary
 * authenticated POST) rather than `login`: AuthService.login assigns `core.token` from the response
 * body, which would mask whether the header was adopted at all.
 */
const OK = { ok: true, data: { ok: true } };

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>).fetch;
  setSessionExpiredSink(() => {}); // reset so later test files don't inherit a live sink
});

// ── A. token renewal adoption ──────────────────────────────────────────────────────────────────
describe('ApiClientCore: adopting a server-renewed token', () => {
  it('swaps in x-nw-token and reports it to the persistence outlet', async () => {
    globalThis.fetch = (async () => response(OK, { [RENEWED_HEADER]: 'tok-renewed' })) as unknown as typeof fetch;
    const persisted: string[] = [];
    const api = new ApiClient('https://h/api');
    api.setToken('tok-old');
    api.setTokenRenewedHandler((t) => persisted.push(t));

    await api.changePassword('old-pw', 'new-pw');

    expect(api.getToken()).toBe('tok-renewed');
    expect(persisted).toEqual(['tok-renewed']);
  });

  it('sends the renewed token on the NEXT request, which is the whole point', async () => {
    const sent: string[] = [];
    let first = true;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push((init.headers as Record<string, string>)['authorization'] ?? '');
      const headers: Record<string, string> = first ? { [RENEWED_HEADER]: 'tok-renewed' } : {};
      first = false;
      return response(OK, headers);
    }) as unknown as typeof fetch;

    const api = new ApiClient('https://h/api');
    api.setToken('tok-old');
    await api.changePassword('old-pw', 'new-pw');
    await api.changePassword('new-pw', 'newer-pw');

    expect(sent).toEqual(['Bearer tok-old', 'Bearer tok-renewed']);
  });

  it('is case-insensitive about the header name (proxies re-case response headers)', async () => {
    globalThis.fetch = (async () => response(OK, { 'X-NW-Token': 'tok-renewed' })) as unknown as typeof fetch;
    const api = new ApiClient('https://h/api');
    api.setToken('tok-old');
    await api.changePassword('old-pw', 'new-pw');
    expect(api.getToken()).toBe('tok-renewed');
  });

  it('renews off an error response too — a near-expiry token is worth renewing either way', async () => {
    globalThis.fetch = (async () =>
      response({ ok: false, error: { code: 'INSUFFICIENT_FUNDS', message: 'no' } },
        { [RENEWED_HEADER]: 'tok-renewed' })) as unknown as typeof fetch;
    const api = new ApiClient('https://h/api');
    api.setToken('tok-old');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(api.changePassword('old-pw', 'new-pw')).rejects.toBeInstanceOf(ApiError);
    expect(api.getToken()).toBe('tok-renewed');
  });

  it('leaves the token alone when the header is absent, and never calls the outlet', async () => {
    globalThis.fetch = (async () => response(OK)) as unknown as typeof fetch;
    const outlet = vi.fn();
    const api = new ApiClient('https://h/api');
    api.setToken('tok-old');
    api.setTokenRenewedHandler(outlet);

    await api.changePassword('old-pw', 'new-pw');

    expect(api.getToken()).toBe('tok-old');
    expect(outlet).not.toHaveBeenCalled();
  });

  it('does not fire the outlet when the server echoes back the token we already hold', async () => {
    globalThis.fetch = (async () => response(OK, { [RENEWED_HEADER]: 'tok-old' })) as unknown as typeof fetch;
    const outlet = vi.fn();
    const api = new ApiClient('https://h/api');
    api.setToken('tok-old');
    api.setTokenRenewedHandler(outlet);

    await api.changePassword('old-pw', 'new-pw');
    expect(outlet).not.toHaveBeenCalled();
  });

  it('a transport with no headers at all is fine (older test doubles, defensive transports)', async () => {
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => OK }) as unknown as Response) as unknown as typeof fetch;
    const api = new ApiClient('https://h/api');
    api.setToken('tok-old');
    await expect(api.changePassword('old-pw', 'new-pw')).resolves.toBeUndefined();
    expect(api.getToken()).toBe('tok-old');
  });
});

// ── B1. the sink itself ────────────────────────────────────────────────────────────────────────
describe('net/log: session-expired sink', () => {
  it('notifySessionExpired fires the registered sink', () => {
    const sink = vi.fn();
    setSessionExpiredSink(sink);
    notifySessionExpired();
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('fires for every code that means "this token is dead"', () => {
    const seen: string[] = [];
    for (const code of ['UNAUTHENTICATED', 'UNAUTHORIZED', 'TOKEN_EXPIRED']) {
      setSessionExpiredSink(() => seen.push(code));
      maybeNotifySessionExpired(code);
    }
    expect(seen).toEqual(['UNAUTHENTICATED', 'UNAUTHORIZED', 'TOKEN_EXPIRED']);
  });

  it('does NOT fire for a permission refusal or any unrelated code', () => {
    const sink = vi.fn();
    setSessionExpiredSink(sink);
    for (const code of ['FORBIDDEN', 'NO_PERMISSION', 'ACCOUNT_BANNED', 'RATE_LIMITED', 'UNKNOWN']) {
      maybeNotifySessionExpired(code);
    }
    expect(sink).not.toHaveBeenCalled();
  });

  it('swallows a throwing sink (it must never turn into another unhandledrejection)', () => {
    setSessionExpiredSink(() => { throw new Error('boom'); });
    expect(() => notifySessionExpired()).not.toThrow();
  });
});

describe('ApiClient / apiErrorMessage: 401 wiring', () => {
  it('a 401 envelope from the transport reaches the sink', async () => {
    globalThis.fetch = (async () =>
      response({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'invalid token' } })) as unknown as typeof fetch;
    const sink = vi.fn();
    setSessionExpiredSink(sink);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const api = new ApiClient('https://h/api');
    api.setToken('tok-dead');
    await expect(api.getSave()).rejects.toBeInstanceOf(ApiError);

    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('a 401 from worldsvc/socialsvc/auctionsvc reaches the same sink', async () => {
    globalThis.fetch = (async () =>
      response({ ok: false, error: { code: 'UNAUTHENTICATED', message: 'authentication required' } })) as unknown as typeof fetch;
    const sink = vi.fn();
    setSessionExpiredSink(sink);

    // WorldApiCore reads its base URLs + token out of storage, hence the stub.
    const client = new WorldApiClient({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    });
    await expect(client.createFamily('Notebook Legion', 'NBL1')).rejects.toThrow();

    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('UNAUTHENTICATED — the code services actually emit — maps to the session-expired copy', () => {
    const e = new ApiError('UNAUTHENTICATED', 'nope');
    expect(uncaughtErrorMessage(e)).toBe(uncaughtErrorMessage(new ApiError('TOKEN_EXPIRED', 'nope')));
  });

  it('a permission refusal no longer claims the session expired', () => {
    const forbidden = uncaughtErrorMessage(new ApiError('FORBIDDEN', 'nope'));
    expect(forbidden).toBe(uncaughtErrorMessage(new ApiError('NO_PERMISSION', 'nope')));
    expect(forbidden).not.toBe(uncaughtErrorMessage(new ApiError('UNAUTHENTICATED', 'nope')));
    expect(forbidden).not.toBeNull();
  });
});

// ── B2. forceLogout + its three gates ──────────────────────────────────────────────────────────
/**
 * Hand-built minimal AppCtx, same technique as auth-reconnect-prompt.test.ts: TS field privacy is
 * compile-time only, so an object carrying just what createAuthNav reads is enough, and this keeps
 * the test on nav/auth.ts's own logic rather than the whole createAppCore stack.
 */
function buildCtx(opts: { token?: string | null; offline?: boolean } = {}) {
  const storage = new Map<string, string>();
  if (opts.token !== null) storage.set('nw_token', opts.token ?? 'tok-dead');
  storage.set('nw_player_name', 'Player');

  let resolveFlush: (() => void) | undefined;
  const flush = new Promise<void>((r) => { resolveFlush = r; });

  const login = vi.fn(async () => ({ token: 'tok-new', accountId: 'acc-1', isNew: false, isAnonymous: false }));
  const loginCbs: LoginSceneCallbacks[] = [];
  const nav = {} as Nav;
  nav.goLobby = vi.fn() as Nav['goLobby'];

  const netSession = { close: vi.fn() };
  const state = { inLobby: true, offlineMode: opts.offline ?? false, netSession } as unknown as AppState;

  const saveManager = {
    adoptSession: vi.fn(async () => true),
    clearSyncedLocalSections: vi.fn(),
    resetForLogout: vi.fn(() => flush),
    get: vi.fn(() => ({ accountId: 'acc-1', flags: {} })),
    getFlag: vi.fn(() => false),
    setFlag: vi.fn(),
    consumeActiveMatch: vi.fn(() => null),
  };

  const views = { showLogin: vi.fn((cb: LoginSceneCallbacks) => { loginCbs.push(cb); }) };

  const ctx = {
    api: { login, setToken: vi.fn() },
    saveManager,
    platform: {
      storage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => { storage.set(k, v); },
        removeItem: (k: string) => { storage.delete(k); },
      },
      openTextInput: vi.fn(),
      getAuthCredential: async () => ({ kind: 'device', deviceId: 'd' }),
    },
    views,
    state,
    nav,
    playerName: () => 'Player',
    avatarId: () => undefined,
    gateConsent: (next: () => void) => next(),
    applyGatewayUrl: vi.fn(),
    featureFlags: null,
    getNetSession: () => netSession,
  } as unknown as AppCtx;

  return { ctx, storage, views, loginCbs, netSession, saveManager, state, endFlush: () => resolveFlush!() };
}

describe('nav/auth: forceLogout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('toasts, tears the session down and lands on the login screen with an explanation', async () => {
    const h = buildCtx();
    const authNav = createAuthNav(h.ctx);

    authNav.forceLogout();
    // The toast is given time to be read first — nothing has navigated yet.
    expect(h.views.showLogin).not.toHaveBeenCalled();
    expect(h.storage.has('nw_token')).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);

    expect(h.storage.has('nw_token')).toBe(false);
    expect(h.storage.has('nw_player_name')).toBe(false);
    expect(h.saveManager.clearSyncedLocalSections).toHaveBeenCalledTimes(1);
    expect(h.saveManager.resetForLogout).toHaveBeenCalledTimes(1);
    expect(h.netSession.close).toHaveBeenCalledTimes(1);
    expect(h.state.netSession).toBeNull();
    expect(h.views.showLogin).toHaveBeenCalledTimes(1);
    expect(h.loginCbs[0]!.initialNotice).toBe('auth.err.sessionExpired');
  });

  // Gate 1: one screen's worth of concurrent requests all 401 at once.
  it('a burst of 401s produces exactly one logout', async () => {
    const h = buildCtx();
    const authNav = createAuthNav(h.ctx);

    for (let i = 0; i < 8; i++) authNav.forceLogout();
    await vi.advanceTimersByTimeAsync(2000);

    expect(h.views.showLogin).toHaveBeenCalledTimes(1);
    expect(h.saveManager.resetForLogout).toHaveBeenCalledTimes(1);
  });

  // Gate 2: resetForLogout deliberately flushes with the departing token, so it 401s too.
  it('the teardown flush cannot re-enter forceLogout (no self-recursion)', async () => {
    const h = buildCtx();
    const authNav = createAuthNav(h.ctx);

    authNav.forceLogout();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.saveManager.resetForLogout).toHaveBeenCalledTimes(1);

    // resetForLogout is still in flight; its best-effort flush 401s and calls back in.
    authNav.forceLogout();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.views.showLogin).toHaveBeenCalledTimes(1);
    expect(h.saveManager.resetForLogout).toHaveBeenCalledTimes(1);

    h.endFlush();
    await vi.advanceTimersByTimeAsync(0);
  });

  // Gate 3a: offline mode never had a session to expire.
  it('does nothing in offline mode', async () => {
    const h = buildCtx({ offline: true });
    createAuthNav(h.ctx).forceLogout();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.views.showLogin).not.toHaveBeenCalled();
    expect(h.saveManager.resetForLogout).not.toHaveBeenCalled();
  });

  // Gate 3b: a guest / anonymous device player holds a token in memory only.
  it('does nothing when no token was ever persisted', async () => {
    const h = buildCtx({ token: null });
    createAuthNav(h.ctx).forceLogout();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.views.showLogin).not.toHaveBeenCalled();
    expect(h.saveManager.resetForLogout).not.toHaveBeenCalled();
  });

  it('re-arms after a successful login, so a later expiry bounces the player again', async () => {
    const h = buildCtx();
    const authNav = createAuthNav(h.ctx);

    authNav.forceLogout();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.views.showLogin).toHaveBeenCalledTimes(1);
    h.endFlush();

    // Log back in through the very login screen forceLogout just opened.
    await h.loginCbs[0]!.onLogin('bob', 'secret123');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.storage.get('nw_token')).toBe('tok-new');

    authNav.forceLogout();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.views.showLogin).toHaveBeenCalledTimes(2);
    expect(h.loginCbs[1]!.initialNotice).toBe('auth.err.sessionExpired');
  });

  it('an ordinary logout does not carry the session-expired notice', async () => {
    const h = buildCtx();
    createAuthNav(h.ctx).doLogout();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.loginCbs[0]!.initialNotice).toBeUndefined();
  });
});
