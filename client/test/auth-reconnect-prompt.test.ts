// login-reconnect-prompt: unit tests for createAuthNav's offerResume() wiring — doAuth() (fresh
// login) and resolveEntry() (token re-entry / wx auto-login) all funnel through SaveManager's
// consumeActiveMatch() exactly once, and only show the "resume your match?" dialog when it returns
// a record. Uses a hand-built minimal AppCtx (TS field privacy is compile-time only; a plain object
// with just the properties createAuthNav actually reads is sufficient — same technique as
// save-manager.test.ts's fakeApi) rather than the full createAppCore/HeadlessPlatform stack, since
// this is exercising nav/auth.ts's own logic, not full app wiring.
import { describe, it, expect, vi } from 'vitest';
import { createAuthNav } from '../src/app/nav/auth';
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
  } as unknown as { showLogin: (cb: any) => void; showReconnectPrompt: (cb: ReconnectPromptCallbacks) => void };
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
