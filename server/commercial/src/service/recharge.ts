// Recharge (IAP receipt verify) + Paddle webhook completion (§6.5). receiptId idempotency + first-purchase
// bonus CAS + cross-account receipt guard. claimFirstPurchaseBonus is recharge-only (kept private here).
import { FIRST_PURCHASE_BONUS_MULTIPLIER } from '@nw/shared';
import type { CommercialBaseCtor, Constructor, Result } from './base';

export interface RechargeHandlers {
  rechargeVerify(args: {
    accountId: string;
    platform: string;
    receipt: string;
    receiptId: string;
  }): Promise<Result<{ coinsAfter: number; coinsGranted: number }>>;
  paddleComplete(args: {
    accountId: string;
    transactionId: string;
    coins: number;
  }): Promise<Result<{ coinsAfter: number; coinsGranted: number }>>;
}

export function RechargeMixin<TBase extends CommercialBaseCtor>(Base: TBase): TBase & Constructor<RechargeHandlers> {
  return class extends Base {
    /**
     * Atomically claim the first-purchase bonus slot.
     * Sets `firstPurchasedAt` only if it doesn't exist yet (CAS-style).
     * Returns true when THIS call claimed it (i.e. this is the first purchase).
     */
    private async claimFirstPurchaseBonus(accountId: string): Promise<boolean> {
      const result = await this.cols.wallets.findOneAndUpdate(
        { _id: accountId, firstPurchasedAt: { $exists: false } },
        { $set: { firstPurchasedAt: this.now() } },
      );
      return result !== null;
    }

    /** Verify recharge receipt + credit coins (commercial verifies platform receipts; dev uses the stub). receiptId idempotency. */
    async rechargeVerify(args: {
      accountId: string;
      platform: string;
      receipt: string;
      receiptId: string;
    }): Promise<Result<{ coinsAfter: number; coinsGranted: number }>> {
      const existing = await this.cols.recharges.findOne({ _id: args.receiptId });
      if (existing) {
        // Receipt already consumed: replay only if it belongs to the same account (return that account's balance);
        // otherwise reject — prevents mirroring another account's balance to the requester (cross-account balance leak).
        if (existing.accountId !== args.accountId) return { ok: false, error: 'INVALID_RECEIPT' };
        const w = await this.cols.wallets.findOne({ _id: existing.accountId });
        return { ok: true, coinsAfter: w?.coins ?? 0, coinsGranted: existing.coinsGranted };
      }
      const v = await this.verifyReceipt(args.platform, args.receipt);
      if (!v.ok) return { ok: false, error: 'INVALID_RECEIPT' };

      // First persist the receipt record (unique receiptId prevents concurrent duplicate grants), then credit coins.
      try {
        await this.cols.recharges.insertOne({
          _id: args.receiptId,
          accountId: args.accountId,
          platform: args.platform,
          coinsGranted: v.coins,
          status: 'granted',
          rawReceipt: args.receipt,
          ts: this.now(),
        });
      } catch (e) {
        // Concurrent race: a unique conflict means another request already processed it; re-read and return the existing result.
        if ((e as { code?: number }).code === 11000) {
          const r = await this.cols.recharges.findOne({ _id: args.receiptId });
          // Same cross-account guard: if the receipt was already claimed by a different account, reject.
          if (r && r.accountId !== args.accountId) return { ok: false, error: 'INVALID_RECEIPT' };
          const w = await this.cols.wallets.findOne({ _id: args.accountId });
          return { ok: true, coinsAfter: w?.coins ?? 0, coinsGranted: r?.coinsGranted ?? v.coins };
        }
        throw e;
      }
      // ensureWallet BEFORE claiming the first-purchase bonus: claimFirstPurchaseBonus's CAS has no upsert, so on a
      // genuine first purchase the wallet must already exist or the 2× bonus would leak to the second recharge (§6.5).
      await this.ensureWallet(args.accountId);
      const isFirst = await this.claimFirstPurchaseBonus(args.accountId);
      const coinsGranted = isFirst ? v.coins * FIRST_PURCHASE_BONUS_MULTIPLIER : v.coins;
      // The receipt slot was reserved above with the pre-bonus v.coins; back-fill the actual granted amount so a
      // later idempotent replay reports the bonus-inclusive value (mirrors the orders coinsAfter back-fill).
      if (coinsGranted !== v.coins) {
        await this.cols.recharges.updateOne({ _id: args.receiptId }, { $set: { coinsGranted } });
      }
      const coinsAfter = await this.credit(args.accountId, coinsGranted, 'recharge', {
        receiptId: args.receiptId,
      });
      return { ok: true, coinsAfter, coinsGranted };
    }

    /**
     * Credit coins from a verified Paddle webhook (no receipt re-verification needed;
     * metaserver already checked the Paddle signature before calling this).
     * Uses recharges collection for idempotency keyed on `paddle:${transactionId}`.
     */
    async paddleComplete(args: {
      accountId: string;
      transactionId: string;
      coins: number;
    }): Promise<Result<{ coinsAfter: number; coinsGranted: number }>> {
      const receiptId = `paddle:${args.transactionId}`;
      const existing = await this.cols.recharges.findOne({ _id: receiptId });
      if (existing) {
        if (existing.accountId !== args.accountId) return { ok: false, error: 'INVALID_RECEIPT' };
        const w = await this.cols.wallets.findOne({ _id: existing.accountId });
        return { ok: true, coinsAfter: w?.coins ?? 0, coinsGranted: existing.coinsGranted };
      }

      await this.ensureWallet(args.accountId);
      const isFirst = await this.claimFirstPurchaseBonus(args.accountId);
      const coinsGranted = isFirst ? args.coins * FIRST_PURCHASE_BONUS_MULTIPLIER : args.coins;

      try {
        await this.cols.recharges.insertOne({
          _id: receiptId,
          accountId: args.accountId,
          platform: 'paddle',
          coinsGranted,
          status: 'granted',
          rawReceipt: args.transactionId,
          ts: this.now(),
        });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) {
          const r = await this.cols.recharges.findOne({ _id: receiptId });
          if (r && r.accountId !== args.accountId) return { ok: false, error: 'INVALID_RECEIPT' };
          const w = await this.cols.wallets.findOne({ _id: args.accountId });
          return { ok: true, coinsAfter: w?.coins ?? 0, coinsGranted: r?.coinsGranted ?? coinsGranted };
        }
        throw e;
      }
      const coinsAfter = await this.credit(args.accountId, coinsGranted, 'recharge', {
        receiptId,
      });
      return { ok: true, coinsAfter, coinsGranted };
    }
  };
}
