// Integration coverage for goDaily()'s onSaveChanged wiring (see the 2026-08-09 DailyScene fix,
// design/game/RETENTION_DESIGN.md §10.9, sibling of test/ui/dailySceneSaveChanged.ui.ts).
// dailySceneSaveChanged.ui.ts proves DailyScene *itself* subscribes and re-renders correctly, but
// it hands the scene a hand-rolled mock `onSaveChanged` — it can't catch a mistake in the real
// production wiring (`onSaveChanged: (listener) => saveManager.subscribe(listener)` in shop.ts).
// This test exercises createShopNav() + a real SaveManager end to end, same harness style as
// shopNav-peerBadges.test.ts, so a broken/removed/misdirected wire-up here fails a test instead of
// only surfacing as "the red dot lied" in the field.
import { describe, it, expect } from 'vitest';
import { createShopNav } from '../src/app/nav/shop';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { IPlatform, IStorage } from '../src/platform/IPlatform';
import type { ApiClient } from '../src/net/ApiClient';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { makeNewSave } from '../src/game/meta/SaveData';
import { TOKEN_KEY } from '../src/app/appConstants';
import { HeadlessAppViews } from './harness/HeadlessAppViews';

class MemStorage implements IStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

interface Harness { views: HeadlessAppViews; nav: Nav; saveManager: SaveManager; }

/** Same construction as shopNav-peerBadges.test.ts, but with a `hasToken` stub — goDaily() (unlike
 *  goGacha/goBattlePass/goShop) unconditionally fires `saveManager.refresh()` on entry, and
 *  SaveManager.refresh() calls `this.api?.hasToken()` before anything else; a bare `{}` stub would
 *  throw synchronously inside that fire-and-forget call. `hasToken: () => false` makes refresh() a
 *  clean no-op (matches "offline/no real backend" in this harness), same as every other stubbed
 *  ApiClient method here. */
function buildShopNav(): Harness {
  const storage = new MemStorage();
  storage.setItem(TOKEN_KEY, 'test-token');
  const platform = { storage, iapKind: () => null, hasRewardedAd: () => false } as unknown as IPlatform;
  const saveManager = new SaveManager({ store: new LocalSaveStore(storage) });

  const views = new HeadlessAppViews();
  const state: AppState = {
    inLobby: true, offlineMode: false, gatewayUrl: null, netSession: null,
    firstLobbyHandled: false, socialBadgeTotal: 0, mailBadgeCount: 0, achievementClaimable: false,
    shopCardClaimable: false, achievementReached: null,
  };

  const nav = {} as Nav;
  nav.goLobby = () => {};

  const ctx: AppCtx = {
    platform,
    views,
    api: { hasToken: () => false } as unknown as ApiClient,
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

describe('goDaily() — onSaveChanged wiring (real SaveManager, not a mock)', () => {
  it('hands DailyScene a working onSaveChanged callback wired to saveManager.subscribe', () => {
    const { views, nav, saveManager } = buildShopNav();
    nav.goDaily();

    expect(views.daily?.onSaveChanged).toBeDefined();

    let fired = 0;
    const unsub = views.daily!.onSaveChanged!(() => { fired++; });
    expect(fired).toBe(0);

    // Any local save mutation (adoptServer/update/reconcile — the exact class of event goDaily()'s
    // own fire-and-forget saveManager.refresh() eventually triggers) must notify this listener.
    saveManager.adoptServer(makeNewSave());
    expect(fired).toBe(1);

    saveManager.update((draft) => { draft.wallet.coins += 1; });
    expect(fired).toBe(2);

    // The returned unsubscribe must actually detach — a leaked listener would keep firing after
    // the scene's own destroy() called it, same failure class as the input-subscription-leak audit.
    unsub();
    saveManager.adoptServer(makeNewSave());
    expect(fired).toBe(2);
  });

  it('goDaily() without a configured api leaves onSaveChanged unset (matches the offline early-return path)', () => {
    const { views, nav } = buildShopNav();
    // Simulate the `!api` branch (nav.goLobby() instead) by rebuilding with no api — mirrors the
    // guard at the top of goDaily(): `if (!api) { nav.goLobby(); return; }`.
    let wentToLobby = false;
    (nav as unknown as { goLobby: () => void }).goLobby = () => { wentToLobby = true; };
    // Re-create with api omitted to hit the early-return branch.
    const storage = new MemStorage();
    const platform = { storage, iapKind: () => null, hasRewardedAd: () => false } as unknown as IPlatform;
    const saveManager = new SaveManager({ store: new LocalSaveStore(storage) });
    const state: AppState = {
      inLobby: true, offlineMode: false, gatewayUrl: null, netSession: null,
      firstLobbyHandled: false, socialBadgeTotal: 0, mailBadgeCount: 0, achievementClaimable: false,
      shopCardClaimable: false, achievementReached: null,
    };
    const offlineNav = {} as Nav;
    offlineNav.goLobby = () => { wentToLobby = true; };
    const ctx: AppCtx = {
      platform, views: new HeadlessAppViews(), api: undefined, baseUrl: null, saveManager,
      replayStore: {} as AppCtx['replayStore'], featureFlags: null, state, nav: offlineNav,
      getNetSession: () => null, applyGatewayUrl: () => {}, playerName: () => 'tester',
      avatarId: () => undefined, gateConsent: (next) => next(), resolvePvpDeck: () => [],
      keepReplay: (r) => r, resolveWorldShard: () => {},
    };
    Object.assign(offlineNav, createShopNav(ctx));
    offlineNav.goDaily();

    expect(wentToLobby).toBe(true);
    expect(views.daily).toBeUndefined(); // never reached showDaily() at all
  });
});
