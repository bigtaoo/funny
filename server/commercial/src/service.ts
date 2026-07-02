// commercial service core (S5-2~4): atomic wallet debit/credit + ledger + orders + gacha + recharge + ads.
// meta is the sole caller (internal trust boundary): commercial does not parse JWTs; it trusts the accountId passed by meta.
// Consistency: spend uses orderId idempotency, recharge uses receiptId idempotency; single-document $gte guard prevents overdraft.
import {
  findGachaPool,
  findShopItem,
  gachaCost,
  buildLimitedPool,
  isLimitedPoolActive,
  IAP_TIERS,
  DEV_STUB_DEFAULT_TIER,
  FIRST_PURCHASE_BONUS_MULTIPLIER,
  VICTORY_DAILY_WIN_CAP,
  FATE_POINT_REDEEM_COST,
  MONTHLY_CARD_DAYS,
  MONTHLY_CARD_DAILY_COINS,
  MONTHLY_CARD_IMMEDIATE_COINS,
  GROWTH_PACK_COINS,
  GROWTH_PACK_CARD_DAYS,
  STARTER_DRAW_COUNT,
  STARTER_DRAW_FLOOR,
  PRODUCT_MONTHLY_CARD,
  PRODUCT_STARTER_DRAW,
  PRODUCT_STARTER_GROWTH,
  type Rarity,
  type GachaPoolDef,
  type LimitedPoolConfig,
} from '@nw/shared';
import type {
  CommercialCollections,
  GachaPoolDoc,
  GachaResultEntry,
  OrderDoc,
  PromoCodeDoc,
  PromoRedemptionDoc,
  WalletDoc,
} from './db';
import { rollGacha, rollStarterPack, type RandInt } from './gacha';

export type ServiceErr =
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_RECEIPT'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'PROMO_NOT_FOUND'
  | 'PROMO_EXPIRED'
  | 'PROMO_EXHAUSTED'
  | 'PROMO_ALREADY_USED'
  | 'POOL_UNAVAILABLE'
  | 'FATE_INSUFFICIENT'
  | 'FATE_INVALID_ITEM'
  | 'ALREADY_PURCHASED';

/** Wallet view returned to meta (mirrored into SaveData). Includes monetization state (§5–§7). */
export interface WalletView {
  coins: number;
  pity: Record<string, number>;
  fatePoints: number;
  subscriptionExpiry: number; // 0 = no active subscription
  starterUsed: string[];
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: ServiceErr };

export interface CommercialDeps {
  cols: CommercialCollections;
  now: () => number;
  /** RNG source for gacha draws (default: crypto true-random; tests inject a fixed seed to reproduce pity). */
  rng?: RandInt;
  /**
   * Receipt verification function for recharge (S4-1).
   * Supports async (WeChat/Stripe require network requests); falls back to the built-in dev stub when omitted.
   * Dev stub: receipt is formatted as `tier:<tierId>` (e.g. `tier:t499`) and grants the corresponding coin tier; any other non-empty value grants the default dev-stub tier (DEV_STUB_DEFAULT_TIER).
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

/** Project a wallet document into the meta-facing view (defaults for lazily-absent monetization fields). */
function walletView(w: WalletDoc | null): WalletView {
  return {
    coins: w?.coins ?? 0,
    pity: w?.gacha.pity ?? {},
    fatePoints: w?.fatePoints ?? 0,
    subscriptionExpiry: w?.subscription?.expiry ?? 0,
    starterUsed: w?.starterUsed ?? [],
  };
}

/** Strip the mongo/audit fields off a GachaPoolDoc back to a plain LimitedPoolConfig. */
function limitedConfigFromDoc(doc: GachaPoolDoc): LimitedPoolConfig {
  return {
    id: doc.id,
    name: doc.name,
    featuredLegendary: doc.featuredLegendary,
    startAt: doc.startAt,
    endAt: doc.endAt,
    ...(doc.fillerLegendaries ? { fillerLegendaries: doc.fillerLegendaries } : {}),
  };
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

  /** GET /internal/wallet: returns balance + all pity counters + monetization state (§5–§7). */
  async getWallet(accountId: string): Promise<WalletView> {
    const w = await this.cols.wallets.findOne({ _id: accountId });
    return walletView(w);
  }

  /**
   * Resolve a pool id to a full definition (GACHA_DESIGN §2). Static pools (standard/unit cards) come from
   * @nw/shared; limited pools are built from the admin-authored config in `gachaPools` and are only returned
   * while inside their [startAt, endAt) window. Returns null when unknown or a closed/out-of-window limited pool.
   */
  private async resolvePool(poolId: string, now: number): Promise<GachaPoolDef | null> {
    const stat = findGachaPool(poolId);
    if (stat) return stat;
    const doc = await this.cols.gachaPools.findOne({ _id: poolId });
    if (!doc || !isLimitedPoolActive(doc, now)) return null;
    return buildLimitedPool(limitedConfigFromDoc(doc));
  }

  /** Create (or overwrite) a limited pool config (admin, GACHA_DESIGN §2.2). */
  async createLimitedPool(args: {
    config: LimitedPoolConfig;
    createdBy: string;
  }): Promise<Result<{ id: string }>> {
    const c = args.config;
    if (!c.id || !c.name || !c.featuredLegendary) return { ok: false, error: 'BAD_REQUEST' };
    if (!(c.endAt > c.startAt)) return { ok: false, error: 'BAD_REQUEST' };
    if (findGachaPool(c.id)) return { ok: false, error: 'BAD_REQUEST' }; // must not shadow a static pool id
    const doc: GachaPoolDoc = {
      _id: c.id,
      id: c.id,
      name: c.name,
      featuredLegendary: c.featuredLegendary,
      startAt: c.startAt,
      endAt: c.endAt,
      ...(c.fillerLegendaries ? { fillerLegendaries: c.fillerLegendaries } : {}),
      createdBy: args.createdBy,
      createdAt: this.now(),
    };
    await this.cols.gachaPools.replaceOne({ _id: c.id }, doc, { upsert: true });
    return { ok: true, id: c.id };
  }

  /** Close a limited pool early (clamp endAt to now); the config is retained so its featured legendary stays Fate-redeemable. */
  async closeLimitedPool(args: { id: string }): Promise<Result<{ id: string }>> {
    const now = this.now();
    const res = await this.cols.gachaPools.findOneAndUpdate(
      { _id: args.id },
      { $set: { endAt: now, closedAt: now } },
    );
    if (!res) return { ok: false, error: 'NOT_FOUND' };
    return { ok: true, id: args.id };
  }

  /** List all limited pool configs (admin management). */
  async listLimitedPools(): Promise<GachaPoolDoc[]> {
    return this.cols.gachaPools.find({}).sort({ createdAt: -1 }).toArray();
  }

  /** List currently-open limited pool configs (for the client gacha listing). */
  async listActiveLimitedPools(now: number): Promise<GachaPoolDoc[]> {
    return (await this.cols.gachaPools.find({}).toArray()).filter((p) => isLimitedPoolActive(p, now));
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
    const pool = await this.resolvePool(args.poolId, this.now());
    if (!pool || (args.count !== 1 && args.count !== 10)) {
      return { ok: false, error: pool ? 'BAD_REQUEST' : 'POOL_UNAVAILABLE' };
    }
    const cost = gachaCost(pool, args.count);

    const wallet = await this.ensureWallet(args.accountId);
    if (wallet.coins < cost) return { ok: false, error: 'INSUFFICIENT_FUNDS' };

    const prevPity = wallet.gacha.pity[args.poolId] ?? 0;
    const { results, pityAfter } = rollGacha(pool, args.count, prevPity, this.rng);

    // Fate points (GACHA_DESIGN §7): in a limited pool, each legendary that is NOT the featured banner is a "歪" → +1.
    const fateGained =
      pool.limited && pool.featuredLegendary
        ? results.filter((r) => r.rarity === 'legendary' && r.itemId !== pool.featuredLegendary).length
        : 0;

    // Debit coins + update pity for this pool (+ credit fate points); single-document atomic op with $gte guard.
    const charged = await this.cols.wallets.findOneAndUpdate(
      { _id: args.accountId, coins: { $gte: cost } },
      {
        $inc: { coins: -cost, rev: 1, ...(fateGained > 0 ? { fatePoints: fateGained } : {}) },
        $set: { [`gacha.pity.${args.poolId}`]: pityAfter, updatedAt: this.now() },
      },
      { returnDocument: 'after' },
    );
    if (!charged) return { ok: false, error: 'INSUFFICIENT_FUNDS' };
    const coinsAfter = charged.coins;
    const fatePointsAfter = charged.fatePoints ?? 0;

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

  /**
   * Extend the subscription by `days` (stacking = extend from max(now, current expiry)) + optionally credit
   * `immediateCoins`, in one atomic aggregation-pipeline update. Writes a ledger entry for the immediate coins.
   * Callers gate idempotency upstream (order slot / starterUsed claim) so this never double-applies.
   */
  private async applySubscription(
    accountId: string,
    days: number,
    immediateCoins: number,
    now: number,
    ref: { orderId?: string; reason?: string },
  ): Promise<{ coinsAfter: number; expiry: number }> {
    await this.ensureWallet(accountId);
    const ms = days * 86400000;
    const res = await this.cols.wallets.findOneAndUpdate(
      { _id: accountId },
      [
        {
          $set: {
            'subscription.expiry': {
              $add: [{ $max: [{ $ifNull: ['$subscription.expiry', now] }, now] }, ms],
            },
            coins: { $add: ['$coins', immediateCoins] },
            rev: { $add: ['$rev', 1] },
            updatedAt: now,
          },
        },
      ],
      { returnDocument: 'after' },
    );
    const coinsAfter = res!.coins;
    if (immediateCoins > 0) {
      await this.cols.ledger.insertOne({
        accountId,
        delta: immediateCoins,
        balanceAfter: coinsAfter,
        reason: ref.reason ?? 'monthly_card',
        ...(ref.orderId ? { orderId: ref.orderId } : {}),
        ts: now,
      });
    }
    return { coinsAfter, expiry: res!.subscription?.expiry ?? now + ms };
  }

  /**
   * Activate / renew the monthly card (GACHA_DESIGN §5). Idempotent by orderId. Extends the subscription by
   * MONTHLY_CARD_DAYS and grants MONTHLY_CARD_IMMEDIATE_COINS at once. Real IAP receipt verification is the
   * caller's concern (meta); here it is treated as an already-authorized purchase.
   */
  async monthlyCardBuy(args: {
    accountId: string;
    orderId: string;
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number }>> {
    const existing = await this.cols.orders.findOne({ _id: args.orderId });
    if (existing) {
      const w = await this.cols.wallets.findOne({ _id: existing.accountId });
      return { ok: true, coinsAfter: w?.coins ?? 0, subscriptionExpiry: w?.subscription?.expiry ?? 0 };
    }
    const now = this.now();
    try {
      await this.cols.orders.insertOne({
        _id: args.orderId,
        accountId: args.accountId,
        kind: 'grant',
        cost: 0,
        status: 'delivered',
        coinsAfter: 0,
        result: {},
        deliveredAt: now,
        ts: now,
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        const w = await this.cols.wallets.findOne({ _id: args.accountId });
        return { ok: true, coinsAfter: w?.coins ?? 0, subscriptionExpiry: w?.subscription?.expiry ?? 0 };
      }
      throw e;
    }
    const { coinsAfter, expiry } = await this.applySubscription(
      args.accountId,
      MONTHLY_CARD_DAYS,
      MONTHLY_CARD_IMMEDIATE_COINS,
      now,
      { orderId: args.orderId },
    );
    await this.cols.orders.updateOne({ _id: args.orderId }, { $set: { coinsAfter } });
    return { ok: true, coinsAfter, subscriptionExpiry: expiry };
  }

  /**
   * Claim the monthly card's daily coins (GACHA_DESIGN §5): +MONTHLY_CARD_DAILY_COINS, once per UTC day.
   * Atomically guarded on an active subscription (expiry > now) AND lastClaimDayKey !== dayKey.
   * Returns claimed:0 (no error) when there is no active card or it was already claimed today.
   */
  async monthlyCardClaim(args: {
    accountId: string;
    dayKey: string;
  }): Promise<Result<{ coinsAfter: number; claimed: number; subscriptionExpiry: number }>> {
    const now = this.now();
    await this.ensureWallet(args.accountId);
    const res = await this.cols.wallets.findOneAndUpdate(
      { _id: args.accountId, 'subscription.expiry': { $gt: now }, 'subscription.lastClaimDayKey': { $ne: args.dayKey } },
      {
        $inc: { coins: MONTHLY_CARD_DAILY_COINS, rev: 1 },
        $set: { 'subscription.lastClaimDayKey': args.dayKey, updatedAt: now },
      },
      { returnDocument: 'after' },
    );
    if (!res) {
      const w = await this.cols.wallets.findOne({ _id: args.accountId });
      return { ok: true, coinsAfter: w?.coins ?? 0, claimed: 0, subscriptionExpiry: w?.subscription?.expiry ?? 0 };
    }
    await this.cols.ledger.insertOne({
      accountId: args.accountId,
      delta: MONTHLY_CARD_DAILY_COINS,
      balanceAfter: res.coins,
      reason: 'monthly_card_daily',
      ts: now,
    });
    return { ok: true, coinsAfter: res.coins, claimed: MONTHLY_CARD_DAILY_COINS, subscriptionExpiry: res.subscription?.expiry ?? 0 };
  }

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
  }): Promise<Result<{ coinsAfter: number; subscriptionExpiry: number; results: GachaResultEntry[] }>> {
    if (args.productId !== PRODUCT_STARTER_DRAW && args.productId !== PRODUCT_STARTER_GROWTH) {
      return { ok: false, error: 'BAD_REQUEST' };
    }
    const existing = await this.cols.orders.findOne({ _id: args.orderId });
    if (existing) {
      const w = await this.cols.wallets.findOne({ _id: existing.accountId });
      return {
        ok: true,
        coinsAfter: w?.coins ?? 0,
        subscriptionExpiry: w?.subscription?.expiry ?? 0,
        results: existing.result.results ?? [],
      };
    }
    const now = this.now();
    await this.ensureWallet(args.accountId);
    // Once-per-account claim: atomically add the product to starterUsed only if not already present.
    const claimed = await this.cols.wallets.findOneAndUpdate(
      { _id: args.accountId, starterUsed: { $ne: args.productId } },
      { $addToSet: { starterUsed: args.productId }, $set: { updatedAt: now } },
      { returnDocument: 'after' },
    );
    if (!claimed) return { ok: false, error: 'ALREADY_PURCHASED' };

    if (args.productId === PRODUCT_STARTER_DRAW) {
      const std = findGachaPool('standard')!;
      const results = rollStarterPack(std, STARTER_DRAW_COUNT, STARTER_DRAW_FLOOR, this.rng);
      await this.cols.orders.insertOne({
        _id: args.orderId,
        accountId: args.accountId,
        kind: 'starter',
        cost: 0,
        status: 'charged', // meta delivers the pack items, then marks delivered
        coinsAfter: claimed.coins,
        result: { results, poolId: 'standard' },
        ts: now,
      });
      return { ok: true, coinsAfter: claimed.coins, subscriptionExpiry: claimed.subscription?.expiry ?? 0, results };
    }

    // starter_growth: coins + 7-day card (no items to deliver → order lands delivered).
    const { coinsAfter, expiry } = await this.applySubscription(
      args.accountId,
      GROWTH_PACK_CARD_DAYS,
      GROWTH_PACK_COINS,
      now,
      { orderId: args.orderId, reason: 'starter_growth' },
    );
    await this.cols.orders.insertOne({
      _id: args.orderId,
      accountId: args.accountId,
      kind: 'grant',
      cost: 0,
      status: 'delivered',
      coinsAfter,
      result: {},
      deliveredAt: now,
      ts: now,
    });
    return { ok: true, coinsAfter, subscriptionExpiry: expiry, results: [] };
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
