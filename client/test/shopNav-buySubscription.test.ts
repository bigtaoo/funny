// Regression/coverage for createShopNav's buyMonthlyCard/buyYearCard:
// - web (iapKind()==='paddle') runs a real Paddle checkout + poll for the save's subscriptionExpiry bump
//   (2026-07-25, COMMERCIAL_DESIGN.md §10.7) — mirrors doRechargeCoins/pollForCoinIncrease.
// - native (apple/google) runs the real store purchase via nativeIapPurchase() and sends the resulting
//   receipt to the server for verification (2026-07-27: previously granted on a bare authenticated
//   request with zero proof of payment, see COMMERCIAL_DESIGN §10.7 / GACHA_DESIGN §5).
// - WeChat/CrazyGames (iapKind()===null) never get buyMonthlyCard/buyYearCard exposed at all (no payment
//   channel wired for these products yet).
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
  /** paddleCheckout / monthlyCardBuy / yearCardBuy / nativeIapPurchase behavior for this test. */
  paddleCheckout?: (tierId: string) => Promise<{ transactionId: string }>;
  monthlyCardBuy?: (platform: string, receipt: string) => ReturnType<ApiClient['monthlyCardBuy']>;
  yearCardBuy?: (platform: string, receipt: string) => ReturnType<ApiClient['yearCardBuy']>;
  openPaddleCheckout?: (transactionId: string, token: string) => Promise<{ completed: boolean }>;
  nativeIapPurchase?: (tierId: string) => Promise<{ receipt: string }>;
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
    nativeIapPurchase: opts.nativeIapPurchase ?? (async () => ({ receipt: 'stub-receipt' })),
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
  describe('native platforms (apple/google): real store purchase + receipt verification', () => {
    it('apple: runs the native store purchase, sends the receipt to the server, no Paddle checkout involved', async () => {
      let nativeCalledWith: string | undefined;
      let serverCalledWith: { platform: string; receipt: string } | undefined;
      let checkoutCalled = false;
      const { views } = buildShopNav({
        iapKind: 'apple',
        nativeIapPurchase: async (tierId) => { nativeCalledWith = tierId; return { receipt: 'apple-receipt-123' }; },
        monthlyCardBuy: async (platform, receipt) => {
          serverCalledWith = { platform, receipt };
          return { save: { ...makeNewSave(), monetization: { fatePoints: 0, subscriptionExpiry: Date.now() + 30 * 86400000, starterUsed: [] } } };
        },
        paddleCheckout: async () => { checkoutCalled = true; return { transactionId: 'x' }; },
      });
      const res = await views.shop!.buyMonthlyCard!();
      expect(nativeCalledWith).toBe('monthly_card');
      expect(serverCalledWith).toEqual({ platform: 'apple', receipt: 'apple-receipt-123' });
      expect(checkoutCalled).toBe(false);
      expect(res.ok).toBe(true);
    });

    it('apple: ALREADY_ACTIVE from the server (after a valid receipt) maps to shop.cardActive', async () => {
      const { views } = buildShopNav({
        iapKind: 'apple',
        monthlyCardBuy: async () => { throw new ApiError('ALREADY_ACTIVE', 'active'); },
      });
      const res = await views.shop!.buyMonthlyCard!();
      expect(res).toEqual({ ok: false, key: 'shop.cardActive' });
    });

    it('apple: server rejects the receipt (INVALID_RECEIPT) → shop.error, subscription not adopted', async () => {
      const { views } = buildShopNav({
        iapKind: 'apple',
        monthlyCardBuy: async () => { throw new ApiError('INVALID_RECEIPT', 'receipt rejected'); },
      });
      const res = await views.shop!.buyMonthlyCard!();
      expect(res).toEqual({ ok: false, key: 'shop.error' });
    });

    it('apple: user cancels the native store sheet → shop.error, server never called', async () => {
      let serverCalled = false;
      const { views } = buildShopNav({
        iapKind: 'apple',
        nativeIapPurchase: async () => { throw new Error('user cancelled'); },
        monthlyCardBuy: async () => { serverCalled = true; return { save: makeNewSave() }; },
      });
      const res = await views.shop!.buyMonthlyCard!();
      expect(res).toEqual({ ok: false, key: 'shop.error' });
      expect(serverCalled).toBe(false);
    });
  });

  describe('WeChat/CrazyGames (iapKind === null): no payment channel wired, buy buttons not exposed', () => {
    it('buyMonthlyCard/buyYearCard/buyStarter are absent from the nav (ShopScene hides the buttons)', () => {
      const { views } = buildShopNav({ iapKind: null });
      expect(views.shop!.buyMonthlyCard).toBeUndefined();
      expect(views.shop!.buyYearCard).toBeUndefined();
      expect(views.shop!.buyStarter).toBeUndefined();
      // Read-only monetization state stays available regardless of purchase capability.
      expect(views.shop!.getMonetization).toBeDefined();
      expect(views.shop!.claimMonthlyCard).toBeDefined();
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
