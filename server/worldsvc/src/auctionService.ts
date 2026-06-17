// 拍卖场业务层（S8-5）。
// 交易标的：材料（scrap/lead/binding，储量在 meta SaveData.materials）和装备。
// 不交易 SLG 季节性资源（food/iron/wood）——防策略套利、维持 biome 差异价值。
// 货币：金币（premium，commercial 扣/付）；税率 10%（AUCTION_TAX_RATE）。
// 过期：expireAt 普通索引 + 扫描器（非 TTL 自删，需结算退还卖方挂存）。
import {
  auctionId as makeAuctionId,
  AUCTION_TAX_RATE,
  AUCTION_MAX_LISTINGS,
  AUCTION_DURATIONS_SEC,
  SlgError,
  type AuctionStatus,
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
  price: number; // 金币单价（每件）
  totalPrice: number; // price × qty
  currency: 'coins';
  designatedBuyerId?: string;
  expireAt: number; // ms
  status: AuctionStatus;
  buyerId?: string;
}

export interface AuctionServiceDeps {
  cols: WorldCollections;
  now: () => number;
  commercial: WorldCommercialClient;
  meta: WorldMetaClient;
}

/** 进程内序号防同毫秒多挂撞键。 */
let auctionSeq = 0;

function docToView(doc: AuctionDoc): AuctionView {
  return {
    auctionId: doc._id,
    worldId: doc.worldId,
    sellerId: doc.sellerId,
    itemType: doc.itemType as 'material' | 'equipment',
    item: doc.item,
    qty: doc.qty,
    price: doc.price,
    totalPrice: doc.price * doc.qty,
    currency: 'coins',
    ...(doc.designatedBuyerId ? { designatedBuyerId: doc.designatedBuyerId } : {}),
    expireAt: doc.expireAt,
    status: doc.status,
    ...(doc.buyerId ? { buyerId: doc.buyerId } : {}),
  };
}

export class AuctionService {
  constructor(private readonly deps: AuctionServiceDeps) {}

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
   * durationSec 必须是 AUCTION_DURATIONS_SEC 之一。
   * 同一账号 open 挂单不超过 AUCTION_MAX_LISTINGS。
   */
  async createAuction(params: {
    worldId: string;
    sellerId: string;
    itemType: 'material' | 'equipment';
    item: Record<string, unknown>;
    qty: number;
    price: number;
    durationSec: number;
    designatedBuyerId?: string;
  }): Promise<AuctionView> {
    const { worldId, sellerId, itemType, item, qty, price, durationSec, designatedBuyerId } = params;
    const { cols, now, meta } = this.deps;

    if (itemType === 'equipment') throw new SlgError('NOT_IMPLEMENTED');
    if (!AUCTION_DURATIONS_SEC.includes(durationSec)) throw new SlgError('BAD_REQUEST');
    if (qty <= 0 || price <= 0) throw new SlgError('BAD_REQUEST');

    // 挂单数上限校验
    const openCount = await cols.auctions.countDocuments({ worldId, sellerId, status: 'open' });
    if (openCount >= AUCTION_MAX_LISTINGS) throw new SlgError('AUCTION_LIMIT_REACHED');

    const ts = now();
    const seq = ++auctionSeq;
    const aid = makeAuctionId(worldId, sellerId, ts, seq);
    const orderId = `auction_list:${aid}`;

    // 材料：从 meta 扣除（托管）
    if (itemType === 'material') {
      const material = item['material'] as string | undefined;
      if (!material) throw new SlgError('BAD_REQUEST');
      await meta.deductMaterial(sellerId, material, qty, orderId);
    }

    const doc: AuctionDoc = {
      _id: aid,
      worldId,
      sellerId,
      itemType,
      item,
      qty,
      price,
      currency: 'coins',
      ...(designatedBuyerId ? { designatedBuyerId } : {}),
      expireAt: ts + durationSec * 1000,
      status: 'open',
      rev: 1,
    };
    await cols.auctions.insertOne(doc);
    return docToView(doc);
  }

  /**
   * 购买拍卖品（原子认领 status open→sold）。
   * 指定买家校验 → 买方扣金币 → 原子 status 更改 → 发放标的 → 卖方收金币（税后）。
   * 买方扣款成功但后续失败：标的保留在 sold 状态，运维后台可查 orderId 补发。
   */
  async buyAuction(worldId: string, buyerId: string, auctionId: string): Promise<AuctionView> {
    const { cols, now, commercial, meta } = this.deps;

    const doc = await cols.auctions.findOne({ _id: auctionId, worldId });
    if (!doc) throw new SlgError('AUCTION_NOT_FOUND');
    if (doc.status !== 'open') throw new SlgError('AUCTION_CLOSED');
    if (doc.sellerId === buyerId) throw new SlgError('BAD_REQUEST');
    if (doc.expireAt < now()) throw new SlgError('AUCTION_CLOSED');
    if (doc.designatedBuyerId && doc.designatedBuyerId !== buyerId) {
      throw new SlgError('NOT_DESIGNATED_BUYER');
    }

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

    // 3. 发放标的给买方
    if (doc.itemType === 'material') {
      const material = doc.item['material'] as string;
      await meta.grantMaterial(buyerId, material, doc.qty, `${buyOrderId}:item`);
    }

    // 4. 卖方收金币（税后，best-effort）
    await commercial.grant(doc.sellerId, sellerReceives, `${buyOrderId}:seller`);

    return docToView(updated);
  }

  /**
   * 取消挂拍（仅 seller，status=open）。
   * 退还材料（best-effort）；装备退还留 TODO。
   */
  async cancelAuction(worldId: string, sellerId: string, auctionId: string): Promise<AuctionView> {
    const { cols, meta } = this.deps;

    const doc = await cols.auctions.findOne({ _id: auctionId, worldId });
    if (!doc) throw new SlgError('AUCTION_NOT_FOUND');
    if (doc.sellerId !== sellerId) throw new SlgError('NO_PERMISSION');
    if (doc.status !== 'open') throw new SlgError('AUCTION_CLOSED');

    const updated = await cols.auctions.findOneAndUpdate(
      { _id: auctionId, status: 'open' },
      { $set: { status: 'cancelled', rev: doc.rev + 1 } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new SlgError('AUCTION_CLOSED');

    // 退还标的
    if (doc.itemType === 'material') {
      const material = doc.item['material'] as string;
      await meta.grantMaterial(sellerId, material, doc.qty, `auction_cancel:${auctionId}`);
    }

    return docToView(updated);
  }

  /**
   * 处理过期挂拍（由 scheduler 定期调用）。
   * 批量扫描 expireAt < now AND status=open → 标记 expired + 退还卖方标的。
   * 每批最多处理 50 条，防止单次扫描过长。
   */
  async processExpiredAuctions(): Promise<number> {
    const { cols, now, meta } = this.deps;
    const ts = now();
    const expired = await cols.auctions
      .find({ status: 'open', expireAt: { $lt: ts } })
      .limit(50)
      .toArray();

    let processed = 0;
    for (const doc of expired) {
      // 原子 open→expired（防并发重复处理）
      const res = await cols.auctions.findOneAndUpdate(
        { _id: doc._id, status: 'open' },
        { $set: { status: 'expired', rev: doc.rev + 1 } },
        { returnDocument: 'after' },
      );
      if (!res) continue; // 并发被抢，跳过

      // 退还卖方标的（best-effort）
      if (doc.itemType === 'material') {
        const material = doc.item['material'] as string;
        await meta.grantMaterial(doc.sellerId, material, doc.qty, `auction_expire:${doc._id}`);
      }
      processed++;
    }
    return processed;
  }
}
