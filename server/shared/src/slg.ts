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
  | 'base'; // 玩家主城落点（运行时写库）

export type ResourceType = 'food' | 'iron' | 'wood';
export type MarchKind = 'attack' | 'reinforce' | 'occupy' | 'sweep' | 'return';
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
export const AUCTION_TAX_RATE = 0.1; // U1 推迟到 S8-5，先占位
export const AUCTION_MAX_LISTINGS = 20;
export const AUCTION_DURATIONS_SEC: readonly number[] = [6 * 3600, 12 * 3600, 24 * 3600];
export const GARRISON_PER_TILE = 500;
/** 占领格至少需带的驻军（到点占领后即成该格 garrison；不足拒绝出征）。 */
export const OCCUPY_MIN_TROOPS = GARRISON_PER_TILE;
export const SEASON_LENGTH_DAYS = 30; // U3 推迟到 S8-7，先占位

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
 * 分布规则（U6 首版）：中心唯一 center 格；等级中心高→边缘低 + 中频噪声扰动；
 * 稀疏 familyKeep 战略要点；其余按密度判 resource（带 biome 资源种类）/ neutral 空地。
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

// ── 错误码：见 api.ts ErrorCode 的 SLG 段（WORLD_FULL/TILE_OCCUPIED/…）──
