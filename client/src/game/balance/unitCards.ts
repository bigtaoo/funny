// 客户端单位养成卡片常量 —— 与 @nw/shared/unitCards 同源，但不 import（shared 带 mongo 依赖）。
// 改数值时两处同步。
export const MERGE_COPIES = 5;
export const UNIT_CARD_MAX_LEVEL = 9;

export const PROGRESSABLE_UNIT_IDS = ['infantry', 'shieldbearer', 'archer'] as const;
export type ProgressableUnitId = (typeof PROGRESSABLE_UNIT_IDS)[number];

export function cardKey(unitId: string, level: number): string {
  return `${unitId}:${level}`;
}
