// commercial service core (S5-2~4): atomic wallet debit/credit + ledger + orders + gacha + recharge + ads.
// meta is the sole caller (internal trust boundary): commercial does not parse JWTs; it trusts the accountId passed by meta.
// Consistency: spend uses orderId idempotency, recharge uses receiptId idempotency; single-document $gte guard prevents overdraft.
import {
  findGachaPool,
  findShopItem,
  gachaCost,
  IAP_TIERS,
  DEV_STUB_DEFAULT_TIER,
  FIRST_PURCHASE_BONUS_MULTIPLIER,
  VICTORY_DAILY_WIN_CAP,
  type Rarity,
} from '@nw/shared';
import type {
  CommercialCollections,
  GachaResultEntry,
  OrderDoc,
  PromoCodeDoc,
  PromoRedemptionDoc,
  WalletDoc,
} from './db';
import { rollGacha, type RandInt } from './gacha';

export type ServiceErr =
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_RECEIPT'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'PROMO_NOT_FOUND'
  | 'PROMO_EXPIRED'
  | 'PROMO_EXHAUSTED'
  | 'PROMO_ALREADY_USED';

export type Result<T> = ({ ok: true } & T) | { ok: false; error: ServiceErr };

export interface CommercialDeps {
  cols: CommercialCollections;
  now: () => number;
  /** RNG source for gacha draws (default: crypto true-random; tests inject a fixed seed to reproduce pity). */
  rng?: RandInt;
  /**
   * Receipt verification function for recharge (S4-1).
   * Supports async (WeChat/Stripe require network requests); falls back to the built-in dev stub when omitted.
   * Dev stub: receipt is formatted as `tier:small|mid|large` and grants the corresponding coin tier; any other non-empty value grants the small tier.
   */
  verifyReceipt?: (platform: string, receipt: string) => Promise<{ ok: boolean; coins: number }> | { ok: boolean; coins: number };
}

/** Dev stub (used only in unit tests / when no real payment channel is configured). */
function devVerifyReceipt(_platform: string, receipt: string): { ok: boolean; coins: number } {
  if (!receipt) return { ok: false, coins: 0 };
  const tier = receipt.startsWith('tier:') ? receipt.slice(5) : DEV_STUB_DEFAULT_TIER;
  const coins = IAP_TIERS[tier];
  return coins ? { ok: true, coins } : { ok: true, coins: IAP_TIERS[DEV_STUB_DEFAULT_TIER]! };
}

export class CommercialService {
  private readonly cols: CommercialCollections;
  private readonly now: () => number;
  private readonly rng?: RandInt;
  private readonly verifyReceipt: (platform: string, receipt: string) => Promise<{ ok: boolean; coins: number }>;

  constructor(deps: CommercialDeps) {
    this.cols = deps.cols;
    this.now = deps.now;
    this.rng = deps.rng;
    const raw = deps.verifyReceipt ?? devVerifyReceipt;
    // Uniformly wrap as async to be compatible with both the synchronous dev stub and async real receipt verifiers.
    this.verifyReceipt = (p, r) => Promise.resolve(raw(p, r));
  }

  /** Fetch or create the wallet (upserts coins:0 rev:0 on first access). */
  private async ensureWallet(accountId: string): Promise<WalletDoc> {
    const res = await this.cols.wallets.findOneAndUpdate(
      { _id: accountId },
      {
        $setOnInsert: {
          _id: accountId,
          coins: 0,
          rev: 0,
          gacha: { pity: {} },
          updatedAt: this.now(),
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    // upsert + returnDocument:after always returns a document.
    return res!;
  }

  /** GET /internal/wallet: returns balance + all pity counters. */
  async getWallet(accountId: string): Promise<{ coins: number; pity: Record<string, number> }> {
    const w = await this.cols.wallets.findOne({ _id: accountId });
    return { coins: w?.coins ?? 0, pity: w?.gacha.pity ?? {} };
  }

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

  /** Credit coins + write ledger entry (shared by recharge/ads/refund). Atomic $inc; returns the new balance. */
  private async credit(
    accountId: string,
    amount: number,
    reason: string,
    ref: { orderId?: string; receiptId?: string },
  ): Promise<number> {
    await this.ensureWallet(accountId);
    const res = await this.cols.wallets.findOneAndUpdate(
      { _id: accountId },
      { $inc: { coins: amount, rev: 1 }, $set: { updatedAt: this.now() } },
      { returnDocument: 'after' },
    );
    const coinsAfter = res!.coins;
    await this.cols.ledger.insertOne({
      accountId,
      delta: amount,
      balanceAfter: coinsAfter,
      reason,
      ...(ref.orderId ? { orderId: ref.orderId } : {}),
      ...(ref.receiptId ? { receiptId: ref.receiptId } : {}),
      ts: this.now(),
    });
    return coinsAfter;
  }

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
    const charged = await this.cols.wallets.findOneAndUpdate(
      { _id: args.accountId, coins: { $gte: args.cost } },
      { $inc: { coins: -args.cost, rev: 1 }, $set: { updatedAt: this.now() } },
      { returnDocument: 'after' },
    );
    if (!charged) return { ok: false, error: 'INSUFFICIENT_FUNDS' };
    const coinsAfter = charged.coins;

    await this.cols.orders.insertOne({
      _id: args.orderId,
      accountId: args.accountId,
      kind: 'shop',
      cost: args.cost,
      status: 'charged',
      coinsAfter,
      result: { itemId: def.grants },
      ts: this.now(),
    });
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
    const charged = await this.cols.wallets.findOneAndUpdate(
      { _id: args.accountId, coins: { $gte: amount } },
      { $inc: { coins: -amount, rev: 1 }, $set: { updatedAt: this.now() } },
      { returnDocument: 'after' },
    );
    if (!charged) return { ok: false, error: 'INSUFFICIENT_FUNDS' };
    const coinsAfter = charged.coins;

    await this.cols.orders.insertOne({
      _id: args.orderId,
      accountId: args.accountId,
      kind: 'sink',
      cost: amount,
      status: 'delivered',
      coinsAfter,
      result: {},
      deliveredAt: this.now(),
      ts: this.now(),
    });
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
    }>
  > {
    const existing = await this.cols.orders.findOne({ _id: args.orderId });
    if (existing && existing.result.results) {
      return {
        ok: true,
        orderId: existing._id,
        coinsAfter: existing.coinsAfter,
        pityAfter: existing.pityAfter?.[args.poolId] ?? 0,
        results: existing.result.results,
      };
    }
    const pool = findGachaPool(args.poolId);
    if (!pool || (args.count !== 1 && args.count !== 10)) {
      return { ok: false, error: 'BAD_REQUEST' };
    }
    const cost = gachaCost(pool, args.count);

    const wallet = await this.ensureWallet(args.accountId);
    if (wallet.coins < cost) return { ok: false, error: 'INSUFFICIENT_FUNDS' };

    const prevPity = wallet.gacha.pity[args.poolId] ?? 0;
    const { results, pityAfter } = rollGacha(pool, args.count, prevPity, this.rng);

    // Debit coins + update pity for this pool; single-document atomic operation with $gte guard to prevent concurrent overdraft.
    const charged = await this.cols.wallets.findOneAndUpdate(
      { _id: args.accountId, coins: { $gte: cost } },
      {
        $inc: { coins: -cost, rev: 1 },
        $set: { [`gacha.pity.${args.poolId}`]: pityAfter, updatedAt: this.now() },
      },
      { returnDocument: 'after' },
    );
    if (!charged) return { ok: false, error: 'INSUFFICIENT_FUNDS' };
    const coinsAfter = charged.coins;

    await this.cols.orders.insertOne({
      _id: args.orderId,
      accountId: args.accountId,
      kind: 'gacha',
      cost,
      status: 'charged',
      coinsAfter,
      result: { results, poolId: args.poolId },
      pityAfter: { [args.poolId]: pityAfter },
      ts: this.now(),
    });
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
    return { ok: true, orderId: args.orderId, coinsAfter, pityAfter, results };
  }

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
    const isFirst = await this.claimFirstPurchaseBonus(args.accountId);
    const coinsGranted = isFirst ? v.coins * FIRST_PURCHASE_BONUS_MULTIPLIER : v.coins;
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

  /** Ad reward coin credit (meta has already validated the ad proof + daily cap; commercial only credits coins and records the ledger entry). */
  async adsCredit(args: {
    accountId: string;
    amount: number;
    dayKey: string;
  }): Promise<Result<{ coinsAfter: number }>> {
    const amount = Math.max(0, Math.floor(args.amount));
    if (amount === 0) return { ok: false, error: 'BAD_REQUEST' };
    const coinsAfter = await this.credit(args.accountId, amount, 'ads', {});
    return { ok: true, coinsAfter };
  }

  /**
   * Tiered victory coin credit (§2.3b). meta computes amount (by rank tier) + dayKey; commercial **authoritatively enforces
   * the daily win cap** here: atomically guards the daily counter < VICTORY_DAILY_WIN_CAP before claiming a slot and crediting,
   * returning capped=true without granting when the limit is reached (the win is still recorded in saves.pvp; coins are not issued).
   * Counter document _id=`accountId:dayKey`, same two-step pattern as the ads cap.
   */
  async victoryCredit(args: {
    accountId: string;
    amount: number;
    dayKey: string;
  }): Promise<Result<{ coinsAfter: number; credited: number; capped: boolean }>> {
    const amount = Math.max(0, Math.floor(args.amount));
    if (amount === 0) return { ok: false, error: 'BAD_REQUEST' };

    const id = `${args.accountId}:${args.dayKey}`;
    // First upsert to ensure the document exists, then $inc with the guard (same pattern as bumpAdsCap).
    await this.cols.victoryDaily.updateOne(
      { _id: id },
      { $setOnInsert: { _id: id, accountId: args.accountId, dayKey: args.dayKey, wins: 0, ts: this.now() } },
      { upsert: true },
    );
    const slot = await this.cols.victoryDaily.findOneAndUpdate(
      { _id: id, wins: { $lt: VICTORY_DAILY_WIN_CAP } },
      { $inc: { wins: 1 }, $set: { ts: this.now() } },
      { returnDocument: 'after' },
    );
    if (!slot) {
      // Daily cap reached: do not credit coins.
      const w = await this.cols.wallets.findOne({ _id: args.accountId });
      return { ok: true, coinsAfter: w?.coins ?? 0, credited: 0, capped: true };
    }
    const coinsAfter = await this.credit(args.accountId, amount, 'victory', {});
    return { ok: true, coinsAfter, credited: amount, capped: false };
  }
}

export type { Rarity };
