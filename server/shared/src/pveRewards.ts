// PvE 经济权威单一来源（PVE_INTEGRITY_PLAN §8.1）。纯数据 + 纯函数，无 game logic
// （M12：metaserver 可 import；严禁反向 import client/src/game）。客户端保留展示镜像
// （campaign/levels JSON 的 starThresholds 用于本地算星、balance/pveUpgrades 的效果乘子用于
// 跑蓝图），但**材料发放 / 升级扣费以本文件为准**（服务器 /pve/* 端点重算）。

export type PveMaterial = 'scrap' | 'lead' | 'binding';

export interface PveLevelConfig {
  id: string;
  /** 解锁前置：须先通关的关卡 id（null = 首关无前置）。顺序解锁。 */
  requires: string | null;
  /** 每次通关发放的材料（§8 决策 3：可重复刷，受每日上限）。空 = 不发材料（如压力关）。 */
  reward: Partial<Record<PveMaterial, number>>;
}

/**
 * 有序战役关卡（顺序解锁）。与客户端 `campaign/levels/*.json` 的 `rewards.materials` 同值，
 * 但**这里是发放权威**（客户端 JSON 降级为参考）。首通额外解锁下一关 + 记星，材料同表（每次发）。
 */
export const PVE_LEVELS: PveLevelConfig[] = [
  { id: 'ch1_lv1', requires: null, reward: { scrap: 6, lead: 2 } },
  { id: 'ch1_lv2', requires: 'ch1_lv1', reward: { scrap: 8, lead: 3, binding: 1 } },
  { id: 'ch1_lv3', requires: 'ch1_lv2', reward: { scrap: 10, lead: 4, binding: 2 } },
  { id: 'ch_stress', requires: 'ch1_lv3', reward: {} },
];

export function findPveLevel(id: string): PveLevelConfig | undefined {
  return PVE_LEVELS.find((l) => l.id === id);
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
