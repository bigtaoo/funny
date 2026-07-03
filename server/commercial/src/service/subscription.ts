// Monthly / year subscription card buys + daily claim (GACHA_DESIGN §5). The shared activation logic
// (applySubscription / subscriptionCardBuy) lives on CommercialServiceBase (also used by starterBuy's growth path).
import {
  MONTHLY_CARD_DAYS,
  MONTHLY_CARD_DAILY_COINS,
  MONTHLY_CARD_IMMEDIATE_COINS,
  YEAR_CARD_DAYS,
  YEAR_CARD_IMMEDIATE_COINS,
} from '@nw/shared';
import type { CommercialBaseCtor, Constructor, Result } from './base';

export interface SubscriptionHandlers {
  monthlyCardBuy(args: {
    accountId: string;
    orderId: string;
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number }>>;
  yearCardBuy(args: {
    accountId: string;
    orderId: string;
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number }>>;
  monthlyCardClaim(args: {
    accountId: string;
    dayKey: string;
  }): Promise<Result<{ coinsAfter: number; claimed: number; subscriptionExpiry: number }>>;
}

export function SubscriptionMixin<TBase extends CommercialBaseCtor>(
  Base: TBase,
): TBase & Constructor<SubscriptionHandlers> {
  return class extends Base {
    /** Activate the monthly card (GACHA_DESIGN §5): 30-day subscription + 600 immediate coins. */
    async monthlyCardBuy(args: {
      accountId: string;
      orderId: string;
    }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number }>> {
      return this.subscriptionCardBuy({ ...args, days: MONTHLY_CARD_DAYS, immediateCoins: MONTHLY_CARD_IMMEDIATE_COINS });
    }

    /** Activate the year card (GACHA_DESIGN §5): 365-day subscription + 600 immediate coins. Same daily claim as the monthly card. */
    async yearCardBuy(args: {
      accountId: string;
      orderId: string;
    }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number }>> {
      return this.subscriptionCardBuy({ ...args, days: YEAR_CARD_DAYS, immediateCoins: YEAR_CARD_IMMEDIATE_COINS });
    }

    /**
     * Claim the monthly card's daily coins (GACHA_DESIGN §5): +MONTHLY_CARD_DAILY_COINS, once per UTC day.
     * Atomically guarded on an active subscription (expiry > now) AND lastClaimDayKey !== dayKey.
     * Returns claimed:0 (no error) when there is no active card or it was already claimed today.
     */
    async monthlyCardClaim(args: {
      accountId: string;
      dayKey: string;
    }): Promise<Result<{ coinsAfter: number; claimed: number; subscriptionExpiry: number }>> {
      const now = this.now();
      await this.ensureWallet(args.accountId);
      const res = await this.cols.wallets.findOneAndUpdate(
        { _id: args.accountId, 'subscription.expiry': { $gt: now }, 'subscription.lastClaimDayKey': { $ne: args.dayKey } },
        {
          $inc: { coins: MONTHLY_CARD_DAILY_COINS, rev: 1 },
          $set: { 'subscription.lastClaimDayKey': args.dayKey, updatedAt: now },
        },
        { returnDocument: 'after' },
      );
      if (!res) {
        const w = await this.cols.wallets.findOne({ _id: args.accountId });
        return { ok: true, coinsAfter: w?.coins ?? 0, claimed: 0, subscriptionExpiry: w?.subscription?.expiry ?? 0 };
      }
      await this.cols.ledger.insertOne({
        accountId: args.accountId,
        delta: MONTHLY_CARD_DAILY_COINS,
        balanceAfter: res.coins,
        reason: 'monthly_card_daily',
        ts: now,
      });
      return { ok: true, coinsAfter: res.coins, claimed: MONTHLY_CARD_DAILY_COINS, subscriptionExpiry: res.subscription?.expiry ?? 0 };
    }
  };
}
