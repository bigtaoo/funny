// 天梯段位 + ELO（S1-R）。纯函数，**gameserver 计算与客户端展示同源**——
// 避免双端各维护一份段位阈值导致显示与权威分歧。
// 数值见 design/game/ECONOMY_BALANCE.md §2.3（9 段称号）；最终落服务端配置便于热调。

/** 9 段段位稳定 id（展示名走客户端 i18n，权威只存 id）。 */
export type RankId =
  | 'bronze'
  | 'silver'
  | 'gold'
  | 'platinum'
  | 'diamond'
  | 'star'
  | 'master'
  | 'grandmaster'
  | 'king';

/** 段位 → ELO 下限（升序）。低于首档下限一律算最低段。 */
export const RANK_TIERS: ReadonlyArray<{ id: RankId; minElo: number }> = [
  { id: 'bronze', minElo: 0 },
  { id: 'silver', minElo: 1100 },
  { id: 'gold', minElo: 1200 },
  { id: 'platinum', minElo: 1350 },
  { id: 'diamond', minElo: 1500 },
  { id: 'star', minElo: 1700 },
  { id: 'master', minElo: 1900 },
  { id: 'grandmaster', minElo: 2100 },
  { id: 'king', minElo: 2400 },
];

/** 新账号初始分（与 makeNewSave 的 pvp.elo 一致）。 */
export const INITIAL_ELO = 1000;

/** ELO K 因子（每局最大波动 ≈ K）。 */
export const ELO_K = 32;

/** ELO 永不为负。 */
export const ELO_FLOOR = 0;

/** 当前分对应的段位 id。 */
export function eloToRank(elo: number): RankId {
  let rank: RankId = RANK_TIERS[0]!.id;
  for (const t of RANK_TIERS) {
    if (elo >= t.minElo) rank = t.id;
    else break; // 升序，遇到比当前分高的下限即可停
  }
  return rank;
}

/**
 * 标准 ELO 结算。返回胜/负双方的整数分差，**零和**（loser = -winner）。
 * 期望胜率 E_win = 1 / (1 + 10^((loserElo - winnerElo)/400))；
 * 实际胜者得分 = round(K × (1 - E_win))，爆冷（低分赢高分）得分更多。
 */
export function computeEloDelta(
  winnerElo: number,
  loserElo: number,
  k: number = ELO_K,
): { winner: number; loser: number } {
  const expWin = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
  const gain = Math.round(k * (1 - expWin));
  return { winner: gain, loser: -gain };
}

/** 连胜/连败串（pvp.streak，正=连胜，负=连败）在一局后的新值。 */
export function nextStreak(prev: number, won: boolean): number {
  if (won) return prev > 0 ? prev + 1 : 1;
  return prev < 0 ? prev - 1 : -1;
}
