// 装备 → 蓝图注入（EQUIPMENT_DESIGN §9 / §7，E1）。
//
// 这是「词条 → 引擎字段映射 + 乘/加算 + 跨系统封顶」的权威落点（equipment.ts §0、
// EQUIPMENT_DESIGN §16 指针都指向 @nw/engine/balance/equipment.ts）。与 pveUpgrades.ts
// 同一层、同一注入风格（原地改蓝图），物理隔离 PvP 公平红线（L1）：
//   · applyEquipment 只被 buildCampaignBlueprints / buildSiegeBlueprints 调用；
//   · buildPvpBlueprints() 签名里永远没有装备参 → 编译期不可能串味（hardwall 单测守护）。
//
// ── 零依赖红线（关键架构约束）────────────────────────────────────────────────
// 客户端 webpack 直接 alias 打包 @nw/engine **源码**（client/webpack.config.js），而
// @nw/shared 依赖 mongodb/jsonwebtoken。故本模块**绝不 import @nw/shared**——否则
// mongodb 会被打进浏览器包。装备「实例类型 + defId 目录」活在 @nw/shared（types.ts /
// equipment.ts），本模块用**结构化等价的本地输入类型**接收，调用方直接把 shared 的
// EquipmentInstance / GearLoadout 传进来（TS 结构化子类型，多余字段无害）。
//
// ── 数值口径 ──────────────────────────────────────────────────────────────
// 下面的系数/封顶全是 DRAFT [可调]，数值权威终点是 ECONOMY_NUMBERS §5（待铺）；本文件
// 先给可跑的占位值，调参时只动这些常量、不动机制（README §0 三铁律：数值活在代码）。

import { UnitType, type UnitBlueprint } from '../types';

// ── 词条 id 词汇表（EQUIPMENT_DESIGN §7.4 / §7.5 / §7.6）──────────────────────
//
// 词条 id 用命名空间前缀自描述「主 / 副 / 特技」，engine 据前缀判定，无需在实例上另加
// 标记字段（E0 的 EquipmentInstance.affixes 是扁平 Affix[]）：
//   · m_*  主词条：每件恒 1 条，**唯一随强化等级放大**（§7.3）。实例存 +0 基础值，
//          engine 算 effective = base × (1 + ENHANCE_COEFF_PER_LEVEL × level)。
//   · s_*  副词条：rare/epic 才有，**固定在 roll 值**，不随强化变（engine 原值取用）。
//   · k_*  特技：仅史诗，触发型 proc（§7.6）。**proc 框架未落地**（开刃/嗜血/回响…需
//          on-kill/on-spawn/on-hit 钩子，§15 待评估）→ engine 当前**识别但 no-op**，
//          不影响蓝图（落地是 E1 之后的独立工作，非本切片）。
//   · 未知 id：安全忽略（前向兼容，新词条上线不炸老 engine）。

/** 词条作用到引擎蓝图的方式。 */
type AffixKind =
  | 'mult_atk'        // 攻击 +X%（乘算，attack）
  | 'mult_hp'         // 生命 +X%（乘算，hp）
  | 'mult_atkspd'     // 攻速 +X%（降低 attackInterval）
  | 'mult_spd'        // 移速 +X%（乘算，speed）
  | 'flat_armor'      // 护甲 +N（加算，armor）
  | 'flat_lifesteal'  // 吸血 +X%（加算到 lifestealPct，0–100 标度）
  | 'flat_regen'      // 生命回复 +N/s（加算，regenPerSec）
  | 'crit'            // 暴击 +X%：引擎暴击机制（trait T3 同款）未落地 → 占位 no-op（§7.4 注）
  | 'noncombat';      // 功能类（材料掉落/体力返还）：不进战斗蓝图，由 pveRewards 读（§7.5）

interface AffixDef {
  kind: AffixKind;
  /** true = 主词条，随强化等级放大；false/缺省 = 副词条，固定值。 */
  main?: boolean;
}

/**
 * 词条 id → 作用方式。**机制权威**（§7.4/§7.5）；具体数值区间/权重在 ECONOMY_NUMBERS §5，
 * 不在此（这里只决定「这条词条往哪个引擎字段、用乘还是加」）。
 */
export const AFFIX_FIELD_MAP: Readonly<Record<string, AffixDef>> = {
  // 主词条（§7.4，按槽位锁定，开出时定 1 个；随强化放大）
  m_atk: { kind: 'mult_atk', main: true },
  m_atkspd: { kind: 'mult_atkspd', main: true },
  m_hp: { kind: 'mult_hp', main: true },
  m_armor: { kind: 'flat_armor', main: true },
  m_spd: { kind: 'mult_spd', main: true },
  m_crit: { kind: 'crit', main: true },
  // 副词条（§7.5 战力类，rare/epic，固定 roll 值）
  s_atk: { kind: 'mult_atk' },
  s_hp: { kind: 'mult_hp' },
  s_armor: { kind: 'flat_armor' },
  s_spd: { kind: 'mult_spd' },
  s_atkspd: { kind: 'mult_atkspd' },
  s_lifesteal: { kind: 'flat_lifesteal' },
  s_regen: { kind: 'flat_regen' },
  // 副词条（§7.5 功能类，不计战力上限、不进蓝图）
  s_matdrop: { kind: 'noncombat' },
  s_stamina: { kind: 'noncombat' },
};

/** 强化系数：主词条最终值 = base × (1 + 系数 × 等级)（§7.3 DRAFT 0.10/级 → +9 ≈ ×1.9）。 */
export const ENHANCE_COEFF_PER_LEVEL = 0.1;

// ── 跨系统封顶（EQUIPMENT_DESIGN §7.7，防数值爆炸，DRAFT [可调]）──────────────
//
// 连续型效果全来源求和后钳到全局硬上限。两类落点：
//   · 乘算百分比（atk/hp/atkspd）：在 applyEquipment 累加阶段对**装备贡献**钳制
//     （烘焙进绝对 hp/attack 后无法反算，必须在累加时钳）。
//   · 绝对字段（lifestealPct）：装备 + trait 都写同一字段 → 由 clampEffectCaps 在
//     注入末尾**统一钳一次**（§7.7④），实现真正的「trait + 装备求和后钳」。
//
// ⚠️ 当前局限（记录待办，非本切片）：暴击（crit）依赖未落地的引擎暴击机制（§7.4 注）；
//    trait 的攻速/攻击/生命增益走 TraitSystem 运行期、不在蓝图烘焙阶段 → 乘算类的
//    「trait + 装备求和封顶」尚未完全合一。E1 先保证装备自身封顶 + lifestealPct 跨源
//    封顶；完整跨源合一待暴击/proc 框架与 trait 数值同表（§7.7 上限归 ECONOMY_NUMBERS §5）。
export const EFFECT_CAPS = {
  /** 攻击% 装备贡献上限（§7.7 ≤ +60%）。 */
  atkPct: 0.6,
  /** 生命% 装备贡献上限（§7.7 ≤ +60%）。 */
  hpPct: 0.6,
  /** 攻速% 装备贡献上限（§7.7 ≤ +40%）。 */
  atkspdPct: 0.4,
  /** 吸血% 全来源（trait T6 + 副词条 + 特技）求和上限（§7.7 ≤ 30）。 */
  lifestealPct: 30,
  /** 护甲 flat 装备贡献上限（S12-E 收紧：progression 改 armor:1/级，L9=+8；装备上限 12 → 合计 ≤20）。 */
  armorFlat: 12,
} as const;

// ── 可被全局 loadout 加成的玩家兵种（§8「影响全军」）──────────────────────────
//
// 与 pveUpgrades 一致：只有玩家阵容里的发牌兵种（Infantry/ShieldBearer/Archer）吃加成；
// PvE 专属怪种（Ironclad/Runner/Harpy/支援）无卡牌、不在玩家阵容 → 不加成。
// 注：与 applyPveUpgrades 同样作用于**共享蓝图表**（按 UnitType 键），siege 攻防共用同一
// 张表的既有行为原样保留（这是 §9「同一处注入」的既定语义，攻防分离不在 E1 扩大）。
export const PLAYER_EQUIPPABLE_UNITS: readonly UnitType[] = [
  UnitType.Infantry,
  UnitType.ShieldBearer,
  UnitType.Archer,
];

// ── 引擎本地输入类型（结构化等价 @nw/shared，不 import shared）─────────────────

/** 词条实例（结构等价 shared Affix）。 */
export interface EngineAffix {
  id: string;
  value: number;
}

/** 装备实例（结构等价 shared EquipmentInstance 的子集，engine 只需这三个字段）。 */
export interface EngineEquipInstance {
  defId: string;
  level: number;
  affixes: EngineAffix[];
}

/** 槽位 → 实例 id（结构等价 shared GearSlotMap；用宽松索引签名以容 Partial<Record<EquipSlot,…>>）。 */
export type EngineSlotMap = { readonly [slot: string]: string | undefined };

/** 穿戴 loadout（结构等价 shared GearLoadout）。 */
export interface EngineGearLoadout {
  global?: EngineSlotMap;
  byUnit?: { readonly [unitType: string]: EngineSlotMap };
}

/** applyEquipment 的输入：穿戴 loadout + 实例库存（按 id 解引用）。 */
export interface EngineEquipmentInput {
  gear: EngineGearLoadout;
  inv: { readonly [instanceId: string]: EngineEquipInstance };
}

// ── 注入 ─────────────────────────────────────────────────────────────────────

/** 单兵种的效果累加器（百分比为小数，0.12 = +12%；flat 为原值）。 */
interface EffectAccum {
  atkPct: number;
  hpPct: number;
  atkspdPct: number;
  spdPct: number;
  armorFlat: number;
  lifestealFlat: number;
  regenFlat: number;
}

function zeroAccum(): EffectAccum {
  return { atkPct: 0, hpPct: 0, atkspdPct: 0, spdPct: 0, armorFlat: 0, lifestealFlat: 0, regenFlat: 0 };
}

/** 取某兵种实际穿戴的 slot→实例 id 映射：byUnit 优先（阶段二），否则 global（阶段一全军）。 */
function loadoutFor(gear: EngineGearLoadout, unitType: UnitType): EngineSlotMap | undefined {
  return gear.byUnit?.[unitType] ?? gear.global;
}

/** 把一件穿戴装备的所有词条累加进 acc（主词条按强化等级放大；功能类/特技/未知跳过）。 */
function accumInstance(acc: EffectAccum, inst: EngineEquipInstance): void {
  const level = Math.max(0, Math.min(inst.level ?? 0, 9));
  for (const affix of inst.affixes ?? []) {
    const def = AFFIX_FIELD_MAP[affix.id];
    if (!def) continue; // 未知词条：安全忽略
    // 主词条随强化放大；副词条固定值。
    const effective = def.main ? affix.value * (1 + ENHANCE_COEFF_PER_LEVEL * level) : affix.value;
    switch (def.kind) {
      case 'mult_atk':
        acc.atkPct += effective / 100;
        break;
      case 'mult_hp':
        acc.hpPct += effective / 100;
        break;
      case 'mult_atkspd':
        acc.atkspdPct += effective / 100;
        break;
      case 'mult_spd':
        acc.spdPct += effective / 100;
        break;
      case 'flat_armor':
        acc.armorFlat += effective;
        break;
      case 'flat_lifesteal':
        acc.lifestealFlat += effective;
        break;
      case 'flat_regen':
        acc.regenFlat += effective;
        break;
      case 'crit': // 暴击机制未落地（§7.4 注）：占位 no-op
      case 'noncombat': // 功能类（材料掉落/体力返还）：不进战斗蓝图（§7.5）
        break;
    }
  }
}

function clamp(v: number, max: number): number {
  return v > max ? max : v < 0 ? 0 : v;
}

/**
 * 把穿戴装备的词条加成原地叠到蓝图（EQUIPMENT_DESIGN §9）。乘算字段的**装备贡献**在此钳到
 * EFFECT_CAPS（烘焙后无法反算），绝对字段（lifestealPct/armor）累加后留给 clampEffectCaps 统一钳。
 *
 * @param bp    蓝图表（applyPveUpgrades 之后、clampEffectCaps 之前的中间态）。
 * @param equip 穿戴 loadout + 实例库存。缺省/空时为 no-op（无装备 = 蓝图不变）。
 */
export function applyEquipment(
  bp: Record<UnitType, UnitBlueprint>,
  equip: EngineEquipmentInput | undefined,
): void {
  if (!equip) return;
  const { gear, inv } = equip;
  if (!gear || !inv) return;

  for (const unitType of PLAYER_EQUIPPABLE_UNITS) {
    const slotMap = loadoutFor(gear, unitType);
    if (!slotMap) continue;
    const acc = zeroAccum();
    let worn = 0;
    for (const slot of Object.keys(slotMap)) {
      const instId = slotMap[slot];
      if (!instId) continue;
      const inst = inv[instId];
      if (!inst) continue; // 引用了不存在的实例：安全忽略
      accumInstance(acc, inst);
      worn++;
    }
    if (worn === 0) continue;

    const u = bp[unitType];
    // 乘算字段：装备贡献在此钳（§7.7 落点①）。
    u.attack = Math.round(u.attack * (1 + clamp(acc.atkPct, EFFECT_CAPS.atkPct)));
    u.hp = Math.round(u.hp * (1 + clamp(acc.hpPct, EFFECT_CAPS.hpPct)));
    // 攻速：百分比降低攻击间隔（§7.4「乘算（降低间隔）」），下限保护防 0/负。
    const atkspd = clamp(acc.atkspdPct, EFFECT_CAPS.atkspdPct);
    if (atkspd > 0) u.attackInterval = u.attackInterval / (1 + atkspd);
    // 移速：§7.7 表未列上限 → 不钳（移速无免伤/破值风险）。
    if (acc.spdPct !== 0) u.speed = u.speed * (1 + acc.spdPct);
    // 绝对字段：累加，统一钳交给 clampEffectCaps（跨源求和封顶，§7.7④）。
    if (acc.armorFlat !== 0) u.armor = (u.armor ?? 0) + acc.armorFlat;
    if (acc.lifestealFlat !== 0) u.lifestealPct = (u.lifestealPct ?? 0) + acc.lifestealFlat;
    if (acc.regenFlat !== 0) u.regenPerSec = (u.regenPerSec ?? 0) + acc.regenFlat;
  }
}

/**
 * 跨系统封顶的**唯一统一落点**（EQUIPMENT_DESIGN §7.7④）：在 applyPveUpgrades + applyEquipment
 * 都叠完后执行一次，钳制**绝对字段**的全来源求和（trait + 装备写同一字段，如 lifestealPct）。
 * 乘算百分比的封顶已在 applyEquipment 累加阶段完成（烘焙后不可反算）；本函数补齐绝对字段。
 */
export function clampEffectCaps(bp: Record<UnitType, UnitBlueprint>): void {
  for (const unitType of Object.keys(bp) as UnitType[]) {
    const u = bp[unitType];
    if (u.lifestealPct !== undefined) {
      u.lifestealPct = clamp(u.lifestealPct, EFFECT_CAPS.lifestealPct);
    }
    if (u.armor !== undefined) {
      // 护甲 flat 全来源封顶（基础护甲 + 装备）；防后期减伤溢出（§7.7）。
      u.armor = Math.min(u.armor, EFFECT_CAPS.armorFlat);
    }
  }
}
