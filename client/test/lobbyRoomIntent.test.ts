// A friend room the platform asked for (CrazyGames invite link / "play with friends", AppState
// .pendingRoomIntent; CRAZYGAMES_LAUNCH.md §4.2) is opened by the lobby entry, ahead of the
// first-launch tutorial: the friend who sent the invite is waiting in that room.
import { describe, it, expect, vi } from 'vitest';
import { createLobbyNav } from '../src/app/nav/lobby';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { IPlatform, IStorage, RoomIntent } from '../src/platform/IPlatform';
import type { ApiClient } from '../src/net/ApiClient';
import type { NetSession } from '../src/net/NetSession';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { TOKEN_KEY } from '../src/app/appConstants';
import { HeadlessAppViews } from './harness/HeadlessAppViews';

class MemStorage implements IStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

function build(opts: { intent: RoomIntent | null; connected: boolean }) {
  const storage = new MemStorage();
  storage.setItem(TOKEN_KEY, 'test-token');
  const platform = { storage, iapKind: () => null, onGameplayStop: () => {} } as unknown as IPlatform;
  const state: AppState = {
    inLobby: false, offlineMode: false, gatewayUrl: 'wss://x/gw', netSession: null,
    firstLobbyHandled: false, // a first launch: the tutorial is still due
    socialBadgeTotal: 0, mailBadgeCount: 0, achievementClaimable: false,
    shopCardClaimable: false, achievementReached: null, pendingRoomIntent: opts.intent,
  };
  const session = { handlers: {}, connect: () => {}, gateway: { getState: () => 'idle' } } as unknown as NetSession;
  let connected = opts.connected;
  const nav = {} as Nav;
  nav.goRoom = vi.fn();
  nav.goTutorial = vi.fn();
  const ctx = {
    platform, views: new HeadlessAppViews(), api: {} as ApiClient, baseUrl: null,
    saveManager: new SaveManager({ store: new LocalSaveStore(storage) }),
    replayStore: {} as AppCtx['replayStore'], featureFlags: null, state, nav,
    getNetSession: () => (connected ? session : null),
    applyGatewayUrl: () => {}, playerName: () => 'tester', avatarId: () => undefined,
    gateConsent: (next: () => void) => next(), resolvePvpDeck: () => [], keepReplay: (r: unknown) => r,
    resolveWorldShard: () => {},
  } as unknown as AppCtx;
  Object.assign(nav, createLobbyNav(ctx));
  return { nav, state, connect: () => { connected = true; } };
}

describe('lobby.ts — platform room intent', () => {
  it('an invite opens its room instead of the lobby, and the tutorial waits', () => {
    const { nav, state } = build({ intent: { kind: 'join', code: '123456' }, connected: true });
    nav.goLobby();
    expect(nav.goRoom).toHaveBeenCalledWith({ intent: { kind: 'join', code: '123456' } });
    expect(nav.goTutorial).not.toHaveBeenCalled();
    expect(state.pendingRoomIntent).toBeNull();
  });

  it('before the server connection exists the lobby shows; the refresh after sign-in opens the room', () => {
    const { nav, state, connect } = build({ intent: { kind: 'create' }, connected: false });
    nav.goLobby();
    expect(nav.goRoom).not.toHaveBeenCalled();
    expect(nav.goTutorial).not.toHaveBeenCalled(); // not dragged into the tutorial meanwhile
    expect(state.inLobby).toBe(true);
    connect();
    nav.goLobby();
    expect(nav.goRoom).toHaveBeenCalledWith({ intent: { kind: 'create' } });
  });

  it('a resize redraw never consumes it', () => {
    const { nav, state } = build({ intent: { kind: 'create' }, connected: true });
    nav.goLobby({ fromResize: true });
    expect(nav.goRoom).not.toHaveBeenCalled();
    expect(state.pendingRoomIntent).not.toBeNull();
  });

  it('without an intent (every platform but CrazyGames) the first entry still goes to the tutorial', () => {
    const { nav } = build({ intent: null, connected: true });
    nav.goLobby();
    expect(nav.goTutorial).toHaveBeenCalled();
    expect(nav.goRoom).not.toHaveBeenCalled();
  });
});
