// 单位养成 — 单一等级模型（DECISIONS §单位养成 / ECONOMY_NUMBERS §4）。
//
// 设计拍板（DECISIONS:55-56）：每兵种一个等级 1–9（5 张 N 级卡合成 1 张 N+1，集卡 sink），
// 各级连续缩放属性（HP/攻击/…），并在 T3/T6/T9 解锁离散「单位养成特性」(trait)。
//
// 本模块是「单位等级 → 蓝图」的唯一注入点，与 equipment.ts 同层、同风格（原地改蓝图）。
// 物理隔离 PvP 公平红线（L1）：applyUnitLevels 只被 buildCampaign/buildSiegeBlueprints 调用，
// buildPvpBlueprints() 签名里永远没有等级参 → 编译期不可能串味（hardwall 单测守护）。
//
// 数值口径：下面系数全是 DRAFT [可调]，数值权威终点是 ECONOMY_NUMBERS §4；本文件先给可跑
// 占位值，调参时只动常量、不动机制（README §0 三铁律：数值活在代码）。

import { UnitType, type UnitBlueprint } from '../types';

/** 单位养成最高等级（DECISIONS §单位养成：9 级，指数集卡 sink）。 */
export const UNIT_MAX_LEVEL = 9;

/**
 * 可养成兵种 = 玩家阵容的发牌兵种（与 equipment.PLAYER_EQUIPPABLE_UNITS 同源）。
 * PvE 专属怪种（Ironclad/Runner/Harpy/Medic…）无卡牌、不在阵容 → 不养成。
 */
export const PROGRESSABLE_UNITS: readonly UnitType[] = [
  UnitType.Infantry,
  UnitType.ShieldBearer,
  UnitType.Archer,
];

/**
 * 每级连续属性成长（ECONOMY_NUMBERS §4.2，逐级 additive 叠加，相对基础蓝图）。
 *   倍率 = 1 + perLevel × (level − 1)   —— L1 = 基础（无加成），L9 = 1 + perLevel×8。
 *   armor 为 flat：armor += armorPerLevel × (level − 1)。
 * 数值与 §4.2 表逐项对齐（[可调]，调参只动这里）：
 *   HP +12%/级(→T9 +96%)、攻击 +10%(→+80%)、攻速 +4%(攻击间隔↓，→+32%)、
 *   移速 +3%(→+24%)、护甲 +2 flat/级(→+16)。
 */
export const STAT_GROWTH_PER_LEVEL = {
  hp: 0.12,
  attack: 0.1,
  /** 攻速%：每级把攻击间隔除以 (1 + atkspd×steps)，下限封顶防破帧（见 applyUnitLevels）。 */
  atkspd: 0.04,
  /** 移速%：speed × (1 + spd×steps)。 */
  spd: 0.03,
  /** 护甲 flat/级（加算）。S12-E 下调：armor:2 时 L9+16 让箭兵 22 攻仅造 6 实伤（73% 减免），过强。 */
  armor: 1,
} as const;

/** 攻速封顶：攻击间隔不得低于基础的此比例（防破帧；§4.2「有下限封顶」）。 */
export const MIN_ATTACK_INTERVAL_RATIO = 0.5;

/**
 * 通用 trait 断点（ECONOMY_NUMBERS §4.4 解锁表，俗套三档 T3/T6/T9，所有可养成兵种通用）：
 *   · T3 暴击：critPct 概率打出 ×critMult 伤害（减护甲前 ×倍率，引擎机制见 CombatSystem）。
 *   · T6 吸血：命中按实际伤害 % 回血（加算进 lifestealPct，由 clampEffectCaps 跨源封顶 ≤30）。
 *   · T9 +1 出兵：spawnCount += count（GameEngine 出牌时读解析后蓝图）。
 * 数值与 §4.4 解锁表对齐（[可调]），后期再按兵种差异化（DECISIONS:61）。
 */
export const TRAIT_BREAKPOINTS = {
  crit: { level: 3, pct: 10, mult: 1.5 },
  lifesteal: { level: 6, pct: 15 },
  bonusSpawn: { level: 9, count: 1 },
} as const;

/** 把单位等级钳到 [1, UNIT_MAX_LEVEL]（未知/0/负 → 1，超上限 → 封顶）。 */
export function clampUnitLevel(level: number | undefined): number {
  if (!Number.isFinite(level as number)) return 1;
  return Math.max(1, Math.min(Math.floor(level as number), UNIT_MAX_LEVEL));
}

/**
 * 把单位养成等级以乘算/断点修饰原地叠到蓝图。唯一的「等级 → blueprint」注入点。
 * 未知兵种 id / 缺省 / L1 都安全 no-op（前向兼容 + 等级不可低于 1）。
 *
 * @param bp     蓝图表（clone 之后、applyEquipment 之前的中间态）。
 * @param levels 单位等级映射（UnitType → 1..9）；缺省/空 = 全 L1 = 无加成。
 */
export function applyUnitLevels(
  bp: Record<UnitType, UnitBlueprint>,
  levels: Record<string, number> | undefined,
): void {
  if (!levels) return;
  for (const unitType of PROGRESSABLE_UNITS) {
    const level = clampUnitLevel(levels[unitType]);
    if (level <= 1) continue; // L1 = 基础，无加成

    const u = bp[unitType];

    // ── 连续属性成长（§4.2，逐级 additive）────────────────────────────────────
    const steps = level - 1;
    u.hp = Math.round(u.hp * (1 + STAT_GROWTH_PER_LEVEL.hp * steps));
    u.attack = Math.round(u.attack * (1 + STAT_GROWTH_PER_LEVEL.attack * steps));
    // 攻速：除以 (1 + atkspd×steps)，钳到基础间隔的下限比例（防破帧）。
    const atkspdFactor = 1 + STAT_GROWTH_PER_LEVEL.atkspd * steps;
    u.attackInterval = Math.max(
      u.attackInterval * MIN_ATTACK_INTERVAL_RATIO,
      u.attackInterval / atkspdFactor,
    );
    // 移速：乘算。
    u.speed = u.speed * (1 + STAT_GROWTH_PER_LEVEL.spd * steps);
    // 护甲：flat 加算（clampEffectCaps 末尾跨源封顶）。
    u.armor = (u.armor ?? 0) + STAT_GROWTH_PER_LEVEL.armor * steps;

    // ── trait 断点（离散质变）────────────────────────────────────────────────
    if (level >= TRAIT_BREAKPOINTS.crit.level) {
      // 取较高值，与未来装备 crit 来源共存（同字段不叠加，防暴击率爆炸）。
      u.critPct = Math.max(u.critPct ?? 0, TRAIT_BREAKPOINTS.crit.pct);
      u.critMult = Math.max(u.critMult ?? 1, TRAIT_BREAKPOINTS.crit.mult);
    }
    if (level >= TRAIT_BREAKPOINTS.lifesteal.level) {
      // 加算进 lifestealPct，跨源求和后由 clampEffectCaps 统一封顶（≤30）。
      u.lifestealPct = (u.lifestealPct ?? 0) + TRAIT_BREAKPOINTS.lifesteal.pct;
    }
    if (level >= TRAIT_BREAKPOINTS.bonusSpawn.level) {
      u.spawnCount = u.spawnCount + TRAIT_BREAKPOINTS.bonusSpawn.count;
    }
  }
}
