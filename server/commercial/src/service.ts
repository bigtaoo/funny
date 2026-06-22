// commercial 业务核心（S5-2~4）：钱包原子扣/加币 + 流水 + 订单 + 盲盒 + 充值 + 广告。
// meta 是唯一调用方（内部信任边界）：commercial 不解析 JWT，只信 meta 传来的 accountId。
// 一致性：消费用 orderId 幂等、充值用 receiptId 幂等；扣币单文档 $gte 守卫防超扣。
import {
  findGachaPool,
  findShopItem,
  gachaCost,
  IAP_TIERS,
  VICTORY_DAILY_WIN_CAP,
  type Rarity,
} from '@nw/shared';
import type {
  CommercialCollections,
  GachaResultEntry,
  OrderDoc,
  WalletDoc,
} from './db';
import { rollGacha, type RandInt } from './gacha';

export type ServiceErr =
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_RECEIPT'
  | 'NOT_FOUND'
  | 'BAD_REQUEST';

export type Result<T> = ({ ok: true } & T) | { ok: false; error: ServiceErr };

export interface CommercialDeps {
  cols: CommercialCollections;
  now: () => number;
  /** 盲盒随机源（默认 crypto 真随机；测试注入复现保底）。 */
  rng?: RandInt;
  /**
   * 充值票据验单函数（S4-1）。
   * 支持 async（微信/Stripe 需网络请求）；不传则用内置 dev 桩。
   * dev 桩：receipt 形如 `tier:small|mid|large`，按档发币；其余非空一律给小档。
   */
  verifyReceipt?: (platform: string, receipt: string) => Promise<{ ok: boolean; coins: number }> | { ok: boolean; coins: number };
}

/** dev 桩（仅单元测试 / 不配置真实渠道时回退）。 */
function devVerifyReceipt(_platform: string, receipt: string): { ok: boolean; coins: number } {
  if (!receipt) return { ok: false, coins: 0 };
  const tier = receipt.startsWith('tier:') ? receipt.slice(5) : 'small';
  const coins = IAP_TIERS[tier];
  return coins ? { ok: true, coins } : { ok: true, coins: IAP_TIERS.small! };
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
    // 统一包装为 async，兼容同步 dev 桩与 async 真实验单。
    this.verifyReceipt = (p, r) => Promise.resolve(raw(p, r));
  }

  /** 取/建钱包（首次操作 upsert coins:0 rev:0）。 */
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
    // upsert + returnDocument:after 必有文档。
    return res!;
  }

  /** GET /internal/wallet：余额 + 全部 pity。 */
  async getWallet(accountId: string): Promise<{ coins: number; pity: Record<string, number> }> {
    const w = await this.cols.wallets.findOne({ _id: accountId });
    return { coins: w?.coins ?? 0, pity: w?.gacha.pity ?? {} };
  }

  /** 加币 + 写流水（充值/广告/退币共用）。原子 $inc，返回新余额。 */
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

  /** 商店直购：扣币 + 记 order(kind:'shop')。物品由 meta 发。 */
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
    // cost 由可信的 meta 传入；这里仍交叉核对目录价，防 meta 侧失配（直购 legendary 不售也会无价）。
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
   * 纯金币消耗（改名等无发货物品的 sink）：原子扣币 + 记 order(kind:'sink', 落库即 delivered)
   * + 流水。orderId 幂等（重放回原余额）。对账只扫 status:'charged'，故 sink 不会被补发。
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
   * 纯金币发放（邮件附件领取 S6-3 等无扣费的入账）：原子加币 + 记 order(kind:'grant'，落库即
   * delivered) + 流水。orderId 幂等（重放回原余额，对账不拾取）。amount 可为 0（纯物品/皮肤附件
   * 也走此处占一个幂等订单，金额 0 不加币）。
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
    // 先占幂等订单（unique _id 防并发重复发币），再加币 + 回填 coinsAfter。
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

  /** 盲盒：扣币 + RNG + 更新保底 + 记 order/gachaHistory。物品由 meta 发。 */
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

    // 扣币 + 更新该池 pity，单文档原子 + $gte 守卫（防并发超扣）。
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
   * 标记订单已发货（meta 发完物品回调，幂等闭环）。
   * 可选 refundCoins：meta 算出的 dupe 退币（epic/legendary 重复），delivered 时一次入账。
   */
  async orderDelivered(args: { orderId: string; refundCoins?: number }): Promise<Result<{}>> {
    const order = await this.cols.orders.findOne({ _id: args.orderId });
    if (!order) return { ok: false, error: 'NOT_FOUND' };
    if (order.status === 'delivered') return { ok: true }; // 幂等：已发货不重复退币

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

  /** 对账：拉某账号未发货订单（meta GET /save 顺带补发）。 */
  async undeliveredOrders(accountId: string): Promise<OrderDoc[]> {
    return this.cols.orders.find({ accountId, status: 'charged' }).toArray();
  }

  /** 充值验单 + 加币（commercial 自验平台票据；dev 用桩）。receiptId 幂等。 */
  async rechargeVerify(args: {
    accountId: string;
    platform: string;
    receipt: string;
    receiptId: string;
  }): Promise<Result<{ coinsAfter: number; coinsGranted: number }>> {
    const existing = await this.cols.recharges.findOne({ _id: args.receiptId });
    if (existing) {
      const w = await this.cols.wallets.findOne({ _id: existing.accountId });
      return { ok: true, coinsAfter: w?.coins ?? 0, coinsGranted: existing.coinsGranted };
    }
    const v = await this.verifyReceipt(args.platform, args.receipt);
    if (!v.ok) return { ok: false, error: 'INVALID_RECEIPT' };

    // 先落票据（receiptId 唯一防并发重复发币），再加币。
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
      // 并发竞态：唯一冲突说明已有人处理，回读返回原结果。
      if ((e as { code?: number }).code === 11000) {
        const w = await this.cols.wallets.findOne({ _id: args.accountId });
        const r = await this.cols.recharges.findOne({ _id: args.receiptId });
        return { ok: true, coinsAfter: w?.coins ?? 0, coinsGranted: r?.coinsGranted ?? v.coins };
      }
      throw e;
    }
    const coinsAfter = await this.credit(args.accountId, v.coins, 'recharge', {
      receiptId: args.receiptId,
    });
    return { ok: true, coinsAfter, coinsGranted: v.coins };
  }

  /** 广告奖励加币（meta 已校验广告凭证 + 当日 cap，commercial 只加币记账）。 */
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
   * 分段胜利金币加币（§2.3b）。meta 算好 amount（按段位）+ dayKey；commercial 在此**权威 enforce
   * 每日胜局上限**：原子守卫当日计数 < VICTORY_DAILY_WIN_CAP 才占一格并发币，超限 capped=true 不发
   * （胜场已计在 saves.pvp，金币不发）。计数文档 _id=`accountId:dayKey`，与广告 cap 同款两步法。
   */
  async victoryCredit(args: {
    accountId: string;
    amount: number;
    dayKey: string;
  }): Promise<Result<{ coinsAfter: number; credited: number; capped: boolean }>> {
    const amount = Math.max(0, Math.floor(args.amount));
    if (amount === 0) return { ok: false, error: 'BAD_REQUEST' };

    const id = `${args.accountId}:${args.dayKey}`;
    // 先 upsert 保证文档存在，再带守卫 $inc（同 bumpAdsCap）。
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
      // 当日已达上限：不发币。
      const w = await this.cols.wallets.findOne({ _id: args.accountId });
      return { ok: true, coinsAfter: w?.coins ?? 0, credited: 0, capped: true };
    }
    const coinsAfter = await this.credit(args.accountId, amount, 'victory', {});
    return { ok: true, coinsAfter, credited: amount, capped: false };
  }
}

export type { Rarity };
