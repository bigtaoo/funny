// Order delivery callback + undelivered-order reconciliation (§6). orderDelivered is an idempotent closed loop
// and credits the meta-computed duplicate refund exactly once (via the base `credit`).
import type { OrderDoc } from '../db';
import type { CommercialBaseCtor, Constructor, Result } from './base';

export interface OrdersHandlers {
  orderDelivered(args: { orderId: string; refundCoins?: number }): Promise<Result<{}>>;
  undeliveredOrders(accountId: string): Promise<OrderDoc[]>;
}

export function OrdersMixin<TBase extends CommercialBaseCtor>(Base: TBase): TBase & Constructor<OrdersHandlers> {
  return class extends Base {
    /**
     * Mark an order as delivered (callback from meta after item delivery; idempotent closed loop).
     * Optional refundCoins: duplicate-item refund computed by meta (epic/legendary duplicates); credited once on delivery.
     */
    async orderDelivered(args: { orderId: string; refundCoins?: number }): Promise<Result<{}>> {
      const order = await this.cols.orders.findOne({ _id: args.orderId });
      if (!order) return { ok: false, error: 'NOT_FOUND' };
      // Idempotent: already delivered. The status flip below happens BEFORE the refund credit — heal a
      // crash landing between the two (order stamped "delivered" with refundCoins recorded, but the credit()
      // ledger write never ran) instead of silently dropping the refund forever (verify-and-heal).
      if (order.status === 'delivered') return this.healOrderRefund(order);

      const refundArg = args.refundCoins ?? 0;
      const refund = Number.isFinite(refundArg) ? Math.max(0, Math.floor(refundArg)) : 0;
      const updated = await this.cols.orders.updateOne(
        { _id: args.orderId, status: 'charged' },
        { $set: { status: 'delivered', deliveredAt: this.now(), refundCoins: refund } },
      );
      // status:'charged' in the filter is the idempotency guard: Mongo only lets one concurrent call actually
      // flip the status (matchedCount 1). A duplicate delivery callback that loses that race (matchedCount 0 —
      // another call already delivered it) must heal the same way as the already-delivered branch above — via
      // a fresh read, since `order` here is the pre-race snapshot and doesn't have the winner's deliveredAt.
      if (updated.matchedCount === 0) {
        const fresh = await this.cols.orders.findOne({ _id: args.orderId });
        return fresh ? this.healOrderRefund(fresh) : { ok: true };
      }
      if (refund > 0) {
        await this.credit(order.accountId, refund, 'gacha_refund', { orderId: args.orderId });
      }
      return { ok: true };
    }

    /**
     * Gated by isStaleClaim (base.ts): within the grace window after delivery, just report ok like before —
     * a duplicate delivery callback for the SAME orderId arriving milliseconds apart (the common case) must
     * not race the winner's still-in-flight refund credit. Only a callback arriving well after delivery heals
     * a genuinely dropped refund (crash between the status flip and the credit call). Past the window, the
     * ledger-absence read is still just a plain read — two stale-claim healers landing together would both
     * see no ledger entry and both credit(). The `healClaimedAt` CAS on the order doc closes that: only the
     * caller whose findOneAndUpdate matches proceeds to credit().
     */
    private async healOrderRefund(order: OrderDoc): Promise<Result<{}>> {
      const refund = order.refundCoins ?? 0;
      if (refund <= 0) return { ok: true };
      if (!this.isStaleClaim(order.deliveredAt ?? order.ts)) return { ok: true };
      const landed = await this.cols.ledger.findOne({ accountId: order.accountId, orderId: order._id });
      if (landed) return { ok: true };
      const claimed = await this.cols.orders.findOneAndUpdate(
        { _id: order._id, healClaimedAt: { $exists: false } },
        { $set: { healClaimedAt: this.now() } },
      );
      if (claimed) await this.credit(order.accountId, refund, 'gacha_refund', { orderId: order._id });
      return { ok: true };
    }

    /** Reconciliation: fetch undelivered orders for an account (meta GET /save triggers re-delivery as a side effect). */
    async undeliveredOrders(accountId: string): Promise<OrderDoc[]> {
      return this.cols.orders.find({ accountId, status: 'charged' }).toArray();
    }
  };
}
