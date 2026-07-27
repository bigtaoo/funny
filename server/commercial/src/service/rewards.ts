// Ad reward + tiered victory coin credit (§2.3b). victoryCredit authoritatively enforces the daily win cap.
import { VICTORY_DAILY_WIN_CAP, bumpCappedCounter } from '@nw/shared';
import type { CommercialBaseCtor, Constructor, Result } from './base';
import { effectiveCoins, spendChannelOf } from '../spendChannel';

export interface RewardsHandlers {
  adsCredit(args: {
    accountId: string;
    amount: number;
    dayKey: string;
    clientPlatform?: string;
  }): Promise<Result<{ coinsAfter: number }>>;
  victoryCredit(args: {
    accountId: string;
    amount: number;
    dayKey: string;
    clientPlatform?: string;
  }): Promise<Result<{ coinsAfter: number; credited: number; capped: boolean }>>;
}

export function RewardsMixin<TBase extends CommercialBaseCtor>(Base: TBase): TBase & Constructor<RewardsHandlers> {
  return class extends Base {
    /** Ad reward coin credit (meta has already validated the ad proof + daily cap; commercial only credits coins and records the ledger entry). */
    async adsCredit(args: {
      accountId: string;
      amount: number;
      dayKey: string;
      clientPlatform?: string;
    }): Promise<Result<{ coinsAfter: number }>> {
      const amount = Math.max(0, Math.floor(args.amount));
      if (amount === 0) return { ok: false, error: 'BAD_REQUEST' };
      const coinsAfter = await this.credit(args.accountId, amount, 'ads', { clientPlatform: args.clientPlatform });
      return { ok: true, coinsAfter };
    }

    /**
     * Tiered victory coin credit (§2.3b). meta computes amount (by rank tier) + dayKey; commercial **authoritatively enforces
     * the daily win cap** here: atomically guards the daily counter < VICTORY_DAILY_WIN_CAP before claiming a slot and crediting,
     * returning capped=true without granting when the limit is reached (the win is still recorded in saves.pvp; coins are not issued).
     * Redis-backed (2026-07-27, moved off Mongo's victoryDaily — see shared/src/dailyCounter.ts for the design).
     */
    async victoryCredit(args: {
      accountId: string;
      amount: number;
      dayKey: string;
      clientPlatform?: string;
    }): Promise<Result<{ coinsAfter: number; credited: number; capped: boolean }>> {
      const amount = Math.max(0, Math.floor(args.amount));
      if (amount === 0) return { ok: false, error: 'BAD_REQUEST' };

      const allowed = await bumpCappedCounter(this.redis, 'victoryDaily', args.accountId, args.dayKey, 'wins', VICTORY_DAILY_WIN_CAP);
      if (!allowed) {
        // Daily cap reached: do not credit coins.
        const w = await this.cols.wallets.findOne({ _id: args.accountId });
        return { ok: true, coinsAfter: effectiveCoins(w, spendChannelOf(args.clientPlatform)), credited: 0, capped: true };
      }
      const coinsAfter = await this.credit(args.accountId, amount, 'victory', { clientPlatform: args.clientPlatform });
      return { ok: true, coinsAfter, credited: amount, capped: false };
    }
  };
}
