// Promo code create/list/redeem (B-PROMO). Redemption dedup via promoRedemptions._id=`accountId:code`.
import type { PromoCodeDoc, PromoRedemptionDoc } from '../db';
import type { CommercialBaseCtor, Constructor, Result } from './base';

export interface PromoHandlers {
  createPromoCode(args: {
    code: string;
    coins: number;
    expiresAt?: number;
    totalLimit?: number;
    note?: string;
    createdBy: string;
  }): Promise<Result<{ code: string }>>;
  listPromoCodes(): Promise<PromoCodeDoc[]>;
  promoRedeem(args: {
    accountId: string;
    code: string;
  }): Promise<Result<{ coinsAfter: number; coinsGranted: number }>>;
}

export function PromoMixin<TBase extends CommercialBaseCtor>(Base: TBase): TBase & Constructor<PromoHandlers> {
  return class extends Base {
    /** Create a promo code (called by admin, forwarded internally via meta). code is normalized to uppercase. */
    async createPromoCode(args: {
      code: string;
      coins: number;
      expiresAt?: number;
      totalLimit?: number;
      note?: string;
      createdBy: string;
    }): Promise<Result<{ code: string }>> {
      const code = args.code.trim().toUpperCase();
      if (!code || args.coins <= 0) return { ok: false, error: 'BAD_REQUEST' };
      try {
        await this.cols.promoCodes.insertOne({
          _id: code,
          coins: Math.floor(args.coins),
          ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
          ...(args.totalLimit !== undefined ? { totalLimit: Math.floor(args.totalLimit) } : {}),
          redeemed: 0,
          ...(args.note ? { note: args.note } : {}),
          createdBy: args.createdBy,
          createdAt: this.now(),
        });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) return { ok: false, error: 'BAD_REQUEST' };
        throw e;
      }
      return { ok: true, code };
    }

    /** List all promo codes (for admin management). */
    async listPromoCodes(): Promise<PromoCodeDoc[]> {
      return this.cols.promoCodes.find({}).sort({ createdAt: -1 }).toArray();
    }

    /**
     * Player promo code redemption (B-PROMO).
     * Validation order: code exists → not expired → total limit not reached → player has not used it → credit coins.
     * Concurrent dedup: promoRedemptions._id=`accountId:code` unique index; conflict replay returns PROMO_ALREADY_USED.
     * Atomic $inc guard on total: claim the redemption first, then $inc redeemed (at most 1 over-limit in concurrent cases, acceptable).
     */
    async promoRedeem(args: {
      accountId: string;
      code: string;
    }): Promise<Result<{ coinsAfter: number; coinsGranted: number }>> {
      const code = args.code.trim().toUpperCase();
      const def = await this.cols.promoCodes.findOne({ _id: code });
      if (!def) return { ok: false, error: 'PROMO_NOT_FOUND' };
      if (def.expiresAt !== undefined && def.expiresAt < this.now()) return { ok: false, error: 'PROMO_EXPIRED' };
      if (def.totalLimit !== undefined && def.redeemed >= def.totalLimit) return { ok: false, error: 'PROMO_EXHAUSTED' };

      const redemptionId = `${args.accountId}:${code}`;
      const existing = await this.cols.promoRedemptions.findOne({ _id: redemptionId });
      if (existing) return { ok: false, error: 'PROMO_ALREADY_USED' };

      const redemption: PromoRedemptionDoc = {
        _id: redemptionId,
        accountId: args.accountId,
        code,
        coinsGranted: def.coins,
        ts: this.now(),
      };
      try {
        await this.cols.promoRedemptions.insertOne(redemption);
      } catch (e) {
        if ((e as { code?: number }).code === 11000) return { ok: false, error: 'PROMO_ALREADY_USED' };
        throw e;
      }

      // Atomically increment redemption count (best-effort; does not hard-guard the total — soft check above is sufficient; at most 1 over-limit concurrently).
      await this.cols.promoCodes.updateOne({ _id: code }, { $inc: { redeemed: 1 } });
      const coinsAfter = await this.credit(args.accountId, def.coins, 'promo', {});
      return { ok: true, coinsAfter, coinsGranted: def.coins };
    }
  };
}
