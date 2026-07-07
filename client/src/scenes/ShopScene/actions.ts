// Network actions for the shop: initial item load, skin buy, promo redemption, coin recharge, and the
// generic monetization-deal runner. Each mutating action wraps the callback in a BusyTracker guard,
// surfaces a success/error toast, and re-renders. The economy is server-authoritative — every buy
// returns a fresh SaveData that the app adopts.
import { t, TranslationKey } from '../../i18n';
import { ui as C } from '../../render/sketchUi';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import { type Constructor, type ShopSceneBaseCtor, type ShopActionResult } from './base';

export interface ActionHandlers {
  loadItems(): Promise<void>;
  onBuy(itemId: string): Promise<void>;
  onRedeem(): Promise<void>;
  onRecharge(tierId: string): Promise<void>;
  runDeal(action: () => Promise<ShopActionResult>, okKey: TranslationKey): Promise<void>;
}

export function ActionsMixin<TBase extends ShopSceneBaseCtor>(Base: TBase): TBase & Constructor<ActionHandlers> {
  return class extends Base {
    // ── Loading ───────────────────────────────────────────────────────────────

    async loadItems(): Promise<void> {
      try {
        this.items = await this.cb.loadItems();
      } catch {
        // On load failure don't pretend the shop is empty: surface a clear error to the player (go back and re-enter to retry).
        this.items = [];
        this.toast = { text: t('common.networkError'), color: C.red };
      }
      this.loading = false;
      this.render();
    }

    // ── Buy ───────────────────────────────────────────────────────────────────

    async onBuy(itemId: string): Promise<void> {
      if (this.bt.busy) return;
      this.blurPromo();
      this.bt.start();
      this.toast = null;
      this.render();
      try {
        const res = await withTimeout(this.cb.buy(itemId));
        this.toast = res.ok
          ? { text: t('shop.bought'), color: C.green }
          : { text: t(res.key), color: C.red };
      } catch (e) {
        this.toast = { text: t(e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.error'), color: C.red };
      } finally {
        this.bt.stop();
        this.render();
      }
    }

    // ── Promo redemption ──────────────────────────────────────────────────────

    async onRedeem(): Promise<void> {
      if (this.bt.busy || !this.cb.redeemPromo) return;
      const code = this.promoCode.trim();
      if (!code) return;
      this.blurPromo();
      this.bt.start();
      this.toast = null;
      this.render();
      try {
        const res = await withTimeout(this.cb.redeemPromo(code));
        if (res.ok) {
          this.promoCode = '';
          if (this.hiddenInput) this.hiddenInput.value = '';
          this.toast = { text: t('shop.promoSuccess'), color: C.green };
        } else {
          this.toast = { text: t(res.key), color: C.red };
        }
      } catch (e) {
        this.toast = { text: t(e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.promoError'), color: C.red };
      } finally {
        this.bt.stop();
        this.render();
      }
    }

    // ── Recharge ─────────────────────────────────────────────────────────────

    async onRecharge(tierId: string): Promise<void> {
      if (this.bt.busy || !this.cb.rechargeCoins) return;
      this.blurPromo();
      this.bt.start();
      this.toast = null;
      this.render();
      // No blanket withTimeout here (unlike buy/redeem): recharge opens a user-paced payment UI
      // (Paddle overlay / native store sheet) that may stay open for minutes. The callback bounds its
      // own network calls internally and always resolves with a result key, so the spinner still clears.
      try {
        const res = await this.cb.rechargeCoins(tierId);
        this.toast = res.ok
          ? { text: t('shop.rechargeSuccess'), color: C.green }
          : { text: t(res.key), color: C.red };
      } catch {
        this.toast = { text: t('shop.rechargeError'), color: C.red };
      } finally {
        this.bt.stop();
        this.render();
      }
    }

    // ── Monetization deals (monthly / year card, starter packs) ────────────────

    async runDeal(action: () => Promise<ShopActionResult>, okKey: TranslationKey): Promise<void> {
      if (this.bt.busy) return;
      this.blurPromo();
      this.bt.start();
      this.toast = null;
      this.render();
      try {
        const res = await withTimeout(action());
        this.toast = res.ok ? { text: t(okKey), color: C.green } : { text: t(res.key), color: C.red };
      } catch (e) {
        this.toast = { text: t(e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.error'), color: C.red };
      } finally {
        this.bt.stop();
        this.render();
      }
    }
  };
}
