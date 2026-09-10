// createShopNav's other two real-money paths — `rechargeCoins` (Coins) and `buyStarter` (starter
// packs) — plus the one rule all three share: StoreKit is told a transaction is done only after the
// SERVER says it granted (ADR-082, IOS_RELEASE.md §6).
//
// Why this file exists, in two parts:
//
//   1. `doRechargeCoins` and `doBuyStarter` had NO test of any kind. `shopNav-buySubscription.test.ts`
//      covers their sibling `doBuySubscription` with 12 cases, and the three read almost the same —
//      which is exactly why nobody noticed: reviewing the recharge path feels like re-reading a
//      tested one. They are not the same code, and the differences are where the money is (coin
//      polling vs expiry polling vs starterUsed polling, three different pending-toast keys, and
//      `starterBuy` taking the product id the grant is idempotent on).
//
//   2. The finish rule had no JS-side assertion at all. `iosStoreKit2.test.ts` reads the Swift source
//      and proves there is exactly one `.finish()` and that it sits in `handleFinish` — i.e. that
//      NATIVE never finishes on its own. It cannot prove the other half, because the decision is
//      ours: JS calls `window.NWBilling.finish(id)`, and whether it does so before or after the
//      grant is a line of TypeScript. Finishing early is the one failure here that cannot be
//      repaired by anything: StoreKit forgets the transaction, the customer has paid, the drain on
//      the next launch has nothing left to report, and no record of the debt exists anywhere.
//      `appleUnfinishedTransactions.test.ts` pins the same rule for the BACKLOG drain
//      ("leaves a transaction unfinished when the report fails"); these are the in-session purchases,
//      which is the path every first-time buyer actually takes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted so the module-level import in src/app/nav/shop/iap.ts resolves to it. `getNativeBilling`
// is here too because src/net/ApiClient pulls it in transitively; only `finishNativeTransaction` is
// under test.
const { finishNativeTransaction } = vi.hoisted(() => ({ finishNativeTransaction: vi.fn() }));
vi.mock('../src/platform/iap', () => ({
  finishNativeTransaction,
  getNativeBilling: () => null,
  getNativeReceiptReader: () => null,
  getNativePendingReader: () => null,
}));

import { createShopNav } from '../src/app/nav/shop';
import type { AppCtx, AppState, Nav } from '../src/app/appCtx';
import type { IPlatform, IStorage } from '../src/platform/IPlatform';
import { ApiError, type ApiClient } from '../src/net/ApiClient';
import type { FeatureFlags } from '../src/net/featureFlags';
import { SaveManager } from '../src/game/meta/SaveManager';
import { LocalSaveStore } from '../src/game/meta/SaveStore';
import { makeNewSave, type SaveData } from '../src/game/meta/SaveData';
import { TOKEN_KEY } from '../src/app/appConstants';
import { BUSY_TIMEOUT_MS } from '../src/ui/busyTracker';
import { HeadlessAppViews } from './harness/HeadlessAppViews';

class MemStorage implements IStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

/** A save the server would return after a successful grant: 500 coins and both starters used. */
function grantedSave(): SaveData {
  const s = makeNewSave();
  return {
    ...s,
    wallet: { ...s.wallet, coins: 500 },
    monetization: { fatePoints: 0, subscriptionExpiry: 0, starterUsed: ['starter_draw', 'starter_growth'] },
  };
}

interface HarnessOpts {
  iapKind: 'paddle' | 'apple' | 'google' | null;
  /** Reject every server grant call with this, instead of granting. */
  serverThrows?: unknown;
  /** Never settle the server grant call (for the withTimeout cases). */
  serverHangs?: boolean;
  nativeIapPurchase?: (productId: string, token?: string) => Promise<{ receipt: string }>;
  openPaddleCheckout?: (transactionId: string, token: string) => Promise<{ completed: boolean }>;
  paddleCheckout?: (id: string) => Promise<{ transactionId: string }>;
  /** No featureFlags at all → no Paddle client token, and no appAccountToken. */
  noFeatureFlags?: boolean;
  /** What the NEXT saveManager.refresh() should report (arms the Paddle webhook polls). */
  refreshAs?: SaveData;
}

/**
 * A real `createShopNav`, with the server calls faked and every interesting event appended to `log`
 * in the order it happened. The ordering is the point for the finish assertions: "finish was called"
 * and "finish was called after the grant" are different statements, and only the second one is the
 * rule.
 */
function buildShop(opts: HarnessOpts) {
  const log: string[] = [];
  const storage = new MemStorage();
  storage.setItem(TOKEN_KEY, 'test-token');

  let refreshed: SaveData | undefined;
  const grant = (name: string) => async (...args: unknown[]) => {
    log.push(`${name}:${args.filter((a) => typeof a === 'string').join(',')}`);
    if (opts.serverHangs) return new Promise<never>(() => {});
    if (opts.serverThrows) throw opts.serverThrows;
    return { save: grantedSave(), granted: 500, results: [] };
  };

  const fakeApi = {
    hasToken: () => true,
    getSave: async () => ({ save: refreshed ?? opts.refreshAs ?? makeNewSave() }),
    iapVerify: grant('iapVerify'),
    starterBuy: grant('starterBuy'),
    monthlyCardBuy: grant('monthlyCardBuy'),
    yearCardBuy: grant('yearCardBuy'),
    paddleCheckout: opts.paddleCheckout ?? (async (id: string) => { log.push(`paddleCheckout:${id}`); return { transactionId: 'txn_1' }; }),
  } as unknown as ApiClient;

  const platform = {
    storage,
    iapKind: () => opts.iapKind,
    nativeIapPurchase: opts.nativeIapPurchase ?? (async (productId: string) => { log.push(`purchase:${productId}`); return { receipt: `receipt-for-${productId}` }; }),
    openPaddleCheckout: opts.openPaddleCheckout ?? (async () => { log.push('overlay'); return { completed: true }; }),
  } as unknown as IPlatform;

  finishNativeTransaction.mockImplementation(async (id: string) => { log.push(`finish:${id}`); return true; });

  const saveManager = new SaveManager({ store: new LocalSaveStore(storage), api: fakeApi });
  const views = new HeadlessAppViews();
  const nav = {} as Nav;
  nav.goLobby = () => {};

  const state: AppState = {
    inLobby: true, offlineMode: false, gatewayUrl: null, netSession: null,
    firstLobbyHandled: false, socialBadgeTotal: 0, mailBadgeCount: 0, achievementClaimable: false,
    shopCardClaimable: false, achievementReached: null,
  };
  const ctx: AppCtx = {
    platform, views, api: fakeApi, baseUrl: null, saveManager,
    replayStore: {} as AppCtx['replayStore'],
    featureFlags: opts.noFeatureFlags ? null : ({
      getPaddleClientToken: () => 'ptok_test',
      getAppleAccountToken: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    } as unknown as FeatureFlags),
    state, nav,
    getNetSession: () => null, applyGatewayUrl: () => {}, playerName: () => 'tester',
    avatarId: () => undefined, gateConsent: (next) => next(), resolvePvpDeck: () => [],
    keepReplay: (r) => r, resolveWorldShard: () => {},
  };

  Object.assign(nav, createShopNav(ctx));
  nav.goShop();
  return { views, log, saveManager, armRefresh: (s: SaveData) => { refreshed = s; } };
}

/** Exhaust pollForCoinIncrease/pollForStarterGrant's delays: [1000, 1500, 2000, 2500, 3000]. */
const ALL_POLL_DELAYS = 1000 + 1500 + 2000 + 2500 + 3000 + 1000;

beforeEach(() => { finishNativeTransaction.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('rechargeCoins (doRechargeCoins) — native', () => {
  it('purchases, verifies the receipt, then adopts the coins the server reports', async () => {
    const { views, log, saveManager } = buildShop({ iapKind: 'apple' });
    expect(await views.shop!.rechargeCoins!('coins_60')).toEqual({ ok: true });
    expect(log).toEqual([
      'purchase:coins_60',
      'iapVerify:apple,receipt-for-coins_60',
      'finish:receipt-for-coins_60',
    ]);
    // The authoritative save is adopted, not merely trusted to arrive: /iap/verify grants
    // synchronously, unlike the Paddle path below.
    expect(saveManager.get().wallet.coins).toBe(500);
  });

  it('attaches the appAccountToken to the store purchase', async () => {
    // The token is how a StoreKit 2 purchase names our account; without it every later renewal
    // notification for that Apple Account is unroutable (IOS_RELEASE.md §6).
    let seen: string | undefined;
    const { views } = buildShop({
      iapKind: 'apple',
      nativeIapPurchase: async (_id, token) => { seen = token; return { receipt: 'r' }; },
    });
    await views.shop!.rechargeCoins!('coins_60');
    expect(seen).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });

  it('THE RULE: a receipt the server rejects is never finished', async () => {
    // The transaction stays with StoreKit, is redelivered on the next launch, and
    // appleUnfinishedTransactions.ts reports it again. That is the recoverable outcome; finishing
    // here would be money taken for coins nothing will ever grant.
    const { views, log } = buildShop({ iapKind: 'apple', serverThrows: new ApiError('INVALID_RECEIPT', 'no') });
    expect(await views.shop!.rechargeCoins!('coins_60')).toEqual({ ok: false, key: 'shop.rechargeError' });
    expect(log).toEqual(['purchase:coins_60', 'iapVerify:apple,receipt-for-coins_60']);
    expect(finishNativeTransaction).not.toHaveBeenCalled();
  });

  it('a cancelled store sheet reaches neither the server nor finish', async () => {
    const { views, log } = buildShop({
      iapKind: 'apple',
      nativeIapPurchase: async () => { throw new Error('user cancelled'); },
    });
    expect(await views.shop!.rechargeCoins!('coins_60')).toEqual({ ok: false, key: 'shop.rechargeError' });
    expect(log).toEqual([]);
    expect(finishNativeTransaction).not.toHaveBeenCalled();
  });

  it('a verify that times out reports the network, and finishes nothing', async () => {
    // withTimeout bounds the NETWORK leg only — the store sheet above is user-paced and unbounded.
    // A timeout is not a rejection: the grant may well have landed, so the transaction must stay
    // open for the drain to re-report.
    vi.useFakeTimers();
    const { views } = buildShop({ iapKind: 'apple', serverHangs: true });
    const pending = views.shop!.rechargeCoins!('coins_60');
    await vi.advanceTimersByTimeAsync(BUSY_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: false, key: 'common.networkTimeout' });
    expect(finishNativeTransaction).not.toHaveBeenCalled();
  });

  it('google is never finished — Play closes its own purchases', async () => {
    const { views, log } = buildShop({ iapKind: 'google' });
    expect(await views.shop!.rechargeCoins!('coins_60')).toEqual({ ok: true });
    expect(log).toEqual(['purchase:coins_60', 'iapVerify:google,receipt-for-coins_60']);
    expect(finishNativeTransaction).not.toHaveBeenCalled();
  });
});

describe('rechargeCoins (doRechargeCoins) — web / Paddle', () => {
  it('creates a checkout, opens the overlay, and resolves once the webhook credits the coins', async () => {
    vi.useFakeTimers();
    const { views, log, armRefresh } = buildShop({ iapKind: 'paddle' });
    armRefresh(grantedSave()); // the webhook has landed by the first poll tick
    const pending = views.shop!.rechargeCoins!('coins_60');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ ok: true });
    expect(log).toEqual(['paddleCheckout:coins_60', 'overlay']);
    expect(finishNativeTransaction).not.toHaveBeenCalled(); // nothing to finish off-store
  });

  it('reports rechargePending — not an error — when the webhook has not landed in ~10s', async () => {
    // The coins still arrive; the toast has to say "on its way", because "failed" invites the player
    // to buy the same tier a second time.
    vi.useFakeTimers();
    const { views } = buildShop({ iapKind: 'paddle' }); // refresh keeps reporting a fresh save: 0 coins
    const pending = views.shop!.rechargeCoins!('coins_60');
    await vi.advanceTimersByTimeAsync(ALL_POLL_DELAYS);
    expect(await pending).toEqual({ ok: false, key: 'shop.rechargePending' });
  });

  it('a dismissed overlay is cancelled, not failed', async () => {
    const { views } = buildShop({
      iapKind: 'paddle',
      openPaddleCheckout: async () => ({ completed: false }),
    });
    expect(await views.shop!.rechargeCoins!('coins_60')).toEqual({ ok: false, key: 'shop.rechargeCancelled' });
  });

  it('no Paddle client token: fails before creating a checkout', async () => {
    // NW_PADDLE_CLIENT_TOKEN unset on the server. Creating a transaction we then cannot open would
    // leave a dangling Paddle transaction per tap.
    const { views, log } = buildShop({ iapKind: 'paddle', noFeatureFlags: true });
    expect(await views.shop!.rechargeCoins!('coins_60')).toEqual({ ok: false, key: 'shop.rechargeError' });
    expect(log).toEqual([]);
  });

  it('a checkout creation that times out reports the network', async () => {
    vi.useFakeTimers();
    const { views } = buildShop({
      iapKind: 'paddle',
      paddleCheckout: () => new Promise<never>(() => {}),
    });
    const pending = views.shop!.rechargeCoins!('coins_60');
    await vi.advanceTimersByTimeAsync(BUSY_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: false, key: 'common.networkTimeout' });
  });
});

describe('buyStarter (doBuyStarter) — native', () => {
  it('purchases, sends the product id with the receipt, then finishes', async () => {
    const { views, log, saveManager } = buildShop({ iapKind: 'apple' });
    expect(await views.shop!.buyStarter!('starter_draw')).toEqual({ ok: true });
    expect(log).toEqual([
      'purchase:starter_draw',
      // The product id travels with the receipt: the grant is idempotent on it, and the two starter
      // packs are different products bought with the same call.
      'starterBuy:starter_draw,apple,receipt-for-starter_draw',
      'finish:receipt-for-starter_draw',
    ]);
    expect(saveManager.get().monetization?.starterUsed).toContain('starter_draw');
  });

  it('THE RULE: a rejected starter receipt is never finished', async () => {
    const { views } = buildShop({ iapKind: 'apple', serverThrows: new ApiError('INVALID_RECEIPT', 'no') });
    expect(await views.shop!.buyStarter!('starter_draw')).toEqual({ ok: false, key: 'shop.error' });
    expect(finishNativeTransaction).not.toHaveBeenCalled();
  });

  it('ALREADY_PURCHASED is left unfinished here, on purpose — the drain closes it', async () => {
    // Deliberately NOT symmetric with appleUnfinishedTransactions.ts, which DOES finish a starter the
    // account already owns ("that content was delivered"). Here the charge is fresh and unexplained:
    // Apple sold a non-consumable the server says is already owned. Leaving it open costs one
    // redelivery on the next launch, where the drain has the whole picture and can close it; finishing
    // it here would erase the only evidence that this happened at all.
    const { views } = buildShop({ iapKind: 'apple', serverThrows: new ApiError('ALREADY_PURCHASED', 'owned') });
    expect(await views.shop!.buyStarter!('starter_growth')).toEqual({ ok: false, key: 'shop.alreadyOwned' });
    expect(finishNativeTransaction).not.toHaveBeenCalled();
  });

  it('a timed-out grant reports the network and finishes nothing', async () => {
    vi.useFakeTimers();
    const { views } = buildShop({ iapKind: 'apple', serverHangs: true });
    const pending = views.shop!.buyStarter!('starter_draw');
    await vi.advanceTimersByTimeAsync(BUSY_TIMEOUT_MS + 1);
    expect(await pending).toEqual({ ok: false, key: 'common.networkTimeout' });
    expect(finishNativeTransaction).not.toHaveBeenCalled();
  });

  it('a cancelled store sheet never reaches the server', async () => {
    const { views, log } = buildShop({
      iapKind: 'apple',
      nativeIapPurchase: async () => { throw new Error('user cancelled'); },
    });
    expect(await views.shop!.buyStarter!('starter_draw')).toEqual({ ok: false, key: 'shop.error' });
    expect(log).toEqual([]);
  });
});

describe('buyStarter (doBuyStarter) — web / Paddle', () => {
  it('resolves once the webhook records the pack as used', async () => {
    vi.useFakeTimers();
    const { views, log, armRefresh } = buildShop({ iapKind: 'paddle' });
    armRefresh(grantedSave());
    const pending = views.shop!.buyStarter!('starter_draw');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ ok: true });
    expect(log).toEqual(['paddleCheckout:starter_draw', 'overlay']);
  });

  it('a pack the save ALREADY listed as used does not count as this purchase landing', async () => {
    // pollForStarterGrant checks `used.includes(id) && !before.includes(id)`. Without the second
    // half, any re-purchase of an owned pack would report success the instant it polled, off a grant
    // that happened weeks ago.
    vi.useFakeTimers();
    const { views, saveManager } = buildShop({ iapKind: 'paddle', refreshAs: grantedSave() });
    await saveManager.refresh(); // the pack is already in starterUsed before the purchase begins
    const pending = views.shop!.buyStarter!('starter_draw');
    await vi.advanceTimersByTimeAsync(ALL_POLL_DELAYS);
    expect(await pending).toEqual({ ok: false, key: 'shop.monthlyPending' });
  });

  it('a dismissed overlay is cancelled', async () => {
    const { views } = buildShop({
      iapKind: 'paddle',
      openPaddleCheckout: async () => ({ completed: false }),
    });
    expect(await views.shop!.buyStarter!('starter_draw')).toEqual({ ok: false, key: 'shop.rechargeCancelled' });
  });

  it('no Paddle client token: fails before creating a checkout', async () => {
    const { views, log } = buildShop({ iapKind: 'paddle', noFeatureFlags: true });
    expect(await views.shop!.buyStarter!('starter_draw')).toEqual({ ok: false, key: 'shop.error' });
    expect(log).toEqual([]);
  });
});

// The rule stated once per purchase surface, so adding a fourth product cannot quietly skip it.
describe('THE RULE across every purchase surface', () => {
  type ShopView = NonNullable<HeadlessAppViews['shop']>;
  const SURFACES = [
    ['rechargeCoins', (v: HeadlessAppViews) => v.shop!.rechargeCoins!('coins_60')],
    ['buyMonthlyCard', (v: HeadlessAppViews) => v.shop!.buyMonthlyCard!()],
    ['buyYearCard', (v: HeadlessAppViews) => v.shop!.buyYearCard!()],
    ['buyStarter', (v: HeadlessAppViews) => v.shop!.buyStarter!('starter_draw')],
  ] as const satisfies ReadonlyArray<readonly [keyof ShopView, (v: HeadlessAppViews) => unknown]>;

  it.each(SURFACES)('%s: finishes exactly once, and only after the grant', async (_name, run) => {
    const { views, log } = buildShop({ iapKind: 'apple' });
    await run(views);
    expect(finishNativeTransaction).toHaveBeenCalledTimes(1);
    const finishAt = log.findIndex((e) => e.startsWith('finish:'));
    const grantAt = log.findIndex((e) => /^(iapVerify|starterBuy|monthlyCardBuy|yearCardBuy):/.test(e));
    expect(grantAt).toBeGreaterThanOrEqual(0);
    expect(finishAt).toBeGreaterThan(grantAt);
  });

  it.each(SURFACES)('%s: finishes nothing when the server refuses', async (_name, run) => {
    const { views } = buildShop({ iapKind: 'apple', serverThrows: new ApiError('INVALID_RECEIPT', 'no') });
    await run(views);
    expect(finishNativeTransaction).not.toHaveBeenCalled();
  });

  it.each(SURFACES)('%s: is hidden entirely when the platform has no store (WeChat/CrazyGames)', (name) => {
    // ShopScene hides the button rather than offering one that always fails, so the callback must be
    // absent from the nav — not present-and-erroring. WeChat Pay is a TODO, and a buy button that
    // only ever toasts an error is worse than no tab.
    const { views } = buildShop({ iapKind: null });
    expect(views.shop![name]).toBeUndefined();
    // ...while the read-only monetization state stays available regardless of purchase capability.
    expect(views.shop!.getMonetization).toBeDefined();
  });
});
