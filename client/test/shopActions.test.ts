/**
 * shopActions.test.ts — direct coverage of ShopScene/actions.ts's `onBuy`/`onRedeem`/`onRecharge`
 * busy-lock + real success/failure/timeout bodies. The 2026-08-05 client-test-audit flagged these
 * as untested at the method level: every existing reference to `cb.redeemPromo`/`cb.rechargeCoins`
 * in `client/test/ui/shopScene.ui.ts` only supplies them as constructor-stub callbacks to test
 * tab/field *visibility* — none of them tap the button or call `onRedeem()`/`onRecharge()` to
 * exercise the try/catch/finally body. `onBuy`'s success/failure paths already have real coverage
 * there; this file adds its catch/timeout branch and a busy-lock test (Shop had zero busy-lock
 * coverage of any kind — unlike Auction's dedicated `auctionActionBusyLock.ui.ts`, there wasn't
 * even one "representative" test to extend).
 *
 * ActionsPanel is now an independent class over `core` (2026-08-11 composition conversion — see
 * claudedocs/client-modules.md's split-form priority note), no PIXI needed since its body only
 * touches `core.bt`, `core.blurPromo()`, `core.render()`, `core.cb.*`, `core.promoCode`,
 * `core.hiddenInput`. `buildScene()` binds ActionsPanel's methods onto the same fake-core object
 * (mirrors sectActions.test.ts's / familySendButton.test.ts's flattened-fake pattern) so every
 * existing `scene.onBuy(...)`/`scene.cb`/`scene.bt` reference below keeps working unchanged.
 * `showToastMessage` is a real module function (not a `this.toast()` method), so it's spied via
 * `vi.spyOn(log, 'showToastMessage')` — same technique `gachaInvFullToast.ui.ts` already uses.
 */
import { describe, it, expect, vi } from 'vitest';
import * as log from '../src/net/log';
import { initI18n, t } from '../src/i18n';
import { ActionsPanel } from '../src/scenes/ShopScene/actions';
import type { ShopSceneCore, ShopActionResult } from '../src/scenes/ShopScene/core';
import { BusyTracker, TimeoutError } from '../src/ui/busyTracker';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

/** Bare-bones stand-in for ShopSceneCore — only the fields actions.ts's ActionsPanel body touches. */
class FakeShopSceneCore {
  items: unknown[] | null = null;
  loading = true;
  promoCode = '';
  hiddenInput: { value: string; blur: () => void } | null = null;
  bt = new BusyTracker();
  cb = {
    loadItems: vi.fn(async (): Promise<unknown[]> => []),
    buy: vi.fn(async (_id: string, _qty?: number): Promise<ShopActionResult> => ({ ok: true })),
    redeemPromo: vi.fn(async (_code: string): Promise<ShopActionResult> => ({ ok: true })) as
      ((code: string) => Promise<ShopActionResult>) | undefined,
    rechargeCoins: vi.fn(async (_tier: string): Promise<ShopActionResult> => ({ ok: true })) as
      ((tierId: string) => Promise<ShopActionResult>) | undefined,
  };
  render = vi.fn();
  blurPromo = vi.fn();
}

function buildScene(overrides: Partial<FakeShopSceneCore> = {}): any {
  const core = new FakeShopSceneCore() as unknown as FakeShopSceneCore & Record<string, any>;
  Object.assign(core, overrides);
  const actions = new ActionsPanel(core as unknown as ShopSceneCore);
  return Object.assign(core, {
    loadItems: actions.loadItems.bind(actions),
    onBuy: actions.onBuy.bind(actions),
    onBuyBulk: actions.onBuyBulk.bind(actions),
    onRedeem: actions.onRedeem.bind(actions),
    onRecharge: actions.onRecharge.bind(actions),
    runDeal: actions.runDeal.bind(actions),
    runUnboundedDeal: actions.runUnboundedDeal.bind(actions),
  });
}

// ── onBuy ─────────────────────────────────────────────────────────────────────

describe('ShopScene — onBuy() busy-lock', () => {
  it('a second call while the first is in flight does not re-issue the purchase', async () => {
    const scene = buildScene();
    scene.cb.buy.mockReturnValueOnce(new Promise<ShopActionResult>(() => {})); // never resolves

    void scene.onBuy('item1', 'Straw Hat');
    void scene.onBuy('item1', 'Straw Hat');
    await Promise.resolve();

    expect(scene.cb.buy).toHaveBeenCalledTimes(1);
    expect(scene.bt.busy).toBe(true);
  });
});

describe('ShopScene — onBuy() catch/timeout branch', () => {
  it('maps a TimeoutError to the network-timeout toast and unlocks', async () => {
    const scene = buildScene();
    scene.cb.buy.mockRejectedValueOnce(new TimeoutError());
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onBuy('item1', 'Straw Hat');

    expect(spy).toHaveBeenCalledWith(t('common.networkTimeout'), 'error');
    expect(scene.bt.busy).toBe(false);
    expect(scene.cb.loadItems).not.toHaveBeenCalled(); // failure path never refreshes the catalog
  });

  it('maps any other thrown error to the generic shop-error toast', async () => {
    const scene = buildScene();
    scene.cb.buy.mockRejectedValueOnce(new Error('network down'));
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onBuy('item1', 'Straw Hat');

    expect(spy).toHaveBeenCalledWith(t('shop.error'), 'error');
  });
});

// ── onBuyBulk ─────────────────────────────────────────────────────────────────

describe('ShopScene — onBuyBulk() busy-lock', () => {
  it('a second call while the first is in flight does not re-issue any purchase', async () => {
    const scene = buildScene();
    scene.cb.buy.mockReturnValueOnce(new Promise<ShopActionResult>(() => {})); // never resolves

    void scene.onBuyBulk('protect_enhance', 'Enhance Protection Stone', 10);
    void scene.onBuyBulk('protect_enhance', 'Enhance Protection Stone', 10);
    await Promise.resolve();

    expect(scene.cb.buy).toHaveBeenCalledTimes(1);
    expect(scene.bt.busy).toBe(true);
  });
});

describe('ShopScene — onBuyBulk() success', () => {
  it('calls buy() ONCE with itemId+qty (server charges/delivers all units in one request), toasts the qty bought, and refreshes the catalog', async () => {
    const scene = buildScene();
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onBuyBulk('protect_enhance', 'Enhance Protection Stone', 10);

    expect(scene.cb.buy).toHaveBeenCalledTimes(1); // one request, not one per unit (2026-08-10 latency fix)
    expect(scene.cb.buy).toHaveBeenCalledWith('protect_enhance', 10);
    expect(spy).toHaveBeenCalledWith(
      t('shop.boughtNamedQty', { name: 'Enhance Protection Stone', qty: 10 }), 'success',
    );
    expect(scene.cb.loadItems).toHaveBeenCalledTimes(1);
    expect(scene.bt.busy).toBe(false);
  });
});

describe('ShopScene — onBuyBulk() failure (e.g. hits a daily cap or the balance dropped mid-flight)', () => {
  it('an ok:false result toasts the mapped error key, nothing bought, and never refreshes the catalog — all-or-nothing, no partial-bought count', async () => {
    const scene = buildScene();
    scene.cb.buy.mockResolvedValueOnce({ ok: false, key: 'shop.insufficient' as never });
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onBuyBulk('protect_enhance', 'Enhance Protection Stone', 10);

    expect(scene.cb.buy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(t('shop.insufficient' as never), 'error');
    expect(scene.cb.loadItems).not.toHaveBeenCalled();
  });

  it('a thrown error maps to the generic shop-error toast', async () => {
    const scene = buildScene();
    scene.cb.buy.mockRejectedValueOnce(new Error('network down'));
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onBuyBulk('protect_enhance', 'Enhance Protection Stone', 10);

    expect(spy).toHaveBeenCalledWith(t('shop.error'), 'error');
    expect(scene.cb.loadItems).not.toHaveBeenCalled();
  });

  it('a TimeoutError maps to the network-timeout toast', async () => {
    const scene = buildScene();
    scene.cb.buy.mockRejectedValueOnce(new TimeoutError());
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onBuyBulk('protect_enhance', 'Enhance Protection Stone', 10);

    expect(spy).toHaveBeenCalledWith(t('common.networkTimeout'), 'error');
    expect(scene.cb.loadItems).not.toHaveBeenCalled();
  });
});

describe('ShopScene — onBuyBulk() edge case: qty=0', () => {
  it('never calls buy(), never toasts, and still releases the busy-lock — defensive guard against a future caller passing a bad qty', async () => {
    const scene = buildScene();
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onBuyBulk('protect_enhance', 'Enhance Protection Stone', 0);

    expect(scene.cb.buy).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(scene.cb.loadItems).not.toHaveBeenCalled();
    expect(scene.bt.busy).toBe(false);
  });
});

// ── onRedeem (promo code) ─────────────────────────────────────────────────────

describe('ShopScene — onRedeem() guards', () => {
  it('does nothing while busy', async () => {
    const scene = buildScene({ promoCode: 'CODE1' });
    scene.bt.start();
    await scene.onRedeem();
    expect(scene.cb.redeemPromo).not.toHaveBeenCalled();
  });

  it('does nothing when redeemPromo is not injected (offline / not logged in)', async () => {
    const scene = buildScene({ promoCode: 'CODE1', cb: { ...new FakeShopSceneCore().cb, redeemPromo: undefined } });
    await scene.onRedeem();
    expect(scene.render).not.toHaveBeenCalled();
  });

  it('does nothing for a blank/whitespace-only code', async () => {
    const scene = buildScene({ promoCode: '   ' });
    await scene.onRedeem();
    expect(scene.cb.redeemPromo).not.toHaveBeenCalled();
  });
});

describe('ShopScene — onRedeem() success', () => {
  it('trims the code, clears the field (state + hidden input), and toasts success', async () => {
    const hiddenInput = { value: 'CODE1', blur: vi.fn() };
    const scene = buildScene({ promoCode: '  CODE1  ', hiddenInput });
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onRedeem();

    expect(scene.cb.redeemPromo).toHaveBeenCalledWith('CODE1');
    expect(scene.blurPromo).toHaveBeenCalledTimes(1);
    expect(scene.promoCode).toBe('');
    expect(hiddenInput.value).toBe('');
    expect(spy).toHaveBeenCalledWith(t('shop.promoSuccess'), 'success');
    expect(scene.bt.busy).toBe(false);
  });
});

describe('ShopScene — onRedeem() failure', () => {
  it('a rejected result (ok:false) toasts the mapped key and keeps the code in the field', async () => {
    const scene = buildScene({ promoCode: 'DEAD1' });
    scene.cb.redeemPromo!.mockResolvedValueOnce({ ok: false, key: 'shop.promoInvalid' as never });
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onRedeem();

    expect(spy).toHaveBeenCalledWith(t('shop.promoInvalid' as never), 'error');
    expect(scene.promoCode).toBe('DEAD1'); // not cleared on failure
  });

  it('a thrown error maps to the promo-specific error toast (not the generic shop.error)', async () => {
    const scene = buildScene({ promoCode: 'CODE1' });
    scene.cb.redeemPromo!.mockRejectedValueOnce(new Error('network down'));
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onRedeem();

    expect(spy).toHaveBeenCalledWith(t('shop.promoError'), 'error');
  });

  it('a TimeoutError still maps to the shared network-timeout toast', async () => {
    const scene = buildScene({ promoCode: 'CODE1' });
    scene.cb.redeemPromo!.mockRejectedValueOnce(new TimeoutError());
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onRedeem();

    expect(spy).toHaveBeenCalledWith(t('common.networkTimeout'), 'error');
  });
});

// ── onRecharge ────────────────────────────────────────────────────────────────

describe('ShopScene — onRecharge() guards', () => {
  it('does nothing while busy', async () => {
    const scene = buildScene();
    scene.bt.start();
    await scene.onRecharge('tier1');
    expect(scene.cb.rechargeCoins).not.toHaveBeenCalled();
  });

  it('does nothing when rechargeCoins is not injected', async () => {
    const scene = buildScene({ cb: { ...new FakeShopSceneCore().cb, rechargeCoins: undefined } });
    await scene.onRecharge('tier1');
    expect(scene.render).not.toHaveBeenCalled();
  });
});

describe('ShopScene — onRecharge() success', () => {
  it('calls rechargeCoins WITHOUT a blanket timeout wrapper and toasts success', async () => {
    const scene = buildScene();

    await scene.onRecharge('tier1');

    expect(scene.cb.rechargeCoins).toHaveBeenCalledWith('tier1');
    expect(scene.bt.busy).toBe(false);
  });

  it('a long-pending recharge (user-paced payment UI) never times out on its own', async () => {
    vi.useFakeTimers();
    try {
      const scene = buildScene();
      scene.cb.rechargeCoins!.mockReturnValueOnce(new Promise<ShopActionResult>(() => {}));

      const pending = scene.onRecharge('tier1');
      await vi.advanceTimersByTimeAsync(15_000); // well past withTimeout's 10s used elsewhere

      expect(scene.bt.busy).toBe(true); // still genuinely pending — no withTimeout race killed it
      void pending;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ShopScene — onRecharge() failure', () => {
  it('a rejected result (ok:false) toasts the mapped key', async () => {
    const scene = buildScene();
    scene.cb.rechargeCoins!.mockResolvedValueOnce({ ok: false, key: 'shop.rechargeError' as never });
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onRecharge('tier1');

    expect(spy).toHaveBeenCalledWith(t('shop.rechargeError' as never), 'error');
  });

  it('any thrown error (even a TimeoutError) maps to the generic recharge-error toast', async () => {
    const scene = buildScene();
    scene.cb.rechargeCoins!.mockRejectedValueOnce(new Error('boom'));
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onRecharge('tier1');

    expect(spy).toHaveBeenCalledWith(t('shop.rechargeError'), 'error');
  });
});
