// 战令定义表客户端镜像（@nw/shared/battlepass.ts 的只读副本，供 BattlePassScene 读取）。
// 不 import @nw/shared（客户端只依赖 game/ 内的纯数据）。
// 数值权威 = ECONOMY_NUMBERS §13；变更时同步更新服务端 battlepass.ts。

export const BATTLEPASS_MAX_LEVEL = 30;
export const BATTLEPASS_BUY_COST = 600;
export const BP_XP_PER_LEVEL = 600;

export type BpRewardKind = 'coins' | 'material' | 'skin';

export interface BpReward {
  kind: BpRewardKind;
  id?: string;
  count: number;
}

export interface BpLevelDef {
  level: number;
  xpRequired: number;
  free?: BpReward;
  paid?: BpReward;
}

export const BATTLEPASS_DEFS: BpLevelDef[] = Array.from({ length: BATTLEPASS_MAX_LEVEL }, (_, i) => {
  const level = i + 1;
  const xpRequired = level * BP_XP_PER_LEVEL;

  let free: BpReward | undefined;
  let paid: BpReward | undefined;

  if (level % 5 === 0) free = { kind: 'coins', count: 50 };
  if (level === 10) free = { kind: 'coins', count: 150 };
  if (level === 20) free = { kind: 'coins', count: 200 };
  if (level === 30) free = { kind: 'coins', count: 300 };

  paid = { kind: 'coins', count: 20 };
  if (level === 10) paid = { kind: 'coins', count: 200 };
  if (level === 20) paid = { kind: 'coins', count: 300 };
  if (level === 30) paid = { kind: 'coins', count: 500 };

  return { level, xpRequired, free, paid };
});

export function xpToLevel(xp: number): number {
  return Math.min(BATTLEPASS_MAX_LEVEL, Math.max(1, Math.floor(xp / BP_XP_PER_LEVEL) + 1));
}

export function xpToNextLevel(xp: number): number {
  if (xp >= BATTLEPASS_MAX_LEVEL * BP_XP_PER_LEVEL) return 0;
  const curLevel = xpToLevel(xp);
  return curLevel * BP_XP_PER_LEVEL - xp;
}
