// IAP polling/purchase flow: real-money recharge, subscriptions, starter packs. The largest and
// most self-contained chunk of createShopNav — pure async polling logic over ctx.platform /
// ctx.saveManager / ctx.featureFlags, no calls into the nav functions (goShop/goGacha/…).
// Split out of createShopNav (see shop.ts).
import * as analytics from '../../../analytics';
import { ApiClient, ApiError } from '../../../net/ApiClient';
import type { ShopActionResult } from '../../../scenes/ShopScene';
import { withTimeout, TimeoutError } from '../../../ui/busyTracker';
import type { AppCtx } from '../../appCtx';
import { log } from '../../appConstants';
import { scheduleSubscriptionReminder } from '../../../platform/localReminders';
import type { SaveData } from '../../../game/meta/SaveData';

export interface ShopIap {
  doRechargeCoins(tierId: string, client: ApiClient, onConverted: () => void): Promise<ShopActionResult>;
  doBuySubscription(
    product: 'monthly_card' | 'year_card',
    buyWithReceipt: (platform: string, receipt: string) => Promise<{ save: SaveData }>,
    client: ApiClient,
    onConverted: () => void,
  ): Promise<ShopActionResult>;
  doBuyStarter(
    productId: 'starter_draw' | 'starter_growth',
    client: ApiClient,
    onConverted: () => void,
  ): Promise<ShopActionResult>;
}

export function createShopIap(ctx: AppCtx): ShopIap {
  const { saveManager, platform, featureFlags } = ctx;

  /** Poll the authoritative save until coins rise above `before` (Paddle webhook lag) or attempts run out (~10s). */
  async function pollForCoinIncrease(before: number): Promise<boolean> {
    const delays = [1000, 1500, 2000, 2500, 3000];
    for (const ms of delays) {
      await new Promise((r) => setTimeout(r, ms));
      // Bound each refresh so a hung request can't stall the poll (ApiClient has no fetch timeout of its own).
      try { await withTimeout(saveManager.refresh()); } catch { /* keep polling; transient / timed out */ }
      if (saveManager.get().wallet.coins > before) return true;
    }
    return false;
  }

  /** Poll the authoritative save until subscriptionExpiry rises above `before` (Paddle webhook lag), mirrors pollForCoinIncrease. */
  async function pollForSubscriptionIncrease(before: number): Promise<boolean> {
    const delays = [1000, 1500, 2000, 2500, 3000];
    for (const ms of delays) {
      await new Promise((r) => setTimeout(r, ms));
      try { await withTimeout(saveManager.refresh()); } catch { /* keep polling; transient / timed out */ }
      if ((saveManager.get().monetization?.subscriptionExpiry ?? 0) > before) return true;
    }
    return false;
  }

  /** Poll the authoritative save until `productId` appears in starterUsed (Paddle webhook lag), mirrors pollForCoinIncrease. */
  async function pollForStarterGrant(productId: string, before: string[]): Promise<boolean> {
    const delays = [1000, 1500, 2000, 2500, 3000];
    for (const ms of delays) {
      await new Promise((r) => setTimeout(r, ms));
      try { await withTimeout(saveManager.refresh()); } catch { /* keep polling; transient / timed out */ }
      const used = saveManager.get().monetization?.starterUsed ?? [];
      if (used.includes(productId) && !before.includes(productId)) return true;
    }
    return false;
  }

  /**
   * Real coin recharge (COMMERCIAL_DESIGN §IAP client). Branches on the platform store:
   * - native ('apple'/'google'): run the store purchase via the injected bridge → verify the
   *   receipt at /iap/verify → adopt the returned authoritative save synchronously.
   * - web ('paddle'): create a checkout transaction → open Paddle.js → on completion, poll the
   *   save briefly (coins are credited asynchronously by /paddle/webhook).
   *
   * Timeout policy: only the *network* calls are bounded by withTimeout — the payment UI
   * (openPaddleCheckout / nativeIapPurchase) is user-paced and left unbounded (a Paddle overlay
   * or a StoreKit sheet may sit open for minutes; the caller must NOT time it out). This is why
   * ShopScene.onRecharge no longer wraps this in a blanket timeout, unlike buy/redeem.
   * Returns a ShopActionResult toast key; never throws.
   */
  async function doRechargeCoins(
    tierId: string,
    client: ApiClient,
    onConverted: () => void,
  ): Promise<ShopActionResult> {
    const kind = platform.iapKind();
    try {
      if (kind === 'apple' || kind === 'google') {
        const { receipt } = await platform.nativeIapPurchase(tierId); // user-paced native store sheet — unbounded
        const { save } = await withTimeout(client.iapVerify(kind, receipt));
        saveManager.adoptServer(save);
        onConverted();
        analytics.track('iap_purchase', { tier: tierId, platform: kind });
        return { ok: true };
      }
      if (kind === 'paddle') {
        const token = featureFlags?.getPaddleClientToken() ?? null;
        if (!token) { log.warn('paddle recharge: client token unavailable (server NW_PADDLE_CLIENT_TOKEN unset?)'); return { ok: false, key: 'shop.rechargeError' }; }
        const { transactionId } = await withTimeout(client.paddleCheckout(tierId));
        const { completed } = await platform.openPaddleCheckout(transactionId, token); // user-paced overlay — unbounded
        if (!completed) return { ok: false, key: 'shop.rechargeCancelled' };
        onConverted();
        analytics.track('iap_purchase', { tier: tierId, platform: 'paddle' });
        // Webhook credits coins asynchronously — poll the authoritative save so the wallet reflects it.
        const before = saveManager.get().wallet.coins;
        const credited = await pollForCoinIncrease(before);
        return credited ? { ok: true } : { ok: false, key: 'shop.rechargePending' };
      }
      return { ok: false, key: 'shop.rechargeError' };
    } catch (e) {
      log.warn('recharge failed', { tier: tierId, kind, err: e instanceof Error ? e.message : String(e) });
      // A bounded network call timed out (checkout creation / verify) → network-timeout toast; else generic.
      return { ok: false, key: e instanceof TimeoutError ? 'common.networkTimeout' : 'shop.rechargeError' };
    }
  }

  /**
   * Buy the monthly/year card (GACHA_DESIGN §5), verified by real payment on every platform:
   * - native ('apple'/'google'): run the store purchase via the injected bridge → the receipt is sent
   *   to `buyWithReceipt` (POST /monthly-card/buy or /year-card/buy with platform+receipt), which the
   *   server verifies before granting (2026-07-27: closes a gap where these endpoints used to grant on
   *   a bare authenticated request with zero proof of payment).
   * - web ('paddle'): unchanged — checkout overlay → webhook grants server-side.
   * - anything else (WeChat/CrazyGames/unknown, iapKind()===null): no real payment channel is wired for
   *   these products yet (same reason the Coins tab is hidden there) — the nav layer doesn't expose
   *   buyMonthlyCard/buyYearCard at all when iapKind() is null (see createShopNav below), so this branch
   *   is defensive only.
   * Same unbounded-payment-UI timeout policy as doRechargeCoins: only the network legs are bounded.
   */
  async function doBuySubscription(
    product: 'monthly_card' | 'year_card',
    buyWithReceipt: (platform: string, receipt: string) => Promise<{ save: SaveData }>,
    client: ApiClient,
    onConverted: () => void,
  ): Promise<ShopActionResult> {
    const trackEvent = product === 'monthly_card' ? 'monthly_card_buy' : 'year_card_buy';
    const kind = platform.iapKind();
    if (kind === 'apple' || kind === 'google') {
      try {
        const { receipt } = await platform.nativeIapPurchase(product); // user-paced native store sheet — unbounded
        const { save } = await withTimeout(buyWithReceipt(kind, receipt));
        saveManager.adoptServer(save);
        onConverted();
        analytics.track(trackEvent, { platform: kind });
        void scheduleSubscriptionReminder(save.monetization?.subscriptionExpiry ?? 0);
        return { ok: true };
      } catch (e) {
        const key = e instanceof ApiError && e.code === 'ALREADY_ACTIVE' ? 'shop.cardActive' as const
          : e instanceof ApiError && e.code === 'INVALID_RECEIPT' ? 'shop.error' as const
          : e instanceof TimeoutError ? 'common.networkTimeout' as const : 'shop.error' as const;
        return { ok: false, key };
      }
    }
    if (kind !== 'paddle') return { ok: false, key: 'shop.error' };
    const token = featureFlags?.getPaddleClientToken() ?? null;
    if (!token) { log.warn('paddle subscription: client token unavailable (server NW_PADDLE_CLIENT_TOKEN unset?)'); return { ok: false, key: 'shop.error' }; }
    try {
      const { transactionId } = await withTimeout(client.paddleCheckout(product));
      const { completed } = await platform.openPaddleCheckout(transactionId, token); // user-paced overlay — unbounded
      if (!completed) return { ok: false, key: 'shop.rechargeCancelled' };
      onConverted();
      analytics.track(trackEvent, { platform: 'paddle' });
      // Webhook grants the subscription asynchronously — poll the authoritative save for the expiry bump.
      const before = saveManager.get().monetization?.subscriptionExpiry ?? 0;
      const granted = await pollForSubscriptionIncrease(before);
      if (granted) void scheduleSubscriptionReminder(saveManager.get().monetization?.subscriptionExpiry ?? 0);
      return granted ? { ok: true } : { ok: false, key: 'shop.monthlyPending' };
    } catch (e) {
      const key = e instanceof ApiError && e.code === 'ALREADY_ACTIVE' ? 'shop.cardActive' as const
        : e instanceof TimeoutError ? 'common.networkTimeout' as const : 'shop.error' as const;
      return { ok: false, key };
    }
  }

  /**
   * Buy a one-off starter pack (GACHA_DESIGN §6, ¥6/¥30 paid product), same real-payment gate as
   * doBuySubscription (2026-07-27: previously granted for free on any platform with `cost: 0`, no
   * purchase step at all).
   */
  async function doBuyStarter(
    productId: 'starter_draw' | 'starter_growth',
    client: ApiClient,
    onConverted: () => void,
  ): Promise<ShopActionResult> {
    const kind = platform.iapKind();
    if (kind === 'apple' || kind === 'google') {
      try {
        const { receipt } = await platform.nativeIapPurchase(productId); // user-paced native store sheet — unbounded
        const { save } = await withTimeout(client.starterBuy(productId, kind, receipt));
        saveManager.adoptServer(save);
        onConverted();
        analytics.track('starter_buy', { product_id: productId, platform: kind });
        return { ok: true };
      } catch (e) {
        const key = e instanceof ApiError && e.code === 'ALREADY_PURCHASED' ? 'shop.alreadyOwned' as const
          : e instanceof TimeoutError ? 'common.networkTimeout' as const : 'shop.error' as const;
        return { ok: false, key };
      }
    }
    if (kind !== 'paddle') return { ok: false, key: 'shop.error' };
    const token = featureFlags?.getPaddleClientToken() ?? null;
    if (!token) { log.warn('paddle starter: client token unavailable (server NW_PADDLE_CLIENT_TOKEN unset?)'); return { ok: false, key: 'shop.error' }; }
    try {
      const { transactionId } = await withTimeout(client.paddleCheckout(productId));
      const { completed } = await platform.openPaddleCheckout(transactionId, token); // user-paced overlay — unbounded
      if (!completed) return { ok: false, key: 'shop.rechargeCancelled' };
      onConverted();
      analytics.track('starter_buy', { product_id: productId, platform: 'paddle' });
      // Webhook grants the pack asynchronously (starterUsed + coins/items) — poll the authoritative save.
      const before = saveManager.get().monetization?.starterUsed ?? [];
      const granted = await pollForStarterGrant(productId, before);
      return granted ? { ok: true } : { ok: false, key: 'shop.monthlyPending' };
    } catch (e) {
      const key = e instanceof ApiError && e.code === 'ALREADY_PURCHASED' ? 'shop.alreadyOwned' as const
        : e instanceof TimeoutError ? 'common.networkTimeout' as const : 'shop.error' as const;
      return { ok: false, key };
    }
  }

  return { doRechargeCoins, doBuySubscription, doBuyStarter };
}
