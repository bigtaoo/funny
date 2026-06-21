// worldsvc 专属库工厂（S8-0，SLG_DESIGN §14.3）。库名 notebook_wars_world，与 meta/commercial/admin
// 物理隔离。8 集合：worlds / tiles / playerWorld / marches / families / familyMembers / auctions / sieges。
// 写型沿用单文档原子 + rev 乐观锁（META_DESIGN §6.3）。稀疏存储：只落被占领/被改动的格子，
// 中立格由 shared proceduralTile() 即时算出，不落库（§14.2 scale 关键）。
import { MongoClient, Db, Collection, type MongoClientOptions } from 'mongodb';
import type {
  TileType,
  ResourceType,
  MarchKind,
  FamilyRole,
  WorldStatus,
  AuctionStatus,
  SiegeOutcome,
  SettleTier,
} from '@nw/shared';
import { FAMILY_MSG_RETENTION_SEC } from '@nw/shared';

/** 防守配置：引擎 LevelDefinition 的受限子集（P2/P5，内嵌不建独立集合）。S8-3 接引擎前为 opaque 占位。 */
export type DefenseConfig = Record<string, unknown>;

/**
 * 布阵单位（GarrisonEntry 的可序列化镜像，G3-2c）。unitType/col/row 合法性由引擎侧 levelSchema
 * 在 buildSiegeBattle→parseLevelDefinition 时校验；initialHp = 分配给该单位的兵力（= 血量，§16.1）。
 */
export interface ArmyEntry {
  unitType: string;
  col: number;
  row: number;
  initialHp?: number;
}

/** 进攻布阵模板（队伍，§16.2）。≤ SIEGE_TEAM_CAP 支，出征挂一支队 → army 快照进 MarchDoc。 */
export interface TeamTemplate {
  id: string;   // 槽位 id（'t1'..'t5'）
  name: string;
  army: ArmyEntry[];
}

export interface WorldDoc {
  _id: string; // worldId = `s{season}-{shard}`
  season: number;
  shard: number;
  status: WorldStatus;
  mapW: number;
  mapH: number;
  openAt: number;
  resetAt?: number;
  capacity: number;
  population: number;
  /** 开服时 pin 的引擎版本（C7/§17.9，= @nw/engine ENGINE_VERSION）；缺省视为未 pin（旧世界）。 */
  engineVersion?: number;
  rev: number;
}

/** 被占领/被改动的格子（中立默认格不落库，由 proceduralTile 算）。 */
export interface TileDoc {
  _id: string; // tileId = `{worldId}:{x}:{y}`
  worldId: string;
  x: number;
  y: number;
  type: TileType;
  level: number;
  resType?: ResourceType;
  ownerId?: string; // 占领者 accountId
  familyId?: string;
  defense?: DefenseConfig; // 领地防守（P5 内嵌）
  garrison?: number;
  protectedUntil?: number; // ms
  watchtower?: boolean; // 瞭望塔（§18 G5 V2）：建塔后该格成大半径持久视野源；丢地随 TileDoc 一并消失
  rev: number;
}

/** 训练队列条目（S8-2）。每批独立排队，completeAt 到期由 scheduler 转化为兵力。 */
export interface TrainingEntry {
  qty: number;       // 本批训练数量
  foodCost: number;  // 已扣粮食（出队时无需退还）
  startAt: number;   // ms epoch
  completeAt: number; // ms epoch（到点 scheduler 加兵到 troops 并移出队列）
}

/** 玩家在某世界的状态（资源惰性结算：存聚合 yieldRate + lastTickAt，读时补算，不逐格 tick）。 */
export interface PlayerWorldDoc {
  _id: string; // `{worldId}:{accountId}`
  worldId: string;
  accountId: string;
  troops: number;
  troopCap: number;
  resources: Record<ResourceType, number>;
  yieldRate: Record<ResourceType, number>; // 每小时产率（占领/丢地时更新）
  lastTickAt: number; // ms，惰性结算锚点
  mainBaseTile?: string;
  defense?: DefenseConfig; // 主城防守（P5 内嵌）
  teams?: TeamTemplate[];  // 进攻布阵模板（G3-2c，≤ SIEGE_TEAM_CAP 支）
  familyId?: string;
  trainingQueue?: TrainingEntry[]; // 训练队列（S8-2，≤ TROOP_TRAIN_QUEUE_MAX 条）
  hasBattlePass?: boolean;         // 当赛季战令（S8-8，赛季重置时清除）
  rev: number;
}

export interface MarchDoc {
  _id: string; // marchId
  worldId: string;
  ownerId: string;
  fromTile: string;
  toTile: string;
  kind: MarchKind;
  troops: number;
  /** 攻方布阵快照（G3-2c，attack 挂队时从 TeamTemplate.army 拷入；出征后队伍可改不影响在途军）。 */
  army?: ArmyEntry[];
  departAt: number;
  arriveAt: number;
  status: 'marching' | 'arrived' | 'recalled';
  rev: number;
}

export interface FamilyDoc {
  _id: string; // familyId
  worldId: string;
  name: string;
  tag: string;
  leaderId: string;
  memberCount: number;
  territoryCount: number;
  sectId?: string; // 所属宗门（S8-4b，无 = 散家族）
  /** 家族繁荣度（G2/§17.4，familyProsperity 算，读时惰性衰减）。缺省视 0（旧家族懒创建）。 */
  prosperity?: number;
  /** 繁荣度衰减锚点 ms（读时按 now-该值 惰性衰减）。 */
  prosperityUpdatedAt?: number;
  /** 赛季累计活跃点（新占领数 + 战斗场次，服务器权威 $inc，无客户端写口）。缺省视 0。 */
  activity?: number;
  rev: number;
}

/** 宗门（S8-4b，§2.1/§8.2）：大区内由家族组成的势力组织。成员 = sectId 指向本门的家族。 */
export interface SectDoc {
  _id: string; // sectId = `s:{worldId}:{TAG}`
  worldId: string;
  name: string;
  tag: string;
  leaderFamilyId: string; // 门主家族
  leaderId: string;       // 门主账号（= 门主家族的 leader），用于权限校验
  memberFamilyCount: number;
  allySectIds: string[];  // 联盟宗门（≤ SECT_ALLY_CAP）
  prosperity: number;     // 繁荣度 = 成员家族繁荣度之和（G2/§17.4，settle/建门/G6 分配时聚合刷新）
  /** 罢免门主投票（§8.2，超 2/3 族长同意 + 提名）。换届/解决后清空。 */
  removalVote?: { nomineeFamilyId: string; voterFamilyIds: string[] };
  rev: number;
}

export interface FamilyMemberDoc {
  _id: string; // `{worldId}:{accountId}`
  worldId: string;
  accountId: string;
  familyId: string;
  role: FamilyRole;
  joinedAt: number;
}

export interface AuctionDoc {
  _id: string; // auctionId
  worldId: string;
  sellerId: string;
  itemType: string;
  item: Record<string, unknown>;
  qty: number;
  price: number; // 一口价：成交单价；竞拍：起拍后无意义（用 startPrice/topBid），保留兼容旧浏览排序
  currency: string;
  designatedBuyerId?: string;
  expireAt: number; // ms（过期由扫描器结算：退还卖方挂存 / 竞拍结拍，非 TTL 自删，见 ensureIndexes 注）
  status: AuctionStatus;
  buyerId?: string;
  // ── B 竞拍（AUCTION_DESIGN §4.B）。saleMode 缺省视为 'fixed'（兼容既有一口价单）──
  saleMode?: 'fixed' | 'auction';
  startPrice?: number;   // 竞拍起拍总价（整批，非单价）
  buyoutPrice?: number;  // 竞拍一口价保底总价（可选）
  topBid?: { bidderId: string; amount: number; ts: number }; // 当前最高出价（总价，金币已托管）
  rev: number;
}

/** C 每日限额计数（AUCTION_DESIGN §4.C）。_id = `${worldId}:${accountId}:${dayKey}`，TTL 自清。 */
export interface AuctionDailyDoc {
  _id: string;
  worldId: string;
  accountId: string;
  dayKey: string; // 服务器 UTC 日界 YYYY-MM-DD
  lists: number;  // 当日新挂单次数
  buys: number;   // 当日购买/出价次数
  expiresAt: Date; // BSON Date，TTL 锚字段
}

/** G 价格护栏滑窗（AUCTION_DESIGN §4.G）。_id = `${worldId}:${category}`，存近 N 笔成交单价。 */
export interface AuctionPriceDoc {
  _id: string;
  worldId: string;
  category: string; // 材料种类（material:scrap…）；装备品类待 A
  prices: number[]; // 近 N 笔成交单价（队尾最新，长度 ≤ AUCTION_PRICE_WINDOW_N）
}

/**
 * 家族频道消息（S8-4）。
 * ★ ts 须存 BSON Date（非 epoch number）——MongoDB TTL 只对 Date 字段生效。
 * 读出时转 epoch number 给客户端。
 */
export interface FamilyMessageDoc {
  _id: string; // `fm:{familyId}:{ts_epoch}:{seq}`
  worldId: string;
  familyId: string;
  senderId: string;
  /** 发送时快照昵称（防改名后历史失真）。 */
  senderName: string;
  body: string;
  /** BSON Date，TTL 锚字段（须 Date 非 epoch，见 CLAUDE.md 注）。 */
  ts: Date;
}

/** 宗门频道消息（S8-4b）。同 FamilyMessageDoc：ts 须 BSON Date（TTL 锚字段）。 */
export interface SectMessageDoc {
  _id: string; // `sm:{sectId}:{ts_epoch}:{seq}`
  worldId: string;
  sectId: string;
  senderId: string;
  senderName: string;
  body: string;
  ts: Date;
}

export interface SiegeDoc {
  _id: string; // siegeId
  worldId: string;
  attackerId: string;
  defenderId?: string;
  tile: string;
  outcome: SiegeOutcome;
  replayRef?: string;
  recomputed: boolean;
  ts: number;
  /**
   * G3-2c 重播观战：持久化权威战斗的输入（seed + 双方布阵 + 格等级）。客户端凭此重建
   * buildSiegeBattle 并以同 seed headless 重跑 → 逐字复现 worldsvc 跑过的那一场（纯演出，非权威）。
   * 旧战报 / 兜底廉价结算路径可缺省（重播降级为不可用）。
   */
  seed?: number;
  attackerArmy?: ArmyEntry[];
  defenderConfig?: DefenseConfig | null;
  tileLevel?: number;
}

/** 国家文档（S8-6.5）。每个首府对应一条记录，无主时无 ownerId/nationName。 */
export interface NationDoc {
  _id: string;            // `nation:{worldId}:{capitalIdx}`
  worldId: string;
  capitalIdx: number;     // 0~9，对应 CAPITAL_FRACTIONS 索引
  x: number;              // 首府格子 x（由 capitalPositions 计算，赛季开服时写入）
  y: number;
  ownerId?: string;       // 占领者 accountId
  familyId?: string;      // 占领者家族
  nationName?: string;    // 立国时玩家命名
  foundedAt?: number;     // ms
  rev: number;
}

/**
 * 赛季结算历史（C2/§17.2）。settleSeason 落库本季排名 + 繁荣度快照，作为下季 G6 分配输入。
 * `_id = `${worldId}:s${season}`` = 幂等键（同季重入 $setOnInsert 不覆盖）。
 */
export interface SeasonResultDoc {
  _id: string;
  worldId: string;
  season: number;
  settledAt: number;
  ranking: Array<{
    rank: number;
    scope: 'sect' | 'family' | 'solo';
    id: string;                // sectId / familyId / ownerId
    name?: string;
    nationCount: number;
    capitalIdxs: number[];
    prosperity?: number;       // 结算时繁荣度快照（sect scope 才有意义）
    memberFamilyIds?: string[]; // 成员家族名单（sect scope 才记，G6 下季 familyShard 展开输入，§20 R2）
    tier: SettleTier;
  }>;
}

/**
 * G6 多 shard 赛季分配（§20.2）。settle 时按上季宗门强弱蛇形均衡分配，落库本季 familyId→shardIndex；
 * 下季玩家 join 时按账号上季家族查表路由（宗门>家族>单随）。
 * `_id = `s${season}``（本赛季）。shardCount 可因人口溢出 $inc 递增。
 */
export interface ShardAllocationDoc {
  _id: string;        // `s${season}`
  season: number;
  shardCount: number;
  capacity: number;
  familyShard: Record<string, number>; // 上季 familyId → 本季 shardIndex
  createdAt: number;
}

export interface WorldCollections {
  worlds: Collection<WorldDoc>;
  tiles: Collection<TileDoc>;
  playerWorld: Collection<PlayerWorldDoc>;
  marches: Collection<MarchDoc>;
  families: Collection<FamilyDoc>;
  familyMembers: Collection<FamilyMemberDoc>;
  familyMessages: Collection<FamilyMessageDoc>;
  sects: Collection<SectDoc>;
  sectMessages: Collection<SectMessageDoc>;
  auctions: Collection<AuctionDoc>;
  auctionDaily: Collection<AuctionDailyDoc>;
  auctionPrices: Collection<AuctionPriceDoc>;
  sieges: Collection<SiegeDoc>;
  nations: Collection<NationDoc>;
  seasonResults: Collection<SeasonResultDoc>;
  shardAllocations: Collection<ShardAllocationDoc>;
}

export interface WorldMongo {
  client: MongoClient;
  db: Db;
  collections: WorldCollections;
  ensureIndexes(): Promise<void>;
  close(): Promise<void>;
}

export async function createWorldMongo(
  uri: string,
  dbName: string,
  options?: MongoClientOptions,
): Promise<WorldMongo> {
  const client = new MongoClient(uri, options);
  try {
    await client.connect();
  } catch (err) {
    const safeUri = uri.replace(/\/\/[^@/]*@/, '//<redacted>@');
    console.error(
      `[world-mongo] 连接 MongoDB 失败 (uri=${safeUri}, db=${dbName}): ` +
        `${(err as Error).message}. 请确认数据库已启动且 NW_WORLD_MONGO_URI/NW_MONGO_URI 正确。`,
    );
    throw err;
  }
  const db = client.db(dbName);
  const collections: WorldCollections = {
    worlds: db.collection<WorldDoc>('worlds'),
    tiles: db.collection<TileDoc>('tiles'),
    playerWorld: db.collection<PlayerWorldDoc>('playerWorld'),
    marches: db.collection<MarchDoc>('marches'),
    families: db.collection<FamilyDoc>('families'),
    familyMembers: db.collection<FamilyMemberDoc>('familyMembers'),
    familyMessages: db.collection<FamilyMessageDoc>('familyMessages'),
    sects: db.collection<SectDoc>('sects'),
    sectMessages: db.collection<SectMessageDoc>('sectMessages'),
    auctions: db.collection<AuctionDoc>('auctions'),
    auctionDaily: db.collection<AuctionDailyDoc>('auctionDaily'),
    auctionPrices: db.collection<AuctionPriceDoc>('auctionPrices'),
    sieges: db.collection<SiegeDoc>('sieges'),
    nations: db.collection<NationDoc>('nations'),
    seasonResults: db.collection<SeasonResultDoc>('seasonResults'),
    shardAllocations: db.collection<ShardAllocationDoc>('shardAllocations'),
  };

  async function ensureIndexes(): Promise<void> {
    await collections.worlds.createIndex({ status: 1 });
    // 视区范围查（P6：空间查询 v1 走 Mongo {worldId,x,y} 范围查；Redis 分桶缓存后置）。
    await collections.tiles.createIndex({ worldId: 1, x: 1, y: 1 });
    await collections.tiles.createIndex({ ownerId: 1 });
    await collections.tiles.createIndex({ familyId: 1 });
    await collections.playerWorld.createIndex({ worldId: 1, accountId: 1 });
    await collections.playerWorld.createIndex({ familyId: 1 });
    await collections.marches.createIndex({ worldId: 1, ownerId: 1 });
    // 到点扫描兜底（主调度走 Redis ZSET，S8-2；无 Redis 时降级 Mongo 轮询）。
    await collections.marches.createIndex({ arriveAt: 1 });
    await collections.families.createIndex({ worldId: 1, tag: 1 }, { unique: true });
    await collections.families.createIndex({ worldId: 1 });
    await collections.familyMembers.createIndex({ familyId: 1 });
    await collections.familyMessages.createIndex({ familyId: 1, ts: -1 });
    // TTL：7 天后自动删除（ts 为 BSON Date 字段，Mongo TTL 只对 Date 生效）。
    await collections.familyMessages.createIndex({ ts: 1 }, { expireAfterSeconds: FAMILY_MSG_RETENTION_SEC });
    // 宗门（S8-4b）：TAG worldId 内唯一；按 worldId 列；成员家族经 families.sectId 查。
    await collections.sects.createIndex({ worldId: 1, tag: 1 }, { unique: true });
    await collections.sects.createIndex({ worldId: 1 });
    await collections.families.createIndex({ sectId: 1 });
    await collections.sectMessages.createIndex({ sectId: 1, ts: -1 });
    await collections.sectMessages.createIndex({ ts: 1 }, { expireAfterSeconds: FAMILY_MSG_RETENTION_SEC });
    await collections.auctions.createIndex({ worldId: 1, itemType: 1, status: 1 });
    await collections.auctions.createIndex({ sellerId: 1 });
    await collections.auctions.createIndex({ designatedBuyerId: 1 });
    // 注：auctions.expireAt 故意 NOT TTL —— 过期需结算（退还卖方挂存），由扫描器按此索引处理；
    // TTL 自删会在结算前丢掉托管物（U13）。§14.3 表里的「TTL {expireAt}」按此实现期决定改为普通索引。
    await collections.auctions.createIndex({ expireAt: 1 });
    // C 每日限额：TTL 自清（expiresAt 为 BSON Date，Mongo TTL 只对 Date 生效）。
    await collections.auctionDaily.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // G 价格滑窗：_id = `${worldId}:${category}` 直查，无需额外索引（主键足够）。
    await collections.sieges.createIndex({ worldId: 1, ts: -1 });
    await collections.sieges.createIndex({ attackerId: 1 });
    // 国家：worldId 内按首府索引唯一
    await collections.nations.createIndex({ worldId: 1, capitalIdx: 1 }, { unique: true });
    await collections.nations.createIndex({ ownerId: 1 });
    // 赛季结算历史（C2/§17.2）：按 worldId 取最近季；G6 分配读上季排名。
    await collections.seasonResults.createIndex({ worldId: 1, season: -1 });
    // G6 多 shard 分配（§20）：按 season 取本季分配表（join 路由查 familyShard）。
    await collections.shardAllocations.createIndex({ season: 1 });
    // 建宗门门槛 / G6 分配按繁荣度查（§17.2）。
    await collections.families.createIndex({ worldId: 1, prosperity: -1 });
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
