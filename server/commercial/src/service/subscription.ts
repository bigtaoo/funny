// Monthly / year subscription card buys + daily claim (GACHA_DESIGN §5). The shared activation logic
// (applySubscription / subscriptionCardBuy) lives on CommercialServiceBase (also used by starterBuy's growth path).
import {
  MONTHLY_CARD_DAYS,
  MONTHLY_CARD_DAILY_COINS,
  MONTHLY_CARD_IMMEDIATE_COINS,
  YEAR_CARD_DAYS,
  YEAR_CARD_IMMEDIATE_COINS,
} from '@nw/shared';
import type { CommercialBaseCtor, Constructor, Result, WalletView } from './base';
import { walletView } from './base';
import { effectiveCoins, rechargeChannelOf, spendChannelOf } from '../spendChannel';

export interface SubscriptionHandlers {
  monthlyCardBuy(args: {
    accountId: string;
    orderId: string;
    /** The caller's VERIFIED recharge platform (apple/google/wechat from verifyNonCoinReceipt, or 'paddle'
     * from the webhook) — mapped to a recharged-pool bucket via rechargeChannelOf (ADR-020). Absent = free
     * pool (should not happen post the receipt-verify gate, but a safe default). */
    rechargePlatform?: string;
    clientPlatform?: string;
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; wallet: WalletView }>>;
  yearCardBuy(args: {
    accountId: string;
    orderId: string;
    rechargePlatform?: string;
    clientPlatform?: string;
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; wallet: WalletView }>>;
  monthlyCardClaim(args: {
    accountId: string;
    dayKey: string;
    clientPlatform?: string;
  }): Promise<Result<{ coinsAfter: number; claimed: number; subscriptionExpiry: number; wallet: WalletView }>>;
}

export function SubscriptionMixin<TBase extends CommercialBaseCtor>(
  Base: TBase,
): TBase & Constructor<SubscriptionHandlers> {
  return class extends Base {
    /** Activate the monthly card (GACHA_DESIGN §5): 30-day subscription + 600 immediate coins. */
    async monthlyCardBuy(args: {
      accountId: string;
      orderId: string;
      rechargePlatform?: string;
      clientPlatform?: string;
    }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; wallet: WalletView }>> {
      return this.subscriptionCardBuy({
        accountId: args.accountId,
        orderId: args.orderId,
        clientPlatform: args.clientPlatform,
        channel: args.rechargePlatform ? (rechargeChannelOf(args.rechargePlatform) ?? undefined) : undefined,
        days: MONTHLY_CARD_DAYS,
        immediateCoins: MONTHLY_CARD_IMMEDIATE_COINS,
      });
    }

    /** Activate the year card (GACHA_DESIGN §5): 365-day subscription + 600 immediate coins. Same daily claim as the monthly card. */
    async yearCardBuy(args: {
      accountId: string;
      orderId: string;
      rechargePlatform?: string;
      clientPlatform?: string;
    }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; wallet: WalletView }>> {
      return this.subscriptionCardBuy({
        accountId: args.accountId,
        orderId: args.orderId,
        clientPlatform: args.clientPlatform,
        channel: args.rechargePlatform ? (rechargeChannelOf(args.rechargePlatform) ?? undefined) : undefined,
        days: YEAR_CARD_DAYS,
        immediateCoins: YEAR_CARD_IMMEDIATE_COINS,
      });
    }

    /**
     * Claim the monthly card's daily coins (GACHA_DESIGN §5): +MONTHLY_CARD_DAILY_COINS, once per UTC day.
     * Atomically guarded on an active subscription (expiry > now) AND lastClaimDayKey !== dayKey. Always credits
     * the free `coins` pool (spendable everywhere) — this is a retention drip, not a real-money top-up.
     * Returns claimed:0 (no error) when there is no active card or it was already claimed today.
     */
    async monthlyCardClaim(args: {
      accountId: string;
      dayKey: string;
      clientPlatform?: string;
    }): Promise<Result<{ coinsAfter: number; claimed: number; subscriptionExpiry: number; wallet: WalletView }>> {
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
      const channel = spendChannelOf(args.clientPlatform);
      if (!res) {
        const w = await this.cols.wallets.findOne({ _id: args.accountId });
        return {
          ok: true,
          coinsAfter: effectiveCoins(w, channel),
          claimed: 0,
          subscriptionExpiry: w?.subscription?.expiry ?? 0,
          wallet: walletView(w, args.clientPlatform),
        };
      }
      const coinsAfter = effectiveCoins(res, channel);
      await this.cols.ledger.insertOne({
        accountId: args.accountId,
        delta: MONTHLY_CARD_DAILY_COINS,
        balanceAfter: coinsAfter,
        reason: 'monthly_card_daily',
        ts: now,
      });
      return {
        ok: true,
        coinsAfter,
        claimed: MONTHLY_CARD_DAILY_COINS,
        subscriptionExpiry: res.subscription?.expiry ?? 0,
        wallet: walletView(res, args.clientPlatform),
      };
    }
  };
}
