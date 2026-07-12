// Regression coverage for the Shop/Gacha/BattlePass peer-tab red-dot wiring (LOBBY_IA_REDESIGN
// P1.5 §9): each screen's sidebar shows its sibling tabs, and a sibling with an unclaimed reward
// must show a badge dot regardless of which of the three screens the user is currently on.
// Found alongside the DailyScene sidebar-badge fix (2026-07-12): BattlePassScene's Shop tab, and
// both ShopScene's/GachaScene's BattlePass tab, built their HubTab entries without ever setting
// `badge`, so the group's monthly-card / battle-pass-level indicators only ever showed up via the
// lobby entry point, never on the in-group peer tab itself.
import { describe, it, expect } from 'vitest';
import { createShopNav } from '../src/app/nav/shop';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { IPlatform, IStorage } from '../src/platform/IPlatform';
import type { ApiClient } from '../src/net/ApiClient';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { makeNewSave } from '../src/game/meta/SaveData';
import type { SaveData } from '../src/game/meta/SaveData';
import { TOKEN_KEY } from '../src/app/appConstants';
import { HeadlessAppViews } from './harness/HeadlessAppViews';
import { BP_XP_PER_LEVEL } from '../src/game/balance/battlepassDefs';

class MemStorage implements IStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

interface Harness { views: HeadlessAppViews; nav: Nav; saveManager: SaveManager; }

/** Same construction as shopNav-backNavigation.test.ts — a real createShopNav() with just enough
 *  of AppCtx stubbed to exercise navigation + badge callbacks (no PIXI, no network). */
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

  const nav = {} as Nav;
  nav.goLobby = () => {};

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
  return { views, nav, saveManager };
}

const claimableMonetization: SaveData['monetization'] = {
  fatePoints: 0,
  subscriptionExpiry: Date.now() + 1000 * 60 * 60 * 24,
  subscriptionLastClaimDay: '2000-01-01', // long ago → today's claim still pending
  starterUsed: [],
};

const claimableBattlePass: SaveData['battlePass'] = {
  seasonNo: 1, xp: 0, level: 1, hasPass: false, claimedFree: [], claimedPaid: [],
};

const clearedBattlePass: SaveData['battlePass'] = {
  seasonNo: 1, xp: BP_XP_PER_LEVEL, level: 2, hasPass: false, claimedFree: [1, 2], claimedPaid: [],
};

describe('Shop/Gacha/BattlePass peer-tab badges', () => {
  it('goGacha: getShopBadge reflects an unclaimed monthly card', () => {
    const { views, nav, saveManager } = buildShopNav();
    saveManager.adoptServer({ ...makeNewSave(), monetization: claimableMonetization });
    nav.goGacha({ shopBack: () => {} });
    expect(views.gacha!.getShopBadge?.()).toBe(true);
  });

  it('goGacha: getShopBadge is false once the monthly card is claimed today', () => {
    const { views, nav, saveManager } = buildShopNav();
    const todayKey = new Date().toISOString().slice(0, 10);
    saveManager.adoptServer({
      ...makeNewSave(),
      monetization: { ...claimableMonetization, subscriptionLastClaimDay: todayKey },
    });
    nav.goGacha({ shopBack: () => {} });
    expect(views.gacha!.getShopBadge?.()).toBe(false);
  });

  it('goGacha: getBattlePassBadge reflects an unclaimed battle-pass level', () => {
    const { views, nav, saveManager } = buildShopNav();
    saveManager.adoptServer({ ...makeNewSave(), battlePass: claimableBattlePass });
    nav.goGacha({ shopBack: () => {} });
    expect(views.gacha!.getBattlePassBadge?.()).toBe(true);
  });

  it('goGacha: getBattlePassBadge is false once every reached level is claimed', () => {
    const { views, nav, saveManager } = buildShopNav();
    saveManager.adoptServer({ ...makeNewSave(), battlePass: clearedBattlePass });
    nav.goGacha({ shopBack: () => {} });
    expect(views.gacha!.getBattlePassBadge?.()).toBe(false);
  });

  it('goBattlePass: getShopBadge reflects an unclaimed monthly card (Shop peer tab, viewed from BattlePass)', () => {
    const { views, nav, saveManager } = buildShopNav();
    saveManager.adoptServer({ ...makeNewSave(), monetization: claimableMonetization });
    nav.goBattlePass({ shopBack: () => {} });
    expect(views.battlePass!.getShopBadge?.()).toBe(true);
  });

  it('goBattlePass: getShopBadge is false with no active card', () => {
    const { views, nav } = buildShopNav();
    nav.goBattlePass({ shopBack: () => {} });
    expect(views.battlePass!.getShopBadge?.()).toBe(false);
  });

  it('goShop: getBattlePassBadge reflects an unclaimed battle-pass level (BattlePass peer tab, viewed from Shop)', () => {
    const { views, nav, saveManager } = buildShopNav();
    saveManager.adoptServer({ ...makeNewSave(), battlePass: claimableBattlePass });
    nav.goShop();
    expect(views.shop!.getBattlePassBadge?.()).toBe(true);
  });

  it('goShop: getBattlePassBadge is false once fully claimed', () => {
    const { views, nav, saveManager } = buildShopNav();
    saveManager.adoptServer({ ...makeNewSave(), battlePass: clearedBattlePass });
    nav.goShop();
    expect(views.shop!.getBattlePassBadge?.()).toBe(false);
  });
});
