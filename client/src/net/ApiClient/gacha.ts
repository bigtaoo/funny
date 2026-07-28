// Gacha pools/draws + monetized card products (GACHA_DESIGN, requires login token).
import type { CardInstance, EquipmentInstance, LeanSaveResponse, SaveData } from '../../game/meta/SaveData';
import { type Constructor, type ApiClientBaseCtor } from './base';
import type { GachaOverflow, GachaPool, GachaResultEntry, RechargeReward } from './types';

export interface GachaApi {
  getGachaPools(): Promise<GachaPool[]>;
  /**
   * Lean response (2026-07-28, EQUIPMENT_DESIGN §3.3-style phase 2): `save.cardInv`/`equipmentInv` are
   * always `null` — nothing stops a player mashing "draw" back to back, so this is the highest-frequency
   * card/equipment-granting endpoint and skips the full-inventory join + transfer on every call.
   * `cardGrants`/`equipmentGrants` carry the instances this draw actually added (never the mailed-overflow
   * ones — see `overflow`). Adopt via `SaveManager.adoptServerPartial`, never the plain `adoptServer`.
   */
  gachaDraw(poolId: string, count: 1 | 10): Promise<{
    save: LeanSaveResponse; results: GachaResultEntry[]; overflow: GachaOverflow;
    cardGrants: CardInstance[]; equipmentGrants: EquipmentInstance[];
  }>;
  redeemFate(itemId: string): Promise<{ save: SaveData; granted: string }>;
  monthlyCardBuy(platform: string, receipt: string): Promise<{ save: SaveData }>;
  yearCardBuy(platform: string, receipt: string): Promise<{ save: SaveData }>;
  monthlyCardClaim(): Promise<{ save: SaveData; claimed: number }>;
  starterBuy(
    productId: 'starter_draw' | 'starter_growth',
    platform: string,
    receipt: string,
  ): Promise<{ save: SaveData; results: GachaResultEntry[] }>;
  /** Claim a cumulative-recharge milestone reward (GACHA_DESIGN §13). Not yet reached → ApiError('BAD_REQUEST'); already claimed → ApiError('ALREADY_CLAIMED'). */
  claimRechargeMilestone(tierId: number): Promise<{ save: SaveData; rewards: RechargeReward[] }>;
}

export function GachaMixin<TBase extends ApiClientBaseCtor>(Base: TBase): TBase & Constructor<GachaApi> {
  return class extends Base {
    /** Gacha pool list (includes expanded entries for display). */
    async getGachaPools(): Promise<GachaPool[]> {
      const data = await this.request<{ pools: GachaPool[] }>('GET', '/gacha/pools');
      return data.pools;
    }

    /** Gacha draw (single / x10, atomic, each result persisted individually). */
    async gachaDraw(
      poolId: string,
      count: 1 | 10,
    ): Promise<{
      save: LeanSaveResponse; results: GachaResultEntry[]; overflow: GachaOverflow;
      cardGrants: CardInstance[]; equipmentGrants: EquipmentInstance[];
    }> {
      return this.post<{
        save: LeanSaveResponse; results: GachaResultEntry[]; overflow: GachaOverflow;
        cardGrants: CardInstance[]; equipmentGrants: EquipmentInstance[];
      }>('/gacha/draw', { poolId, count });
    }

    /** Redeem Fate Points for a chosen past-featured legendary (GACHA_DESIGN §7). Insufficient → ApiError('FATE_INSUFFICIENT'). */
    async redeemFate(itemId: string): Promise<{ save: SaveData; granted: string }> {
      return this.post<{ save: SaveData; granted: string }>('/fate/redeem', { itemId });
    }

    /**
     * Buy the monthly card (GACHA_DESIGN §5), verified against a real store receipt (`platform`/`receipt`,
     * same shape as `iapVerify` — see doBuySubscription in app/nav/shop.ts; never called for Paddle, which
     * grants via webhook). Single-slot → ApiError('ALREADY_ACTIVE') while a card is still running;
     * bad/mismatched receipt → ApiError('INVALID_RECEIPT').
     */
    async monthlyCardBuy(platform: string, receipt: string): Promise<{ save: SaveData }> {
      return this.post<{ save: SaveData }>('/monthly-card/buy', { platform, receipt });
    }

    /** Buy the year card (GACHA_DESIGN §5): 365-day subscription. Same receipt gate as monthlyCardBuy. */
    async yearCardBuy(platform: string, receipt: string): Promise<{ save: SaveData }> {
      return this.post<{ save: SaveData }>('/year-card/buy', { platform, receipt });
    }

    /** Claim the monthly card daily coins (once per UTC day; claimed=0 if inactive or already claimed). */
    async monthlyCardClaim(): Promise<{ save: SaveData; claimed: number }> {
      return this.post<{ save: SaveData; claimed: number }>('/monthly-card/claim', {});
    }

    /**
     * Buy a one-off starter pack (GACHA_DESIGN §6, ¥6/¥30 paid product), verified against a real store
     * receipt (same shape as monthlyCardBuy). Already bought → ApiError('ALREADY_PURCHASED'); bad/mismatched
     * receipt → ApiError('INVALID_RECEIPT').
     */
    async starterBuy(
      productId: 'starter_draw' | 'starter_growth',
      platform: string,
      receipt: string,
    ): Promise<{ save: SaveData; results: GachaResultEntry[] }> {
      return this.post<{ save: SaveData; results: GachaResultEntry[] }>('/starter/buy', { productId, platform, receipt });
    }

    async claimRechargeMilestone(tierId: number): Promise<{ save: SaveData; rewards: RechargeReward[] }> {
      return this.post<{ save: SaveData; rewards: RechargeReward[] }>('/recharge/claim', { tierId });
    }
  };
}
