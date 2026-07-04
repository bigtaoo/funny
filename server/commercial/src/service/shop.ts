// Shop purchase / coin sink / coin grant (§6). All three use insert-first orderId idempotency (§6.5):
// reserve the order slot BEFORE debiting so concurrent same-orderId calls cannot double-charge.
import { findShopItem } from '@nw/shared';
import type { OrderDoc } from '../db';
import type { CommercialBaseCtor, Constructor, Result } from './base';

export interface ShopHandlers {
  shopCharge(args: {
    accountId: string;
    itemId: string;
    cost: number;
    orderId: string;
  }): Promise<Result<{ orderId: string; coinsAfter: number; status: OrderDoc['status'] }>>;
  spend(args: {
    accountId: string;
    amount: number;
    reason: string;
    orderId: string;
  }): Promise<Result<{ coinsAfter: number }>>;
  grant(args: {
    accountId: string;
    amount: number;
    reason: string;
    orderId: string;
  }): Promise<Result<{ coinsAfter: number }>>;
}

export function ShopMixin<TBase extends CommercialBaseCtor>(Base: TBase): TBase & Constructor<ShopHandlers> {
  return class extends Base {
    /** Direct shop purchase: debit coins + record order(kind:'shop'). Item delivery is handled by meta. */
    async shopCharge(args: {
      accountId: string;
      itemId: string;
      cost: number;
      orderId: string;
    }): Promise<Result<{ orderId: string; coinsAfter: number; status: OrderDoc['status'] }>> {
      const existing = await this.cols.orders.findOne({ _id: args.orderId });
      if (existing) {
        return { ok: true, orderId: existing._id, coinsAfter: existing.coinsAfter, status: existing.status };
      }
      // cost is passed from the trusted meta server; we still cross-check against the catalog price to guard against meta-side mismatches (e.g. legendary items that are not for sale would have no price).
      const def = findShopItem(args.itemId);
      if (!def || def.cost !== args.cost) return { ok: false, error: 'BAD_REQUEST' };

      await this.ensureWallet(args.accountId);
      // Insert-first idempotency (§6.5): claim the orderId slot BEFORE debiting so two concurrent calls with the
      // same orderId cannot both pass the "existing?" check and double-charge. E11000 → replay the existing order.
      try {
        await this.cols.orders.insertOne({
          _id: args.orderId,
          accountId: args.accountId,
          kind: 'shop',
          cost: args.cost,
          status: 'charged',
          coinsAfter: 0, // back-filled after the debit succeeds
          result: { itemId: def.grants },
          ts: this.now(),
        });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) {
          const o = await this.cols.orders.findOne({ _id: args.orderId });
          return { ok: true, orderId: args.orderId, coinsAfter: o?.coinsAfter ?? 0, status: o?.status ?? 'charged' };
        }
        throw e;
      }
      const charged = await this.cols.wallets.findOneAndUpdate(
        { _id: args.accountId, coins: { $gte: args.cost } },
        { $inc: { coins: -args.cost, rev: 1 }, $set: { updatedAt: this.now() } },
        { returnDocument: 'after' },
      );
      if (!charged) {
        // Insufficient funds: release the reserved slot so a later top-up can retry the same orderId.
        await this.cols.orders.deleteOne({ _id: args.orderId });
        return { ok: false, error: 'INSUFFICIENT_FUNDS' };
      }
      const coinsAfter = charged.coins;

      await this.cols.orders.updateOne({ _id: args.orderId }, { $set: { coinsAfter } });
      await this.cols.ledger.insertOne({
        accountId: args.accountId,
        delta: -args.cost,
        balanceAfter: coinsAfter,
        reason: 'shop',
        orderId: args.orderId,
        ts: this.now(),
      });
      return { ok: true, orderId: args.orderId, coinsAfter, status: 'charged' };
    }

    /**
     * Pure coin sink (rename and other no-delivery actions): atomic debit + record order(kind:'sink', persisted immediately as delivered)
     * + ledger entry. orderId idempotency (replay returns the original balance). Reconciliation only scans status:'charged', so sinks are never re-delivered.
     */
    async spend(args: {
      accountId: string;
      amount: number;
      reason: string;
      orderId: string;
    }): Promise<Result<{ coinsAfter: number }>> {
      const existing = await this.cols.orders.findOne({ _id: args.orderId });
      if (existing) return { ok: true, coinsAfter: existing.coinsAfter };

      const amount = Math.max(0, Math.floor(args.amount));
      if (amount === 0) return { ok: false, error: 'BAD_REQUEST' };

      await this.ensureWallet(args.accountId);
      // Insert-first idempotency (§6.5): reserve the orderId slot before debiting; E11000 → replay the existing order.
      try {
        await this.cols.orders.insertOne({
          _id: args.orderId,
          accountId: args.accountId,
          kind: 'sink',
          cost: amount,
          status: 'delivered',
          coinsAfter: 0, // back-filled after the debit succeeds
          result: {},
          deliveredAt: this.now(),
          ts: this.now(),
        });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) {
          const o = await this.cols.orders.findOne({ _id: args.orderId });
          return { ok: true, coinsAfter: o?.coinsAfter ?? 0 };
        }
        throw e;
      }
      const charged = await this.cols.wallets.findOneAndUpdate(
        { _id: args.accountId, coins: { $gte: amount } },
        { $inc: { coins: -amount, rev: 1 }, $set: { updatedAt: this.now() } },
        { returnDocument: 'after' },
      );
      if (!charged) {
        // Insufficient funds: release the reserved slot so a later top-up can retry the same orderId.
        await this.cols.orders.deleteOne({ _id: args.orderId });
        return { ok: false, error: 'INSUFFICIENT_FUNDS' };
      }
      const coinsAfter = charged.coins;

      await this.cols.orders.updateOne({ _id: args.orderId }, { $set: { coinsAfter } });
      await this.cols.ledger.insertOne({
        accountId: args.accountId,
        delta: -amount,
        balanceAfter: coinsAfter,
        reason: args.reason,
        orderId: args.orderId,
        ts: this.now(),
      });
      return { ok: true, coinsAfter };
    }

    /**
     * Pure coin grant (mail attachment claims S6-3 and other fee-free credits): atomic credit + record order(kind:'grant', persisted
     * immediately as delivered) + ledger entry. orderId idempotency (replay returns the original balance; reconciliation ignores grants).
     * amount may be 0 (pure item/skin attachments also flow through here to claim an idempotent order slot; amount 0 skips the coin credit).
     */
    async grant(args: {
      accountId: string;
      amount: number;
      reason: string;
      orderId: string;
    }): Promise<Result<{ coinsAfter: number }>> {
      const existing = await this.cols.orders.findOne({ _id: args.orderId });
      if (existing) return { ok: true, coinsAfter: existing.coinsAfter };

      const amount = Math.max(0, Math.floor(args.amount));
      // First claim the idempotent order slot (unique _id prevents concurrent duplicate grants), then credit coins + backfill coinsAfter.
      try {
        await this.cols.orders.insertOne({
          _id: args.orderId,
          accountId: args.accountId,
          kind: 'grant',
          cost: 0,
          status: 'delivered',
          coinsAfter: 0,
          result: {},
          deliveredAt: this.now(),
          ts: this.now(),
        });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) {
          const o = await this.cols.orders.findOne({ _id: args.orderId });
          return { ok: true, coinsAfter: o?.coinsAfter ?? 0 };
        }
        throw e;
      }
      const coinsAfter =
        amount > 0
          ? await this.credit(args.accountId, amount, args.reason, { orderId: args.orderId })
          : (await this.ensureWallet(args.accountId)).coins;
      await this.cols.orders.updateOne({ _id: args.orderId }, { $set: { coinsAfter } });
      return { ok: true, coinsAfter };
    }
  };
}
