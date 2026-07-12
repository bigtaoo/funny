// Regression coverage for createShopNav's back-navigation bug: Shop/Coins/Gacha/BattlePass
// are peer tabs in the same group (LOBBY_IA_REDESIGN P1.5), not a navigation stack. Pressing
// the physical back button from a Gacha or BattlePass peer tab must return straight to the
// group's origin (e.g. the lobby), never detour through the Shop screen first — a user who
// tapped the lobby's shop icon (which opens Gacha) and hit back used to land on the Shop tab
// instead of the lobby.
import { describe, it, expect } from 'vitest';
import { createShopNav } from '../src/app/nav/shop';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { IPlatform, IStorage } from '../src/platform/IPlatform';
import type { ApiClient } from '../src/net/ApiClient';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { TOKEN_KEY } from '../src/app/appConstants';
import { HeadlessAppViews } from './harness/HeadlessAppViews';

class MemStorage implements IStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

interface Harness { views: HeadlessAppViews; nav: Nav; goLobbyCalls(): number; }

/** Builds a real createShopNav() wired to a HeadlessAppViews, with just enough of AppCtx
 *  stubbed to exercise navigation (no PIXI, no network — matches shop.ts's actual usage). */
function buildShopNav(): Harness {
  const storage = new MemStorage();
  storage.setItem(TOKEN_KEY, 'test-token');
  const platform = { storage, iapKind: () => null } as unknown as IPlatform;
  const saveManager = new SaveManager({ store: new LocalSaveStore(storage) });

  const views = new HeadlessAppViews();
  const state: AppState = {
    inLobby: true, offlineMode: false, gatewayUrl: null, netSession: null,
    firstLobbyHandled: false, socialBadgeTotal: 0, achievementClaimable: false,
    shopCardClaimable: false, achievementReached: null,
  };

  let goLobbyCalls = 0;
  const nav = {} as Nav;
  nav.goLobby = () => { goLobbyCalls++; };

  const ctx: AppCtx = {
    platform,
    views,
    api: {} as ApiClient, // truthy — shop.ts only branches on !api, never calls its methods for pure navigation
    baseUrl: null,
    saveManager,
    replayStore: {} as AppCtx['replayStore'],
    featureFlags: null,
    state,
    nav,
    getNetSession: () => null,
    applyGatewayUrl: () => {},
    playerName: () => 'tester',
    avatarId: () => undefined,
    gateConsent: (next) => next(),
    resolvePvpDeck: () => [],
    keepReplay: (r) => r,
    resolveWorldShard: () => {},
  };

  Object.assign(nav, createShopNav(ctx));
  return { views, nav, goLobbyCalls: () => goLobbyCalls };
}

describe('createShopNav — group peer-tab back navigation', () => {
  it('Gacha opened directly (lobby shop icon, shopBack=goLobby): back returns straight to the origin, not the Shop screen', () => {
    const { views, nav, goLobbyCalls } = buildShopNav();
    nav.goGacha({ shopBack: () => nav.goLobby() });
    expect(views.screen).toBe('gacha');

    views.gacha!.onBack();
    expect(views.screen).toBe('gacha'); // must NOT flip to 'shop' — no Shop-screen detour
    expect(goLobbyCalls()).toBe(1);
  });

  it('Gacha opened as a Shop peer tab: back returns to the same origin the Shop screen would use, skipping Shop entirely', () => {
    const { views, nav } = buildShopNav();
    let originCalls = 0;
    nav.goShop(() => { originCalls++; });
    expect(views.screen).toBe('shop');

    views.shop!.openGacha();
    expect(views.screen).toBe('gacha');

    views.gacha!.onBack();
    expect(views.screen).toBe('gacha'); // onBack doesn't re-render Gacha itself; assert the origin fired instead of a Shop hop
    expect(originCalls).toBe(1);
  });

  it('BattlePass opened as a peer tab: back returns straight to the origin, not the Shop screen', () => {
    const { views, nav } = buildShopNav();
    let originCalls = 0;
    nav.goShop(() => { originCalls++; });
    views.shop!.openBattlePass?.();
    expect(views.screen).toBe('battlePass');

    views.battlePass!.onBack();
    expect(originCalls).toBe(1);
  });

  it('BattlePass opened standalone (no shopBack): back falls back to the lobby directly', () => {
    const { views, nav, goLobbyCalls } = buildShopNav();
    nav.goBattlePass();
    expect(views.screen).toBe('battlePass');

    views.battlePass!.onBack();
    expect(goLobbyCalls()).toBe(1);
  });
});
