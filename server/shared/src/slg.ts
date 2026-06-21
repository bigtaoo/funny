// SLG 大世界常量 / 枚举 / ID / 程序化地图生成单一来源（SLG_DESIGN.md §14，S8-0）。
// 纯数据 + 纯函数，无 DB / 无 PIXI。worldsvc 用它做地图/领地/行军/家族的服务端权威；
// 集合文档形状（TileDoc/PlayerWorldDoc/MarchDoc…）在 mongo.ts（或 worldsvc 自带 db.ts）。
//
// ★ 程序化生成（§14.2「稀疏存储 + 程序化默认」）：DB 只存被占领/被改动的格子，
//   未触碰的中立格由 worldId 派生的纯函数 proceduralTile() 即时算出，不落库——scale 的关键。
//   同一 worldId + 同一 (x,y) 永远算出同一格（双端任一可算）。

import { ErrorCode, type ErrorCode as ErrorCodeT } from './api';

/**
 * worldsvc 端点错误：携带 SLG ErrorCode（httpApi 据 ERROR_HTTP_STATUS 映射 HTTP）。
 * code 限定为 api.ts ErrorCode 的合法值（含 SLG 段 + 通用 BAD_REQUEST/NOT_FOUND/…）。
 */
export class SlgError extends Error {
  readonly code: ErrorCodeT;
  constructor(code: keyof typeof ErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'SlgError';
    this.code = ErrorCode[code];
  }
}

// ── 枚举（§14.7）─────────────────────────────────────
export type TileType =
  | 'neutral' // 中立空地（低级、可占领、产出微薄）
  | 'resource' // 资源格（产 food/iron/wood）
  | 'territory' // 已被玩家占领的领地（运行时写库后才有，生成不产出此类型）
  | 'familyKeep' // 战略要点 / 家族关隘（稀疏、高级、高价值）
  | 'center' // 世界中心（宗门归属争夺点，唯一）
  | 'base' // 玩家主城落点（运行时写库）
  | 'obstacle' // 阻挡地形（山脉/河流，完全不可通行，S8-6.6）
  | 'gate'; // 关隘/桥（嵌于阻挡带；占领方及盟友可通行；未占领视为阻挡，S8-6.6）

export type ResourceType = 'food' | 'iron' | 'wood';
export type MarchKind = 'attack' | 'reinforce' | 'occupy' | 'sweep' | 'scout' | 'return';
export type SiegeOutcome = 'attacker_win' | 'defender_win' | 'draw';
export type FamilyRole = 'leader' | 'elder' | 'member';
export type WorldStatus = 'open' | 'active' | 'settling' | 'closed';
export type AuctionStatus = 'open' | 'sold' | 'expired' | 'cancelled';

export const RESOURCE_TYPES: readonly ResourceType[] = ['food', 'iron', 'wood'];

// ── 确定性 ID 推导（§14.7；无需查表，任一端可算）──────────
/** 世界 ID：`s{season}-{shard}`，一个赛季宗门世界 = 一张地图实例。 */
export function worldId(season: number, shard: number): string {
  return `s${season}-${shard}`;
}
/** 格子 ID：`{worldId}:{x}:{y}`。 */
export function tileId(world: string, x: number, y: number): string {
  return `${world}:${x}:${y}`;
}
/** 玩家在某世界的状态文档 ID。 */
export function playerWorldId(world: string, accountId: string): string {
  return `${world}:${accountId}`;
}
/** 家族成员文档 ID。 */
export function familyMemberId(world: string, accountId: string): string {
  return `${world}:${accountId}`;
}
/** 家族 ID（S8-4）：`f:{worldId}:{TAG}`；TAG 大写唯一缩写（3–4 字符）。 */
export function familyId(worldId: string, tag: string): string {
  return `f:${worldId}:${tag.toUpperCase()}`;
}
/** 宗门 ID（S8-4b）：`s:{worldId}:{TAG}`；TAG 大写唯一缩写（2–5 字符），worldId 内唯一。 */
export function sectId(worldId: string, tag: string): string {
  return `s:${worldId}:${tag.toUpperCase()}`;
}
/** 拍卖 ID（S8-5）：`a:{worldId}:{sellerId}:{ts}:{seq}`，防同毫秒多挂撞键。 */
export function auctionId(worldId: string, sellerId: string, ts: number, seq: number): string {
  return `a:${worldId}:${sellerId}:${ts}:${seq}`;
}
/**
 * 行军 ID（S8-2）：`m:{worldId}:{ownerId}:{departAt}:{seq}`。
 * 行军是临时文档（不像 tile/playerWorld 全局确定性），用 departAt(ms) + 进程内单调 seq
 * 保证同毫秒多次出征不撞键。worldsvc 非确定性引擎，可安全用真实时间戳。
 */
export function marchId(world: string, ownerId: string, departAt: number, seq: number): string {
  return `m:${world}:${ownerId}:${departAt}:${seq}`;
}
/** 围攻 ID（S8-3）：`g:{worldId}:{attackerId}:{ts}:{seq}`，瞬态战报记录，同 marchId 防撞键。 */
export function siegeId(world: string, attackerId: string, ts: number, seq: number): string {
  return `g:${world}:${attackerId}:${ts}:${seq}`;
}

// ── 容量 / 地图尺寸（U4/U2 已拍，2026-06-16；SLG_DESIGN §14.10）──
/** 单服（一个赛季宗门世界）目标容量：中型 300–500 人。 */
export const SLG_WORLD_CAPACITY_MIN = 300;
export const SLG_WORLD_CAPACITY_TARGET = 400;
export const SLG_WORLD_CAPACITY_MAX = 500;

/**
 * 地图尺寸：随容量配，按人均 ~150–300 格可开发反算 → ~400 人锁 300×300（90k 格）。
 * 稀疏存储：尺寸只影响开荒节奏/行军距离感，不影响存储（只落被占格）。
 */
export const SLG_MAP_W = 300;
export const SLG_MAP_H = 300;
export const SLG_MAP_MAX_LEVEL = 5;

// ── 程序化分布旋钮（U6 首版 DRAFT，集中此处便于调参）────────
export const SLG_GEN = {
  /** 资源格密度：非中立空地里被判为资源格的比例。 */
  resourceDensity: 0.34,
  /** 战略要点（familyKeep）噪声阈值，越高越稀疏。 */
  keepThreshold: 0.86,
  /** 战略要点最低离中心距离比（避免贴中心刷关隘）。 */
  keepMinDistRatio: 0.12,
  /** 等级噪声频率（值越大区块越碎）。 */
  levelFreq: 1 / 14,
  /** 资源种类（biome）噪声频率（值越小区块越大→大片同种资源便于专精与交易）。 */
  biomeFreq: 1 / 40,
  /** 战略要点噪声频率。 */
  keepFreq: 1 / 22,
  /** biome 三分阈值（food < t0 < wood < t1 < iron）。 */
  biomeFoodMax: 0.38,
  biomeWoodMax: 0.68,
  /** 中立空地的等级封顶（保持空地低价值）。 */
  neutralLevelCap: 2,
  // ── S8-6.6 阻挡地形 + 关隘 ──────────────────────────
  /** 阻挡地形噪声频率（中尺度连续山脉/河流地带）。 */
  obstacleFreq: 1 / 40,
  /** 阻挡地形噪声阈值（超过此值 → 障碍，~12% 格子）。 */
  obstacleThreshold: 0.88,
  /**
   * 障碍地形仅生成于 dr ≤ 此比例的区域（外围平原不生成障碍，保证玩家起始角落区可通行）。
   * 角落附近（dr > obstacleMaxDr）为无障碍安全区域。
   */
  obstacleMaxDr: 0.87,
  /** 关隘噪声频率（大尺度，稀疏战略通道）。 */
  gateFreq: 1 / 60,
  /** 关隘噪声阈值：障碍带内此值以上生成关隘（战略通道），极稀疏。 */
  gateThreshold: 0.99,
} as const;

// ── 数值常量（U6 DRAFT，上线后调参）────────────────────
export const TROOP_CAP_BASE = 2000;
export const MARCH_SPEED_SEC_PER_TILE = 6; // 行军每格耗时（秒）
export const MARCH_MIN_TROOPS = 1; // 出征最少带兵
export const RESOURCE_CAP = 200_000;
export const RESOURCE_YIELD_BASE = 100; // 每格每小时基础产出（× level 倍率）
export const PROTECTION_SEC = 8 * 3600; // 新手/被破城保护时长
export const FAMILY_CAP = 30; // S8-4 拍板：中小家族上限 30 人
/** 家族频道消息保留时长（秒），TTL 锚字段须 BSON Date（见 db.ts FamilyMessageDoc.ts 注）。 */
export const FAMILY_MSG_RETENTION_SEC = 7 * 24 * 3600; // 7 天
/** 家族频道单条消息正文最大长度。 */
export const FAMILY_MSG_BODY_MAX = 500;
// ── 宗门（S8-4b，§2.1 / §8.2）──────────────────────────────
/** 宗门内家族数量上限（≤30 家族 → ≤900 人）。 */
export const SECT_FAMILY_CAP = 30;
/** 建立宗门花费金币（U5：5000 coin + 繁荣度门槛）。 */
export const SECT_CREATE_COST = 5000;
/** 宗门可结盟的其他宗门数量上限（合纵连横 ≤3 宗门联盟 = 自身 + 2 盟友）。 */
export const SECT_ALLY_CAP = 2;
/** 门主主城被攻破时，全宗门成员当前资源损失比例（§8.2 重大惩罚）。 */
export const SECT_LEADER_PENALTY_RATE = 0.5;
/** 换届罢免投票通过门槛（族长票数 / 家族数 ≥ 此比例，§8.2 超 2/3）。 */
export const SECT_REMOVAL_VOTE_RATIO = 2 / 3;
export const AUCTION_TAX_RATE = 0.1; // U1 推迟到 S8-5，先占位
export const AUCTION_MAX_LISTINGS = 20;
export const AUCTION_DURATIONS_SEC: readonly number[] = [6 * 3600, 12 * 3600, 24 * 3600];

// ── 拍卖行反 RMT 闸门（AUCTION_DESIGN §4，DRAFT 数值上线后调参）──────────────
/** C 每日限额：单账号每日新挂单次数上限（按服务器 UTC 日界计）。 */
export const AUCTION_DAILY_LIST_CAP = 30;
/** C 每日限额：单账号每日购买/出价次数上限。 */
export const AUCTION_DAILY_BUY_CAP = 30;
/** C 每日限额计数文档 TTL（秒）：超 2 日自然过期清理（按 dayKey 隔离，留足跨日界缓冲）。 */
export const AUCTION_DAILY_TTL_SEC = 2 * 24 * 3600;
/**
 * E 绑定材料禁挂：列入此集合的材料禁止上拍（账号绑定/赛季活动专属）。
 * 初期为空——机制位先就绪，禁挂清单随经济运营填（AUCTION_DESIGN §4.E）。
 */
export const AUCTION_BANNED_MATERIALS: ReadonlySet<string> = new Set<string>();
/**
 * G 价格护栏（动态滑窗，AUCTION_DESIGN §4.G）：每品类维护近 N 笔成交单价滑窗算 refPrice，
 * 挂单/出价单价须落在 [refPrice×FLOOR, refPrice×CEIL]；样本不足回退静态估值；无静态值则放行（冷启动不裸奔但不误杀）。
 */
export const AUCTION_PRICE_WINDOW_N = 20; // 滑窗保留近 N 笔成交单价
export const AUCTION_PRICE_WINDOW_MIN_SAMPLES = 5; // 少于此样本数走静态回退
export const AUCTION_PRICE_FLOOR_RATIO = 0.5; // 单价下限 = refPrice × 0.5（封地板倾销）
export const AUCTION_PRICE_CEIL_RATIO = 2.0; // 单价上限 = refPrice × 2.0（封天价洗钱）
/** G 冷启动静态参考单价（每件，DRAFT）：滑窗样本不足时用，演算去 ECONOMY_NUMBERS。未列品类则放行。 */
export const AUCTION_STATIC_REF_PRICE: Readonly<Record<string, number>> = {
  scrap: 10,
  lead: 30,
  binding: 80,
};
// ── B 竞拍（AUCTION_DESIGN §4.B，DRAFT）──────────────────────────────────────
/** 竞拍最小加价幅度 = 当前最高价 × 此比例（不足则按起拍价绝对值兜底）。 */
export const AUCTION_MIN_INCREMENT_RATIO = 0.05;
/** 防狙击窗口（秒）：到期前此窗口内有新出价 → expireAt 顺延同等窗口，封末段秒杀。 */
export const AUCTION_ANTI_SNIPE_WINDOW_SEC = 5 * 60;
export const GARRISON_PER_TILE = 500;
/** 占领格至少需带的驻军（到点占领后即成该格 garrison；不足拒绝出征）。 */
export const OCCUPY_MIN_TROOPS = GARRISON_PER_TILE;
export const SEASON_LENGTH_DAYS = 60; // U3：2 个月
/** 主动迁城花费金币（§3.4 / §8.2 主城迁移：选好新址 + 付费迁移，所有玩家通用，非门主特有）。 */
export const RELOCATE_COST = 500;

/**
 * gateway 横扩推送通道（SOC9 / §8.4）：worldsvc 把「一条消息 + 收件人列表」发到此 Redis
 * pub/sub channel，每个 gateway 实例订阅后向本机在线的收件人 socket 扇出。避免 worldsvc 对
 * ≤900 人宗门做 O(n) HTTP 直推（信息量过大），亦天然支持多 gateway 实例路由。
 */
export const GW_PUSH_REDIS_CHANNEL = 'nw:gw:push';

// ── 训练队列（S8-2，§4 兵力循环）──────────────────────────────
/** 每兵训练消耗粮食（DRAFT，上线后调参）。 */
export const TROOP_TRAIN_FOOD_COST = 10;
/** 每兵训练耗时（秒，DRAFT）。*/
export const TROOP_TRAIN_TIME_SEC = 5;
/** 单批最大训练量（上限单批队列大小）。 */
export const TROOP_TRAIN_BATCH_MAX = 500;
/** 同时可排的训练批次上限（训练队列槽位）。 */
export const TROOP_TRAIN_QUEUE_MAX = 2;
/** 加速：1 金币 = 多少秒训练时间（DRAFT，60 秒/币）。 */
export const TROOP_SPEEDUP_SECS_PER_COIN = 60;

// ── 国家系统（S8-6.5，§2.4）──────────────────────────────────
/** 国家数量（10 首府 = 10 国）。*/
export const NATION_COUNT = 10;
/** 国民加成：本国 Voronoi 区内资源产出加成（分数，0.10 = +10%，DRAFT）。 */
export const NATION_BONUS_PRODUCTION = 0.10;
/** 国民加成：本国 Voronoi 区内防御战斗加成（分数，0.15 = +15%，DRAFT）。 */
export const NATION_BONUS_DEFENSE = 0.15;
/**
 * 10 首府相对坐标（分数 0~1，乘以 mapW-1/mapH-1 得实际格子）。
 * 布局：8 外围（四角 + 四边中点）+ 1 中部偏内 + 1 中原（地图中心）。
 * 设计文档 §2.4：固定坐标，hardcoded in shared/slg.ts，Voronoi 分区由此派生。
 */
export const CAPITAL_FRACTIONS: readonly [number, number][] = [
  [0.14, 0.14], // 0: 西北角
  [0.50, 0.10], // 1: 正北
  [0.86, 0.14], // 2: 东北角
  [0.10, 0.50], // 3: 正西
  [0.90, 0.50], // 4: 正东
  [0.14, 0.86], // 5: 西南角
  [0.50, 0.90], // 6: 正南
  [0.86, 0.86], // 7: 东南角
  [0.32, 0.32], // 8: 内圈西北（普通首府）
  [0.50, 0.50], // 9: 中原首府（地图中心，赛季额外奖励目标）
] as const;

/** 把相对坐标转换为地图实际整数坐标。 */
export function capitalPositions(mapW: number, mapH: number): [number, number][] {
  return CAPITAL_FRACTIONS.map(([fx, fy]) => [
    Math.round(fx * (mapW - 1)),
    Math.round(fy * (mapH - 1)),
  ]);
}

/** 返回 (x,y) 所属的最近首府索引（Voronoi 分区，欧氏距离）。 */
export function nearestCapitalIdx(
  x: number,
  y: number,
  capitals: readonly [number, number][],
): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < capitals.length; i++) {
    const [cx, cy] = capitals[i]!;
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

/** 判断 (x,y) 是否是某个首府位置，返回首府索引（-1 = 不是首府）。 */
export function capitalIdxAt(
  x: number,
  y: number,
  capitals: readonly [number, number][],
): number {
  for (let i = 0; i < capitals.length; i++) {
    const [cx, cy] = capitals[i]!;
    if (cx === x && cy === y) return i;
  }
  return -1;
}

// ── SLG 商店商品（S8-8，§8）──────────────────────────────────
export interface SlgShopItem {
  id: string;
  /** 金币价格。 */
  cost: number;
  kind: 'troop_speedup' | 'resource_pack' | 'protection' | 'battle_pass';
  /** 具体效果参数（duration_sec / resource_each / pass_season）。 */
  effect: Record<string, number | string>;
  description: string;
}

export const SLG_SHOP_ITEMS: readonly SlgShopItem[] = [
  // 训练加速
  { id: 'slg_speedup_1h',    cost: 200,   kind: 'troop_speedup', effect: { duration_sec: 3600 },  description: '加速训练 1 小时' },
  { id: 'slg_speedup_8h',    cost: 1400,  kind: 'troop_speedup', effect: { duration_sec: 28800 }, description: '加速训练 8 小时' },
  { id: 'slg_speedup_24h',   cost: 3600,  kind: 'troop_speedup', effect: { duration_sec: 86400 }, description: '加速训练 24 小时' },
  // 资源包（food/iron/wood 各加等量）
  { id: 'slg_res_s',  cost: 300,   kind: 'resource_pack', effect: { each: 20000 },  description: '小资源包（各 2 万）' },
  { id: 'slg_res_m',  cost: 1000,  kind: 'resource_pack', effect: { each: 80000 },  description: '中资源包（各 8 万）' },
  { id: 'slg_res_l',  cost: 3000,  kind: 'resource_pack', effect: { each: 200000 }, description: '大资源包（各 20 万）' },
  // 保护罩
  { id: 'slg_shield_8h',  cost: 500,  kind: 'protection', effect: { duration_sec: 28800 }, description: '主城保护罩 8 小时' },
  { id: 'slg_shield_24h', cost: 1200, kind: 'protection', effect: { duration_sec: 86400 }, description: '主城保护罩 24 小时' },
  // 赛季战令
  { id: 'slg_battle_pass', cost: 9800, kind: 'battle_pass', effect: { pass_season: 1 }, description: '赛季战令（当季有效）' },
] as const;

// ── 确定性噪声（纯函数，无随机源；同输入同输出）─────────────
/** 32-bit 整数哈希（两坐标 + seed → uint32）。 */
function hash2(x: number, y: number, seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (x | 0), 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (y | 0), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
/** 坐标 → [0,1) 伪随机值。 */
function rand2(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / 4294967296;
}
/** 字符串 → 32-bit seed（worldId → 世界种子）。 */
export function worldSeed(world: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < world.length; i++) {
    h ^= world.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
/** 值噪声（双线性插值 + smoothstep），输出 [0,1]，连续平滑——用于 biome/等级大区块。 */
function valueNoise(x: number, y: number, freq: number, seed: number): number {
  const fx = x * freq;
  const fy = y * freq;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const s = (t: number) => t * t * (3 - 2 * t); // smoothstep
  const v00 = rand2(x0, y0, seed);
  const v10 = rand2(x0 + 1, y0, seed);
  const v01 = rand2(x0, y0 + 1, seed);
  const v11 = rand2(x0 + 1, y0 + 1, seed);
  const sx = s(tx);
  const sy = s(ty);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

// ── 程序化地图生成（核心，§14.2 / U2 / U6 首版）──────────────
/** 程序化格子的默认属性（未被占领的中立世界）。运行时被占领后以 DB 文档为准。 */
export interface ProceduralTile {
  type: TileType;
  /** 资源/格子等级 1..SLG_MAP_MAX_LEVEL（越高产出越多、默认 NPC 驻军越强）。 */
  level: number;
  /** 资源种类（仅 resource / familyKeep 有）。 */
  resType?: ResourceType;
}

/** biome：低频噪声分三大区，便于资源专精与跨区交易（U1 拍卖经济的地理基础）。 */
function biomeAt(x: number, y: number, seed: number): ResourceType {
  const n = valueNoise(x, y, SLG_GEN.biomeFreq, seed ^ 0x0444);
  if (n < SLG_GEN.biomeFoodMax) return 'food';
  if (n < SLG_GEN.biomeWoodMax) return 'wood';
  return 'iron';
}

/**
 * 算出 (worldId, x, y) 的程序化默认格子。纯函数、确定性、不落库。
 * 分布规则（U6 + S8-6.6）：中心唯一 center 格；阻挡地形（山脉/河流）+ 关隘嵌于阻挡带；
 * 等级中心高→边缘低；稀疏 familyKeep 战略要点；其余按密度判 resource / neutral。
 */
export function proceduralTile(world: string, x: number, y: number): ProceduralTile {
  const seed = worldSeed(world);
  const cx = SLG_MAP_W / 2;
  const cy = SLG_MAP_H / 2;

  // 世界中心（唯一）
  if (x === Math.floor(cx) && y === Math.floor(cy)) {
    return { type: 'center', level: SLG_MAP_MAX_LEVEL };
  }

  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxDist = Math.sqrt(cx * cx + cy * cy);
  const dr = dist / maxDist; // 0 中心 .. 1 角落

  // ── 阻挡地形 + 关隘（S8-6.6）────────────────────────────────
  // 仅在 dr ≤ obstacleMaxDr 的中部区域生成；外围平原（角落）保持无障碍，保证玩家起始区通行。
  if (dr <= SLG_GEN.obstacleMaxDr) {
    const obstNoise = valueNoise(x, y, SLG_GEN.obstacleFreq, seed ^ 0x0888);
    if (obstNoise > SLG_GEN.obstacleThreshold) {
      // 关隘：阻挡带内高峰位置（战略通道）——比阻挡更稀疏。
      const gateNoise = valueNoise(x, y, SLG_GEN.gateFreq, seed ^ 0x0999);
      if (gateNoise > SLG_GEN.gateThreshold) {
        return { type: 'gate', level: Math.max(2, SLG_MAP_MAX_LEVEL - 1) };
      }
      return { type: 'obstacle', level: 1 };
    }
  }

  // 等级：中心高→边缘低（(1-dr) 主导）+ 中频噪声扰动
  const lvlNoise = valueNoise(x, y, SLG_GEN.levelFreq, seed ^ 0x0111);
  let level = Math.round((1 - dr) * (SLG_MAP_MAX_LEVEL - 1) + 1 + (lvlNoise - 0.5) * 1.5);
  level = Math.max(1, Math.min(SLG_MAP_MAX_LEVEL, level));

  // 战略要点 / 家族关隘：稀疏高峰，离中心一定距离外
  const keepNoise = valueNoise(x, y, SLG_GEN.keepFreq, seed ^ 0x0222);
  if (keepNoise > SLG_GEN.keepThreshold && dr > SLG_GEN.keepMinDistRatio) {
    return {
      type: 'familyKeep',
      level: Math.max(level, SLG_MAP_MAX_LEVEL - 1),
      resType: biomeAt(x, y, seed),
    };
  }

  // 资源格 vs 中立空地
  const occ = rand2(x, y, seed ^ 0x0333);
  if (occ < SLG_GEN.resourceDensity) {
    return { type: 'resource', level, resType: biomeAt(x, y, seed) };
  }
  return { type: 'neutral', level: Math.min(level, SLG_GEN.neutralLevelCap) };
}

// ── 领地产出（S8-1，资源惰性结算的单格贡献，§14.3）────────────
/**
 * 单格每小时产出（占领后计入 `playerWorld.yieldRate`）。纯函数。
 * - `base`（主城）：给起步粮食 trickle（`RESOURCE_YIELD_BASE`），保证新玩家有产出可结算。
 * - 有 `resType` 的格（resource / familyKeep / 占领后的 territory）：产对应资源 `RESOURCE_YIELD_BASE × level`。
 * - 其余（无 resType 的 neutral/territory）：不产出。
 */
export function tileYield(
  type: TileType,
  level: number,
  resType?: ResourceType,
): Partial<Record<ResourceType, number>> {
  if (type === 'base') return { food: RESOURCE_YIELD_BASE };
  if (resType) return { [resType]: RESOURCE_YIELD_BASE * Math.max(1, level) };
  return {};
}

// ── 行军（S8-2，§14.4/§4）────────────────────────────────
/**
 * 行军耗时（秒）：欧氏距离（向上取整）× MARCH_SPEED_SEC_PER_TILE，最少 1 格。
 * 纯函数、双端可算（客户端预估 ETA / 服务端权威定 arriveAt）。同格（距离 0）= 1 格成本。
 */
export function marchDurationSec(fx: number, fy: number, tx: number, ty: number): number {
  const dx = tx - fx;
  const dy = ty - fy;
  const tiles = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy)));
  return tiles * MARCH_SPEED_SEC_PER_TILE;
}

// ── A* 行军寻路（S8-6.6，§4「行军寻路」）──────────────────────────
// 4方向 A*（上/下/左/右，无斜向），曼哈顿距离启发。
// 阻挡格不可通行；未占领关隘视为阻挡（"未占领视为阻挡"）；
// 已占领关隘仅占领方 / 盟友可途经（passableGateKeys 由调用方预取 DB 组装）。

/** 行军路径节点。 */
export interface PathCell {
  x: number;
  y: number;
}

/**
 * A* 寻路：从 (fx,fy) 到 (tx,ty)。
 * - 返回完整路径（含起点和终点）；同格返回单节点 [{fx,fy}]。
 * - 目标不可达（障碍 / 无路 / 越界）返回 null。
 * - passableGateKeys：可途经的关隘格 key 集合（格式 "x:y"）；目标关隘本身始终可达（不论有无通行权）。
 * - MAX_NODES 安全上限（防超大地图极端情况）。
 */
export function findMarchPath(
  world: string,
  mapW: number,
  mapH: number,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  passableGateKeys: ReadonlySet<string>,
): PathCell[] | null {
  if (fx === tx && fy === ty) return [{ x: fx, y: fy }];
  if (!_slgInBounds(fx, fy, mapW, mapH) || !_slgInBounds(tx, ty, mapW, mapH)) return null;

  const walkable = (x: number, y: number, isDest: boolean): boolean => {
    if (!_slgInBounds(x, y, mapW, mapH)) return false;
    const p = proceduralTile(world, x, y);
    if (p.type === 'obstacle') return false; // 障碍永远阻挡，含目标格
    if (p.type === 'gate') return isDest || passableGateKeys.has(`${x}:${y}`);
    return true;
  };

  if (!walkable(tx, ty, true)) return null; // 目标格是障碍

  const MAX_NODES = 500_000;
  // g: 从起点到该节点的最短步数；par: 父节点 flat index（重建路径）
  const g = new Map<number, number>();
  const par = new Map<number, number>();
  // open set：最小堆，元素 = [f, flatIdx]
  const heap: [number, number][] = [];

  const h = (x: number, y: number) => Math.abs(x - tx) + Math.abs(y - ty);
  const si = fy * mapW + fx;
  g.set(si, 0);
  _slgHeapPush(heap, [h(fx, fy), si]);

  const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const closed = new Set<number>();
  let explored = 0;

  while (heap.length > 0) {
    const [, cur] = _slgHeapPop(heap)!;
    if (closed.has(cur)) continue;
    closed.add(cur);

    const cx = cur % mapW;
    const cy = (cur / mapW) | 0;
    if (cx === tx && cy === ty) return _slgReconstructPath(par, mapW, si, cur);
    if (++explored > MAX_NODES) break;

    const cg = g.get(cur)!;
    for (const [ddx, ddy] of DIRS) {
      const nx = cx + ddx;
      const ny = cy + ddy;
      const isDest = nx === tx && ny === ty;
      if (!walkable(nx, ny, isDest)) continue;
      const ni = ny * mapW + nx;
      const ng = cg + 1;
      if (ng < (g.get(ni) ?? Infinity)) {
        g.set(ni, ng);
        par.set(ni, cur);
        _slgHeapPush(heap, [ng + h(nx, ny), ni]);
      }
    }
  }
  return null;
}

/** 行军路径 → 耗时（秒）：path.length-1 步 × MARCH_SPEED_SEC_PER_TILE。 */
export function marchDurationFromPath(path: PathCell[]): number {
  return Math.max(0, path.length - 1) * MARCH_SPEED_SEC_PER_TILE;
}

function _slgInBounds(x: number, y: number, mapW: number, mapH: number): boolean {
  return x >= 0 && y >= 0 && x < mapW && y < mapH;
}

function _slgReconstructPath(par: Map<number, number>, mapW: number, start: number, end: number): PathCell[] {
  const path: PathCell[] = [];
  let cur = end;
  while (cur !== start) {
    path.push({ x: cur % mapW, y: (cur / mapW) | 0 });
    cur = par.get(cur)!;
  }
  path.push({ x: start % mapW, y: (start / mapW) | 0 });
  return path.reverse();
}

function _slgHeapPush(heap: [number, number][], item: [number, number]): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    const pi = heap[p]!; const ii = heap[i]!;
    if (pi[0] <= ii[0]) break;
    heap[p] = ii; heap[i] = pi;
    i = p;
  }
}

function _slgHeapPop(heap: [number, number][]): [number, number] | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let m = i;
      if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
      if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
      if (m === i) break;
      const tmp = heap[i]!; heap[i] = heap[m]!; heap[m] = tmp;
      i = m;
    }
  }
  return top;
}

// ── 围攻结算（S8-3，§5.3）────────────────────────────────
// worldsvc 不引确定性引擎（M12），到点用此**廉价线性数值结算**即时落地围攻 outcome
// （territory 易主 / 主城掠夺 / NPC 扫荡）；这是设计许可的「非关键 / 廉价数值结算」路径（§5.3）。
// 「关键战斗」（真人手操破城）的引擎复算（buildSiegeBlueprints + judgeRunner siege 分支）已在
// 客户端落地并单测，S8-3b 经 worldsvc→gateway /gw/judge 接入此处替代廉价结算。

/** 中立 / 资源格的 NPC 守军强度（扫荡 sweep 的防守，按格等级线性）。 */
export const NPC_GARRISON_PER_LEVEL = 120;
/** 围攻得手后掠夺目标资源的比例（territory 易主 / 主城掠夺时从败方资源抽走给攻方）。 */
export const SIEGE_LOOT_RATE = 0.25;
/** 扫荡 NPC 得手的一次性资源缴获（按格等级，单资源）。 */
export const SWEEP_LOOT_PER_LEVEL = 200;

/** 单格 NPC 守军（扫荡防守强度）。 */
export function npcGarrison(level: number): number {
  return NPC_GARRISON_PER_LEVEL * Math.max(1, level);
}

export interface SiegeResolution {
  outcome: SiegeOutcome;
  /** 攻方生还兵力（attacker_win 时可成新驻军 / 回师；defender_win = 0 全灭）。 */
  attackerSurvivors: number;
  /** 守方生还兵力（defender_win 时为残余守军；attacker_win = 0）。 */
  defenderSurvivors: number;
}

/**
 * 线性（Lanchester-lite）围攻结算：攻方兵力 > 守方防守强度 → 攻方胜，生还 = 兵力差；
 * 否则守方胜（平局并入守方，符合「防守占优」）。纯函数、确定性、双端可算。
 */
export function resolveSiege(attackerTroops: number, defenseStrength: number): SiegeResolution {
  const atk = Math.max(0, Math.floor(attackerTroops));
  const def = Math.max(0, Math.floor(defenseStrength));
  if (atk > def) {
    return { outcome: 'attacker_win', attackerSurvivors: atk - def, defenderSurvivors: 0 };
  }
  return { outcome: 'defender_win', attackerSurvivors: 0, defenderSurvivors: def - atk };
}

/**
 * 国民防御加成（S8-6.5 / §2.4）：守军处于「己方占领首府的 Voronoi 区」内时，有效防守强度
 * ×(1+NATION_BONUS_DEFENSE)，否则取原值。纯函数、确定性、整数化、双端可算。
 */
export function nationDefenseStrength(garrison: number, inOwnNation: boolean): number {
  const g = Math.max(0, Math.floor(garrison));
  return inOwnNation ? Math.floor(g * (1 + NATION_BONUS_DEFENSE)) : g;
}

// ── 视野 / 迷雾（G5，§8.2 / §2.1 / §15.2）─────────────────────────────────────
// 拍板（2026-06-21）：迷雾模型 2a —— 地形层（程序化、确定性）全图始终可见；动态层（归属/
// 驻军/防守/保护罩/行军）仅在「当前视野」内显示，视野外一律退回 proceduralTile 的底层地形
// （连「该格已被占领」这一信号都不泄露）。视野不落库：读时按视野源实时计算 + 短 TTL 缓存。
// 视野源 = 己方领地（半径 VISION_TERRITORY）+ 主城（半径 VISION_BASE）+ 在途己方/家族行军
// （半径 VISION_MARCH，按 departAt/arriveAt 线性插值当前位置）+ 同家族成员领地（共享，≤30 人，
// §8.2 拍板降级为家族级而非宗门级，避免 900 人并集让迷雾名存实亡）。视野形状用 Chebyshev
// （方形）距离——格子网格上最简、双端可算。

/** 己方领地视野半径（Chebyshev，DRAFT）。 */
export const VISION_TERRITORY_RADIUS = 2;
/** 主城视野半径（比领地大，DRAFT）。 */
export const VISION_BASE_RADIUS = 5;
/** 在途行军视野半径（侦察行军价值的来源，DRAFT）。 */
export const VISION_MARCH_RADIUS = 2;
/**
 * 侦察行军（scout kind）视野半径（G5 V2 余项，DRAFT）。比普通行军大——侦察的价值就在于
 * 「探得更深」：不打不占，派少量兵到任意非障碍格，沿途 + 抵达点照亮一片更大的视野后自动回师。
 */
export const VISION_SCOUT_RADIUS = 4;

/** 视野源：一个中心点 + 半径（Chebyshev）。 */
export interface VisionSource {
  x: number;
  y: number;
  radius: number;
}

/**
 * 某格 (x,y) 是否落在任一视野源的 Chebyshev 半径内。纯函数、双端可算。
 * 源数量在视区内有界（己方/家族领地 + 主城 + 在途行军），逐格调用代价可接受。
 */
export function isInVision(sources: readonly VisionSource[], x: number, y: number): boolean {
  for (const s of sources) {
    if (Math.abs(x - s.x) <= s.radius && Math.abs(y - s.y) <= s.radius) return true;
  }
  return false;
}

/**
 * 行军当前位置（fromTile→toTile 线性插值；G5 视野用，路径可能绕障故为近似，足够圈视野）。
 * frac 由 (now-departAt)/(arriveAt-departAt) 钳在 [0,1]；退化（arriveAt≤departAt）取终点。
 */
export function marchInterpPos(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  departAt: number,
  arriveAt: number,
  now: number,
): { x: number; y: number } {
  const span = arriveAt - departAt;
  const frac = span > 0 ? Math.max(0, Math.min(1, (now - departAt) / span)) : 1;
  return {
    x: Math.round(fromX + (toX - fromX) * frac),
    y: Math.round(fromY + (toY - fromY) * frac),
  };
}

// ── 围攻可玩防守关卡（S8-3b / C2）─────────────────────────────────────────────
// 把存储的防守 config（DefenseConfig 子集：garrison/defenderBuildings/defenderBaseLevel）规整成一份
// 「攻方可打」的完整 LevelDefinition 形态对象（objective=destroy_base，无脚本波次）。客户端用它在
// GameScene siege 模式实打 / 复盘；worldsvc 复算（resolveSiegeWithJudge）用同一份作为 judge 的
// defenseJson —— 两端必须逐字一致才能确定性复算，故集中于此单一来源。

/** 由 siegeId 派生确定性 seed（FNV-1a 32-bit），供围攻关卡 + 复算同 seed。 */
export function siegeSeedFromId(sid: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sid.length; i++) {
    h ^= sid.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function clampBaseLevel(n: number): number {
  return Math.max(0, Math.min(3, Math.floor(n) || 0));
}

/**
 * 围攻战斗硬时限（ticks，§16.1 DRAFT）：~10 分钟游戏时间 × 60 × 30 Hz = 18000 ticks。
 * 超时双基地皆存 → 防守方胜（防守占优）+ headless 复算算力封顶。调参细化见 §16.5。
 */
export const SIEGE_BATTLE_TIMEOUT_TICKS = 10 * 60 * 30;

/** 进攻布阵模板（队伍）上限（§16.2，前期 5 支 = 可保存模板数 + 并发上限）。 */
export const SIEGE_TEAM_CAP = 5;

/**
 * 规整防守 config → 完整围攻关卡对象。`config` 为防守方自定义（可空）；`tileLevel` 用于无自定义时
 * 派生一个象征性的基地等级防守。返回形态对齐客户端 LevelDefinition（loose object，避免在 shared
 * 复制引擎 schema）。纯函数、确定性、双端可算。
 */
export function buildSiegeLevel(
  config: { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown } | null | undefined,
  tileLevel: number,
  seed: number,
): Record<string, unknown> {
  const level: Record<string, unknown> = {
    id: `siege:${seed}`,
    chapter: 0,
    seed,
    objective: { kind: 'destroy_base' },
    waves: { entries: [] },
  };
  if (config) {
    if (Array.isArray(config.garrison) && config.garrison.length > 0) level.garrison = config.garrison;
    if (Array.isArray(config.defenderBuildings) && config.defenderBuildings.length > 0) {
      level.defenderBuildings = config.defenderBuildings;
    }
    if (typeof config.defenderBaseLevel === 'number') {
      level.defenderBaseLevel = clampBaseLevel(config.defenderBaseLevel);
    }
  } else {
    // 无自定义防守 → 用格等级派生一个象征性基地防守（确定性，攻方破基即胜）。
    level.defenderBaseLevel = clampBaseLevel(Math.floor(tileLevel) - 1);
  }
  return level;
}

/**
 * 围攻自动战斗关卡（G3-2a，§16.3）：在 {@link buildSiegeLevel}（守方布阵 + 双基地 +
 * objective:destroy_base）基础上扩出**攻方预布军**（`attackerArmy`，下半场 owner0）+
 * **战斗硬时限**（`battleTimeoutTicks`，超时判防守方胜）。无 live 指令 → 战斗由
 * `seed + 双方布阵` 唯一确定（worldsvc headless 跑权威；客户端 seed 重播观战）。
 *
 * 纯函数、确定性、双端可算。返回 loose object，形态对齐客户端 LevelDefinition
 * （含 attackerArmy / battleTimeoutTicks，由 levelSchema 校验）。
 *
 * @param attacker 攻方布阵（`army` = GarrisonEntry[]，含每单位 initialHp = 分配兵力）。
 * @param defender 守方 config（garrison / defenderBuildings / defenderBaseLevel），同 buildSiegeLevel。
 * @param tileLevel 无守方自定义时派生象征性基地等级。
 * @param seed 关卡 seed（围攻同 seed，复算/重播一致）。
 * @param battleTimeoutTicks 战斗硬时限，默认 {@link SIEGE_BATTLE_TIMEOUT_TICKS}。
 */
export function buildSiegeBattle(
  attacker: { army?: unknown } | null | undefined,
  defender: { garrison?: unknown; defenderBuildings?: unknown; defenderBaseLevel?: unknown } | null | undefined,
  tileLevel: number,
  seed: number,
  battleTimeoutTicks: number = SIEGE_BATTLE_TIMEOUT_TICKS,
): Record<string, unknown> {
  // 复用守方规整（双基地 + destroy_base 已含）；再叠加攻方军 + 时限。
  const level = buildSiegeLevel(defender, tileLevel, seed);
  level.battleTimeoutTicks = Math.max(1, Math.floor(battleTimeoutTicks));
  if (attacker && Array.isArray(attacker.army) && attacker.army.length > 0) {
    level.attackerArmy = attacker.army;
  }
  return level;
}

// ── 错误码：见 api.ts ErrorCode 的 SLG 段（WORLD_FULL/TILE_OCCUPIED/…）──
