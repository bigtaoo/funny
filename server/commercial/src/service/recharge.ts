// Recharge (IAP receipt verify) + Paddle webhook completion (§6.5). receiptId idempotency + first-purchase
// bonus CAS + cross-account receipt guard. claimFirstPurchaseBonus is recharge-only (kept private here).
import { FIRST_PURCHASE_BONUS_MULTIPLIER } from '@nw/shared';
import type { CommercialBaseCtor, Constructor, Result } from './base';
import type { PaddleEventDoc } from '../db';

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
    /** Real USD price charged (GACHA_DESIGN §13), pre-quantity-clamp-independent — the caller (paddle.ts)
     * already resolved priceId × quantity into this. Absent/0 = not tracked (e.g. unmapped priceId). */
    usdCents?: number;
  }): Promise<Result<{ coinsAfter: number; coinsGranted: number }>>;
  /**
   * Decrement totalRechargeCents for a refunded Paddle transaction (GACHA_DESIGN §13, ADR-045): looks up the
   * original recharge's stored usdCents and subtracts it (floored at 0). Idempotent via refundedAt — a
   * redelivered refund event (Paddle at-least-once) is a no-op on replay. Already-claimed reward tiers are
   * NOT revoked, only future tier eligibility is affected.
   */
  paddleRefund(args: { transactionId: string }): Promise<Result<{ decrementedCents: number }>>;
  /** Record any Paddle webhook event (support/CS lookup — "why didn't this payment go through"). Upserts on
   * `transactionId:eventType` so Paddle's at-least-once redelivery doesn't create duplicate log rows. */
  recordPaddleEvent(args: {
    transactionId: string;
    eventType: string;
    status?: string;
    accountId?: string;
    rawEvent: string;
  }): Promise<void>;
  /** List logged Paddle events for support lookup, filtered by accountId and/or transactionId. */
  listPaddleEvents(args: { accountId?: string; transactionId?: string; limit?: number }): Promise<PaddleEventDoc[]>;
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
      const usdCents = v.usdCents ?? 0;

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
          usdCents,
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
        rechargeUsdCents: usdCents,
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
      usdCents?: number;
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
      const usdCents = args.usdCents ?? 0;

      try {
        await this.cols.recharges.insertOne({
          _id: receiptId,
          accountId: args.accountId,
          platform: 'paddle',
          coinsGranted,
          status: 'granted',
          rawReceipt: args.transactionId,
          ts: this.now(),
          usdCents,
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
        rechargeUsdCents: usdCents,
      });
      return { ok: true, coinsAfter, coinsGranted };
    }

    /** Decrement totalRechargeCents for a refunded Paddle transaction (GACHA_DESIGN §13, ADR-045). See RechargeHandlers.paddleRefund doc. */
    async paddleRefund(args: { transactionId: string }): Promise<Result<{ decrementedCents: number }>> {
      const receiptId = `paddle:${args.transactionId}`;
      const doc = await this.cols.recharges.findOne({ _id: receiptId });
      if (!doc || doc.refundedAt || !doc.usdCents) return { ok: true, decrementedCents: 0 };

      const amount = doc.usdCents;
      await this.cols.wallets.findOneAndUpdate(
        { _id: doc.accountId },
        [
          {
            $set: {
              totalRechargeCents: { $max: [0, { $subtract: [{ $ifNull: ['$totalRechargeCents', 0] }, amount] }] },
              rev: { $add: ['$rev', 1] },
              updatedAt: this.now(),
            },
          },
        ],
      );
      await this.cols.recharges.updateOne({ _id: receiptId }, { $set: { refundedAt: this.now() } });
      return { ok: true, decrementedCents: amount };
    }

    async recordPaddleEvent(args: {
      transactionId: string;
      eventType: string;
      status?: string;
      accountId?: string;
      rawEvent: string;
    }): Promise<void> {
      const _id = `${args.transactionId}:${args.eventType}`;
      await this.cols.paddleEvents.updateOne(
        { _id },
        {
          $set: {
            _id,
            transactionId: args.transactionId,
            eventType: args.eventType,
            status: args.status,
            accountId: args.accountId,
            rawEvent: args.rawEvent,
            ts: this.now(),
          },
        },
        { upsert: true },
      );
    }

    async listPaddleEvents(args: {
      accountId?: string;
      transactionId?: string;
      limit?: number;
    }): Promise<PaddleEventDoc[]> {
      const filter: Partial<Record<'accountId' | 'transactionId', string>> = {};
      if (args.accountId) filter.accountId = args.accountId;
      if (args.transactionId) filter.transactionId = args.transactionId;
      return this.cols.paddleEvents
        .find(filter)
        .sort({ ts: -1 })
        .limit(Math.min(args.limit ?? 100, 500))
        .toArray();
    }
  };
}
