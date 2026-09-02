// Network actions for the shop: initial item load, skin buy, promo redemption, coin recharge, and the
// generic monetization-deal runner. Each mutating action wraps the callback in a BusyTracker guard,
// surfaces a success/error toast, and re-renders. The economy is server-authoritative — every buy
// returns a fresh SaveData that the app adopts.
//
// ActionsPanel has no dependency on either tab (ShopPanel/CoinsPanel) — they depend on IT, calling
// its methods through the ActionHandlers interface below (2026-08-11: converted from the former
// `XMixin(Base)` inheritance chain to an independent class over `core`, per
// claudedocs/client-modules.md's split-form priority note).
import { t, TranslationKey } from '../../i18n';
import { withTimeout, TimeoutError } from '../../ui/busyTracker';
import { showToastMessage } from '../../net/log';
import type { ShopSceneCore, ShopActionResult } from './core';

export interface ActionHandlers {
  loadItems(): Promise<void>;
  onBuy(itemId: string, itemName: string): Promise<void>;
  onBuyBulk(itemId: string, itemName: string, qty: number): Promise<void>;
  onRedeem(): Promise<void>;
  onRecharge(tierId: string): Promise<void>;
  runDeal(action: () => Promise<ShopActionResult>, okKey: TranslationKey, itemName?: string): Promise<void>;
  runUnboundedDeal(action: () => Promise<ShopActionResult>, okKey: TranslationKey, itemName?: string): Promise<void>;
}

export class ActionsPanel implements ActionHandlers {
  constructor(private readonly core: ShopSceneCore) {}

  // ── Loading ───────────────────────────────────────────────────────────────

  async loadItems(): Promise<void> {
    const core = this.core;
    try {
      core.items = await core.cb.loadItems();
    } catch {
      // On load failure don't pretend the shop is empty: surface a clear error to the player (go back and re-enter to retry).
      core.items = [];
      showToastMessage(t('common.networkError'), 'error');
    }
    core.loading = false;
    core.render();
  }

  // ── Buy ───────────────────────────────────────────────────────────────────

  async onBuy(itemId: string, itemName: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.blurPromo();
    core.bt.start();
    core.render();
    try {
      const res = await withTimeout(core.cb.buy(itemId));
      if (res.ok) {
        showToastMessage(t('shop.boughtNamed', { name: itemName }), 'success');
        // Refresh the catalog so a material bundle's live dailyLimit/purchasedToday (ShopPanel
        // buildShopCards) reflects this purchase immediately, instead of only on the next scene open.
        await this.loadItems();
      } else {
        showToastMessage(t(res.key), 'error');
      }
    } catch (e) {
      showToastMessage(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.error'), 'error');
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  /**
   * Repeat-buy a re-buyable consumable `qty` times in one tap (e.g. the "×10" button next to a
   * material/item's normal Buy — bulk-buying enhance-protection stones one click at a time was the
   * reported friction). One `cb.buy(itemId, qty)` call — the server charges/delivers all `qty` units
   * atomically in a single request (2026-08-10: this used to fire `qty` sequential `cb.buy()` calls
   * under one busy-lock, which was functionally fine but meant a "×10" tap paid for 10 full network
   * round-trips end to end, visibly slower than every other single-shot shop action; see economy.ts
   * shopBuy). All-or-nothing, matching the button's own affordability gate (`canBuy10` already requires
   * `coins >= cost * qty` before it's even enabled): either all `qty` land or none do, no partial-bought
   * count to report.
   */
  async onBuyBulk(itemId: string, itemName: string, qty: number): Promise<void> {
    const core = this.core;
    if (core.bt.busy || qty < 1) return;
    core.blurPromo();
    core.bt.start();
    core.render();
    try {
      const res = await withTimeout(core.cb.buy(itemId, qty));
      if (res.ok) {
        showToastMessage(t('shop.boughtNamedQty', { name: itemName, qty }), 'success');
        await this.loadItems(); // refresh dailyLimit/purchasedToday + coin balance
      } else {
        showToastMessage(t(res.key), 'error');
      }
    } catch (e) {
      showToastMessage(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.error'), 'error');
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  // ── Promo redemption ──────────────────────────────────────────────────────

  async onRedeem(): Promise<void> {
    const core = this.core;
    if (core.bt.busy || !core.cb.redeemPromo) return;
    const code = core.promoCode.trim();
    if (!code) return;
    core.blurPromo();
    core.bt.start();
    core.render();
    try {
      const res = await withTimeout(core.cb.redeemPromo(code));
      if (res.ok) {
        core.promoCode = '';
        core.setPromoValue('');
        showToastMessage(t('shop.promoSuccess'), 'success');
      } else {
        showToastMessage(t(res.key), 'error');
      }
    } catch (e) {
      showToastMessage(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.promoError'), 'error');
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  // ── Recharge ─────────────────────────────────────────────────────────────

  async onRecharge(tierId: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy || !core.cb.rechargeCoins) return;
    core.blurPromo();
    core.bt.start();
    core.render();
    // No blanket withTimeout here (unlike buy/redeem): recharge opens a user-paced payment UI
    // (Paddle overlay / native store sheet) that may stay open for minutes. The callback bounds its
    // own network calls internally and always resolves with a result key, so the spinner still clears.
    try {
      const res = await core.cb.rechargeCoins(tierId);
      if (res.ok) showToastMessage(t('shop.rechargeSuccess'), 'success');
      else showToastMessage(t(res.key), 'error');
    } catch {
      showToastMessage(t('shop.rechargeError'), 'error');
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  // ── Monetization deals (monthly / year card, starter packs) ────────────────

  async runDeal(action: () => Promise<ShopActionResult>, okKey: TranslationKey, itemName?: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.blurPromo();
    core.bt.start();
    core.render();
    try {
      const res = await withTimeout(action());
      if (res.ok) showToastMessage(itemName ? t('shop.boughtNamed', { name: itemName }) : t(okKey), 'success');
      else showToastMessage(t(res.key), 'error');
    } catch (e) {
      showToastMessage(t(e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.error'), 'error');
    } finally {
      core.bt.stop();
      core.render();
    }
  }

  /**
   * Like runDeal, but without the blanket withTimeout (mirrors onRecharge's reasoning): monthly/year
   * card buys may open a user-paced Paddle overlay that stays open for minutes, which withTimeout would
   * kill. The callback bounds its own network calls internally and always resolves with a result key.
   */
  async runUnboundedDeal(action: () => Promise<ShopActionResult>, okKey: TranslationKey, itemName?: string): Promise<void> {
    const core = this.core;
    if (core.bt.busy) return;
    core.blurPromo();
    core.bt.start();
    core.render();
    try {
      const res = await action();
      if (res.ok) showToastMessage(itemName ? t('shop.boughtNamed', { name: itemName }) : t(okKey), 'success');
      else showToastMessage(t(res.key), 'error');
    } catch {
      showToastMessage(t('shop.error'), 'error');
    } finally {
      core.bt.stop();
      core.render();
    }
  }
}
