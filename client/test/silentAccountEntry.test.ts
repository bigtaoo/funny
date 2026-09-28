// IPlatform.silentAccountOnly (CrazyGames Basic Launch, design/game/CRAZYGAMES_LAUNCH.md §2): no
// login screen anywhere — the anonymous device / portal identity is authenticated silently, its
// token persisted as the account session, and every "go to login" bounce retries that instead.
// Same hand-built minimal AppCtx technique as auth-reconnect-prompt.test.ts.
import { describe, it, expect, vi } from 'vitest';
import { createAuthNav } from '../src/app/nav/auth';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface BuildOpts {
  bootstrapOk?: boolean; failFirst?: boolean; cred?: 'device' | 'crazygames'; api?: boolean; token?: string;
  /** CrazyGames-style portal: auth listener + explicit sign-in. */
  portal?: { signInOk?: boolean };
  stored?: Record<string, string>;
}

function build(opts: BuildOpts = {}) {
  const storage = new Map<string, string>(Object.entries(opts.stored ?? {}));
  if (opts.token) storage.set('nw_token', opts.token);
  /** What the api held each time bootstrap ran (the guest token the server would receive). */
  const tokenAtBootstrap: (string | null)[] = [];
  let portalListener: (() => void) | null = null;
  let apiToken: string | null = null;
  const api = opts.api === false ? null : {
    getToken: () => apiToken,
    hasToken: () => apiToken !== null,
    setToken: vi.fn((t: string | null) => { apiToken = t; }),
  };
  const saveManager = {
    bootstrap: vi.fn(async () => {
      tokenAtBootstrap.push(apiToken);
      if (opts.bootstrapOk === false) return false;
      if (opts.failFirst && saveManager.bootstrap.mock.calls.length === 1) return false;
      apiToken = 'silent-token';
      return true;
    }),
    consumeActiveMatch: vi.fn(() => null),
    get: vi.fn(() => ({ accountId: 'acc-1', pvp: { rank: 'bronze', elo: 1000 }, titles: [], inventory: { skins: [] }, cardInv: {}, everOwned: {} })),
    getFlag: vi.fn(() => false),
  };
  const views = { showLogin: vi.fn(), showSettings: vi.fn(), showReconnectPrompt: vi.fn() };
  const state = { inLobby: false } as AppState;
  const nav = {} as Nav;
  const lobbyCalls: unknown[] = [];
  nav.goLobby = vi.fn((o) => { lobbyCalls.push(o); state.inLobby = true; }) as Nav['goLobby'];
  const ctx = {
    api, saveManager, views, state, nav,
    platform: {
      silentAccountOnly: true,
      storage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => { storage.set(k, v); },
        removeItem: (k: string) => { storage.delete(k); },
      },
      getAuthCredential: async () => (opts.cred === 'crazygames' ? { kind: 'crazygames', token: 'cg' } : { kind: 'device', deviceId: 'd' }),
      openTextInput: vi.fn(),
      declinePortalIdentity: vi.fn(() => opts.cred === 'crazygames'),
      ...(opts.portal ? {
        onPortalSignIn: (cb: () => void) => { portalListener = cb; },
        signInWithCrazyGames: vi.fn(async () => (opts.portal!.signInOk === false ? null : { kind: 'crazygames', token: 'cg' })),
      } : {}),
    },
    playerName: () => 'Guest',
    avatarId: () => undefined,
    gateConsent: (next: () => void) => next(),
    applyGatewayUrl: vi.fn(),
    featureFlags: null,
    getNetSession: () => null,
  } as unknown as AppCtx;
  const platform = (ctx as unknown as { platform: { declinePortalIdentity: ReturnType<typeof vi.fn> } }).platform;
  return {
    authNav: createAuthNav(ctx), storage, views, lobbyCalls, saveManager, platform, tokenAtBootstrap,
    portalSignsIn: () => portalListener?.(),
    hasPortalListener: () => portalListener !== null,
  };
}

describe('silentAccountOnly entry', () => {
  it('a guest with no portal session lands in the lobby, never on the login screen', async () => {
    const { authNav, views, lobbyCalls } = build({ cred: 'device' });
    await authNav.resolveEntry();
    await settle();
    expect(views.showLogin).not.toHaveBeenCalled();
    expect(lobbyCalls[0]).toEqual({ offline: false });
  });

  it('REGRESSION: persists the silent token so the lobby treats the guest as a real account', async () => {
    // Before this, the token stayed in memory only and every TOKEN_KEY gate (mail, daily, ranked,
    // world map) treated a signed-in portal player as logged out.
    const { authNav, storage, lobbyCalls } = build({ cred: 'crazygames' });
    await authNav.resolveEntry();
    await settle();
    expect(storage.get('nw_token')).toBe('silent-token');
    expect(lobbyCalls.length, 'the lobby is rebuilt once the session exists').toBe(2);
  });

  it('a failed bootstrap persists nothing (offline play keeps working, no fake session)', async () => {
    const { authNav, storage } = build({ bootstrapOk: false });
    await authNav.resolveEntry();
    await settle();
    expect(storage.has('nw_token')).toBe(false);
  });

  it('a portal identity the server refuses falls back to a guest account instead of none', async () => {
    // The local SDK hands out a demo portal token, and CrazyGames SSO has never been exercised on
    // the portal: an unconfigured or failing verification must not strand every signed-in player.
    const { authNav, storage, saveManager, platform } = build({ cred: 'crazygames', failFirst: true });
    await authNav.resolveEntry();
    await settle();
    expect(platform.declinePortalIdentity).toHaveBeenCalledTimes(1);
    expect(saveManager.bootstrap).toHaveBeenCalledTimes(2);
    expect(storage.get('nw_token')).toBe('silent-token');
  });

  it('no API base configured → offline lobby, still no login screen', async () => {
    const { authNav, views, lobbyCalls } = build({ api: false });
    await authNav.resolveEntry();
    expect(views.showLogin).not.toHaveBeenCalled();
    expect(lobbyCalls).toEqual([{ offline: true }]);
  });

  it('every "needs login" bounce retries the silent entry instead of opening the login screen', async () => {
    const { authNav, views, saveManager } = build();
    authNav.goLogin();
    await settle();
    expect(views.showLogin).not.toHaveBeenCalled();
    expect(saveManager.bootstrap).toHaveBeenCalledTimes(1);
  });

  it('a dead token re-enters silently: no "please log in again" toast, no login screen', async () => {
    const { authNav, storage, views, saveManager } = build({ token: 'dead' });
    authNav.forceLogout();
    await settle();
    expect(views.showLogin).not.toHaveBeenCalled();
    expect(saveManager.bootstrap).toHaveBeenCalledTimes(1);
    expect(storage.get('nw_token')).toBe('silent-token');
  });

  it('settings offer no login, logout or account deletion', () => {
    const { authNav, views } = build({ token: 'tok' });
    authNav.goSettings();
    const cb = views.showSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(cb.onLogin).toBeUndefined();
    expect(cb.onLogout).toBeUndefined();
    expect(cb.onDeleteAccount).toBeUndefined();
  });
});

describe('silentAccountOnly — portal account integration (CRAZYGAMES_LAUNCH.md §4.1)', () => {
  it('REGRESSION: the stored guest session reaches the server with the portal login, so it can be bound', async () => {
    // Without it a returning guest who has since signed into CrazyGames got a brand-new account and
    // their progress stayed behind on the device account.
    const { authNav, tokenAtBootstrap } = build({ cred: 'crazygames', token: 'guest-token', portal: {} });
    await authNav.resolveEntry();
    await settle();
    expect(tokenAtBootstrap[0]).toBe('guest-token');
  });

  it('signing into the portal mid-session re-resolves identity in place (no scene change)', async () => {
    const { authNav, saveManager, lobbyCalls, portalSignsIn, hasPortalListener } = build({ cred: 'device', portal: {} });
    await authNav.resolveEntry();
    await settle();
    expect(hasPortalListener()).toBe(true);
    const lobbiesBefore = lobbyCalls.length;
    const bootstrapsBefore = saveManager.bootstrap.mock.calls.length;
    portalSignsIn();
    await settle();
    expect(saveManager.bootstrap.mock.calls.length).toBe(bootstrapsBefore + 1);
    // Only the in-lobby refresh; never a forced trip to the lobby from wherever the player is.
    expect(lobbyCalls.slice(lobbiesBefore).every((o) => (o as { offline: boolean }).offline === false)).toBe(true);
  });

  it('two sign-in signals at once run a single re-resolve', async () => {
    const { authNav, saveManager, portalSignsIn } = build({ cred: 'device', portal: {} });
    await authNav.resolveEntry();
    await settle();
    const before = saveManager.bootstrap.mock.calls.length;
    portalSignsIn(); portalSignsIn();
    await settle();
    expect(saveManager.bootstrap.mock.calls.length).toBe(before + 1);
  });

  it('a guest gets the "sign in with CrazyGames" row; it opens only the portal prompt', async () => {
    const { authNav, views, platform, saveManager } = build({ token: 'tok', portal: {} });
    authNav.goSettings();
    const cb = views.showSettings.mock.calls[0][0] as { onLinkPortalAccount?: () => void };
    expect(cb.onLinkPortalAccount).toBeTypeOf('function');
    cb.onLinkPortalAccount!();
    await settle(); await settle();
    expect((platform as unknown as { signInWithCrazyGames: ReturnType<typeof vi.fn> }).signInWithCrazyGames).toHaveBeenCalledTimes(1);
    expect(saveManager.bootstrap).toHaveBeenCalledTimes(1);
    expect(views.showSettings).toHaveBeenCalledTimes(2); // redrawn with the portal profile
  });

  it('a cancelled portal prompt changes nothing', async () => {
    const { authNav, views, saveManager } = build({ token: 'tok', portal: { signInOk: false } });
    authNav.goSettings();
    (views.showSettings.mock.calls[0][0] as { onLinkPortalAccount: () => void }).onLinkPortalAccount();
    await settle();
    expect(saveManager.bootstrap).not.toHaveBeenCalled();
    expect(views.showSettings).toHaveBeenCalledTimes(1);
  });

  it('a portal account: no sign-in row, no rename, no avatar picking', () => {
    const { authNav, views } = build({
      token: 'tok', portal: {},
      stored: { nw_name_locked: '1', nw_platform_avatar: 'url:https://images.crazygames.com/userportal/avatars/1.png' },
    });
    authNav.goSettings();
    const cb = views.showSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(cb.onLinkPortalAccount).toBeUndefined();
    expect(cb.onRename).toBeUndefined();
    expect(cb.onSetAvatar).toBeUndefined();
  });

  it('a guest keeps rename and avatar picking', () => {
    const { authNav, views } = build({ token: 'tok', portal: {} });
    authNav.goSettings();
    const cb = views.showSettings.mock.calls[0][0] as Record<string, unknown>;
    expect(cb.onSetAvatar).toBeTypeOf('function');
  });
});
