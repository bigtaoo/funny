// Shop purchase / coin sink / coin grant (§6). All three use insert-first orderId idempotency (§6.5):
// reserve the order slot BEFORE debiting so concurrent same-orderId calls cannot double-charge.
import { findShopItem, SHOP_BUY_MAX_QTY } from '@nw/shared';
import type { OrderDoc } from '../db';
import type { Result, WalletCore } from './base';
import { effectiveCoins, spendChannelOf } from '../spendChannel';

export interface ShopHandlers {
  shopCharge(args: {
    accountId: string;
    itemId: string;
    cost: number;
    /** Units to charge/deliver in this one call (bulk-buy, ×10 button, 2026-08-10). Default 1. */
    qty?: number;
    orderId: string;
    clientPlatform?: string;
  }): Promise<Result<{ orderId: string; coinsAfter: number; status: OrderDoc['status'] }>>;
  spend(args: {
    accountId: string;
    amount: number;
    reason: string;
    orderId: string;
    clientPlatform?: string;
  }): Promise<Result<{ coinsAfter: number }>>;
  grant(args: {
    accountId: string;
    amount: number;
    reason: string;
    orderId: string;
    clientPlatform?: string;
  }): Promise<Result<{ coinsAfter: number }>>;
}

export class ShopService {
  constructor(private readonly core: WalletCore) {}

    /**
     * Direct shop purchase: debit coins + record order(kind:'shop'). Item delivery is handled by meta.
     * `qty` (2026-08-10, bulk-buy) charges/records several units atomically in this one call — `cost` is
     * still the *per-unit* catalog price (cross-checked below), the actual debit/ledger delta is
     * `cost * qty`. All-or-nothing: an insufficient balance for the full qty charges nothing at all
     * (no partial fulfillment), matching what the client's affordability gate already assumes.
     */
    async shopCharge(args: {
      accountId: string;
      itemId: string;
      cost: number;
      qty?: number;
      orderId: string;
      clientPlatform?: string;
    }): Promise<Result<{ orderId: string; coinsAfter: number; status: OrderDoc['status'] }>> {
      const existing = await this.core.cols.orders.findOne({ _id: args.orderId });
      if (existing) {
        // Ownership check (2026-08-04 fix, mirrors recharge.ts's existing accountId guard): orderId is a
        // raw client/meta-supplied string with no structural binding to the caller — every current caller
        // happens to mint a fresh UUID per request, so this hasn't manifested as a live cross-account leak,
        // but nothing in this shared cache-replay pattern enforced it. Without this, a future caller that
        // doesn't mint a fresh id could read back a DIFFERENT account's balance under a colliding orderId,
        // exactly the class of bug already fixed once for recharge.ts's receiptId path.
        if (existing.accountId !== args.accountId) return { ok: false, error: 'BAD_REQUEST' };
        return { ok: true, orderId: existing._id, coinsAfter: existing.coinsAfter, status: existing.status };
      }
      // cost is passed from the trusted meta server; we still cross-check against the catalog price to guard against meta-side mismatches (e.g. legendary items that are not for sale would have no price).
      const def = findShopItem(args.itemId);
      if (!def || def.cost !== args.cost) return { ok: false, error: 'BAD_REQUEST' };
      // qty defensive re-validation (meta already clamps this — see economy.ts shopBuy — but commercial
      // is the one actually moving coins, so it doesn't take meta's word for it, same spirit as the cost cross-check above).
      const qty = args.qty ?? 1;
      if (!Number.isInteger(qty) || qty < 1 || qty > SHOP_BUY_MAX_QTY) return { ok: false, error: 'BAD_REQUEST' };
      const totalCost = def.cost * qty;

      await this.core.ensureWallet(args.accountId);
      // Insert-first idempotency (§6.5): claim the orderId slot BEFORE debiting so two concurrent calls with the
      // same orderId cannot both pass the "existing?" check and double-charge. E11000 → replay the existing order.
      try {
        await this.core.cols.orders.insertOne({
          _id: args.orderId,
          accountId: args.accountId,
          kind: 'shop',
          cost: totalCost,
          status: 'charged',
          coinsAfter: 0, // back-filled after the debit succeeds
          result: { itemId: def.grants, qty },
          ts: this.core.now(),
        });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) {
          const o = await this.core.cols.orders.findOne({ _id: args.orderId });
          if (o && o.accountId !== args.accountId) return { ok: false, error: 'BAD_REQUEST' };
          return { ok: true, orderId: args.orderId, coinsAfter: o?.coinsAfter ?? 0, status: o?.status ?? 'charged' };
        }
        throw e;
      }
      const channel = spendChannelOf(args.clientPlatform);
      const charged = await this.core.debitEffective(args.accountId, totalCost, channel);
      if (!charged) {
        // Insufficient funds: release the reserved slot so a later top-up can retry the same orderId.
        await this.core.cols.orders.deleteOne({ _id: args.orderId });
        return { ok: false, error: 'INSUFFICIENT_FUNDS' };
      }
      const coinsAfter = effectiveCoins(charged, channel);

      await this.core.cols.orders.updateOne({ _id: args.orderId }, { $set: { coinsAfter } });
      await this.core.cols.ledger.insertOne({
        accountId: args.accountId,
        delta: -totalCost,
        balanceAfter: coinsAfter,
        reason: 'shop',
        orderId: args.orderId,
        ts: this.core.now(),
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
      clientPlatform?: string;
    }): Promise<Result<{ coinsAfter: number }>> {
      const existing = await this.core.cols.orders.findOne({ _id: args.orderId });
      // Ownership check (2026-08-04 fix) — see shopCharge's identical guard above for the full rationale.
      if (existing) {
        if (existing.accountId !== args.accountId) return { ok: false, error: 'BAD_REQUEST' };
        return { ok: true, coinsAfter: existing.coinsAfter };
      }

      const amount = Number.isFinite(args.amount) ? Math.max(0, Math.floor(args.amount)) : 0;
      if (amount === 0) return { ok: false, error: 'BAD_REQUEST' };

      await this.core.ensureWallet(args.accountId);
      // Insert-first idempotency (§6.5): reserve the orderId slot before debiting; E11000 → replay the existing order.
      try {
        await this.core.cols.orders.insertOne({
          _id: args.orderId,
          accountId: args.accountId,
          kind: 'sink',
          cost: amount,
          status: 'delivered',
          coinsAfter: 0, // back-filled after the debit succeeds
          result: {},
          deliveredAt: this.core.now(),
          ts: this.core.now(),
        });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) {
          const o = await this.core.cols.orders.findOne({ _id: args.orderId });
          if (o && o.accountId !== args.accountId) return { ok: false, error: 'BAD_REQUEST' };
          return { ok: true, coinsAfter: o?.coinsAfter ?? 0 };
        }
        throw e;
      }
      const channel = spendChannelOf(args.clientPlatform);
      const charged = await this.core.debitEffective(args.accountId, amount, channel);
      if (!charged) {
        // Insufficient funds: release the reserved slot so a later top-up can retry the same orderId.
        await this.core.cols.orders.deleteOne({ _id: args.orderId });
        return { ok: false, error: 'INSUFFICIENT_FUNDS' };
      }
      const coinsAfter = effectiveCoins(charged, channel);

      await this.core.cols.orders.updateOne({ _id: args.orderId }, { $set: { coinsAfter } });
      await this.core.cols.ledger.insertOne({
        accountId: args.accountId,
        delta: -amount,
        balanceAfter: coinsAfter,
        reason: args.reason,
        orderId: args.orderId,
        ts: this.core.now(),
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
      clientPlatform?: string;
    }): Promise<Result<{ coinsAfter: number }>> {
      const existing = await this.core.cols.orders.findOne({ _id: args.orderId });
      // Ownership check (2026-08-04 fix) — see shopCharge's identical guard above for the full rationale.
      if (existing) {
        if (existing.accountId !== args.accountId) return { ok: false, error: 'BAD_REQUEST' };
        return { ok: true, coinsAfter: existing.coinsAfter };
      }

      // Guard finiteness before flooring/clamping: Math.floor(Infinity)===Infinity, which would sail
      // through the `amount > 0` check below and reach credit()'s unconditional wallet $inc.
      const amount = Number.isFinite(args.amount) ? Math.max(0, Math.floor(args.amount)) : 0;
      // First claim the idempotent order slot (unique _id prevents concurrent duplicate grants), then credit coins + backfill coinsAfter.
      try {
        await this.core.cols.orders.insertOne({
          _id: args.orderId,
          accountId: args.accountId,
          kind: 'grant',
          cost: 0,
          status: 'delivered',
          coinsAfter: 0,
          result: {},
          deliveredAt: this.core.now(),
          ts: this.core.now(),
        });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) {
          const o = await this.core.cols.orders.findOne({ _id: args.orderId });
          if (o && o.accountId !== args.accountId) return { ok: false, error: 'BAD_REQUEST' };
          return { ok: true, coinsAfter: o?.coinsAfter ?? 0 };
        }
        throw e;
      }
      const coinsAfter =
        amount > 0
          ? await this.core.credit(args.accountId, amount, args.reason, { orderId: args.orderId, clientPlatform: args.clientPlatform })
          : effectiveCoins(await this.core.ensureWallet(args.accountId), spendChannelOf(args.clientPlatform));
      await this.core.cols.orders.updateOne({ _id: args.orderId }, { $set: { coinsAfter } });
      return { ok: true, coinsAfter };
    }
}
