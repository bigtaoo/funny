// Recharge (IAP receipt verify) + Paddle webhook completion (§6.5). receiptId idempotency + first-purchase
// bonus CAS + cross-account receipt guard. claimFirstPurchaseBonus is recharge-only (kept private here).
import { FIRST_PURCHASE_BONUS_MULTIPLIER } from '@nw/shared';
import type { IapProductKind } from '../iap';
import type { CommercialBaseCtor, Constructor, Result } from './base';
import type { PaddleEventDoc } from '../db';
import { effectiveCoins, rechargeChannelOf, spendChannelOf } from '../spendChannel';

export interface RechargeHandlers {
  rechargeVerify(args: {
    accountId: string;
    platform: string;
    receipt: string;
    receiptId: string;
    clientPlatform?: string;
  }): Promise<Result<{ coinsAfter: number; coinsGranted: number }>>;
  /**
   * Verify a receipt resolves to a specific non-coin SKU (monthly/year card, starter pack) before the
   * caller (metaserver's subscription/starter HTTP handlers) is allowed to grant it — closes the
   * "treated as authorized" gap where those endpoints used to grant on a bare authenticated request with
   * no proof of payment at all (GACHA_DESIGN §5/§6). Idempotent on receiptId like rechargeVerify; does
   * NOT itself grant anything — the caller still calls monthlyCardBuy/yearCardBuy/starterBuy after this
   * returns ok, same two-step shape as iapVerify → credit.
   */
  verifyNonCoinReceipt(args: {
    accountId: string;
    platform: string;
    receipt: string;
    receiptId: string;
    expectedProduct: IapProductKind;
  }): Promise<Result<{ product: IapProductKind }>>;
  paddleComplete(args: {
    accountId: string;
    transactionId: string;
    coins: number;
    /** Real USD price charged (GACHA_DESIGN §13), pre-quantity-clamp-independent — the caller (paddle.ts)
     * already resolved priceId × quantity into this. Absent/0 = not tracked (e.g. unmapped priceId). */
    usdCents?: number;
  }): Promise<Result<{ coinsAfter: number; coinsGranted: number }>>;
  // (paddleComplete has no clientPlatform — it's a server-side webhook callback, not a client request;
  // its channel is always 'web' since Paddle only serves the web build. Its returned coinsAfter therefore
  // reflects the 'web' bucket, which is what the next same-session web wallet fetch will also show.)
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

    /**
     * Replay-safe balance for an already-consumed receipt. The recharges record is written BEFORE
     * credit() runs (reserves the receiptId first so concurrent duplicates can't double-grant) — if a
     * crash lands between that insert and the credit() $inc, a naive replay would read the current
     * (un-credited) balance and report success, silently losing the coins forever with no trace of
     * failure. Heal it instead: the ledger entry is written atomically as part of credit() and keyed on
     * receiptId, so its absence is a reliable signal the credit never landed — same verify-and-heal
     * house style as equipment.ts's idempotent-replay branches. Gated by isStaleClaim (base.ts): within
     * the grace window this just reads the current balance like before, so concurrent duplicates of the
     * SAME receiptId (the common case, still in-flight) don't race the true winner and double-credit.
     * Past the window, the ledger-absence read alone is still just a plain read — two stale-claim healers
     * arriving together would both see no ledger entry and both call credit(). The `healedAt` CAS on the
     * recharges doc itself (findOneAndUpdate) closes that: only the caller whose update actually matches
     * proceeds to credit(); the loser falls through to read whatever balance is currently there.
     */
    private async healRechargeCredit(
      doc: { _id: string; accountId: string; coinsGranted: number; platform: string; usdCents?: number; ts: number },
      receiptId: string,
      clientPlatform: string | undefined,
    ): Promise<number> {
      if (this.isStaleClaim(doc.ts)) {
        const already = await this.cols.ledger.findOne({ accountId: doc.accountId, receiptId });
        if (!already) {
          const claimed = await this.cols.recharges.findOneAndUpdate(
            { _id: doc._id, healedAt: { $exists: false } },
            { $set: { healedAt: this.now() } },
          );
          if (claimed) {
            return this.credit(doc.accountId, doc.coinsGranted, 'recharge', {
              receiptId,
              rechargeUsdCents: doc.usdCents,
              channel: rechargeChannelOf(doc.platform) ?? undefined,
              clientPlatform,
            });
          }
        }
      }
      const w = await this.cols.wallets.findOne({ _id: doc.accountId });
      return effectiveCoins(w, spendChannelOf(clientPlatform));
    }

    /** Verify recharge receipt + credit coins (commercial verifies platform receipts; dev uses the stub). receiptId idempotency. */
    async rechargeVerify(args: {
      accountId: string;
      platform: string;
      receipt: string;
      receiptId: string;
      clientPlatform?: string;
    }): Promise<Result<{ coinsAfter: number; coinsGranted: number }>> {
      const existing = await this.cols.recharges.findOne({ _id: args.receiptId });
      if (existing) {
        // Receipt already consumed: replay only if it belongs to the same account (return that account's balance);
        // otherwise reject — prevents mirroring another account's balance to the requester (cross-account balance leak).
        if (existing.accountId !== args.accountId) return { ok: false, error: 'INVALID_RECEIPT' };
        const coinsAfter = await this.healRechargeCredit(existing, args.receiptId, args.clientPlatform);
        return { ok: true, coinsAfter, coinsGranted: existing.coinsGranted };
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
          const coinsAfter = r
            ? await this.healRechargeCredit(r, args.receiptId, args.clientPlatform)
            : effectiveCoins(await this.cols.wallets.findOne({ _id: args.accountId }), spendChannelOf(args.clientPlatform));
          return { ok: true, coinsAfter, coinsGranted: r?.coinsGranted ?? v.coins };
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
      // Real money: fund the recharged bucket matching the VERIFIED platform (ADR-020), not the free pool.
      // rechargeChannelOf returns null for unrecognized platform strings (dev-stub `dev`/`dev-*`) — falls
      // back to `channel: undefined` (free pool), same as before this feature existed.
      const coinsAfter = await this.credit(args.accountId, coinsGranted, 'recharge', {
        receiptId: args.receiptId,
        rechargeUsdCents: usdCents,
        channel: rechargeChannelOf(args.platform) ?? undefined,
        clientPlatform: args.clientPlatform,
      });
      return { ok: true, coinsAfter, coinsGranted };
    }

    async verifyNonCoinReceipt(args: {
      accountId: string;
      platform: string;
      receipt: string;
      receiptId: string;
      expectedProduct: IapProductKind;
    }): Promise<Result<{ product: IapProductKind }>> {
      const existing = await this.cols.recharges.findOne({ _id: args.receiptId });
      if (existing) {
        // Cross-account guard (mirrors rechargeVerify) + cross-product guard: a receipt already consumed
        // for a different product (or a different account) can't be replayed to claim this one.
        if (existing.accountId !== args.accountId) return { ok: false, error: 'INVALID_RECEIPT' };
        if (existing.product !== args.expectedProduct) return { ok: false, error: 'INVALID_RECEIPT' };
        return { ok: true, product: args.expectedProduct };
      }
      const v = await this.verifyReceipt(args.platform, args.receipt);
      if (!v.ok || !v.product || v.product !== args.expectedProduct) {
        return { ok: false, error: 'INVALID_RECEIPT' };
      }
      try {
        await this.cols.recharges.insertOne({
          _id: args.receiptId,
          accountId: args.accountId,
          platform: args.platform,
          coinsGranted: 0,
          status: 'granted',
          rawReceipt: args.receipt,
          ts: this.now(),
          product: v.product,
        });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) {
          const r = await this.cols.recharges.findOne({ _id: args.receiptId });
          if (!r || r.accountId !== args.accountId || r.product !== args.expectedProduct) {
            return { ok: false, error: 'INVALID_RECEIPT' };
          }
          return { ok: true, product: args.expectedProduct };
        }
        throw e;
      }
      return { ok: true, product: args.expectedProduct };
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
      // meta forwards these straight from the internal HTTP body (internalHttp.ts's `num()` only
      // guards typeof+finite, not sign/range) — this is the only remaining check before an unconditional
      // wallet $inc, so it must reject bad values rather than trust the caller.
      if (!Number.isFinite(args.coins) || args.coins <= 0) return { ok: false, error: 'BAD_REQUEST' };
      if (args.usdCents !== undefined && (!Number.isFinite(args.usdCents) || args.usdCents < 0)) {
        return { ok: false, error: 'BAD_REQUEST' };
      }
      const receiptId = `paddle:${args.transactionId}`;
      const existing = await this.cols.recharges.findOne({ _id: receiptId });
      if (existing) {
        if (existing.accountId !== args.accountId) return { ok: false, error: 'INVALID_RECEIPT' };
        const coinsAfter = await this.healRechargeCredit(existing, receiptId, undefined);
        return { ok: true, coinsAfter, coinsGranted: existing.coinsGranted };
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
          const coinsAfter = r
            ? await this.healRechargeCredit(r, receiptId, undefined)
            : effectiveCoins(await this.cols.wallets.findOne({ _id: args.accountId }), 'web');
          return { ok: true, coinsAfter, coinsGranted: r?.coinsGranted ?? coinsGranted };
        }
        throw e;
      }
      // Paddle only serves the web build — always the 'web' bucket (ADR-020), never a client-declared platform.
      const coinsAfter = await this.credit(args.accountId, coinsGranted, 'recharge', {
        receiptId,
        rechargeUsdCents: usdCents,
        channel: 'web',
      });
      return { ok: true, coinsAfter, coinsGranted };
    }

    /** Decrement totalRechargeCents for a refunded Paddle transaction (GACHA_DESIGN §13, ADR-045). See RechargeHandlers.paddleRefund doc. */
    async paddleRefund(args: { transactionId: string }): Promise<Result<{ decrementedCents: number }>> {
      const receiptId = `paddle:${args.transactionId}`;
      const doc = await this.cols.recharges.findOne({ _id: receiptId });
      if (!doc || doc.refundedAt || !doc.usdCents) return { ok: true, decrementedCents: 0 };

      const amount = doc.usdCents;
      // Claim the refund atomically first (refundedAt-absent guard): Paddle redelivers webhooks at-least-once,
      // so two concurrent refund events for the same transaction must not both pass the pre-check above and
      // both decrement totalRechargeCents. Only the request that wins this guarded update proceeds to decrement.
      const claimed = await this.cols.recharges.updateOne(
        { _id: receiptId, refundedAt: { $exists: false } },
        { $set: { refundedAt: this.now() } },
      );
      if (claimed.matchedCount === 0) return { ok: true, decrementedCents: 0 };

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
