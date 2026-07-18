// login-reconnect-prompt: unit tests for createAuthNav's offerResume() wiring — doAuth() (fresh
// login) and resolveEntry() (token re-entry / wx auto-login) all funnel through SaveManager's
// consumeActiveMatch() exactly once, and only show the "resume your match?" dialog when it returns
// a record. Uses a hand-built minimal AppCtx (TS field privacy is compile-time only; a plain object
// with just the properties createAuthNav actually reads is sufficient — same technique as
// save-manager.test.ts's fakeApi) rather than the full createAppCore/HeadlessPlatform stack, since
// this is exercising nav/auth.ts's own logic, not full app wiring.
import { describe, it, expect, vi } from 'vitest';
import { createAuthNav, mapAuthError } from '../src/app/nav/auth';
import { ApiError } from '../src/net/ApiClient/base';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { ActiveMatchInfo } from '../src/net/ApiClient';
import type { ReconnectPromptCallbacks } from '../src/render/ReconnectPromptDialog';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const SAMPLE_MATCH: ActiveMatchInfo = {
  roomId: 'room-1',
  gameUrl: 'ws://game:8081/ws',
  ticket: 'signed.jwt.ticket',
  mode: 'ranked',
};

/** Minimal fake SaveManager: only the methods createAuthNav actually calls. */
function fakeSaveManager(opts: { activeMatch?: ActiveMatchInfo | null; accountId?: string } = {}) {
  let pending = opts.activeMatch ?? null;
  return {
    adoptSession: vi.fn(async () => true),
    bootstrap: vi.fn(async () => true),
    get: vi.fn(() => ({ accountId: opts.accountId ?? 'acc-1' })),
    consumeActiveMatch: vi.fn(() => {
      const m = pending;
      pending = null; // read-and-clear, mirrors the real SaveManager
      return m;
    }),
    setPending(m: ActiveMatchInfo | null) { pending = m; },
  };
}

/** Minimal fake AppViews: records showLogin/showReconnectPrompt calls; other methods unused here. */
function fakeViews() {
  const calls: { showReconnectPrompt: ReconnectPromptCallbacks[] } = { showReconnectPrompt: [] };
  let loginCb: { onLogin: (id: string, pw: string) => void } | undefined;
  return {
    calls,
    showLogin: vi.fn((cb: { onLogin: (id: string, pw: string) => void }) => { loginCb = cb; }),
    triggerLogin(id: string, pw: string) { loginCb!.onLogin(id, pw); },
    showReconnectPrompt: vi.fn((cb: ReconnectPromptCallbacks) => { calls.showReconnectPrompt.push(cb); }),
    showSettings: vi.fn(),
  };
}

function buildCtx(opts: {
  saveManager: ReturnType<typeof fakeSaveManager>;
  views: ReturnType<typeof fakeViews>;
  api?: unknown;
  token?: string | null;
  wx?: boolean;
}) {
  const nav = {} as Nav;
  const goLobbyCalls: unknown[] = [];
  nav.goLobby = vi.fn((o) => { goLobbyCalls.push(o); }) as Nav['goLobby'];

  const storageMap = new Map<string, string>();
  if (opts.token) storageMap.set('nw_token', opts.token);

  const netSession = { rejoinMatch: vi.fn() };

  const ctx = {
    api: opts.api ?? {
      login: vi.fn(async () => ({ token: 't', accountId: 'acc-1', isNew: false, isAnonymous: false })),
      setToken: vi.fn(),
    },
    saveManager: opts.saveManager,
    platform: {
      storage: {
        getItem: (k: string) => storageMap.get(k) ?? null,
        setItem: (k: string, v: string) => { storageMap.set(k, v); },
        removeItem: (k: string) => { storageMap.delete(k); },
      },
      getAuthCredential: async () => (opts.wx ? { kind: 'wx' } : { kind: 'device', deviceId: 'd' }),
    },
    views: opts.views,
    state: {} as AppState,
    nav,
    playerName: () => 'Player',
    avatarId: () => undefined,
    gateConsent: (next: () => void) => next(),
    applyGatewayUrl: vi.fn(),
    featureFlags: null,
    getNetSession: () => netSession,
  } as unknown as AppCtx;

  return { ctx, nav, goLobbyCalls, netSession };
}

describe('offerResume via doAuth() (fresh password login)', () => {
  it('no activeMatch → goes straight to lobby, no dialog', async () => {
    const saveManager = fakeSaveManager({ activeMatch: null });
    const views = fakeViews();
    const { ctx, goLobbyCalls } = buildCtx({ saveManager, views });
    const authNav = createAuthNav(ctx);

    authNav.goLogin();
    views.triggerLogin('user', 'pw');
    await settle();

    expect(saveManager.consumeActiveMatch).toHaveBeenCalledTimes(1);
    expect(views.showReconnectPrompt).not.toHaveBeenCalled();
    expect(goLobbyCalls).toEqual([{ offline: false }]);
  });

  it('activeMatch present → shows the reconnect dialog instead of going straight to lobby', async () => {
    const saveManager = fakeSaveManager({ activeMatch: SAMPLE_MATCH });
    const views = fakeViews();
    const { ctx, goLobbyCalls } = buildCtx({ saveManager, views });
    const authNav = createAuthNav(ctx);

    authNav.goLogin();
    views.triggerLogin('user', 'pw');
    await settle();

    expect(views.showReconnectPrompt).toHaveBeenCalledTimes(1);
    expect(goLobbyCalls).toEqual([]); // lobby nav deferred to the dialog's callbacks
  });

  it('onReconnect calls NetSession.rejoinMatch with the cached gameUrl/ticket', async () => {
    const saveManager = fakeSaveManager({ activeMatch: SAMPLE_MATCH });
    const views = fakeViews();
    const { ctx, netSession } = buildCtx({ saveManager, views });
    const authNav = createAuthNav(ctx);

    authNav.goLogin();
    views.triggerLogin('user', 'pw');
    await settle();

    const cb = views.calls.showReconnectPrompt[0]!;
    cb.onReconnect();
    expect(netSession.rejoinMatch).toHaveBeenCalledWith(SAMPLE_MATCH.gameUrl, SAMPLE_MATCH.ticket);
  });

  it('onDecline goes to the lobby', async () => {
    const saveManager = fakeSaveManager({ activeMatch: SAMPLE_MATCH });
    const views = fakeViews();
    const { ctx, goLobbyCalls } = buildCtx({ saveManager, views });
    const authNav = createAuthNav(ctx);

    authNav.goLogin();
    views.triggerLogin('user', 'pw');
    await settle();

    const cb = views.calls.showReconnectPrompt[0]!;
    cb.onDecline();
    expect(goLobbyCalls).toEqual([{ offline: false }]);
  });
});

describe('offerResume via resolveEntry() (token re-entry)', () => {
  it('lobby nav fires without waiting on the network round-trip; dialog pops once activeMatch resolves', async () => {
    const saveManager = fakeSaveManager({ activeMatch: SAMPLE_MATCH });
    const views = fakeViews();
    const { ctx, goLobbyCalls } = buildCtx({ saveManager, views, token: 'existing-token' });
    const authNav = createAuthNav(ctx);

    await authNav.resolveEntry();
    // goLobby is called synchronously inside resolveEntry, not gated on adoptSession() resolving —
    // preserves the existing "instant lobby" entry experience.
    expect(goLobbyCalls).toEqual([{ offline: false }]);

    await settle(); // let the adoptSession().then(...) microtask run
    expect(views.showReconnectPrompt).toHaveBeenCalledTimes(1);
    // No second nav.goLobby is fired by offerResume itself when the dialog is shown (it's fired only
    // from the dialog's own onDecline callback, tested separately for the doAuth path).
    expect(goLobbyCalls).toEqual([{ offline: false }]);
  });

  it('no activeMatch → no dialog ever shown', async () => {
    const saveManager = fakeSaveManager({ activeMatch: null });
    const views = fakeViews();
    const { ctx } = buildCtx({ saveManager, views, token: 'existing-token' });
    const authNav = createAuthNav(ctx);

    await authNav.resolveEntry();
    await settle();
    expect(views.showReconnectPrompt).not.toHaveBeenCalled();
  });
});

describe('offerResume via resolveEntry() (wx auto-login)', () => {
  it('activeMatch found after bootstrap() pops the dialog', async () => {
    const saveManager = fakeSaveManager({ activeMatch: SAMPLE_MATCH });
    const views = fakeViews();
    const { ctx, goLobbyCalls } = buildCtx({ saveManager, views, wx: true });
    const authNav = createAuthNav(ctx);

    await authNav.resolveEntry();
    // goLobby fires without waiting for the bootstrap() round-trip (same "instant lobby" behavior
    // as the token path) — whether the dialog has already popped by this exact microtask tick is an
    // implementation timing detail, not asserted here; what matters is it (a) fires goLobby right
    // away and (b) shows the dialog once bootstrap resolves, checked after settle() below.
    expect(goLobbyCalls).toEqual([{ offline: false }]);

    await settle();
    expect(saveManager.bootstrap).toHaveBeenCalledTimes(1);
    expect(views.showReconnectPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('account-switch NetSession reset (2026-07-18: elo credited to previous account bug)', () => {
  it('doAuth() closes a stale NetSession from a previous account, even when the gateway URL is unchanged', async () => {
    const saveManager = fakeSaveManager({ activeMatch: null });
    const views = fakeViews();
    const { ctx } = buildCtx({ saveManager, views });
    const staleSession = { close: vi.fn() };
    (ctx.state as AppState).netSession = staleSession as unknown as AppState['netSession'];
    const authNav = createAuthNav(ctx);

    authNav.goLogin();
    views.triggerLogin('tao', 'pw');
    await settle();

    expect(staleSession.close).toHaveBeenCalledTimes(1);
    expect(ctx.state.netSession).toBeNull();
  });

  it('doLogout() closes any live NetSession so it cannot keep routing to the logged-out account', () => {
    const saveManager = fakeSaveManager({ activeMatch: null });
    const views = fakeViews();
    const { ctx } = buildCtx({ saveManager, views, token: 'existing-token' });
    const staleSession = { close: vi.fn() };
    (ctx.state as AppState).netSession = staleSession as unknown as AppState['netSession'];
    const authNav = createAuthNav(ctx);

    authNav.doLogout();

    expect(staleSession.close).toHaveBeenCalledTimes(1);
    expect(ctx.state.netSession).toBeNull();
  });

  it('doAuth() does not throw when no NetSession has been created yet (fresh app launch)', async () => {
    const saveManager = fakeSaveManager({ activeMatch: null });
    const views = fakeViews();
    const { ctx } = buildCtx({ saveManager, views });
    // state.netSession left at its initial null — nothing to close yet.
    const authNav = createAuthNav(ctx);

    authNav.goLogin();
    expect(() => views.triggerLogin('tao', 'pw')).not.toThrow();
    await settle();

    expect(ctx.state.netSession).toBeNull();
  });

  it('repeated account switches each close only the session that was live at that moment', async () => {
    const saveManager = fakeSaveManager({ activeMatch: null });
    const views = fakeViews();
    const { ctx } = buildCtx({ saveManager, views });
    const authNav = createAuthNav(ctx);

    // tao1's gateway session is live when tao logs in.
    const sessionForTao1 = { close: vi.fn() };
    (ctx.state as AppState).netSession = sessionForTao1 as unknown as AppState['netSession'];
    authNav.goLogin();
    views.triggerLogin('tao', 'pw');
    await settle();
    expect(sessionForTao1.close).toHaveBeenCalledTimes(1);
    expect(ctx.state.netSession).toBeNull();

    // Simulate tao's own gateway session getting lazily created afterwards (e.g. opening a room),
    // then a second switch to a third account — the fix must not only fire once per process lifetime.
    const sessionForTao = { close: vi.fn() };
    (ctx.state as AppState).netSession = sessionForTao as unknown as AppState['netSession'];
    authNav.goLogin();
    views.triggerLogin('tao2', 'pw');
    await settle();
    expect(sessionForTao.close).toHaveBeenCalledTimes(1);
    expect(sessionForTao1.close).toHaveBeenCalledTimes(1); // untouched by the second switch
    expect(ctx.state.netSession).toBeNull();
  });

  it('doLogout() does not throw when no NetSession exists', () => {
    const saveManager = fakeSaveManager({ activeMatch: null });
    const views = fakeViews();
    const { ctx } = buildCtx({ saveManager, views, token: 'existing-token' });
    const authNav = createAuthNav(ctx);

    expect(() => authNav.doLogout()).not.toThrow();
    expect(ctx.state.netSession).toBeNull();
  });
});

describe('mapAuthError (2026-07-18: banned accounts get a distinct message, not the generic network error)', () => {
  it('ACCOUNT_BANNED maps to its own key, not the generic network fallback', () => {
    expect(mapAuthError(new ApiError('ACCOUNT_BANNED', 'account banned'))).toBe('auth.err.banned');
  });
  it('unmapped codes still fall back to the generic network error', () => {
    expect(mapAuthError(new ApiError('SOME_UNKNOWN_CODE', 'x'))).toBe('auth.err.network');
  });
  it('INVALID_CREDENTIALS still maps as before (regression guard)', () => {
    expect(mapAuthError(new ApiError('INVALID_CREDENTIALS', 'nope'))).toBe('auth.err.invalid');
  });
});
