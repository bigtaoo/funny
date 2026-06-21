// 单位养成卡片 —— 集卡合成模型（ECONOMY_NUMBERS §4 / ADR-009）。
//
// 纯数据 + 纯函数，无 game logic（M12：metaserver 可 import；严禁反向 import client/engine）。
// 卡片库存（cardInventory）是收集的原始来源；单位强度等级（unitLevels）= 各兵种当前最高
// 拥有卡级，由 deriveUnitLevels 从库存派生（服务器权威，引擎只读 unitLevels 跑蓝图）。
//
// 合成（§4.1）：5 张 N 级卡 → 1 张 (N+1) 级，100% 成功（指数 sink）。本文件是「合成 + 派生」
// 的权威落点，meta /pve/merge 端点重算。卡片来源（盲盒 / 关卡掉落）见 S12-C。

/** 合成所需同级卡数（5 张 N → 1 张 N+1）。 */
export const MERGE_COPIES = 5;

/** 卡片 / 单位等级上限（与 @nw/engine UNIT_MAX_LEVEL 同值，解耦不 import）。 */
export const UNIT_CARD_MAX_LEVEL = 9;

/**
 * 可养成兵种 id —— 须与 @nw/engine `UnitType` 的字符串值逐字一致
 * （'infantry' / 'shieldbearer' / 'archer'），这样 SaveData.unitLevels 的键能直接喂引擎。
 */
export const PROGRESSABLE_UNIT_IDS = ['infantry', 'shieldbearer', 'archer'] as const;
export type ProgressableUnitId = (typeof PROGRESSABLE_UNIT_IDS)[number];

export function isProgressableUnit(id: string): id is ProgressableUnitId {
  return (PROGRESSABLE_UNIT_IDS as readonly string[]).includes(id);
}

/** cardInventory 的键：`${unitId}:${level}`。 */
export function cardKey(unitId: string, level: number): string {
  return `${unitId}:${level}`;
}

/** 解析卡片键；非法格式 / 越界等级 / 未知兵种 → null。 */
export function parseCardKey(key: string): { unitId: ProgressableUnitId; level: number } | null {
  const idx = key.lastIndexOf(':');
  if (idx <= 0) return null;
  const unitId = key.slice(0, idx);
  const level = Number(key.slice(idx + 1));
  if (!isProgressableUnit(unitId)) return null;
  if (!Number.isInteger(level) || level < 1 || level > UNIT_CARD_MAX_LEVEL) return null;
  return { unitId, level };
}

/**
 * 从卡片库存派生各兵种强度等级 = 该兵种当前**最高拥有卡级**（count>0）；无卡 = 等级 1（基础）。
 * 只产出 level>1 的条目（基础 L1 由引擎对缺省键默认，省存储 + 保 save 精简）。
 */
export function deriveUnitLevels(inv: Record<string, number>): Record<string, number> {
  const max: Record<string, number> = {};
  for (const [key, count] of Object.entries(inv)) {
    if (!count || count <= 0) continue;
    const parsed = parseCardKey(key);
    if (!parsed) continue;
    if (parsed.level > (max[parsed.unitId] ?? 0)) max[parsed.unitId] = parsed.level;
  }
  const out: Record<string, number> = {};
  for (const unitId of PROGRESSABLE_UNIT_IDS) {
    const lvl = max[unitId] ?? 1;
    if (lvl > 1) out[unitId] = lvl;
  }
  return out;
}

/** 合成失败原因。 */
export type MergeError = 'INVALID_UNIT' | 'INVALID_LEVEL' | 'INSUFFICIENT';

/**
 * 合成一次：消耗 {@link MERGE_COPIES} 张 (unitId, level) 卡 → +1 张 (level+1)。
 * 纯函数，返回**新库存**（不改入参）或错误码。L9 不可再合成。
 */
export function applyCardMerge(
  inv: Record<string, number>,
  unitId: string,
  level: number,
): Record<string, number> | MergeError {
  if (!isProgressableUnit(unitId)) return 'INVALID_UNIT';
  if (!Number.isInteger(level) || level < 1 || level >= UNIT_CARD_MAX_LEVEL) return 'INVALID_LEVEL';
  const fromKey = cardKey(unitId, level);
  const toKey = cardKey(unitId, level + 1);
  const have = inv[fromKey] ?? 0;
  if (have < MERGE_COPIES) return 'INSUFFICIENT';
  const next = { ...inv, [fromKey]: have - MERGE_COPIES, [toKey]: (inv[toKey] ?? 0) + 1 };
  if (next[fromKey] === 0) delete next[fromKey];
  return next;
}

/** 把若干张卡加进库存（关卡掉落 / 盲盒发货用，纯函数返回新库存）。无效键跳过。 */
export function grantCards(
  inv: Record<string, number>,
  grants: Record<string, number>,
): Record<string, number> {
  const next = { ...inv };
  for (const [key, amount] of Object.entries(grants)) {
    if (!amount || amount <= 0) continue;
    if (!parseCardKey(key)) continue;
    next[key] = (next[key] ?? 0) + amount;
  }
  return next;
}
