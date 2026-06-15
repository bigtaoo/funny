// 战役通关评星纯函数（S3-1）。与 UI / 存档解耦，便于单测。
//
// 评星：基地剩余 HP% 对照 level.rewards.starThresholds（[1★,2★,3★] 的 HP% 门槛）。
// 基地满血 = BASE_HP(100)，无回血，故剩余 HP% = clamp(100 - damageTakenByBase, 0, 100)。
//
// PVE_INTEGRITY_PLAN §8 起，通关结算（progress/stars/materials）是服务器权威：客户端用
// 本文件算出 stars 报给服务器（POST /pve/clear 校验后发放），不再本地发材料 / 写 progress
// （旧 applyCampaignClear 已删除，走 SaveManager.recordClear）。

import { BASE_HP } from '../config';

/** 基地剩余 HP% → 星数（0..3），按非递减门槛。无门槛时通关即 1★。 */
export function computeStars(
  thresholds: [number, number, number] | undefined,
  remainingHpPct: number,
): 0 | 1 | 2 | 3 {
  if (!thresholds) return remainingHpPct > 0 ? 1 : 0;
  let stars = 0;
  for (const t of thresholds) {
    if (remainingHpPct >= t) stars++;
  }
  return stars as 0 | 1 | 2 | 3;
}

/** 由本局玩家基地承伤算剩余 HP%（满血 100，clamp 到 0..100）。 */
export function remainingHpPct(damageTakenByBase: number): number {
  return Math.max(0, Math.min(100, BASE_HP - damageTakenByBase));
}
