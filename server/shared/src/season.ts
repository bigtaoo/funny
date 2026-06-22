// 天梯赛季系统（S11，SEASON_DESIGN.md）。纯函数，无 DB / 无 PIXI。
// 赛季时钟、软重置、段位首达金币、赛季峰值金币。
// 数值以 ECONOMY_NUMBERS §13 为准；本文件定义常量 + 纯函数逻辑。
import type { RankId } from './ladder';
import { RANK_TIERS, eloToRank } from './ladder';

// ── 赛季时钟 ────────────────────────────────────────────────────────────────

/** 6 周一赛季（展示/预计结束用；实际开新季由 admin 手动触发）。 */
export const SEASON_DURATION_MS = 6 * 7 * 24 * 60 * 60 * 1000;

/** 软重置基准 ELO（高于此向基准回归；等于或低于不变）。初定黄金下限 1200。 */
export const SEASON_RESET_BASELINE = 1200;

/** 赛季时钟文档（`ladderSeasons` 集合，全局唯一 _id='current'）。 */
export interface LadderSeasonDoc {
  _id: 'current';
  /** 当前赛季号，从 1 起。 */
  seasonNo: number;
  /** 本季开始时间（epoch ms）。 */
  startAt: number;
  /** 预计结束时间（仅展示用，不自动触发切换）。 */
  endAt: number;
  /** 并发 roll 护栏：`settling` 仅在 roll 自身执行瞬间（CAS）。 */
  state: 'active' | 'settling';
}

// ── 软重置算法（§4.1）──────────────────────────────────────────────────────

/**
 * 赛季末软重置 ELO：高于基准的向基准回归一半；低于/等于基准不动。
 * 例（基准 1200）：2400→1800；1500→1350；1200→1200；1000→1000。
 */
export function softReset(elo: number, baseline = SEASON_RESET_BASELINE): number {
  return elo > baseline ? Math.round((elo + baseline) / 2) : elo;
}

// ── 段位升序列表（辅助首达计算）──────────────────────────────────────────────

/** 所有 RankId 按 ELO 升序排列（与 RANK_TIERS 同步）。 */
export const RANKS_ASCENDING: RankId[] = RANK_TIERS.map((t) => t.id);

/**
 * 返回所有段位 id 中 ≤ targetRank 的子集（含 target 本身）。
 * 用于首达金币计算：升到某段位时把此段及以下所有「首次到达」一并补发。
 */
export function ranksAtOrBelow(targetRank: RankId): RankId[] {
  const idx = RANKS_ASCENDING.indexOf(targetRank);
  if (idx < 0) return [];
  return RANKS_ASCENDING.slice(0, idx + 1);
}

// ── 段位首达金币（§4.3，终身一次性，reachedRanks 账本）────────────────────

/**
 * 段位首达金币（§2.3a，ECONOMY_BALANCE）。终身只首次发，不可刷。
 * 数值参考：青铜 100 … 王者 3500。
 */
export const FIRST_REACH_COINS: Record<RankId, number> = {
  bronze: 100,
  silver: 200,
  gold: 400,
  platinum: 700,
  diamond: 1000,
  star: 1500,
  master: 2000,
  grandmaster: 2500,
  king: 3500,
};

/** 指定段位的首达金币额度。 */
export function firstReachCoins(rank: RankId): number {
  return FIRST_REACH_COINS[rank] ?? 0;
}

/**
 * 计算「新达到 afterRank」时的新增首达金币总额及新入 reachedRanks 集合。
 * `reachedRanks` 是终身账本（`pvp.reachedRanks`）。
 */
export function computeFirstReachGrant(
  afterRank: RankId,
  reachedRanks: RankId[],
): { coins: number; newly: RankId[] } {
  const reachedSet = new Set(reachedRanks);
  const newly = ranksAtOrBelow(afterRank).filter((r) => !reachedSet.has(r));
  const coins = newly.reduce((sum, r) => sum + firstReachCoins(r), 0);
  return { coins, newly };
}

// ── 赛季峰值金币（§4.2，每季可重复，走邮件）──────────────────────────────

/**
 * 赛季峰值金币（赛季末结算，按峰值段位发，每季可重复）。
 * 约为首达金币的 30–40%（初定）；具体数值交 ECONOMY_NUMBERS §13 校准。
 */
export const SEASON_PEAK_COINS: Record<RankId, number> = {
  bronze: 0,     // 低段不发：没意义且会成为打账号数的激励
  silver: 0,
  gold: 100,
  platinum: 200,
  diamond: 350,
  star: 500,
  master: 700,
  grandmaster: 900,
  king: 1200,
};

/** 指定峰值段位对应的赛季结算金币。 */
export function seasonPeakCoins(rank: RankId): number {
  return SEASON_PEAK_COINS[rank] ?? 0;
}

// ── pvp 字段扩展（SE-1，SaveData.pvp 新字段的默认值工厂）──────────────────

/** 为新存档/迁移初始化 pvp 赛季字段（调用方再 spread 进 pvp 块）。 */
export function makePvpSeasonDefaults(
  seasonNo: number,
  elo: number,
): {
  seasonNo: number;
  seasonPeakElo: number;
  seasonPeakRank: RankId;
  reachedRanks: RankId[];
} {
  return {
    seasonNo,
    seasonPeakElo: elo,
    seasonPeakRank: eloToRank(elo),
    reachedRanks: [],
  };
}
