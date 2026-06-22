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
 * 可养成兵种 id —— 须与 @nw/engine `UnitType` 的字符串值逐字一致，SaveData.unitLevels 的键直接喂引擎。
 * 顺序决定 levelCardReward 的章节轮换（ch1→index0，ch2→index1，…）：
 *   奇章（Tao）: infantry / shieldbearer / archer
 *   偶章（Anna）: max / lena / mara
 */
export const PROGRESSABLE_UNIT_IDS = ['infantry', 'max', 'shieldbearer', 'lena', 'archer', 'mara'] as const;
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

// ── 卡片来源（S12-C，ECONOMY_NUMBERS §3 关卡掉落 / §4.1 抽奖出卡）────────────────
// 卡片两条来源：①盲盒（独立单位卡池，commercial 滚 RNG）②关卡掉落（PvE 通关确定性整数）。
// 入库统一走 grantCards → cardInventory，unitLevels 由 deriveUnitLevels 重算（服务器权威）。

/** 单位卡盲盒池 id（与皮肤池 `standard` 分离：养成 ≠ 外观，抽卡动机/调参互不干扰）。 */
export const UNIT_CARD_POOL_ID = 'units';

/**
 * gacha 稀有度 → 单位卡级映射（独立单位卡池，§4.1「抽奖出卡」补充源）。
 * 盲盒产 T1–T4：common→T1 / rare→T2 / epic→T3 / legendary→T4（高级卡加速，T5+ 仍靠合成/拍卖）。
 * 与皮肤池同权重（economy.ts `RARITY_WEIGHTS`）；卡片天然集卡 → **不走 dupe 退币**，全部入库。
 */
export const GACHA_RARITY_TO_CARD_LEVEL: Record<string, number> = {
  common: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
};

/**
 * 构建单位卡池 itemsByRarity（cardKey 作 itemId，3 兵种 × 1 tier/稀有度）。
 * economy.ts 拼装 GACHA_POOLS 时调用，使「池内 item = 合法 cardKey」，发货端 parseCardKey 即可识别。
 */
export function unitCardPoolItems(): Record<'common' | 'rare' | 'epic' | 'legendary', string[]> {
  const at = (rarity: string) =>
    PROGRESSABLE_UNIT_IDS.map((u) => cardKey(u, GACHA_RARITY_TO_CARD_LEVEL[rarity]!));
  return { common: at('common'), rare: at('rare'), epic: at('epic'), legendary: at('legendary') };
}

/**
 * 关卡掉单位卡（确定性整数，§3 体力门控 + §4.1「后期关产 T3 卡」）。
 * 从 levelId `ch{N}_lv{M}` 派生：章节越后 tier 越高（ch1–2→T1 / ch3–4→T2 / ch5–6→T3），
 * 单位按章节轮换（inf/shd/arc）；终关（lv10）双倍。非章节关（如 `ch_stress`）不掉卡。
 * `[可调]`：tier/张数是「高级卡获取速率」旋钮（与盲盒/拍卖供给一起调），**不动 5→1 合成系数**。
 * 纯函数、不引入 RNG（保 PvE 抽检幂等 + 服务器权威确定性）。
 */
export function levelCardReward(levelId: string): Record<string, number> {
  const m = /^ch(\d+)_lv(\d+)$/.exec(levelId);
  if (!m) return {};
  const chapter = Number(m[1]);
  const lv = Number(m[2]);
  if (!chapter || !lv) return {};
  const tier = Math.min(3, Math.floor((chapter - 1) / 2) + 1);
  const unitId = PROGRESSABLE_UNIT_IDS[(chapter - 1) % PROGRESSABLE_UNIT_IDS.length]!;
  const count = lv >= 10 ? 2 : 1;
  return { [cardKey(unitId, tier)]: count };
}
