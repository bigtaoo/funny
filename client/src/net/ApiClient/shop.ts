// Shop / ads / IAP / web recharge / promo (S2, requires login token).
import type { SaveData } from '../../game/meta/SaveData';
import { type Constructor, type ApiClientBaseCtor } from './base';
import type { ShopItem } from './types';

export interface ShopApi {
  getShopItems(): Promise<ShopItem[]>;
  shopBuy(itemId: string): Promise<{ save: SaveData; granted: string }>;
  adsReward(adToken: string): Promise<{ save: SaveData; granted: number }>;
  iapVerify(platform: string, receipt: string): Promise<{ save: SaveData; granted: number }>;
  paddleCheckout(tierId: string): Promise<{ transactionId: string }>;
  redeemPromoCode(code: string): Promise<{ save: SaveData; granted: number }>;
}

export function ShopMixin<TBase extends ApiClientBaseCtor>(Base: TBase): TBase & Constructor<ShopApi> {
  return class extends Base {
    // ── Economy: shop / ads / IAP (S2, requires login token) ────────────
    // All coin-spending actions return the server-authoritative SaveData (wallet/inventory as per server).
    // Insufficient balance → ApiError('INSUFFICIENT_FUNDS') (402); invalid receipt → ApiError('INVALID_RECEIPT') (400).

    /** Shop item list (catalog single source of truth is the server-side @nw/shared). */
    async getShopItems(): Promise<ShopItem[]> {
      const data = await this.request<{ items: ShopItem[] }>('GET', '/shop/items');
      return data.items;
    }

    /** Direct purchase: deduct coins → grant item → push back authoritative save. */
    async shopBuy(itemId: string): Promise<{ save: SaveData; granted: string }> {
      return this.post<{ save: SaveData; granted: string }>('/shop/buy', { itemId });
    }

    /** Ad reward (daily cap; cap exceeded → ApiError('DAILY_CAP_REACHED'), 429). */
    async adsReward(adToken: string): Promise<{ save: SaveData; granted: number }> {
      return this.post<{ save: SaveData; granted: number }>('/ads/reward', { adToken });
    }

    /**
     * IAP receipt verification (idempotent). Native app-store recharge: `platform` is
     * 'apple' / 'google' and `receipt` is the StoreKit / Play Billing receipt from the
     * native bridge; the server verifies it and returns the authoritative save.
     */
    async iapVerify(
      platform: string,
      receipt: string,
    ): Promise<{ save: SaveData; granted: number }> {
      return this.post<{ save: SaveData; granted: number }>('/iap/verify', { platform, receipt });
    }

    /**
     * Web recharge (Paddle): create a checkout transaction for a coin tier (e.g. 't499').
     * Returns the Paddle transactionId the client hands to Paddle.Checkout.open(); coins are
     * credited asynchronously by the /paddle/webhook. Unmapped tier → ApiError('INVALID_TIER');
     * Paddle not configured → ApiError('PADDLE_NOT_CONFIGURED').
     */
    async paddleCheckout(tierId: string): Promise<{ transactionId: string }> {
      return this.post<{ transactionId: string }>('/shop/paddle/checkout', { tierId });
    }

    /**
     * Promo code redemption (B-PROMO): validates code → credits coins → pushes back authoritative save.
     * Invalid/expired code → ApiError('PROMO_NOT_FOUND'); already used → ApiError('PROMO_ALREADY_USED').
     */
    async redeemPromoCode(code: string): Promise<{ save: SaveData; granted: number }> {
      return this.post<{ save: SaveData; granted: number }>('/promo/redeem', { code });
    }
  };
}
