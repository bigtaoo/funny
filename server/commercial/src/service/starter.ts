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
import type { CommercialBaseCtor, Constructor, Result, WalletView } from './base';
import { walletView } from './base';
import { effectiveCoins, rechargeChannelOf, spendChannelOf } from '../spendChannel';

export interface StarterHandlers {
  starterBuy(args: {
    accountId: string;
    productId: string;
    orderId: string;
    /** The caller's VERIFIED recharge platform (verifyNonCoinReceipt) — mapped to a recharged-pool bucket
     * via rechargeChannelOf (ADR-020) for starter_growth's coins. Irrelevant for starter_draw (no coins). */
    rechargePlatform?: string;
    clientPlatform?: string;
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; results: GachaResultEntry[]; wallet: WalletView }>>;
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
      rechargePlatform?: string;
      clientPlatform?: string;
    }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; results: GachaResultEntry[]; wallet: WalletView }>> {
      if (args.productId !== PRODUCT_STARTER_DRAW && args.productId !== PRODUCT_STARTER_GROWTH) {
        return { ok: false, error: 'BAD_REQUEST' };
      }
      const displayChannel = spendChannelOf(args.clientPlatform);
      const existing = await this.cols.orders.findOne({ _id: args.orderId });
      if (existing) {
        const w = await this.cols.wallets.findOne({ _id: existing.accountId });
        return {
          ok: true,
          coinsAfter: effectiveCoins(w, displayChannel),
          subscriptionExpiry: w?.subscription?.expiry ?? 0,
          results: existing.result.results ?? [],
          wallet: walletView(w, args.clientPlatform),
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
        const coinsAfter = effectiveCoins(claimed, displayChannel);
        await this.cols.orders.insertOne({
          _id: args.orderId,
          accountId: args.accountId,
          kind: 'starter',
          cost: 0,
          status: 'charged', // meta delivers the pack items, then marks delivered
          coinsAfter,
          result: { results, poolId: 'standard' },
          ts: now,
        });
        return { ok: true, coinsAfter, subscriptionExpiry: claimed.subscription?.expiry ?? 0, results, wallet: walletView(claimed, args.clientPlatform) };
      }

      // starter_growth: coins + 7-day card (no items to deliver → order lands delivered). Real money (¥30) —
      // fund the caller's verified recharge channel (ADR-020), not the free pool.
      const growthChannel = args.rechargePlatform ? (rechargeChannelOf(args.rechargePlatform) ?? undefined) : undefined;
      const { coinsAfter, expiry, wallet } = await this.applySubscription(
        args.accountId,
        GROWTH_PACK_CARD_DAYS,
        GROWTH_PACK_COINS,
        now,
        {
          orderId: args.orderId,
          reason: 'starter_growth',
          channel: growthChannel,
          clientPlatform: args.clientPlatform,
        },
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
      return { ok: true, coinsAfter, subscriptionExpiry: expiry, results: [], wallet: walletView(wallet, args.clientPlatform, growthChannel) };
    }
  };
}
