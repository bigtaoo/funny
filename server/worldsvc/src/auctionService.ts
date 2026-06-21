// 拍卖场业务层（S8-5）。
// 交易标的：材料（scrap/lead/binding，储量在 meta SaveData.materials）和装备。
// 不交易 SLG 季节性资源（food/iron/wood）——防策略套利、维持 biome 差异价值。
// 货币：金币（premium，commercial 扣/付）；税率 10%（AUCTION_TAX_RATE）。
// 过期：expireAt 普通索引 + 扫描器（非 TTL 自删，需结算退还卖方挂存 / 竞拍结拍）。
//
// 反 RMT 闸门（AUCTION_DESIGN §4）：
//   C 每日限额（挂单/购买次数）— auctionDaily 计数 + TTL 自清
//   E 绑定材料禁挂 — AUCTION_BANNED_MATERIALS
//   G 价格护栏 — 动态滑窗 refPrice + 区间校验（冷启动回退静态值）
//   F 季末冻结/清算 — world.status settling/closed 拒新挂单 + clearWorldOnReset 退还
//   B 竞拍 — saleMode='auction'：起拍/加价/托管/防狙击/到期结拍
import {
  auctionId as makeAuctionId,
  AUCTION_TAX_RATE,
  AUCTION_MAX_LISTINGS,
  AUCTION_DURATIONS_SEC,
  AUCTION_DAILY_LIST_CAP,
  AUCTION_DAILY_BUY_CAP,
  AUCTION_DAILY_TTL_SEC,
  AUCTION_BANNED_MATERIALS,
  AUCTION_PRICE_WINDOW_N,
  AUCTION_PRICE_WINDOW_MIN_SAMPLES,
  AUCTION_PRICE_FLOOR_RATIO,
  AUCTION_PRICE_CEIL_RATIO,
  AUCTION_STATIC_REF_PRICE,
  AUCTION_MIN_INCREMENT_RATIO,
  AUCTION_ANTI_SNIPE_WINDOW_SEC,
  EQUIPMENT_DEFS,
  EQUIP_AUCTION_REF_PRICE_BY_RARITY,
  SlgError,
  type AuctionStatus,
  type EquipmentInstance,
} from '@nw/shared';
import type { WorldCollections, AuctionDoc } from './db';
import type { WorldCommercialClient } from './commercialClient';
import type { WorldMetaClient } from './metaClient';

export interface AuctionView {
  auctionId: string;
  worldId: string;
  sellerId: string;
  itemType: 'material' | 'equipment';
  item: Record<string, unknown>;
  qty: number;
  price: number; // 金币单价（每件）：一口价=成交单价；竞拍=当前最高出价单价（无人出价则起拍价）
  totalPrice: number; // 当前有效单价 × qty
  currency: 'coins';
  designatedBuyerId?: string;
  expireAt: number; // ms
  status: AuctionStatus;
  buyerId?: string;
  // B 竞拍字段（saleMode 缺省 'fixed'）
  saleMode: 'fixed' | 'auction';
  startPrice?: number;  // 竞拍起拍单价
  buyoutPrice?: number; // 竞拍一口价保底单价（可选）
  topBid?: { bidderId: string; amount: number; ts: number }; // 当前最高出价（单价）
}

export interface AuctionServiceDeps {
  cols: WorldCollections;
  now: () => number;
  commercial: WorldCommercialClient;
  meta: WorldMetaClient;
}

/** 进程内序号防同毫秒多挂撞键。 */
let auctionSeq = 0;

/** 装备挂单标的载荷（A）：整件实例快照托管（qty 恒 1，非堆叠唯一实例）。 */
function equipInstanceOf(item: Record<string, unknown>): EquipmentInstance | null {
  const inst = item['instance'];
  return inst && typeof inst === 'object' ? (inst as EquipmentInstance) : null;
}

/** 标的品类键（价格滑窗按品类隔离）。材料 = `material:{mat}`；装备 = `equip:{defId}`（A，按定义/稀有度隔离）。 */
function categoryOf(doc: Pick<AuctionDoc, 'itemType' | 'item'>): string | null {
  if (doc.itemType === 'material') {
    const mat = doc.item['material'] as string | undefined;
    return mat ? `material:${mat}` : null;
  }
  if (doc.itemType === 'equipment') {
    const inst = equipInstanceOf(doc.item);
    return inst?.defId ? `equip:${inst.defId}` : null;
  }
  return null;
}

function docToView(doc: AuctionDoc): AuctionView {
  const saleMode = doc.saleMode ?? 'fixed';
  const effUnit = saleMode === 'auction' ? (doc.topBid?.amount ?? doc.startPrice ?? doc.price) : doc.price;
  return {
    auctionId: doc._id,
    worldId: doc.worldId,
    sellerId: doc.sellerId,
    itemType: doc.itemType as 'material' | 'equipment',
    item: doc.item,
    qty: doc.qty,
    price: effUnit,
    totalPrice: effUnit * doc.qty,
    currency: 'coins',
    ...(doc.designatedBuyerId ? { designatedBuyerId: doc.designatedBuyerId } : {}),
    expireAt: doc.expireAt,
    status: doc.status,
    ...(doc.buyerId ? { buyerId: doc.buyerId } : {}),
    saleMode,
    ...(doc.startPrice != null ? { startPrice: doc.startPrice } : {}),
    ...(doc.buyoutPrice != null ? { buyoutPrice: doc.buyoutPrice } : {}),
    ...(doc.topBid ? { topBid: doc.topBid } : {}),
  };
}

export class AuctionService {
  constructor(private readonly deps: AuctionServiceDeps) {}

  // ── C 每日限额计数（按服务器 UTC 日界，TTL 自清）──────────────────────────
  private dayKey(): string {
    return new Date(this.deps.now()).toISOString().slice(0, 10);
  }

  /**
   * 当日某类操作次数 +1，超 cap 抛 AUCTION_LIMIT_REACHED（并回滚本次计数，防永久锁死）。
   * 先占名额（reserve）再执行业务——标准限流；业务后续失败的极少数过计只偏保守，可接受。
   */
  private async bumpDaily(worldId: string, accountId: string, kind: 'lists' | 'buys', cap: number): Promise<void> {
    const { cols, now } = this.deps;
    const id = `${worldId}:${accountId}:${this.dayKey()}`;
    const res = await cols.auctionDaily.findOneAndUpdate(
      { _id: id },
      {
        $inc: { [kind]: 1 },
        $setOnInsert: {
          worldId,
          accountId,
          dayKey: this.dayKey(),
          expiresAt: new Date(now() + AUCTION_DAILY_TTL_SEC * 1000),
        },
      },
      { upsert: true, returnDocument: 'after' },
    );
    const count = (res?.[kind] as number | undefined) ?? 1;
    if (count > cap) {
      await cols.auctionDaily.updateOne({ _id: id }, { $inc: { [kind]: -1 } });
      throw new SlgError('AUCTION_LIMIT_REACHED');
    }
  }

  // ── G 价格护栏（动态滑窗 + 静态回退）──────────────────────────────────────
  /** 取某品类参考单价：滑窗样本足 → 中位数；否则静态回退；都无 → null（冷启动放行）。 */
  private async refPrice(worldId: string, category: string): Promise<number | null> {
    const doc = await this.deps.cols.auctionPrices.findOne({ _id: `${worldId}:${category}` });
    if (doc && doc.prices.length >= AUCTION_PRICE_WINDOW_MIN_SAMPLES) {
      const sorted = [...doc.prices].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)]!; // 中位数，抗极端值
    }
    if (category.startsWith('material:')) {
      const mat = category.slice('material:'.length);
      const stat = AUCTION_STATIC_REF_PRICE[mat];
      if (stat != null) return stat;
    }
    if (category.startsWith('equip:')) {
      // 装备冷启动按稀有度估值（§4.A：价格护栏按稀有度设区间）。
      const defId = category.slice('equip:'.length);
      const def = EQUIPMENT_DEFS[defId];
      if (def) return EQUIP_AUCTION_REF_PRICE_BY_RARITY[def.rarity];
    }
    return null;
  }

  /** 校验单价落在 refPrice 浮动带内；无参考价（冷启动且无静态值）则放行。 */
  private async checkPriceGuard(worldId: string, category: string | null, unitPrice: number): Promise<void> {
    if (!category) return;
    const ref = await this.refPrice(worldId, category);
    if (ref == null) return;
    if (unitPrice < ref * AUCTION_PRICE_FLOOR_RATIO || unitPrice > ref * AUCTION_PRICE_CEIL_RATIO) {
      throw new SlgError('PRICE_OUT_OF_RANGE');
    }
  }

  /** 每笔成交后把单价压入品类滑窗（保留近 N 笔）。 */
  private async recordSoldPrice(worldId: string, category: string | null, unitPrice: number): Promise<void> {
    if (!category) return;
    await this.deps.cols.auctionPrices.updateOne(
      { _id: `${worldId}:${category}` },
      {
        $push: { prices: { $each: [unitPrice], $slice: -AUCTION_PRICE_WINDOW_N } },
        $setOnInsert: { worldId, category },
      },
      { upsert: true },
    );
  }

  /**
   * 把挂单标的发给目标账号（成交给买方 / 撤单·过期·季末退给卖方）。
   * 材料 → grantMaterial；装备 → grantEquipment（转移整件实例快照）。均 best-effort + orderId 幂等。
   */
  private async deliverItem(toAccountId: string, doc: AuctionDoc, orderId: string): Promise<void> {
    const { meta } = this.deps;
    if (doc.itemType === 'material') {
      const material = doc.item['material'] as string;
      await meta.grantMaterial(toAccountId, material, doc.qty, orderId);
    } else if (doc.itemType === 'equipment') {
      const inst = equipInstanceOf(doc.item);
      if (inst) await meta.grantEquipment(toAccountId, inst, orderId);
    }
  }

  // ── F 季末冻结：settling/closed 世界拒新挂单（买/撤/结拍不受限）─────────────
  private async assertWorldAcceptsListings(worldId: string): Promise<void> {
    const world = await this.deps.cols.worlds.findOne({ _id: worldId });
    if (world && (world.status === 'settling' || world.status === 'closed')) {
      throw new SlgError('WORLD_CLOSED');
    }
  }

  /** 列出世界内 open 状态的拍卖（可按 itemType 筛选，按价格升序，limit ≤50）。 */
  async listAuctions(worldId: string, itemType?: string, limit = 20): Promise<AuctionView[]> {
    const query: Record<string, unknown> = { worldId, status: 'open' };
    if (itemType) query['itemType'] = itemType;
    const docs = await this.deps.cols.auctions
      .find(query)
      .sort({ price: 1 })
      .limit(Math.min(Math.max(limit, 1), 50))
      .toArray();
    return docs.map(docToView);
  }

  /** 我的挂单列表（含全状态）。 */
  async getMyListings(worldId: string, accountId: string): Promise<AuctionView[]> {
    const docs = await this.deps.cols.auctions
      .find({ worldId, sellerId: accountId })
      .sort({ expireAt: -1 })
      .limit(AUCTION_MAX_LISTINGS)
      .toArray();
    return docs.map(docToView);
  }

  /**
   * 挂拍。
   * itemType='material' → 从 meta 扣除材料（orderId 幂等）。
   * itemType='equipment' → TODO（装备库 S8-x 后补），当前拒绝。
   * saleMode='fixed'（缺省）：price=一口价单价。
   * saleMode='auction'：startPrice=起拍单价，buyoutPrice?=一口价保底单价。
   * durationSec 必须是 AUCTION_DURATIONS_SEC 之一；同账号 open 挂单 ≤ AUCTION_MAX_LISTINGS；
   * 每日新挂单 ≤ AUCTION_DAILY_LIST_CAP（C）；禁挂材料拒绝（E）；单价越界拒绝（G）；settling 世界拒绝（F）。
   */
  async createAuction(params: {
    worldId: string;
    sellerId: string;
    itemType: 'material' | 'equipment';
    item: Record<string, unknown>;
    qty: number;
    price?: number; // fixed 模式：一口价单价
    saleMode?: 'fixed' | 'auction';
    startPrice?: number; // auction 模式：起拍单价
    buyoutPrice?: number; // auction 模式：一口价保底单价（可选）
    durationSec: number;
    designatedBuyerId?: string;
  }): Promise<AuctionView> {
    const {
      worldId, sellerId, itemType, item, qty, durationSec, designatedBuyerId,
    } = params;
    const saleMode = params.saleMode ?? 'fixed';
    const { cols, now, meta } = this.deps;

    if (!AUCTION_DURATIONS_SEC.includes(durationSec)) throw new SlgError('BAD_REQUEST');
    // 装备 qty 恒 1（非堆叠唯一实例，§4.A）；材料 qty>0。
    const effectiveQty = itemType === 'equipment' ? 1 : qty;
    if (effectiveQty <= 0) throw new SlgError('BAD_REQUEST');

    // 售卖形态参数校验 + 确定挂单单价（用于浏览排序 + 护栏校验）
    let unitPrice: number; // 一口价单价 / 竞拍起拍单价
    let startPrice: number | undefined;
    let buyoutPrice: number | undefined;
    if (saleMode === 'auction') {
      startPrice = params.startPrice;
      buyoutPrice = params.buyoutPrice;
      if (startPrice == null || startPrice <= 0) throw new SlgError('BAD_REQUEST');
      if (buyoutPrice != null && buyoutPrice < startPrice) throw new SlgError('BAD_REQUEST');
      unitPrice = startPrice;
    } else {
      if (params.price == null || params.price <= 0) throw new SlgError('BAD_REQUEST');
      unitPrice = params.price;
    }

    // F 季末冻结
    await this.assertWorldAcceptsListings(worldId);

    const ts = now();
    const seq = ++auctionSeq;
    const aid = makeAuctionId(worldId, sellerId, ts, seq);
    const orderId = `auction_list:${aid}`;
    let storedItem: Record<string, unknown> = item;

    if (itemType === 'material') {
      // E 绑定材料禁挂
      const material = item['material'] as string | undefined;
      if (!material) throw new SlgError('BAD_REQUEST');
      if (AUCTION_BANNED_MATERIALS.has(material)) throw new SlgError('MATERIAL_NOT_TRADEABLE');
      // G 价格护栏（按品类参考价校验单价）
      await this.checkPriceGuard(worldId, categoryOf({ itemType, item }), unitPrice);
      // 并发挂单数上限
      const openCount = await cols.auctions.countDocuments({ worldId, sellerId, status: 'open' });
      if (openCount >= AUCTION_MAX_LISTINGS) throw new SlgError('AUCTION_LIMIT_REACHED');
      // C 每日新挂单上限（占名额）
      await this.bumpDaily(worldId, sellerId, 'lists', AUCTION_DAILY_LIST_CAP);
      // 从 meta 扣除材料（托管）
      await meta.deductMaterial(sellerId, material, qty, orderId);
    } else if (itemType === 'equipment') {
      // A 装备交易：客户端传 instanceId，服务器托管整件实例（移出卖方库存）→ 存快照。
      const instanceId = item['instanceId'];
      if (typeof instanceId !== 'string') throw new SlgError('BAD_REQUEST');
      // 并发挂单数上限（托管前先卡，避免无谓托管再退）
      const openCount = await cols.auctions.countDocuments({ worldId, sellerId, status: 'open' });
      if (openCount >= AUCTION_MAX_LISTINGS) throw new SlgError('AUCTION_LIMIT_REACHED');
      // 托管：穿戴中/锁定/不存在由 meta 抛 SlgError（EQUIP_IN_USE/EQUIP_LOCKED/EQUIP_NOT_FOUND）。
      const instance = await meta.escrowEquipment(sellerId, instanceId, orderId);
      storedItem = { instance };
      try {
        // G 价格护栏（装备按 defId/稀有度品类）+ C 每日上限——失败则退还托管实例。
        await this.checkPriceGuard(worldId, `equip:${instance.defId}`, unitPrice);
        await this.bumpDaily(worldId, sellerId, 'lists', AUCTION_DAILY_LIST_CAP);
      } catch (e) {
        await meta.grantEquipment(sellerId, instance, `${orderId}:return`);
        throw e;
      }
    } else {
      throw new SlgError('BAD_REQUEST');
    }

    const doc: AuctionDoc = {
      _id: aid,
      worldId,
      sellerId,
      itemType,
      item: storedItem,
      qty: effectiveQty,
      price: unitPrice,
      currency: 'coins',
      ...(designatedBuyerId ? { designatedBuyerId } : {}),
      expireAt: ts + durationSec * 1000,
      status: 'open',
      saleMode,
      ...(startPrice != null ? { startPrice } : {}),
      ...(buyoutPrice != null ? { buyoutPrice } : {}),
      rev: 1,
    };
    await cols.auctions.insertOne(doc);
    return docToView(doc);
  }

  /**
   * 购买拍卖品（一口价单，原子认领 status open→sold）。
   * 指定买家校验 → 每日上限（C）→ 买方扣金币 → 原子 status 更改 → 发放标的 → 卖方收金币（税后）。
   * 买方扣款成功但后续失败：标的保留在 sold 状态，运维后台可查 orderId 补发。
   * 竞拍单（saleMode='auction'）不走此路径——出价/买断走 placeBid。
   */
  async buyAuction(worldId: string, buyerId: string, auctionId: string): Promise<AuctionView> {
    const { cols, now, commercial } = this.deps;

    const doc = await cols.auctions.findOne({ _id: auctionId, worldId });
    if (!doc) throw new SlgError('AUCTION_NOT_FOUND');
    if (doc.status !== 'open') throw new SlgError('AUCTION_CLOSED');
    if ((doc.saleMode ?? 'fixed') !== 'fixed') throw new SlgError('BAD_REQUEST'); // 竞拍单用 placeBid
    if (doc.sellerId === buyerId) throw new SlgError('BAD_REQUEST');
    if (doc.expireAt < now()) throw new SlgError('AUCTION_CLOSED');
    if (doc.designatedBuyerId && doc.designatedBuyerId !== buyerId) {
      throw new SlgError('NOT_DESIGNATED_BUYER');
    }

    // C 每日购买上限（占名额，先于扣款）
    await this.bumpDaily(worldId, buyerId, 'buys', AUCTION_DAILY_BUY_CAP);

    const totalPrice = doc.price * doc.qty;
    const tax = Math.floor(totalPrice * AUCTION_TAX_RATE);
    const sellerReceives = totalPrice - tax;

    const buyOrderId = `auction_buy:${auctionId}`;

    // 1. 买方扣金币（insufficient → 抛错，不成交）
    await commercial.spend(buyerId, totalPrice, buyOrderId);

    // 2. 原子 status open→sold（防并发重复购买）
    const updated = await cols.auctions.findOneAndUpdate(
      { _id: auctionId, status: 'open' },
      { $set: { status: 'sold', buyerId, rev: doc.rev + 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      // 并发被别人抢购 → 退回买方金币（best-effort）
      await commercial.grant(buyerId, totalPrice, `${buyOrderId}:refund`);
      throw new SlgError('AUCTION_CLOSED');
    }

    // 3. 发放标的给买方（材料发材料 / 装备转移实例）
    await this.deliverItem(buyerId, doc, `${buyOrderId}:item`);

    // 4. 卖方收金币（税后，best-effort）
    await commercial.grant(doc.sellerId, sellerReceives, `${buyOrderId}:seller`);

    // G 记录成交单价进滑窗
    await this.recordSoldPrice(worldId, categoryOf(doc), doc.price);

    return docToView(updated);
  }

  /**
   * 竞拍出价（saleMode='auction'，B）。
   * amount = 出价单价（金币/件）；托管 = amount × qty。
   * 校验 → 每日上限 → 托管出价金币 → 原子写 topBid（rev 守卫）→ 退还前一出价者 → 防狙击顺延。
   * 达/超 buyoutPrice → 立即结拍（标的给出价者，卖方收税后款，金币已托管无需二次扣）。
   */
  async placeBid(worldId: string, bidderId: string, auctionId: string, amount: number): Promise<AuctionView> {
    const { cols, now, commercial } = this.deps;
    if (amount <= 0) throw new SlgError('BAD_REQUEST');

    const doc = await cols.auctions.findOne({ _id: auctionId, worldId });
    if (!doc) throw new SlgError('AUCTION_NOT_FOUND');
    if (doc.status !== 'open') throw new SlgError('AUCTION_CLOSED');
    if ((doc.saleMode ?? 'fixed') !== 'auction') throw new SlgError('BAD_REQUEST'); // 一口价单用 buyAuction
    if (doc.sellerId === bidderId) throw new SlgError('BAD_REQUEST');
    if (doc.expireAt < now()) throw new SlgError('AUCTION_CLOSED');
    if (doc.designatedBuyerId && doc.designatedBuyerId !== bidderId) {
      throw new SlgError('NOT_DESIGNATED_BUYER');
    }

    // 出价下限：起拍价 / 当前最高价 + 最小加价幅度
    const startPrice = doc.startPrice ?? doc.price;
    let minBid = startPrice;
    if (doc.topBid) {
      const inc = Math.max(1, Math.floor(doc.topBid.amount * AUCTION_MIN_INCREMENT_RATIO));
      minBid = doc.topBid.amount + inc;
    }
    if (amount < minBid) throw new SlgError('BID_TOO_LOW');

    // G 价格护栏（出价单价同样受护栏约束）
    await this.checkPriceGuard(worldId, categoryOf(doc), amount);

    // C 每日出价上限
    await this.bumpDaily(worldId, bidderId, 'buys', AUCTION_DAILY_BUY_CAP);

    const prevBid = doc.topBid;
    const escrowTotal = amount * doc.qty;
    const bidOrderId = `auction_bid:${auctionId}:${bidderId}:${amount}`;

    // 1. 托管本次出价金币（不足 → 抛错，不改 topBid）
    await commercial.spend(bidderId, escrowTotal, bidOrderId);

    // 2. 防狙击：到期前窗口内出价 → expireAt 顺延同等窗口
    const ts = now();
    const windowMs = AUCTION_ANTI_SNIPE_WINDOW_SEC * 1000;
    const newExpireAt = doc.expireAt - ts < windowMs ? ts + windowMs : doc.expireAt;

    // 3. 原子写 topBid（rev 守卫防并发出价覆盖）
    const updated = await cols.auctions.findOneAndUpdate(
      { _id: auctionId, status: 'open', rev: doc.rev },
      {
        $set: { topBid: { bidderId, amount, ts }, expireAt: newExpireAt, rev: doc.rev + 1 },
      },
      { returnDocument: 'after' },
    );
    if (!updated) {
      // 并发被抢/已结束 → 退回本次托管
      await commercial.grant(bidderId, escrowTotal, `${bidOrderId}:refund`);
      throw new SlgError('AUCTION_CLOSED');
    }

    // 4. 退还前一最高出价者托管金币（best-effort，幂等）
    if (prevBid) {
      await commercial.grant(
        prevBid.bidderId,
        prevBid.amount * doc.qty,
        `auction_bid_refund:${auctionId}:${prevBid.bidderId}:${prevBid.amount}`,
      );
    }

    // 5. 买断：达/超 buyoutPrice → 立即结拍
    if (doc.buyoutPrice != null && amount >= doc.buyoutPrice) {
      return this.settleAuctionWin(updated, commercial);
    }
    return docToView(updated);
  }

  /**
   * 竞拍结拍（内部）：把标的发给最高出价者、卖方收税后款（金币已托管，无需二次扣）。
   * 原子 open→sold 防与过期扫描器/买断双结。被并发抢结 → 直接读回当前态返回。
   */
  private async settleAuctionWin(
    doc: AuctionDoc,
    commercial: WorldCommercialClient,
  ): Promise<AuctionView> {
    const top = doc.topBid!;
    const updated = await this.deps.cols.auctions.findOneAndUpdate(
      { _id: doc._id, status: 'open' },
      { $set: { status: 'sold', buyerId: top.bidderId, rev: doc.rev + 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      const cur = await this.deps.cols.auctions.findOne({ _id: doc._id });
      return docToView(cur ?? doc);
    }

    const totalPrice = top.amount * doc.qty;
    const tax = Math.floor(totalPrice * AUCTION_TAX_RATE);
    const sellerReceives = totalPrice - tax;
    const orderId = `auction_settle:${doc._id}`;

    // 发标的给得标者（材料 / 装备实例）
    await this.deliverItem(top.bidderId, doc, `${orderId}:item`);
    // 卖方收税后款
    await commercial.grant(doc.sellerId, sellerReceives, `${orderId}:seller`);
    // G 记录成交单价
    await this.recordSoldPrice(doc.worldId, categoryOf(doc), top.amount);

    return docToView(updated);
  }

  /**
   * 取消挂拍（仅 seller，status=open）。
   * 竞拍单已有出价 → 拒绝取消（保护出价者）；无出价可撤。
   * 退还标的（材料 / 装备实例，best-effort）。
   */
  async cancelAuction(worldId: string, sellerId: string, auctionId: string): Promise<AuctionView> {
    const { cols } = this.deps;

    const doc = await cols.auctions.findOne({ _id: auctionId, worldId });
    if (!doc) throw new SlgError('AUCTION_NOT_FOUND');
    if (doc.sellerId !== sellerId) throw new SlgError('NO_PERMISSION');
    if (doc.status !== 'open') throw new SlgError('AUCTION_CLOSED');
    if ((doc.saleMode ?? 'fixed') === 'auction' && doc.topBid) throw new SlgError('BAD_REQUEST'); // 有出价不可撤

    const updated = await cols.auctions.findOneAndUpdate(
      { _id: auctionId, status: 'open' },
      { $set: { status: 'cancelled', rev: doc.rev + 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new SlgError('AUCTION_CLOSED');

    // 退还标的（材料 / 装备实例）
    await this.deliverItem(sellerId, doc, `auction_cancel:${auctionId}`);

    return docToView(updated);
  }

  /**
   * 处理过期挂拍（由 scheduler 定期调用）。
   * 批量扫描 expireAt < now AND status=open：
   *   竞拍单且有 topBid → 结拍（标的给最高出价者，卖方收税后款）；
   *   否则（一口价过期 / 竞拍无人出价）→ 标记 expired + 退还卖方标的。
   * 每批最多处理 50 条，防止单次扫描过长。
   */
  async processExpiredAuctions(): Promise<number> {
    const { cols, now, commercial } = this.deps;
    const ts = now();
    const expired = await cols.auctions
      .find({ status: 'open', expireAt: { $lt: ts } })
      .limit(50)
      .toArray();

    let processed = 0;
    for (const doc of expired) {
      const isAuctionWin = (doc.saleMode ?? 'fixed') === 'auction' && !!doc.topBid;
      if (isAuctionWin) {
        // 竞拍结拍（settleAuctionWin 内含原子 open→sold 防并发）
        await this.settleAuctionWin(doc, commercial);
        processed++;
        continue;
      }

      // 原子 open→expired（防并发重复处理）
      const res = await cols.auctions.findOneAndUpdate(
        { _id: doc._id, status: 'open' },
        { $set: { status: 'expired', rev: doc.rev + 1 } },
        { returnDocument: 'after' },
      );
      if (!res) continue; // 并发被抢，跳过

      // 退还卖方标的（材料 / 装备实例，best-effort）
      await this.deliverItem(doc.sellerId, doc, `auction_expire:${doc._id}`);
      processed++;
    }
    return processed;
  }

  /**
   * F 季末清算：赛季重置时强制清算世界内所有 open 挂单。
   * 批量 open→cancelled + 退还卖方标的 + 退还竞拍托管出价；清空该世界价格滑窗（新赛季市场重启）。
   * 由 /admin/world/reset 在 svc.resetSeason 之外调用（拍卖标的属养成侧，退回安全，SLG4）。
   */
  async clearWorldOnReset(worldId: string): Promise<{ cancelled: number }> {
    const { cols, commercial } = this.deps;
    let cancelled = 0;
    // 循环处理直到无 open（量大时分批，每批 ≤100）
    for (;;) {
      const open = await cols.auctions.find({ worldId, status: 'open' }).limit(100).toArray();
      if (open.length === 0) break;
      for (const doc of open) {
        const res = await cols.auctions.findOneAndUpdate(
          { _id: doc._id, status: 'open' },
          { $set: { status: 'cancelled', rev: doc.rev + 1 } },
          { returnDocument: 'after' },
        );
        if (!res) continue;
        // 退还卖方标的（材料 / 装备实例）
        await this.deliverItem(doc.sellerId, doc, `auction_reset:${doc._id}`);
        // 退还竞拍托管出价（若有）
        if ((doc.saleMode ?? 'fixed') === 'auction' && doc.topBid) {
          await commercial.grant(
            doc.topBid.bidderId,
            doc.topBid.amount * doc.qty,
            `auction_reset_refund:${doc._id}`,
          );
        }
        cancelled++;
      }
    }
    // 清空该世界价格滑窗（新赛季市场重启，refPrice 不跨季污染）
    await cols.auctionPrices.deleteMany({ worldId });
    return { cancelled };
  }
}
