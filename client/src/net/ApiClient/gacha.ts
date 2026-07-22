// Gacha pools/draws + monetized card products (GACHA_DESIGN, requires login token).
import type { SaveData } from '../../game/meta/SaveData';
import { type Constructor, type ApiClientBaseCtor } from './base';
import type { GachaOverflow, GachaPool, GachaResultEntry, RechargeReward } from './types';

export interface GachaApi {
  getGachaPools(): Promise<GachaPool[]>;
  gachaDraw(poolId: string, count: 1 | 10): Promise<{ save: SaveData; results: GachaResultEntry[]; overflow: GachaOverflow }>;
  redeemFate(itemId: string): Promise<{ save: SaveData; granted: string }>;
  monthlyCardBuy(): Promise<{ save: SaveData }>;
  yearCardBuy(): Promise<{ save: SaveData }>;
  monthlyCardClaim(): Promise<{ save: SaveData; claimed: number }>;
  starterBuy(productId: 'starter_draw' | 'starter_growth'): Promise<{ save: SaveData; results: GachaResultEntry[] }>;
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
    ): Promise<{ save: SaveData; results: GachaResultEntry[]; overflow: GachaOverflow }> {
      return this.post<{ save: SaveData; results: GachaResultEntry[]; overflow: GachaOverflow }>('/gacha/draw', {
        poolId,
        count,
      });
    }

    /** Redeem Fate Points for a chosen past-featured legendary (GACHA_DESIGN §7). Insufficient → ApiError('FATE_INSUFFICIENT'). */
    async redeemFate(itemId: string): Promise<{ save: SaveData; granted: string }> {
      return this.post<{ save: SaveData; granted: string }>('/fate/redeem', { itemId });
    }

    /** Buy the monthly card (GACHA_DESIGN §5). Single-slot → ApiError('ALREADY_ACTIVE') while a card is still running. */
    async monthlyCardBuy(): Promise<{ save: SaveData }> {
      return this.post<{ save: SaveData }>('/monthly-card/buy', {});
    }

    /** Buy the year card (GACHA_DESIGN §5): 365-day subscription. Single-slot → ApiError('ALREADY_ACTIVE') while a card is still running. */
    async yearCardBuy(): Promise<{ save: SaveData }> {
      return this.post<{ save: SaveData }>('/year-card/buy', {});
    }

    /** Claim the monthly card daily coins (once per UTC day; claimed=0 if inactive or already claimed). */
    async monthlyCardClaim(): Promise<{ save: SaveData; claimed: number }> {
      return this.post<{ save: SaveData; claimed: number }>('/monthly-card/claim', {});
    }

    /** Buy a one-off starter pack (GACHA_DESIGN §6). Already bought → ApiError('ALREADY_PURCHASED'). */
    async starterBuy(
      productId: 'starter_draw' | 'starter_growth',
    ): Promise<{ save: SaveData; results: GachaResultEntry[] }> {
      return this.post<{ save: SaveData; results: GachaResultEntry[] }>('/starter/buy', { productId });
    }

    async claimRechargeMilestone(tierId: number): Promise<{ save: SaveData; rewards: RechargeReward[] }> {
      return this.post<{ save: SaveData; rewards: RechargeReward[] }>('/recharge/claim', { tierId });
    }
  };
}
