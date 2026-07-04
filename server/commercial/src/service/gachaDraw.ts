// Gacha draw + Fate Point redemption (GACHA_DESIGN §7). Draw uses insert-first orderId idempotency (§6.5):
// reserve the order slot (with the rolled results) BEFORE debiting so concurrent same-orderId calls cannot both debit.
import { gachaCost, customPoolCost, FATE_POINT_REDEEM_COST } from '@nw/shared';
import type { GachaResultEntry } from '../db';
import { rollGacha, rollCustomGacha } from '../gacha';
import type { CommercialBaseCtor, Constructor, Result } from './base';

export interface GachaDrawHandlers {
  gachaDraw(args: {
    accountId: string;
    poolId: string;
    count: number;
    orderId: string;
  }): Promise<
    Result<{
      orderId: string;
      coinsAfter: number;
      pityAfter: number;
      results: GachaResultEntry[];
      fateGained: number;
      fatePointsAfter: number;
    }>
  >;
  redeemFate(args: {
    accountId: string;
    itemId: string;
    orderId: string;
  }): Promise<Result<{ orderId: string; itemId: string; coinsAfter: number; fatePointsAfter: number }>>;
}

export function GachaDrawMixin<TBase extends CommercialBaseCtor>(Base: TBase): TBase & Constructor<GachaDrawHandlers> {
  return class extends Base {
    /** Gacha draw: debit coins + RNG + update pity + record order/gachaHistory. Item delivery is handled by meta. */
    async gachaDraw(args: {
      accountId: string;
      poolId: string;
      count: number;
      orderId: string;
    }): Promise<
      Result<{
        orderId: string;
        coinsAfter: number;
        pityAfter: number;
        results: GachaResultEntry[];
        fateGained: number;
        fatePointsAfter: number;
      }>
    > {
      const existing = await this.cols.orders.findOne({ _id: args.orderId });
      if (existing && existing.result.results) {
        const w = await this.cols.wallets.findOne({ _id: existing.accountId });
        return {
          ok: true,
          orderId: existing._id,
          coinsAfter: existing.coinsAfter,
          pityAfter: existing.pityAfter?.[args.poolId] ?? 0,
          results: existing.result.results,
          fateGained: 0, // replay: fate already credited on the original draw
          fatePointsAfter: w?.fatePoints ?? 0,
        };
      }
      const resolved = await this.resolvePool(args.poolId, this.now());
      if (!resolved || (args.count !== 1 && args.count !== 10)) {
        return { ok: false, error: resolved ? 'BAD_REQUEST' : 'POOL_UNAVAILABLE' };
      }
      const cost =
        resolved.kind === 'custom' ? customPoolCost(resolved.cfg, args.count) : gachaCost(resolved.pool, args.count);

      const wallet = await this.ensureWallet(args.accountId);
      if (wallet.coins < cost) return { ok: false, error: 'INSUFFICIENT_FUNDS' };

      const prevPity = wallet.gacha.pity[args.poolId] ?? 0;
      // Custom pools (§12) have NO pity, NO soft-pity and NO featured-legendary/Fate logic — a plain weighted roll.
      // Derived/static pools keep the full pity + Fate machinery.
      let results: GachaResultEntry[];
      let pityAfter: number;
      let fateGained: number;
      if (resolved.kind === 'custom') {
        results = rollCustomGacha(resolved.cfg, args.count, this.rng);
        pityAfter = prevPity; // untouched: custom pools do not accrue pity
        fateGained = 0;
      } else {
        const pool = resolved.pool;
        const roll = rollGacha(pool, args.count, prevPity, this.rng);
        results = roll.results;
        pityAfter = roll.pityAfter;
        // Fate points (GACHA_DESIGN §7): in a limited pool, each legendary that is NOT the featured banner is a "歪" → +1.
        fateGained =
          pool.limited && pool.featuredLegendary
            ? results.filter((r) => r.rarity === 'legendary' && r.itemId !== pool.featuredLegendary).length
            : 0;
      }

      // Insert-first idempotency (§6.5): reserve the orderId slot (with the rolled results) BEFORE debiting so two
      // concurrent calls with the same orderId cannot both debit. E11000 → replay the existing draw's result.
      try {
        await this.cols.orders.insertOne({
          _id: args.orderId,
          accountId: args.accountId,
          kind: 'gacha',
          cost,
          status: 'charged',
          coinsAfter: 0, // back-filled after the debit succeeds
          result: { results, poolId: args.poolId },
          pityAfter: { [args.poolId]: pityAfter },
          ts: this.now(),
        });
      } catch (e) {
        if ((e as { code?: number }).code === 11000) {
          const o = await this.cols.orders.findOne({ _id: args.orderId });
          const w = await this.cols.wallets.findOne({ _id: args.accountId });
          return {
            ok: true,
            orderId: args.orderId,
            coinsAfter: o?.coinsAfter ?? 0,
            pityAfter: o?.pityAfter?.[args.poolId] ?? pityAfter,
            results: o?.result.results ?? results,
            fateGained: 0, // replay: fate already credited on the original draw
            fatePointsAfter: w?.fatePoints ?? 0,
          };
        }
        throw e;
      }
      // Debit coins + update pity for this pool (+ credit fate points); single-document atomic op with $gte guard.
      const charged = await this.cols.wallets.findOneAndUpdate(
        { _id: args.accountId, coins: { $gte: cost } },
        {
          $inc: { coins: -cost, rev: 1, ...(fateGained > 0 ? { fatePoints: fateGained } : {}) },
          $set: { [`gacha.pity.${args.poolId}`]: pityAfter, updatedAt: this.now() },
        },
        { returnDocument: 'after' },
      );
      if (!charged) {
        // Insufficient funds (raced drain after the pre-check): release the reserved slot before returning.
        await this.cols.orders.deleteOne({ _id: args.orderId });
        return { ok: false, error: 'INSUFFICIENT_FUNDS' };
      }
      const coinsAfter = charged.coins;
      const fatePointsAfter = charged.fatePoints ?? 0;

      await this.cols.orders.updateOne({ _id: args.orderId }, { $set: { coinsAfter } });
      await this.cols.ledger.insertOne({
        accountId: args.accountId,
        delta: -cost,
        balanceAfter: coinsAfter,
        reason: 'gacha',
        orderId: args.orderId,
        ts: this.now(),
      });
      await this.cols.gachaHistory.insertOne({
        accountId: args.accountId,
        poolId: args.poolId,
        orderId: args.orderId,
        results,
        pityBefore: prevPity,
        pityAfter,
        ts: this.now(),
      });
      return { ok: true, orderId: args.orderId, coinsAfter, pityAfter, results, fateGained, fatePointsAfter };
    }

    /**
     * Redeem Fate Points for a self-chosen past-featured legendary (GACHA_DESIGN §7.1). Deducts
     * FATE_POINT_REDEEM_COST atomically (guarded), records a `fate` order (meta delivers the skin like a gacha
     * order), and returns the chosen itemId + remaining points. Idempotent by orderId (replay returns the record).
     * The item must be (or have been) the featured legendary of some limited pool.
     */
    async redeemFate(args: {
      accountId: string;
      itemId: string;
      orderId: string;
    }): Promise<Result<{ orderId: string; itemId: string; coinsAfter: number; fatePointsAfter: number }>> {
      const existing = await this.cols.orders.findOne({ _id: args.orderId });
      if (existing) {
        const w = await this.cols.wallets.findOne({ _id: existing.accountId });
        return {
          ok: true,
          orderId: existing._id,
          itemId: existing.result.itemId ?? args.itemId,
          coinsAfter: existing.coinsAfter,
          fatePointsAfter: w?.fatePoints ?? 0,
        };
      }
      // The chosen item must be the featured legendary of some limited pool (past or present).
      const known = await this.cols.gachaPools.findOne({ featuredLegendary: args.itemId });
      if (!known) return { ok: false, error: 'FATE_INVALID_ITEM' };

      await this.ensureWallet(args.accountId);
      const charged = await this.cols.wallets.findOneAndUpdate(
        { _id: args.accountId, fatePoints: { $gte: FATE_POINT_REDEEM_COST } },
        { $inc: { fatePoints: -FATE_POINT_REDEEM_COST, rev: 1 }, $set: { updatedAt: this.now() } },
        { returnDocument: 'after' },
      );
      if (!charged) return { ok: false, error: 'FATE_INSUFFICIENT' };

      await this.cols.orders.insertOne({
        _id: args.orderId,
        accountId: args.accountId,
        kind: 'fate',
        cost: 0,
        status: 'charged',
        coinsAfter: charged.coins,
        result: { itemId: args.itemId },
        ts: this.now(),
      });
      return {
        ok: true,
        orderId: args.orderId,
        itemId: args.itemId,
        coinsAfter: charged.coins,
        fatePointsAfter: charged.fatePoints ?? 0,
      };
    }
  };
}
