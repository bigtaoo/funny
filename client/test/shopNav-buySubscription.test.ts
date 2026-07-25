// Regression/coverage for createShopNav's buyMonthlyCard/buyYearCard (2026-07-25, COMMERCIAL_DESIGN.md §10.7):
// on web (iapKind()==='paddle') these now run a real Paddle checkout + poll for the save's subscriptionExpiry
// bump, instead of granting immediately — mirrors doRechargeCoins/pollForCoinIncrease. Native/hidden-store
// platforms are unchanged (still call the direct grant endpoint).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createShopNav } from '../src/app/nav/shop';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { IPlatform, IStorage } from '../src/platform/IPlatform';
import { ApiError, type ApiClient } from '../src/net/ApiClient';
import type { FeatureFlags } from '../src/net/featureFlags';
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

interface FakeApiOpts {
  iapKind: 'paddle' | 'apple' | 'google' | null;
  /** paddleCheckout / monthlyCardBuy / yearCardBuy behavior for this test. */
  paddleCheckout?: (tierId: string) => Promise<{ transactionId: string }>;
  monthlyCardBuy?: () => ReturnType<ApiClient['monthlyCardBuy']>;
  yearCardBuy?: () => ReturnType<ApiClient['yearCardBuy']>;
  openPaddleCheckout?: (transactionId: string, token: string) => Promise<{ completed: boolean }>;
  /** subscriptionExpiry the save should report the NEXT time saveManager.refresh() is called (simulates the webhook having landed). */
  expiryAfterRefresh?: number;
}

/** Builds a real createShopNav() wired to a HeadlessAppViews, with just enough of AppCtx stubbed to
 *  exercise buyMonthlyCard/buyYearCard (mirrors shopNav-backNavigation.test.ts's harness). */
function buildShopNav(opts: FakeApiOpts) {
  const storage = new MemStorage();
  storage.setItem(TOKEN_KEY, 'test-token');

  let refreshedExpiry: number | undefined;
  const fakeApi = {
    hasToken: () => true,
    async getSave() {
      return { save: { ...makeNewSave(), monetization: { fatePoints: 0, subscriptionExpiry: refreshedExpiry ?? opts.expiryAfterRefresh ?? 0, starterUsed: [] } } };
    },
    monthlyCardBuy: opts.monthlyCardBuy ?? (async () => ({ save: makeNewSave() })),
    yearCardBuy: opts.yearCardBuy ?? (async () => ({ save: makeNewSave() })),
    paddleCheckout: opts.paddleCheckout ?? (async () => ({ transactionId: 'txn_test' })),
  } as unknown as ApiClient;

  const platform = {
    storage,
    iapKind: () => opts.iapKind,
    openPaddleCheckout: opts.openPaddleCheckout ?? (async () => ({ completed: true })),
  } as unknown as IPlatform;

  const saveManager = new SaveManager({ store: new LocalSaveStore(storage), api: fakeApi });
  // Arm the poll: the FIRST refresh() call after checkout "completes" reports the bumped expiry (simulates
  // the webhook having landed by the time the client's first poll tick fires).
  const armRefresh = (expiry: number) => { refreshedExpiry = expiry; };

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
    api: fakeApi,
    baseUrl: null,
    saveManager,
    replayStore: {} as AppCtx['replayStore'],
    featureFlags: { getPaddleClientToken: () => 'ptok_test' } as unknown as FeatureFlags,
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
  nav.goShop();
  return { views, armRefresh };
}

describe('createShopNav — buyMonthlyCard/buyYearCard', () => {
  describe('native/hidden-store platforms (iapKind !== paddle): unchanged direct-grant behavior', () => {
    it('apple: calls the direct grant endpoint, no Paddle checkout involved', async () => {
      let directCalled = false;
      const { views } = buildShopNav({
        iapKind: 'apple',
        monthlyCardBuy: async () => { directCalled = true; return { save: { ...makeNewSave(), monetization: { fatePoints: 0, subscriptionExpiry: Date.now() + 30 * 86400000, starterUsed: [] } } }; },
      });
      const res = await views.shop!.buyMonthlyCard!();
      expect(directCalled).toBe(true);
      expect(res.ok).toBe(true);
    });

    it('apple: ALREADY_ACTIVE from the direct endpoint maps to shop.cardActive', async () => {
      const { views } = buildShopNav({
        iapKind: 'apple',
        monthlyCardBuy: async () => { throw new ApiError('ALREADY_ACTIVE', 'active'); },
      });
      const res = await views.shop!.buyMonthlyCard!();
      expect(res).toEqual({ ok: false, key: 'shop.cardActive' });
    });
  });

  describe('web (iapKind === paddle): real checkout + poll', () => {
    it('missing Paddle client token → shop.error, checkout never called', async () => {
      let checkoutCalled = false;
      const storage = new MemStorage();
      storage.setItem(TOKEN_KEY, 'test-token');
      const fakeApi = {
        hasToken: () => true,
        getSave: async () => ({ save: makeNewSave() }),
        paddleCheckout: async () => { checkoutCalled = true; return { transactionId: 'x' }; },
      } as unknown as ApiClient;
      const platform = { storage, iapKind: () => 'paddle' as const, openPaddleCheckout: async () => ({ completed: true }) } as unknown as IPlatform;
      const saveManager = new SaveManager({ store: new LocalSaveStore(storage), api: fakeApi });
      const views = new HeadlessAppViews();
      const nav = {} as Nav;
      nav.goLobby = () => {};
      const ctx: AppCtx = {
        platform, views, api: fakeApi, baseUrl: null, saveManager,
        replayStore: {} as AppCtx['replayStore'],
        featureFlags: null, // no token available
        state: { inLobby: true, offlineMode: false, gatewayUrl: null, netSession: null, firstLobbyHandled: false, socialBadgeTotal: 0, mailBadgeCount: 0, achievementClaimable: false, shopCardClaimable: false, achievementReached: null },
        nav, getNetSession: () => null, applyGatewayUrl: () => {}, playerName: () => 'tester', avatarId: () => undefined,
        gateConsent: (next) => next(), resolvePvpDeck: () => [], keepReplay: (r) => r, resolveWorldShard: () => {},
      };
      Object.assign(nav, createShopNav(ctx));
      nav.goShop();

      const res = await views.shop!.buyMonthlyCard!();
      expect(res).toEqual({ ok: false, key: 'shop.error' });
      expect(checkoutCalled).toBe(false);
    });

    it('checkout rejects ALREADY_ACTIVE (pre-check on the server) → shop.cardActive, overlay never opened', async () => {
      let overlayOpened = false;
      const { views } = buildShopNav({
        iapKind: 'paddle',
        paddleCheckout: async () => { throw new ApiError('ALREADY_ACTIVE', 'active'); },
        openPaddleCheckout: async () => { overlayOpened = true; return { completed: true }; },
      });
      const res = await views.shop!.buyYearCard!();
      expect(res).toEqual({ ok: false, key: 'shop.cardActive' });
      expect(overlayOpened).toBe(false);
    });

    it('user dismisses the Paddle overlay → shop.rechargeCancelled', async () => {
      const { views } = buildShopNav({
        iapKind: 'paddle',
        openPaddleCheckout: async () => ({ completed: false }),
      });
      const res = await views.shop!.buyMonthlyCard!();
      expect(res).toEqual({ ok: false, key: 'shop.rechargeCancelled' });
    });

    it('successful checkout: polls the save and resolves ok once subscriptionExpiry bumps (webhook already landed by first poll tick)', async () => {
      vi.useFakeTimers();
      try {
        const newExpiry = Date.now() + 30 * 86400000;
        const { views, armRefresh } = buildShopNav({ iapKind: 'paddle' });
        armRefresh(newExpiry);

        const pending = views.shop!.buyMonthlyCard!();
        await vi.advanceTimersByTimeAsync(1000); // first poll tick (pollForSubscriptionIncrease's delays[0])
        const res = await pending;
        expect(res).toEqual({ ok: true });
      } finally {
        vi.useRealTimers();
      }
    });

    it('checkout succeeds but the webhook never lands within the poll window → shop.monthlyPending (not an error — card still arrives later)', async () => {
      vi.useFakeTimers();
      try {
        const { views } = buildShopNav({ iapKind: 'paddle' }); // expiryAfterRefresh defaults to 0 — never bumps
        const pending = views.shop!.buyMonthlyCard!();
        await vi.advanceTimersByTimeAsync(1000 + 1500 + 2000 + 2500 + 3000 + 1000); // exhaust all poll delays
        const res = await pending;
        expect(res).toEqual({ ok: false, key: 'shop.monthlyPending' });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
