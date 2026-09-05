// Monthly / year subscription card buys + daily claim (GACHA_DESIGN §5). The shared activation logic
// (applySubscription / subscriptionCardBuy) lives on WalletCore (also used by starterBuy's growth path).
import {
  MONTHLY_CARD_DAYS,
  MONTHLY_CARD_DAILY_COINS,
  MONTHLY_CARD_IMMEDIATE_COINS,
  YEAR_CARD_DAYS,
  YEAR_CARD_IMMEDIATE_COINS,
} from '@nw/shared';
import type { Result, WalletView, WalletCore } from './base';
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
  subscriptionSyncApple(args: {
    accountId: string;
    receipt: string;
    clientPlatform?: string;
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; granted: number; wallet: WalletView }>>;
}

/**
 * Ceiling on how many receipt periods one sync applies. Apple keeps every renewal in the receipt
 * forever, so a five-year subscriber's receipt carries ~60 of them and all but the newest are
 * already-granted no-ops. Taking the newest N bounds the work per cold start without ever dropping an
 * ungranted period: a player would have to miss N consecutive renewals — five years of not opening
 * the app while still paying — to lose one, and the periods dropped in that case are ones that
 * expired long ago anyway.
 */
const MAX_SYNC_PERIODS = 60;

export class SubscriptionService {
  constructor(private readonly core: WalletCore) {}

  /** Activate the monthly card (GACHA_DESIGN §5): 30-day subscription + 600 immediate coins. */
    async monthlyCardBuy(args: {
      accountId: string;
      orderId: string;
      rechargePlatform?: string;
      clientPlatform?: string;
    }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; wallet: WalletView }>> {
      return this.core.subscriptionCardBuy({
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
      return this.core.subscriptionCardBuy({
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
      const now = this.core.now();
      await this.core.ensureWallet(args.accountId);
      const res = await this.core.cols.wallets.findOneAndUpdate(
        { _id: args.accountId, 'subscription.expiry': { $gt: now }, 'subscription.lastClaimDayKey': { $ne: args.dayKey } },
        {
          $inc: { coins: MONTHLY_CARD_DAILY_COINS, rev: 1 },
          $set: { 'subscription.lastClaimDayKey': args.dayKey, updatedAt: now },
        },
        { returnDocument: 'after' },
      );
      const channel = spendChannelOf(args.clientPlatform);
      if (!res) {
        const w = await this.core.cols.wallets.findOne({ _id: args.accountId });
        return {
          ok: true,
          coinsAfter: effectiveCoins(w, channel),
          claimed: 0,
          subscriptionExpiry: w?.subscription?.expiry ?? 0,
          wallet: walletView(w, args.clientPlatform),
        };
      }
      const coinsAfter = effectiveCoins(res, channel);
      await this.core.cols.ledger.insertOne({
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

    /**
     * Apply every not-yet-granted auto-renewable subscription period in an Apple receipt
     * (IOS_RELEASE.md §4.1b). The client calls this on cold start, so it is written to be a cheap
     * no-op in the overwhelmingly common case where there is nothing new.
     *
     * Why a sync exists at all: an auto-renewable subscription renews inside Apple's systems, with no
     * user action and no round trip through our client. StoreKit 1 surfaces those renewals as extra
     * transactions in the app receipt, so re-reading the receipt is how the server learns the player
     * paid again. Each period is granted under `apple:<transactionId>` — subscriptionCardBuy is
     * idempotent on orderId, which is what makes running this on every launch safe rather than a
     * monthly-card printing press.
     *
     * `renewal: true` is passed because a renewal by definition arrives while the current period is
     * still running (Apple bills ~a day early so the subscription never lapses); the single-slot gate
     * would otherwise reject money Apple has already taken. See subscriptionCardBuy's `renewal` doc.
     *
     * Returns `granted` = how many periods this call actually added, so the caller can skip the save
     * round trip when nothing changed. Fails closed to `granted: 0` when Apple is unconfigured or the
     * receipt is rejected — never an error the player sees, since this runs unprompted at boot.
     */
    async subscriptionSyncApple(args: {
      accountId: string;
      receipt: string;
      clientPlatform?: string;
    }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; granted: number; wallet: WalletView }>> {
      const read = this.core.verifyAppleSubscriptions;
      const periods = read ? await read(args.receipt).catch(() => []) : [];
      const recent = periods.slice(-MAX_SYNC_PERIODS);

      let granted = 0;
      let last: Result<{ coinsAfter: number; subscriptionExpiry: number; wallet: WalletView }> | null = null;
      for (const period of recent) {
        const before = (await this.core.cols.wallets.findOne({ _id: args.accountId }))?.subscription?.expiry ?? 0;
        const res = await this.core.subscriptionCardBuy({
          accountId: args.accountId,
          orderId: `apple:${period.transactionId}`,
          clientPlatform: args.clientPlatform,
          channel: 'apple',
          days: period.product === 'year_card' ? YEAR_CARD_DAYS : MONTHLY_CARD_DAYS,
          immediateCoins: period.product === 'year_card' ? YEAR_CARD_IMMEDIATE_COINS : MONTHLY_CARD_IMMEDIATE_COINS,
          renewal: true,
        });
        // A replay of an already-granted period returns ok with the wallet untouched; a real grant moves
        // the expiry. Comparing is how "granted" stays honest without subscriptionCardBuy having to
        // report new-vs-replay, which no other caller needs to know.
        if (res.ok) {
          if (res.subscriptionExpiry > before) granted += 1;
          last = res;
        }
      }

      if (last?.ok) {
        return {
          ok: true,
          coinsAfter: last.coinsAfter,
          subscriptionExpiry: last.subscriptionExpiry,
          granted,
          wallet: last.wallet,
        };
      }
      const w = await this.core.cols.wallets.findOne({ _id: args.accountId });
      return {
        ok: true,
        coinsAfter: effectiveCoins(w, spendChannelOf(args.clientPlatform)),
        subscriptionExpiry: w?.subscription?.expiry ?? 0,
        granted: 0,
        wallet: walletView(w, args.clientPlatform),
      };
    }
}
