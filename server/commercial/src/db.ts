// commercial 专属库工厂（S5-1，COMMERCIAL_DESIGN §3/§7）。库名 notebook_wars_commercial，
// 与 meta 库物理隔离。集合：wallets / ledger / orders / recharges / gachaHistory。
import { MongoClient, Db, Collection, type MongoClientOptions } from 'mongodb';
import type { Rarity } from '@nw/shared';

/** 余额（单文档原子更新 + 乐观锁 rev）。pity 嵌进同文档（设计默认 A，扣币+保底一次原子）。 */
export interface WalletDoc {
  _id: string; // accountId
  coins: number; // >= 0
  rev: number;
  gacha: { pity: Record<string, number> }; // poolId → 距上次 legendary 的累计抽数
  updatedAt: number;
}

/** 不可变流水（每笔加减一条，审计/对账）。 */
export interface LedgerDoc {
  accountId: string;
  delta: number;
  balanceAfter: number;
  reason: string; // shop | gacha | gacha_refund | recharge | ads
  orderId?: string;
  receiptId?: string;
  ts: number;
}

export interface GachaResultEntry {
  itemId: string;
  rarity: Rarity;
}

/** 消费订单（幂等键 orderId + 待发货对账 saga）。 */
export interface OrderDoc {
  _id: string; // orderId（meta 生成 UUID）
  accountId: string;
  // 'sink' = 纯金币消耗（改名等），无物品发货，落库即 status:'delivered'，对账不拾取。
  // 'grant' = 纯金币发放（邮件附件领取 S6-3），同 sink 落库即 delivered，对账不拾取。
  kind: 'shop' | 'gacha' | 'sink' | 'grant';
  cost: number;
  status: 'charged' | 'delivered';
  coinsAfter: number; // 扣币后余额（幂等重放回放）
  result: { itemId?: string; results?: GachaResultEntry[]; poolId?: string };
  pityAfter?: Record<string, number>;
  refundCoins?: number; // 发货回调里 meta 算出的 dupe 退币（delivered 时入账）
  deliveredAt?: number;
  ts: number;
}

/** 充值票据（幂等 receiptId + 防重复发币）。 */
export interface RechargeDoc {
  _id: string; // receiptId
  accountId: string;
  platform: string;
  coinsGranted: number;
  status: 'granted';
  rawReceipt: string;
  ts: number;
}

/** 抽卡历史（逐抽落库，M7）。 */
export interface GachaHistoryDoc {
  accountId: string;
  poolId: string;
  orderId: string;
  results: GachaResultEntry[];
  pityBefore: number;
  pityAfter: number;
  ts: number;
}

/** 每日胜利金币领取计数（_id=`accountId:dayKey` → 已领局数），enforce 每日上限。 */
export interface VictoryDailyDoc {
  _id: string; // `${accountId}:${dayKey}`
  accountId: string;
  dayKey: string;
  wins: number; // 当日已发金币的胜局数（封顶 VICTORY_DAILY_WIN_CAP）
  ts: number;
}

/** 优惠码定义（B-PROMO）。_id = code 字符串（大写规范化）。 */
export interface PromoCodeDoc {
  _id: string; // code（已规范化大写）
  coins: number; // 兑换金币数
  expiresAt?: number; // 过期时间戳（ms），缺省永不过期
  totalLimit?: number; // 全局兑换上限（缺省无限）
  redeemed: number; // 已兑换次数（原子 $inc）
  note?: string; // 运营备注
  createdBy: string; // adminId
  createdAt: number;
}

/** 优惠码兑换记录（B-PROMO）。_id = `${accountId}:${code}` 天然唯一防重复。 */
export interface PromoRedemptionDoc {
  _id: string; // `${accountId}:${code}`
  accountId: string;
  code: string;
  coinsGranted: number;
  ts: number;
}

export interface CommercialCollections {
  wallets: Collection<WalletDoc>;
  ledger: Collection<LedgerDoc>;
  orders: Collection<OrderDoc>;
  recharges: Collection<RechargeDoc>;
  gachaHistory: Collection<GachaHistoryDoc>;
  victoryDaily: Collection<VictoryDailyDoc>;
  promoCodes: Collection<PromoCodeDoc>;
  promoRedemptions: Collection<PromoRedemptionDoc>;
}

export interface CommercialMongo {
  client: MongoClient;
  db: Db;
  collections: CommercialCollections;
  ensureIndexes(): Promise<void>;
  close(): Promise<void>;
}

export async function createCommercialMongo(
  uri: string,
  dbName: string,
  options?: MongoClientOptions,
): Promise<CommercialMongo> {
  const client = new MongoClient(uri, options);
  try {
    await client.connect();
  } catch (err) {
    // 连接失败时输出清晰、脱敏的错误信息再抛出，避免启动期 DB 连不上变成沉默崩溃。
    const safeUri = uri.replace(/\/\/[^@/]*@/, '//<redacted>@');
    console.error(
      `[commercial-mongo] 连接 MongoDB 失败 (uri=${safeUri}, db=${dbName}): ` +
        `${(err as Error).message}. 请确认数据库已启动且连接配置 (NW_COMM_MONGO_URI/NW_MONGO_URI) 正确。`,
    );
    throw err;
  }
  const db = client.db(dbName);
  const collections: CommercialCollections = {
    wallets: db.collection<WalletDoc>('wallets'),
    ledger: db.collection<LedgerDoc>('ledger'),
    orders: db.collection<OrderDoc>('orders'),
    recharges: db.collection<RechargeDoc>('recharges'),
    gachaHistory: db.collection<GachaHistoryDoc>('gachaHistory'),
    victoryDaily: db.collection<VictoryDailyDoc>('victoryDaily'),
    promoCodes: db.collection<PromoCodeDoc>('promoCodes'),
    promoRedemptions: db.collection<PromoRedemptionDoc>('promoRedemptions'),
  };

  async function ensureIndexes(): Promise<void> {
    await collections.ledger.createIndex({ accountId: 1, ts: -1 });
    await collections.orders.createIndex({ accountId: 1, status: 1 });
    // 对账扫描：未发货订单（status:'charged'）按时间。
    await collections.orders.createIndex({ status: 1, ts: 1 });
    await collections.gachaHistory.createIndex({ accountId: 1, ts: -1 });
    // recharges._id = receiptId 天然唯一；wallets._id = accountId 天然唯一。
    // promoCodes._id = code 天然唯一；promoRedemptions._id = accountId:code 天然唯一。
    await collections.promoRedemptions.createIndex({ accountId: 1, ts: -1 });
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
