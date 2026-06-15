// 战役通关奖励发放（S3-1）。纯函数 + SaveData mutator，便于单测、与 UI 解耦。
//
// 评星：基地剩余 HP% 对照 level.rewards.starThresholds（[1★,2★,3★] 的 HP% 门槛）。
// 基地满血 = BASE_HP(100)，无回血，故剩余 HP% = clamp(100 - damageTakenByBase, 0, 100)。
//
// 材料只在「首次通关」发放（PvE farming 无公平影响，但避免无限刷；星级始终取最高）。
// 材料 / progress 是客户端同步段（SaveData），可本地写 + 防抖上行（§2）。coins / 皮肤解锁
// 属服务器权威段，需服务端端点，S3-1 不在此发放（留待 S2 经济端点接入）。

import type { LevelDefinition } from '../campaign/LevelDefinition';
import { BASE_HP } from '../config';
import type { SaveData } from './SaveData';

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

/**
 * 把一次通关写进 SaveData 草稿（配 SaveManager.update）。
 * 返回本次发放的材料（UI 展示用），无发放则空对象。
 *
 * @param draft           SaveData 草稿（原地改）。
 * @param levelId         关卡 id。
 * @param level           关卡定义（取 rewards.materials）。
 * @param stars           本局星数（0..3）。
 * @param record          可选最佳记录（timeMs / leaked），取更优者。
 */
export function applyCampaignClear(
  draft: SaveData,
  levelId: string,
  level: LevelDefinition,
  stars: 0 | 1 | 2 | 3,
  record?: { timeMs?: number; leaked?: number },
): Record<string, number> {
  if (stars <= 0) return {}; // 未通关不发放

  const firstClear = !draft.progress.cleared.includes(levelId);
  if (firstClear) draft.progress.cleared.push(levelId);

  // 星级取最高（stars > 0 已由上方守卫保证）。
  const prevStars = draft.progress.stars[levelId] ?? 0;
  if (stars > prevStars) draft.progress.stars[levelId] = stars as 1 | 2 | 3;

  // 最佳记录取更优（时间更短、漏怪更少）。
  if (record) {
    const prev = draft.progress.best[levelId];
    const prevTime = prev?.timeMs ?? Infinity;
    if (record.timeMs === undefined || record.timeMs < prevTime) {
      draft.progress.best[levelId] = { ...prev, ...record };
    }
  }

  // 材料只在首次通关发放。
  const granted: Record<string, number> = {};
  if (firstClear && level.rewards?.materials) {
    for (const [mat, amt] of Object.entries(level.rewards.materials)) {
      if (amt <= 0) continue;
      draft.materials[mat] = (draft.materials[mat] ?? 0) + amt;
      granted[mat] = amt;
    }
  }
  return granted;
}
