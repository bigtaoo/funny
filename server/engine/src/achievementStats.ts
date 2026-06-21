// 引擎 PlayerStats → 成就 statKey 增量映射（S9-3b / S9-6）。
// 成就系统的 statKey 是字符串（机制权威 @nw/shared/achievements.ts），引擎只产出原始计数；
// 这里把「引擎单位/法术类型 → statKey」的对应**集中一处**，让 PvP 战报上报（客户端）与
// PvE 结算喂入（服务端，S9-3b PvE 半）复用同一份映射，杜绝两处手抄漂移。
import { PlayerStats, SpellType, UnitType } from './types';

/**
 * 把本局某方的 PlayerStats 折算为成就 statKey 增量（仅含非零项）。
 * - `kill.archer`  ← 击杀弓箭手（Archer）
 * - `kill.guard`   ← 击杀盾兵/守卫（ShieldBearer，i18n「破盾者」）
 * - `cast.meteor`  ← 释放陨石次数（Meteor cast，非命中数）
 * 返回 `Record<string, number>`（statKey→delta）；调用方（客户端上报 / meta 累加）按需取用。
 */
export function achievementStatDelta(stats: PlayerStats): Record<string, number> {
  const kills = stats.killsByType ?? {};
  const casts = stats.castsByType ?? {};
  const out: Record<string, number> = {};
  const archer = kills[UnitType.Archer] ?? 0;
  const guard = kills[UnitType.ShieldBearer] ?? 0;
  const meteor = casts[SpellType.Meteor] ?? 0;
  if (archer > 0) out['kill.archer'] = archer;
  if (guard > 0) out['kill.guard'] = guard;
  if (meteor > 0) out['cast.meteor'] = meteor;
  return out;
}
