// 成就系统机制单一来源的「定义 + 纯逻辑」实现（机制权威 ACHIEVEMENT_DESIGN.md）。
// 纯数据 + 纯函数，无 DB / 无 PIXI；服务端与客户端同源（客户端经镜像/codegen 复用同套定义算阶）。
// 数字（阈值/金币）镜像 ECONOMY_BALANCE.md §2.4（DRAFT），改条目 = 发版（§6.1 决策：硬编码不可运营配）。
import type { SaveData } from './types';

/**
 * StatKey：终身累计、单调递增的统计量标识。命名「域.主体.动作」。
 * **一旦上线只增不改不删**（改名 = 丢历史累计；§3.1）。一个 stat 可被多条成就复用。
 */
export type StatKey =
  | 'kill.archer' // 累计击杀弓箭手
  | 'kill.guard' // 累计击杀守卫
  | 'cast.meteor' // 释放陨石次数
  | 'campaign.chaptersCleared' // 通关章节数（取最大达成，首通才涨）
  | 'pvp.wins'; // 累计 PvP 胜场（仅 ranked）

/** 成就分类（成就墙按此分 tab，§7）。 */
export type AchCategory = 'pve' | 'pvp' | 'collection' | 'progression';

/** 成就 id（稳定标识，同 StatKey 上线后不改）。 */
export type AchId = string;

export interface AchTier {
  threshold: number; // 该阶解锁所需 stat 值（阶严格递增：高阶阈值 ≥ 低阶）
  coins: number; // 该阶一次性金币（A1：纯一次性、不可刷）
}

export interface Achievement {
  id: AchId;
  statKey: StatKey;
  category: AchCategory;
  tiers: AchTier[]; // 通常 3 阶（I/II/III），逐阶领
  /** 顶阶达成额外授予的永久称号（§0 2026-06-21 补；可选，多数成就无）。 */
  titleId?: string;
  /** 隐藏/彩蛋成就（达成前不在墙上展示，§10 决策 9；模型预留，初期全 false）。 */
  hidden?: boolean;
  /** 该 statKey 是否计 PvE 重打（§10 决策 3；多数 kill.* 接受重打）。仅文档/审计语义，不影响累加。 */
  countsReplay?: boolean;
}

/**
 * 硬编码成就定义表（§3.1 五条模板初值，阈值/金币 = ECONOMY_BALANCE §2.4 DRAFT）。
 * 单条满阶 ~350 金币；后期扩到 ~25 条 → 全游戏一次性 ~8–9k 金币池（全部一次性，非持续泵）。
 */
export const ACHIEVEMENTS: Achievement[] = [
  {
    id: 'ach.kill.archer',
    statKey: 'kill.archer',
    category: 'pvp',
    countsReplay: true,
    tiers: [
      { threshold: 100, coins: 50 },
      { threshold: 500, coins: 100 },
      { threshold: 2000, coins: 200 },
    ],
  },
  {
    id: 'ach.kill.guard',
    statKey: 'kill.guard',
    category: 'pvp',
    countsReplay: true,
    tiers: [
      { threshold: 100, coins: 50 },
      { threshold: 500, coins: 100 },
      { threshold: 2000, coins: 200 },
    ],
  },
  {
    id: 'ach.cast.meteor',
    statKey: 'cast.meteor',
    category: 'progression',
    countsReplay: true,
    tiers: [
      { threshold: 20, coins: 50 },
      { threshold: 100, coins: 100 },
      { threshold: 400, coins: 200 },
    ],
  },
  {
    id: 'ach.campaign.chapters',
    statKey: 'campaign.chaptersCleared',
    category: 'pve',
    countsReplay: false, // 首通才计，重打不涨（§3.1 $max 语义）
    tiers: [
      { threshold: 1, coins: 100 },
      { threshold: 3, coins: 200 },
      { threshold: 9, coins: 400 }, // 「全部」占位：暂按 9 章，章节扩充时同步
    ],
    titleId: 'ach.all_chapters', // 顶阶（全通关）额外授予永久称号（§7）
  },
  {
    id: 'ach.pvp.wins',
    statKey: 'pvp.wins',
    category: 'pvp',
    countsReplay: false,
    tiers: [
      { threshold: 10, coins: 50 },
      { threshold: 50, coins: 150 },
      { threshold: 200, coins: 300 },
    ],
    titleId: 'ach.pvp.veteran', // 顶阶（200 胜）额外授予永久称号（§7）
  },
];

export function findAchievement(id: AchId): Achievement | undefined {
  return ACHIEVEMENTS.find((a) => a.id === id);
}

export interface TierState {
  tier: number; // 1-based
  threshold: number;
  coins: number;
  reached: boolean; // stat ≥ 阈值
  claimable: boolean; // 达阈值且未领（红点源）
  claimed: boolean; // 已领
  progress: number; // min(stat, 阈值)，用于进度条
}

/**
 * 当前各阶状态推导（无状态，客户端/服务器同算，§4.1）。
 * 解锁阶永远由 stats 当场推导，不落库 → 改定义/调阈值不需迁移玩家数据。
 */
export function tierState(
  def: Achievement,
  stats: SaveData['stats'],
  claimedTiers: number[],
): TierState[] {
  const v = stats?.[def.statKey] ?? 0;
  return def.tiers.map((t, i) => {
    const tier = i + 1;
    const reached = v >= t.threshold;
    const claimed = claimedTiers.includes(tier);
    return {
      tier,
      threshold: t.threshold,
      coins: t.coins,
      reached,
      claimable: reached && !claimed,
      claimed,
      progress: Math.min(v, t.threshold),
    };
  });
}

/** 任一成就存在可领阶 → 入口红点（§4.1 红点聚合）。 */
export function hasClaimable(
  stats: SaveData['stats'],
  achievements: SaveData['achievements'],
): boolean {
  for (const def of ACHIEVEMENTS) {
    const claimed = achievements?.[def.id]?.claimedTiers ?? [];
    if (tierState(def, stats, claimed).some((s) => s.claimable)) return true;
  }
  return false;
}

export type ClaimError = 'BAD_REQUEST' | 'NOT_REACHED' | 'ALREADY_CLAIMED';

export interface ClaimOk {
  ok: true;
  coins: number; // 本次发放金币
  tier: number;
}

/**
 * 领取校验纯函数（§4.3 步骤 1–2）：不信客户端，二次校验 stat ≥ 阈值 + 未领。
 * 通过返回该阶金币；失败返回错误码。落库（$addToSet + 发币）由调用方在事务内完成。
 */
export function validateClaim(
  achId: AchId,
  tier: number,
  stats: SaveData['stats'],
  claimedTiers: number[],
): ClaimOk | { ok: false; error: ClaimError } {
  const def = findAchievement(achId);
  if (!def) return { ok: false, error: 'BAD_REQUEST' };
  if (!Number.isInteger(tier) || tier < 1 || tier > def.tiers.length) {
    return { ok: false, error: 'BAD_REQUEST' };
  }
  const t = def.tiers[tier - 1];
  if (!t) return { ok: false, error: 'BAD_REQUEST' };
  const v = stats?.[def.statKey] ?? 0;
  if (v < t.threshold) return { ok: false, error: 'NOT_REACHED' };
  if (claimedTiers.includes(tier)) return { ok: false, error: 'ALREADY_CLAIMED' };
  return { ok: true, coins: t.coins, tier };
}

// ─── PvP 战报计数（S9-6，§4.2 直接上报 + §4.4 L1 异常复查）─────────────────────

/**
 * 可由 PvP 战报上报喂入的 statKey（**仅 ranked**，§3.1）。
 * `pvp.wins` **不在此列**——它由 meta 据已校验的 winner_side 服务器自算（§4.2），不信客户端上报。
 * `campaign.chaptersCleared` 是 PvE 专属，也不在此列。
 */
export const PVP_REPORTED_STAT_KEYS: readonly StatKey[] = ['kill.archer', 'kill.guard', 'cast.meteor'];

/**
 * L1 单局硬边界（§4.4）：单局某 statKey 上报值超此上限即「离谱超界」→ 整份拒收 + 标记嫌疑。
 * 当前为**粗上界**（按引擎极端规模估计：单局单位/法术出牌数量级），精确推导见 §6.2 待办。
 * 远大于正常单局值（正常单局击杀几十、陨石个位数），只用于挡住明显伪造，不影响真实计数。
 */
export const PVP_STAT_MATCH_CAP: Readonly<Record<string, number>> = {
  'kill.archer': 200,
  'kill.guard': 200,
  'cast.meteor': 100,
};

/**
 * 清洗客户端上报的本局 PvP 统计（L1，§4.4）：
 * - **未知/不可上报 key**：丢弃（向前兼容版本错位，不因此拒收整份）。
 * - **非负整数校验 + L1 硬边界**：任一**已知可上报 key** 非法或越界 → 返回 `null`（拒收整份该方统计，
 *   调用方应跳过 kill/cast 累加，但 `pvp.wins`/ELO 仍照常；嫌疑升档属 S9-7，此处仅清洗）。
 * - 0 值省略（懒创建，不写 0）。
 */
export function sanitizePvpReportedStats(
  reported: Record<string, number> | undefined,
): Partial<Record<StatKey, number>> | null {
  if (!reported) return {};
  const out: Partial<Record<StatKey, number>> = {};
  for (const [k, v] of Object.entries(reported)) {
    if (!PVP_REPORTED_STAT_KEYS.includes(k as StatKey)) continue; // 未知 key → 丢弃（不拒整份）
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return null; // 非法 → L1 拒收
    if (v > (PVP_STAT_MATCH_CAP[k] ?? 0)) return null; // L1 越界 → 拒收
    if (v > 0) out[k as StatKey] = v;
  }
  return out;
}

/**
 * 把一份 statKey 增量累加进玩家终身 `stats`（懒创建：无增量则原样返回 prev、不实例化）。
 * 服务器权威结算点（PvP applyPvp / PvE 结算）调用；纯函数便于单测。
 */
export function accrueStats(
  prev: SaveData['stats'],
  delta: Partial<Record<StatKey, number>>,
): SaveData['stats'] {
  const keys = Object.keys(delta) as StatKey[];
  if (keys.length === 0) return prev;
  const next: Record<string, number> = { ...(prev ?? {}) };
  for (const k of keys) next[k] = (next[k] ?? 0) + (delta[k] ?? 0);
  return next as SaveData['stats'];
}
