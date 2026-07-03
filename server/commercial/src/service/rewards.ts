// Ad reward + tiered victory coin credit (§2.3b). victoryCredit authoritatively enforces the daily win cap.
import { VICTORY_DAILY_WIN_CAP } from '@nw/shared';
import type { CommercialBaseCtor, Constructor, Result } from './base';

export interface RewardsHandlers {
  adsCredit(args: {
    accountId: string;
    amount: number;
    dayKey: string;
  }): Promise<Result<{ coinsAfter: number }>>;
  victoryCredit(args: {
    accountId: string;
    amount: number;
    dayKey: string;
  }): Promise<Result<{ coinsAfter: number; credited: number; capped: boolean }>>;
}

export function RewardsMixin<TBase extends CommercialBaseCtor>(Base: TBase): TBase & Constructor<RewardsHandlers> {
  return class extends Base {
    /** Ad reward coin credit (meta has already validated the ad proof + daily cap; commercial only credits coins and records the ledger entry). */
    async adsCredit(args: {
      accountId: string;
      amount: number;
      dayKey: string;
    }): Promise<Result<{ coinsAfter: number }>> {
      const amount = Math.max(0, Math.floor(args.amount));
      if (amount === 0) return { ok: false, error: 'BAD_REQUEST' };
      const coinsAfter = await this.credit(args.accountId, amount, 'ads', {});
      return { ok: true, coinsAfter };
    }

    /**
     * Tiered victory coin credit (§2.3b). meta computes amount (by rank tier) + dayKey; commercial **authoritatively enforces
     * the daily win cap** here: atomically guards the daily counter < VICTORY_DAILY_WIN_CAP before claiming a slot and crediting,
     * returning capped=true without granting when the limit is reached (the win is still recorded in saves.pvp; coins are not issued).
     * Counter document _id=`accountId:dayKey`, same two-step pattern as the ads cap.
     */
    async victoryCredit(args: {
      accountId: string;
      amount: number;
      dayKey: string;
    }): Promise<Result<{ coinsAfter: number; credited: number; capped: boolean }>> {
      const amount = Math.max(0, Math.floor(args.amount));
      if (amount === 0) return { ok: false, error: 'BAD_REQUEST' };

      const id = `${args.accountId}:${args.dayKey}`;
      // First upsert to ensure the document exists, then $inc with the guard (same pattern as bumpAdsCap).
      await this.cols.victoryDaily.updateOne(
        { _id: id },
        { $setOnInsert: { _id: id, accountId: args.accountId, dayKey: args.dayKey, wins: 0, ts: this.now() } },
        { upsert: true },
      );
      const slot = await this.cols.victoryDaily.findOneAndUpdate(
        { _id: id, wins: { $lt: VICTORY_DAILY_WIN_CAP } },
        { $inc: { wins: 1 }, $set: { ts: this.now() } },
        { returnDocument: 'after' },
      );
      if (!slot) {
        // Daily cap reached: do not credit coins.
        const w = await this.cols.wallets.findOne({ _id: args.accountId });
        return { ok: true, coinsAfter: w?.coins ?? 0, credited: 0, capped: true };
      }
      const coinsAfter = await this.credit(args.accountId, amount, 'victory', {});
      return { ok: true, coinsAfter, credited: amount, capped: false };
    }
  };
}
