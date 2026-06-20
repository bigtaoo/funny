// 战役通关评星纯函数（S3-1）。与 UI / 存档解耦，便于单测。
//
// 评星：基地剩余 HP% 对照 level.rewards.starThresholds（[1★,2★,3★] 的 HP% 门槛）。
// 基地满血 = BASE_HP(100)，无回血，故剩余 HP% = clamp(100 - damageTakenByBase, 0, 100)。
//
// PVE_INTEGRITY_PLAN §8 起，通关结算（progress/stars/materials）是服务器权威：客户端用
// 本文件算出 stars 报给服务器（POST /pve/clear 校验后发放），不再本地发材料 / 写 progress
// （旧 applyCampaignClear 已删除，走 SaveManager.recordClear）。

import { BASE_HP } from '../config';

/**
 * 基地剩余 HP% → 星数（0..3），按非递减门槛。
 * 通关保底 1★：只要基地没被打爆（HP>0）即视为通关 → 至少 1★（解锁下一关）；
 * starThresholds 只用来把评价**升级**到 2★/3★，不该把一次胜利压到 0★。
 * （此前门槛 [50,80,100] 会让「血量<50% 的胜利」算 0★，导致通关不入账、下一关不解锁——见 §通关0星 bug。）
 */
export function computeStars(
  thresholds: [number, number, number] | undefined,
  remainingHpPct: number,
): 0 | 1 | 2 | 3 {
  if (remainingHpPct <= 0) return 0; // 基地被打爆 = 没通关
  if (!thresholds) return 1;
  let stars = 0;
  for (const t of thresholds) {
    if (remainingHpPct >= t) stars++;
  }
  return Math.max(1, stars) as 0 | 1 | 2 | 3; // 胜利保底 1★
}

/** 由本局玩家基地承伤算剩余 HP%（满血 100，clamp 到 0..100）。 */
export function remainingHpPct(damageTakenByBase: number): number {
  return Math.max(0, Math.min(100, BASE_HP - damageTakenByBase));
}
