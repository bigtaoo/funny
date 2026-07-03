// Starter pack buy (GACHA_DESIGN §6), once per account (starterUsed guard).
// The growth path reuses applySubscription on the base.
import {
  PRODUCT_STARTER_DRAW,
  PRODUCT_STARTER_GROWTH,
  STARTER_DRAW_COUNT,
  STARTER_DRAW_FLOOR,
  GROWTH_PACK_COINS,
  GROWTH_PACK_CARD_DAYS,
  findGachaPool,
} from '@nw/shared';
import type { GachaResultEntry } from '../db';
import { rollStarterPack } from '../gacha';
import type { CommercialBaseCtor, Constructor, Result } from './base';

export interface StarterHandlers {
  starterBuy(args: {
    accountId: string;
    productId: string;
    orderId: string;
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; results: GachaResultEntry[] }>>;
}

export function StarterMixin<TBase extends CommercialBaseCtor>(Base: TBase): TBase & Constructor<StarterHandlers> {
  return class extends Base {
    /**
     * Buy a starter pack (GACHA_DESIGN §6), once per account (starterUsed guard).
     *  • starter_draw: a rare+ floored 10-pull on the standard pool (independent of pity); meta delivers the items.
     *  • starter_growth: GROWTH_PACK_COINS + a GROWTH_PACK_CARD_DAYS-day monthly card.
     * The first-7-days eligibility window for the growth pack is enforced upstream by meta (account age).
     */
    async starterBuy(args: {
      accountId: string;
      productId: string;
      orderId: string;
    }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; results: GachaResultEntry[] }>> {
      if (args.productId !== PRODUCT_STARTER_DRAW && args.productId !== PRODUCT_STARTER_GROWTH) {
        return { ok: false, error: 'BAD_REQUEST' };
      }
      const existing = await this.cols.orders.findOne({ _id: args.orderId });
      if (existing) {
        const w = await this.cols.wallets.findOne({ _id: existing.accountId });
        return {
          ok: true,
          coinsAfter: w?.coins ?? 0,
          subscriptionExpiry: w?.subscription?.expiry ?? 0,
          results: existing.result.results ?? [],
        };
      }
      const now = this.now();
      await this.ensureWallet(args.accountId);
      // Once-per-account claim: atomically add the product to starterUsed only if not already present.
      const claimed = await this.cols.wallets.findOneAndUpdate(
        { _id: args.accountId, starterUsed: { $ne: args.productId } },
        { $addToSet: { starterUsed: args.productId }, $set: { updatedAt: now } },
        { returnDocument: 'after' },
      );
      if (!claimed) return { ok: false, error: 'ALREADY_PURCHASED' };

      if (args.productId === PRODUCT_STARTER_DRAW) {
        const std = findGachaPool('standard')!;
        const results = rollStarterPack(std, STARTER_DRAW_COUNT, STARTER_DRAW_FLOOR, this.rng);
        await this.cols.orders.insertOne({
          _id: args.orderId,
          accountId: args.accountId,
          kind: 'starter',
          cost: 0,
          status: 'charged', // meta delivers the pack items, then marks delivered
          coinsAfter: claimed.coins,
          result: { results, poolId: 'standard' },
          ts: now,
        });
        return { ok: true, coinsAfter: claimed.coins, subscriptionExpiry: claimed.subscription?.expiry ?? 0, results };
      }

      // starter_growth: coins + 7-day card (no items to deliver → order lands delivered).
      const { coinsAfter, expiry } = await this.applySubscription(
        args.accountId,
        GROWTH_PACK_CARD_DAYS,
        GROWTH_PACK_COINS,
        now,
        { orderId: args.orderId, reason: 'starter_growth' },
      );
      await this.cols.orders.insertOne({
        _id: args.orderId,
        accountId: args.accountId,
        kind: 'grant',
        cost: 0,
        status: 'delivered',
        coinsAfter,
        result: {},
        deliveredAt: now,
        ts: now,
      });
      return { ok: true, coinsAfter, subscriptionExpiry: expiry, results: [] };
    }
  };
}
