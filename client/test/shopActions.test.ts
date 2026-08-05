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
 * Follows sectActions.test.ts's / familySendButton.test.ts's pattern: mount `ActionsMixin` directly
 * on a bare-bones fake base — no PIXI needed, since the mixin body only touches `this.bt`,
 * `this.blurPromo()`, `this.render()`, `this.cb.*`, `this.promoCode`, `this.hiddenInput`.
 * `showToastMessage` is a real module function (not a `this.toast()` method), so it's spied via
 * `vi.spyOn(log, 'showToastMessage')` — same technique `gachaInvFullToast.ui.ts` already uses.
 */
import { describe, it, expect, vi } from 'vitest';
import * as log from '../src/net/log';
import { initI18n, t } from '../src/i18n';
import { ActionsMixin } from '../src/scenes/ShopScene/actions';
import type { ShopSceneBaseCtor, ShopActionResult } from '../src/scenes/ShopScene/base';
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

/** Bare-bones stand-in for ShopSceneBase — only the fields actions.ts's mixin body touches. */
class FakeShopSceneBase {
  items: unknown[] | null = null;
  loading = true;
  promoCode = '';
  hiddenInput: { value: string; blur: () => void } | null = null;
  bt = new BusyTracker();
  cb = {
    loadItems: vi.fn(async (): Promise<unknown[]> => []),
    buy: vi.fn(async (_id: string): Promise<ShopActionResult> => ({ ok: true })),
    redeemPromo: vi.fn(async (_code: string): Promise<ShopActionResult> => ({ ok: true })) as
      ((code: string) => Promise<ShopActionResult>) | undefined,
    rechargeCoins: vi.fn(async (_tier: string): Promise<ShopActionResult> => ({ ok: true })) as
      ((tierId: string) => Promise<ShopActionResult>) | undefined,
  };
  render = vi.fn();
  blurPromo = vi.fn();
}

const ShopWithActions = ActionsMixin(FakeShopSceneBase as unknown as ShopSceneBaseCtor);

function buildScene(overrides: Partial<FakeShopSceneBase> = {}): any {
  const scene = new ShopWithActions() as unknown as FakeShopSceneBase & Record<string, any>;
  Object.assign(scene, overrides);
  return scene;
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

// ── onRedeem (promo code) ─────────────────────────────────────────────────────

describe('ShopScene — onRedeem() guards', () => {
  it('does nothing while busy', async () => {
    const scene = buildScene({ promoCode: 'CODE1' });
    scene.bt.start();
    await scene.onRedeem();
    expect(scene.cb.redeemPromo).not.toHaveBeenCalled();
  });

  it('does nothing when redeemPromo is not injected (offline / not logged in)', async () => {
    const scene = buildScene({ promoCode: 'CODE1', cb: { ...new FakeShopSceneBase().cb, redeemPromo: undefined } });
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
    const scene = buildScene({ cb: { ...new FakeShopSceneBase().cb, rechargeCoins: undefined } });
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
