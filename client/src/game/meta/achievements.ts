// 成就系统客户端纯逻辑（ACHIEVEMENT_DESIGN §4.1）。
// 机制权威 = server/shared/src/achievements.ts；这里**只镜像无状态阶推导**这十几行稳定逻辑，
// 不镜像 ACHIEVEMENTS 定义表——`defs` 由 GET /achievements 服务端下发（codegen Achievement 类型），
// 免定义表漂移。客户端与服务端同算（§4.1：解锁阶永远由 stats 当场推导，不落库）。
import type { components } from '../../net/openapi';
import type { SaveData } from './SaveData';

/** 成就定义（线协议，来自 codegen openapi schema，服务端下发）。 */
export type Achievement = components['schemas']['Achievement'];

export interface TierState {
  tier: number; // 1-based
  threshold: number;
  coins: number;
  reached: boolean; // stat ≥ 阈值
  claimable: boolean; // 达阈值且未领（红点源）
  claimed: boolean; // 已领
  progress: number; // min(stat, 阈值)，进度条用
}

/**
 * 当前各阶状态推导（无状态，与服务端 tierState 同算，§4.1）。
 * @param claimedTiers 该成就已领阶号（来自 SaveData.achievements[id].claimedTiers）。
 */
export function tierState(
  def: Achievement,
  stats: SaveData['stats'],
  claimedTiers: number[],
): TierState[] {
  const v = stats?.[def.statKey] ?? 0;
  return def.tiers.map((tDef, i) => {
    const tier = i + 1;
    const reached = v >= tDef.threshold;
    const claimed = claimedTiers.includes(tier);
    return {
      tier,
      threshold: tDef.threshold,
      coins: tDef.coins,
      reached,
      claimable: reached && !claimed,
      claimed,
      progress: Math.min(v, tDef.threshold),
    };
  });
}

/** 某成就是否有可领阶（卡片/分类红点源）。 */
export function achievementClaimable(
  def: Achievement,
  stats: SaveData['stats'],
  achievements: SaveData['achievements'],
): boolean {
  const claimed = achievements?.[def.id]?.claimedTiers ?? [];
  return tierState(def, stats, claimed).some((s) => s.claimable);
}

/** 任一成就存在可领阶 → 入口红点聚合（§4.1）。defs 为服务端下发的定义表。 */
export function hasClaimable(
  defs: Achievement[],
  stats: SaveData['stats'],
  achievements: SaveData['achievements'],
): boolean {
  return defs.some((def) => achievementClaimable(def, stats, achievements));
}
