// Starter pack buy (GACHA_DESIGN §6), once per account (starterUsed guard).
// The growth path reuses applySubscription on the base.
import {
  PRODUCT_STARTER_DRAW,
  PRODUCT_STARTER_GROWTH,
  STARTER_DRAW_COUNT,
  STARTER_DRAW_FLOOR,
  GROWTH_PACK_COINS,
  GROWTH_PACK_CARD_DAYS,
  findGachaPool,
} from '@nw/shared';
import type { GachaResultEntry } from '../db';
import { rollStarterPack } from '../gacha';
import type { Result, WalletView, WalletCore } from './base';
import { walletView } from './base';
import { effectiveCoins, rechargeChannelOf, spendChannelOf } from '../spendChannel';

export interface StarterHandlers {
  starterBuy(args: {
    accountId: string;
    productId: string;
    orderId: string;
    /** The caller's VERIFIED recharge platform (verifyNonCoinReceipt) — mapped to a recharged-pool bucket
     * via rechargeChannelOf (ADR-020) for starter_growth's coins. Irrelevant for starter_draw (no coins). */
    rechargePlatform?: string;
    clientPlatform?: string;
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; results: GachaResultEntry[]; wallet: WalletView }>>;
}

export class StarterService {
  constructor(private readonly core: WalletCore) {}

    /**
     * Buy a starter pack (GACHA_DESIGN §6), once per account (starterUsed guard).
     *  • starter_draw: a rare+ floored 10-pull on the standard pool (independent of pity); meta delivers the items.
     *  • starter_growth: GROWTH_PACK_COINS + a GROWTH_PACK_CARD_DAYS-day monthly card.
     * The first-7-days eligibility window for the growth pack is enforced upstream by meta (account age).
     */
    async starterBuy(args: {
      accountId: string;
      productId: string;
      orderId: string;
      rechargePlatform?: string;
      clientPlatform?: string;
    }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; results: GachaResultEntry[]; wallet: WalletView }>> {
      if (args.productId !== PRODUCT_STARTER_DRAW && args.productId !== PRODUCT_STARTER_GROWTH) {
        return { ok: false, error: 'BAD_REQUEST' };
      }
      const displayChannel = spendChannelOf(args.clientPlatform);
      const existing = await this.core.cols.orders.findOne({ _id: args.orderId });
      if (existing) {
        // Ownership check (2026-08-04 fix) — see shop.ts's shopCharge for the full rationale.
        if (existing.accountId !== args.accountId) return { ok: false, error: 'BAD_REQUEST' };
        // status:'charged' on the growth-pack path means a prior attempt claimed the slot but hasn't
        // flipped it to 'delivered' yet (see the insert below, same fix as subscriptionCardBuy in
        // base.ts). starter_draw orders are always inserted 'charged' by design (meta delivers the pack
        // items later) and must NOT be resumed here — only growth-pack orders (kind:'grant') carry
        // unfinished applySubscription work. Gated by isStaleClaim: a retry landing while the original
        // call is merely slow (not crashed) must not redo applySubscription itself (double-grant); only
        // resume for real once the claim is stale enough that the original is presumed dead.
        if (existing.status === 'charged' && existing.kind === 'grant') {
          if (this.core.isStaleClaim(existing.ts) && (await this.core.claimOrderResume(args.orderId))) {
            return this.finishStarterGrowth(args, existing.accountId);
          }
          const w0 = await this.core.cols.wallets.findOne({ _id: existing.accountId });
          return {
            ok: true,
            coinsAfter: effectiveCoins(w0, displayChannel),
            subscriptionExpiry: w0?.subscription?.expiry ?? 0,
            results: [],
            wallet: walletView(w0, args.clientPlatform),
          };
        }
        const w = await this.core.cols.wallets.findOne({ _id: existing.accountId });
        return {
          ok: true,
          coinsAfter: effectiveCoins(w, displayChannel),
          subscriptionExpiry: w?.subscription?.expiry ?? 0,
          results: existing.result.results ?? [],
          wallet: walletView(w, args.clientPlatform),
        };
      }
      const now = this.core.now();
      await this.core.ensureWallet(args.accountId);
      // Once-per-account claim: atomically add the product to starterUsed only if not already present.
      const claimed = await this.core.cols.wallets.findOneAndUpdate(
        { _id: args.accountId, starterUsed: { $ne: args.productId } },
        { $addToSet: { starterUsed: args.productId }, $set: { updatedAt: now } },
        { returnDocument: 'after' },
      );
      if (!claimed) return { ok: false, error: 'ALREADY_PURCHASED' };

      if (args.productId === PRODUCT_STARTER_DRAW) {
        const std = findGachaPool('standard')!;
        const results = rollStarterPack(std, STARTER_DRAW_COUNT, STARTER_DRAW_FLOOR, this.core.rng);
        const coinsAfter = effectiveCoins(claimed, displayChannel);
        await this.core.cols.orders.insertOne({
          _id: args.orderId,
          accountId: args.accountId,
          kind: 'starter',
          cost: 0,
          status: 'charged', // meta delivers the pack items, then marks delivered
          coinsAfter,
          result: { results, poolId: 'standard' },
          ts: now,
        });
        return { ok: true, coinsAfter, subscriptionExpiry: claimed.subscription?.expiry ?? 0, results, wallet: walletView(claimed, args.clientPlatform) };
      }

      // starter_growth: coins + 7-day card. Reserve the order slot as 'charged' BEFORE applySubscription
      // runs (not after) — a crash between the two must leave a resumable 'charged' row, not report
      // fabricated success while the grant never happened (see the existing-order branch above).
      await this.core.cols.orders.insertOne({
        _id: args.orderId,
        accountId: args.accountId,
        kind: 'grant',
        cost: 0,
        status: 'charged',
        coinsAfter: 0,
        result: {},
        ts: now,
      });
      return this.finishStarterGrowth(args, args.accountId);
    }

    private async finishStarterGrowth(
      args: { accountId: string; orderId: string; rechargePlatform?: string; clientPlatform?: string },
      accountId: string,
    ): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; results: GachaResultEntry[]; wallet: WalletView }>> {
      const now = this.core.now();
      // Real money (¥30) — fund the caller's verified recharge channel (ADR-020), not the free pool.
      const growthChannel = args.rechargePlatform ? (rechargeChannelOf(args.rechargePlatform) ?? undefined) : undefined;
      const { coinsAfter, expiry, wallet } = await this.core.applySubscription(
        accountId,
        GROWTH_PACK_CARD_DAYS,
        GROWTH_PACK_COINS,
        now,
        {
          orderId: args.orderId,
          reason: 'starter_growth',
          channel: growthChannel,
          clientPlatform: args.clientPlatform,
        },
      );
      await this.core.cols.orders.updateOne(
        { _id: args.orderId },
        { $set: { status: 'delivered', coinsAfter, deliveredAt: now } },
      );
      return { ok: true, coinsAfter, subscriptionExpiry: expiry, results: [], wallet: walletView(wallet, args.clientPlatform, growthChannel) };
    }
}
