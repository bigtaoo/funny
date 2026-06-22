// PvE 经济权威单一来源（PVE_INTEGRITY_PLAN §8.1）。纯数据 + 纯函数，无 game logic
// （M12：metaserver 可 import；严禁反向 import client/src/game）。客户端保留展示镜像
// （campaign/levels JSON 的 starThresholds 用于本地算星、balance/pveUpgrades 的效果乘子用于
// 跑蓝图），但**材料发放 / 升级扣费以本文件为准**（服务器 /pve/* 端点重算）。

export type PveMaterial = 'scrap' | 'lead' | 'binding';

/** 装备掉落配置（EQUIPMENT_DESIGN §4 关卡掉落 faucet，DRAFT [可调]）。 */
export interface EquipmentDropConfig {
  /** 掉落稀有度（对应 EquipRarity；槽位在落地时随机选三槽之一）。 */
  rarity: 'common' | 'fine' | 'rare' | 'epic';
  /** 掉落概率 0..1（每次通关独立 roll，不受每日材料 cap 约束，DRAFT [可调]）。 */
  rate: number;
}

export interface PveLevelConfig {
  id: string;
  /** 解锁前置：须先通关的关卡 id（null = 首关无前置）。顺序解锁。 */
  requires: string | null;
  /** 每次通关发放的材料（§8 决策 3：可重复刷，受每日上限）。空 = 不发材料（如压力关）。 */
  reward: Partial<Record<PveMaterial, number>>;
  /**
   * 关卡装备掉落（Boss/精英关专属额外奖励，EQUIPMENT_DESIGN §4）。
   * 概率独立 roll（不受每日材料 cap 影响）；满仓时静默跳过。
   * 仅 lv5（章节中期精英）和 lv10（章节 Boss）有配置；其余普通关无掉落。
   */
  equipmentDrop?: EquipmentDropConfig;
}

/**
 * 有序战役关卡（顺序解锁）。与客户端 `campaign/levels/*.json` 的 `rewards.materials` 同值，
 * 但**这里是发放权威**（客户端 JSON 降级为参考）。首通额外解锁下一关 + 记星，材料同表（每次发）。
 */
export const PVE_LEVELS: PveLevelConfig[] = [
  // ── Chapter 1 ────────────────────────────────────────────────────────────
  { id: 'ch1_lv1',  requires: null,       reward: { scrap: 6,  lead: 2 } },
  { id: 'ch1_lv2',  requires: 'ch1_lv1',  reward: { scrap: 8,  lead: 3,  binding: 1 } },
  { id: 'ch1_lv3',  requires: 'ch1_lv2',  reward: { scrap: 10, lead: 4,  binding: 2 } },
  { id: 'ch1_lv4',  requires: 'ch1_lv3',  reward: { scrap: 8,  lead: 3 } },
  { id: 'ch1_lv5',  requires: 'ch1_lv4',  reward: { scrap: 10, lead: 4 },          equipmentDrop: { rarity: 'common', rate: 0.10 } },
  { id: 'ch1_lv6',  requires: 'ch1_lv5',  reward: { scrap: 10, lead: 4,  binding: 1 } },
  { id: 'ch1_lv7',  requires: 'ch1_lv6',  reward: { scrap: 12, lead: 5 } },
  { id: 'ch1_lv8',  requires: 'ch1_lv7',  reward: { scrap: 14, lead: 6,  binding: 1 } },
  { id: 'ch1_lv9',  requires: 'ch1_lv8',  reward: { scrap: 16, lead: 7,  binding: 2 } },
  { id: 'ch1_lv10', requires: 'ch1_lv9',  reward: { scrap: 18, lead: 8,  binding: 3 }, equipmentDrop: { rarity: 'common', rate: 0.18 } },
  // ── Chapter 2 ────────────────────────────────────────────────────────────
  { id: 'ch2_lv1',  requires: 'ch1_lv10', reward: { scrap: 6,  lead: 5 } },
  { id: 'ch2_lv2',  requires: 'ch2_lv1',  reward: { scrap: 7,  lead: 5 } },
  { id: 'ch2_lv3',  requires: 'ch2_lv2',  reward: { scrap: 8,  lead: 6 } },
  { id: 'ch2_lv4',  requires: 'ch2_lv3',  reward: { scrap: 9,  lead: 6,  binding: 1 } },
  { id: 'ch2_lv5',  requires: 'ch2_lv4',  reward: { scrap: 8,  lead: 7 },           equipmentDrop: { rarity: 'common', rate: 0.12 } },
  { id: 'ch2_lv6',  requires: 'ch2_lv5',  reward: { scrap: 9,  lead: 7,  binding: 1 } },
  { id: 'ch2_lv7',  requires: 'ch2_lv6',  reward: { scrap: 10, lead: 8,  binding: 1 } },
  { id: 'ch2_lv8',  requires: 'ch2_lv7',  reward: { scrap: 10, lead: 8,  binding: 1 } },
  { id: 'ch2_lv9',  requires: 'ch2_lv8',  reward: { scrap: 9,  lead: 8,  binding: 2 } },
  { id: 'ch2_lv10', requires: 'ch2_lv9',  reward: { scrap: 12, lead: 10, binding: 2 }, equipmentDrop: { rarity: 'fine',   rate: 0.15 } },
  // ── Chapter 3 ────────────────────────────────────────────────────────────
  { id: 'ch3_lv1',  requires: 'ch2_lv10', reward: { scrap: 8,  lead: 4 } },
  { id: 'ch3_lv2',  requires: 'ch3_lv1',  reward: { scrap: 8,  lead: 4 } },
  { id: 'ch3_lv3',  requires: 'ch3_lv2',  reward: { scrap: 9,  lead: 5 } },
  { id: 'ch3_lv4',  requires: 'ch3_lv3',  reward: { scrap: 9,  lead: 5 } },
  { id: 'ch3_lv5',  requires: 'ch3_lv4',  reward: { scrap: 9,  lead: 6,  binding: 1 }, equipmentDrop: { rarity: 'fine',   rate: 0.10 } },
  { id: 'ch3_lv6',  requires: 'ch3_lv5',  reward: { scrap: 10, lead: 6,  binding: 1 } },
  { id: 'ch3_lv7',  requires: 'ch3_lv6',  reward: { scrap: 10, lead: 7,  binding: 2 } },
  { id: 'ch3_lv8',  requires: 'ch3_lv7',  reward: { scrap: 11, lead: 7,  binding: 2 } },
  { id: 'ch3_lv9',  requires: 'ch3_lv8',  reward: { scrap: 11, lead: 8,  binding: 2 } },
  { id: 'ch3_lv10', requires: 'ch3_lv9',  reward: { scrap: 12, lead: 8,  binding: 3 }, equipmentDrop: { rarity: 'rare',   rate: 0.12 } },
  // ── Chapter 4 ────────────────────────────────────────────────────────────
  { id: 'ch4_lv1',  requires: 'ch3_lv10', reward: { scrap: 10, lead: 7,  binding: 2 } },
  { id: 'ch4_lv2',  requires: 'ch4_lv1',  reward: { scrap: 10, lead: 7,  binding: 2 } },
  { id: 'ch4_lv3',  requires: 'ch4_lv2',  reward: { scrap: 11, lead: 8,  binding: 2 } },
  { id: 'ch4_lv4',  requires: 'ch4_lv3',  reward: { scrap: 11, lead: 8,  binding: 3 } },
  { id: 'ch4_lv5',  requires: 'ch4_lv4',  reward: { scrap: 12, lead: 9,  binding: 3 }, equipmentDrop: { rarity: 'fine',   rate: 0.10 } },
  { id: 'ch4_lv6',  requires: 'ch4_lv5',  reward: { scrap: 12, lead: 9,  binding: 3 } },
  { id: 'ch4_lv7',  requires: 'ch4_lv6',  reward: { scrap: 13, lead: 10, binding: 3 } },
  { id: 'ch4_lv8',  requires: 'ch4_lv7',  reward: { scrap: 13, lead: 10, binding: 4 } },
  { id: 'ch4_lv9',  requires: 'ch4_lv8',  reward: { scrap: 14, lead: 11, binding: 4 } },
  { id: 'ch4_lv10', requires: 'ch4_lv9',  reward: { scrap: 15, lead: 12, binding: 4 }, equipmentDrop: { rarity: 'rare',   rate: 0.12 } },
  // ── Chapter 5 ────────────────────────────────────────────────────────────
  { id: 'ch5_lv1',  requires: 'ch4_lv10', reward: { scrap: 14, lead: 10, binding: 4 } },
  { id: 'ch5_lv2',  requires: 'ch5_lv1',  reward: { scrap: 14, lead: 11, binding: 4 } },
  { id: 'ch5_lv3',  requires: 'ch5_lv2',  reward: { scrap: 15, lead: 11, binding: 4 } },
  { id: 'ch5_lv4',  requires: 'ch5_lv3',  reward: { scrap: 15, lead: 12, binding: 4 } },
  { id: 'ch5_lv5',  requires: 'ch5_lv4',  reward: { scrap: 16, lead: 12, binding: 4 }, equipmentDrop: { rarity: 'rare',   rate: 0.08 } },
  { id: 'ch5_lv6',  requires: 'ch5_lv5',  reward: { scrap: 16, lead: 13, binding: 5 } },
  { id: 'ch5_lv7',  requires: 'ch5_lv6',  reward: { scrap: 17, lead: 13, binding: 5 } },
  { id: 'ch5_lv8',  requires: 'ch5_lv7',  reward: { scrap: 18, lead: 14, binding: 5 } },
  { id: 'ch5_lv9',  requires: 'ch5_lv8',  reward: { scrap: 19, lead: 14, binding: 5 } },
  { id: 'ch5_lv10', requires: 'ch5_lv9',  reward: { scrap: 20, lead: 15, binding: 6 }, equipmentDrop: { rarity: 'rare',   rate: 0.12 } },
  // ── Chapter 6 ────────────────────────────────────────────────────────────
  { id: 'ch6_lv1',  requires: 'ch5_lv10', reward: { scrap: 18, lead: 14, binding: 6 } },
  { id: 'ch6_lv2',  requires: 'ch6_lv1',  reward: { scrap: 19, lead: 15, binding: 7 } },
  { id: 'ch6_lv3',  requires: 'ch6_lv2',  reward: { scrap: 20, lead: 15, binding: 7 } },
  { id: 'ch6_lv4',  requires: 'ch6_lv3',  reward: { scrap: 20, lead: 16, binding: 7 } },
  { id: 'ch6_lv5',  requires: 'ch6_lv4',  reward: { scrap: 21, lead: 16, binding: 8 }, equipmentDrop: { rarity: 'rare',   rate: 0.10 } },
  { id: 'ch6_lv6',  requires: 'ch6_lv5',  reward: { scrap: 22, lead: 17, binding: 8 } },
  { id: 'ch6_lv7',  requires: 'ch6_lv6',  reward: { scrap: 22, lead: 17, binding: 8 } },
  { id: 'ch6_lv8',  requires: 'ch6_lv7',  reward: { scrap: 24, lead: 18, binding: 9 } },
  { id: 'ch6_lv9',  requires: 'ch6_lv8',  reward: { scrap: 25, lead: 19, binding: 9 } },
  { id: 'ch6_lv10', requires: 'ch6_lv9',  reward: { scrap: 28, lead: 20, binding: 10 }, equipmentDrop: { rarity: 'epic',   rate: 0.08 } },
  // ── Extras ───────────────────────────────────────────────────────────────
  { id: 'ch_stress', requires: 'ch1_lv3', reward: {} },
];

export function findPveLevel(id: string): PveLevelConfig | undefined {
  return PVE_LEVELS.find((l) => l.id === id);
}

// ── 成就：章节通关计数（ACHIEVEMENT_DESIGN §3.1 `campaign.chaptersCleared`）──────────
// PvE 唯一能服务器权威产出的成就 stat（其余 kill.*/cast.* 待引擎分类型埋点，§6.2）。

/**
 * 各章节的「终关」levelId（该章 lv 序号最大者），由 {@link PVE_LEVELS} 派生（单一来源）。
 * 无 `_lvN` 后缀的特殊关（如 `ch_stress`）不属任何章节，被忽略。
 */
function chapterFinales(): Map<string, string> {
  const maxLv = new Map<string, number>();
  const finale = new Map<string, string>();
  for (const l of PVE_LEVELS) {
    const m = /^(.+)_lv(\d+)$/.exec(l.id);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const ch = m[1];
    const n = Number(m[2]);
    if (n > (maxLv.get(ch) ?? -1)) {
      maxLv.set(ch, n);
      finale.set(ch, l.id);
    }
  }
  return finale;
}

/**
 * 已通关章节数 = 终关已通关的章节个数（章节 = 终关 `ch{N}_lv{max}` 在 cleared 中）。
 * 纯函数，由 {@link PVE_LEVELS} 派生，不读时钟/不连库。cleared 单调增 → 结果单调增（首通才涨、
 * 重打不涨），故服务器侧 `$max` 写入。特殊关（`ch_stress`，无终关编号）不计章节。
 */
export function chaptersClearedCount(cleared: readonly string[]): number {
  const clearedSet = new Set(cleared);
  let count = 0;
  for (const finaleId of chapterFinales().values()) {
    if (clearedSet.has(finaleId)) count++;
  }
  return count;
}

/** 每日「发材料的通关」次数上限（超出仍记 progress/stars，材料不发，§8 决策 3）。DRAFT 待实测。 */
export const PVE_DAILY_CLEAR_REWARD_CAP = 20;

/**
 * 升级材料花费（权威）。**效果**（HP/伤害乘子）留在客户端 `game/balance/pveUpgrades`（game logic，
 * 跑蓝图用）；**花费**在此，服务器 /pve/upgrade 重算扣费。id / maxLevel / baseCost 须与客户端镜像一致。
 */
export interface PveUpgradeCost {
  id: string;
  material: PveMaterial;
  maxLevel: number;
  /** level n→n+1 花费 = baseCost × (n+1)（线性递增）。 */
  baseCost: number;
}

export const PVE_UPGRADE_COSTS: PveUpgradeCost[] = [
  { id: 'inf_hp', material: 'scrap', maxLevel: 5, baseCost: 3 },
  { id: 'inf_dmg', material: 'scrap', maxLevel: 5, baseCost: 3 },
  { id: 'shd_hp', material: 'lead', maxLevel: 5, baseCost: 2 },
  { id: 'shd_dmg', material: 'lead', maxLevel: 5, baseCost: 2 },
  { id: 'arc_dmg', material: 'binding', maxLevel: 5, baseCost: 1 },
  { id: 'arc_hp', material: 'binding', maxLevel: 5, baseCost: 1 },
];

export function findPveUpgrade(id: string): PveUpgradeCost | undefined {
  return PVE_UPGRADE_COSTS.find((u) => u.id === id);
}

// ── L1 录像抽检复算触发（PVE_INTEGRITY_PLAN §8.6 第 3 步）────────────────────
// 把通关结果发给第三方在线客户端无头复算（复用 S1-J），复算星数 ≥ 声称才发材料。默认不传录像，
// 仅被抽中时回执 needsReplay 让客户端补传。触发：①按比例随机抽检 ②首通高价值关 ③L0 异常（开局
// 蓝图战力与服务器权威 pveUpgrades 不符——「开局战力不符 → 必作弊」，§0）。

/** 重复刷已通关关的随机抽检比例（首通/异常恒触发，不走此率）。DRAFT 待实测调。 */
export const PVE_VERIFY_SAMPLE_RATE = 0.1;

/** PvE 复算拒绝次数达此阈值 → 封号（pveBanned=true）。 */
export const PVE_REJECT_BAN_THRESHOLD = 3;

export interface SpotCheckInput {
  /** 是否首次通关该关（含解锁，高价值）。 */
  isFirstClear: boolean;
  /** L0 异常：客户端上报的开局蓝图快照与服务器权威 pveUpgrades 不符。 */
  blueprintMismatch: boolean;
  /** 0..1 随机数（调用方注入，便于测试确定性）。 */
  rand: number;
  /** 抽检比例（缺省 {@link PVE_VERIFY_SAMPLE_RATE}）。 */
  sampleRate?: number;
}

/**
 * 是否对该次通关做 L1 录像抽检复算。首通 / 异常恒触发；其余按比例随机抽检。
 * 纯函数（随机数外部注入），不读时钟 / 不连库。
 */
export function shouldSpotCheck(input: SpotCheckInput): boolean {
  if (input.blueprintMismatch || input.isFirstClear) return true;
  const rate = input.sampleRate ?? PVE_VERIFY_SAMPLE_RATE;
  return input.rand < rate;
}

/** currentLevel → currentLevel+1 的花费；已满级返回 null。 */
export function pveUpgradeCost(
  cost: PveUpgradeCost,
  currentLevel: number,
): { material: PveMaterial; amount: number } | null {
  if (currentLevel >= cost.maxLevel) return null;
  return { material: cost.material, amount: cost.baseCost * (currentLevel + 1) };
}
