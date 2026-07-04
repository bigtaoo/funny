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
      if (order.status === 'delivered') return { ok: true }; // Idempotent: already delivered, do not refund again.

      const refund = Math.max(0, Math.floor(args.refundCoins ?? 0));
      await this.cols.orders.updateOne(
        { _id: args.orderId, status: 'charged' },
        { $set: { status: 'delivered', deliveredAt: this.now(), refundCoins: refund } },
      );
      if (refund > 0) {
        await this.credit(order.accountId, refund, 'gacha_refund', { orderId: args.orderId });
      }
      return { ok: true };
    }

    /** Reconciliation: fetch undelivered orders for an account (meta GET /save triggers re-delivery as a side effect). */
    async undeliveredOrders(accountId: string): Promise<OrderDoc[]> {
      return this.cols.orders.find({ accountId, status: 'charged' }).toArray();
    }
  };
}
