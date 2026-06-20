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
} from '@nw/shared';
import { FAMILY_MSG_RETENTION_SEC } from '@nw/shared';

/** 防守配置：引擎 LevelDefinition 的受限子集（P2/P5，内嵌不建独立集合）。S8-3 接引擎前为 opaque 占位。 */
export type DefenseConfig = Record<string, unknown>;

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
  prosperity: number;     // 繁荣度（DRAFT，赛季内有效）
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
  price: number;
  currency: string;
  designatedBuyerId?: string;
  expireAt: number; // ms（过期由扫描器结算：退还卖方挂存，非 TTL 自删，见 ensureIndexes 注）
  status: AuctionStatus;
  buyerId?: string;
  rev: number;
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
  sieges: Collection<SiegeDoc>;
  nations: Collection<NationDoc>;
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
    sieges: db.collection<SiegeDoc>('sieges'),
    nations: db.collection<NationDoc>('nations'),
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
    await collections.sieges.createIndex({ worldId: 1, ts: -1 });
    await collections.sieges.createIndex({ attackerId: 1 });
    // 国家：worldId 内按首府索引唯一
    await collections.nations.createIndex({ worldId: 1, capitalIdx: 1 }, { unique: true });
    await collections.nations.createIndex({ ownerId: 1 });
  }

  return {
    client,
    db,
    collections,
    ensureIndexes,
    close: () => client.close(),
  };
}
