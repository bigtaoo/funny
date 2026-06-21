// PvE 养成 — 升级树 + 公平性硬墙（META_DESIGN.md §5）。
//
// 两条蓝图构造路径，物理隔离 PvE 战力与 PvP 公平：
//   · buildPvpBlueprints()        —— 只读常量，签名里根本不出现 SaveData / 升级数据。
//   · buildCampaignBlueprints(lv) —— 常量克隆 + applyPveUpgrades（唯一注入点）。
// 硬墙单测（test/hardwall.test.ts）：满级升级下 buildPvpBlueprints() 仍与 UNIT_BLUEPRINTS 逐字相等。
//
// 升级只改单位数值（hp/damage/speed），不碰建筑、不碰皮肤（皮肤纯渲染层）。
// 材料 = 关卡掉落（非货币，M6），花在升级上；竞技不可达 → 不上重型反作弊（§2）。

import { UNIT_BLUEPRINTS } from '../config';
import { UnitType, type UnitBlueprint } from '../types';
import { applyEquipment, clampEffectCaps, type EngineEquipmentInput } from './equipment';
import { applyUnitLevels } from './progression';

// ── 材料（关卡掉落，PvE 升级货币）────────────────────────────────────────────
//
// 笔记本主题三档材料。数值为 DRAFT（ECONOMY_BALANCE.md §5 待实测调参）。

export const MATERIALS = {
  /** 碎屑 — 常见掉落，低级升级主料。 */
  scrap: 'scrap',
  /** 铅芯 — 中级掉落。 */
  lead: 'lead',
  /** 装订线 — 稀有掉落，高级升级。 */
  binding: 'binding',
} as const;

export type MaterialId = (typeof MATERIALS)[keyof typeof MATERIALS];

/** 展示用材料元数据（名称走 i18n key，图标色由渲染层取）。 */
export const MATERIAL_ORDER: MaterialId[] = [MATERIALS.scrap, MATERIALS.lead, MATERIALS.binding];

// ── 升级定义 ────────────────────────────────────────────────────────────────

export interface PveUpgradeDef {
  /** 稳定 id，作 SaveData.pveUpgrades 的键。 */
  id: string;
  unitType: UnitType;
  stat: 'hp' | 'damage' | 'speed';
  maxLevel: number;
  /** 每级 +x（小数，乘算叠加在基础值上：mult = 1 + effectPerLevel × level）。 */
  effectPerLevel: number;
  /** 升级消耗的材料。 */
  material: MaterialId;
  /** level n→n+1 的材料数 = baseCost × (n+1)（线性递增深坑）。 */
  baseCost: number;
}

/**
 * 升级树。三名玩家单位（Infantry / ShieldBearer / Archer）各一条 HP + 一条 Damage 线。
 * PvE 专属怪种（Ironclad / Runner）无升级（它们不在玩家阵容里）。数值为 DRAFT。
 */
export const PVE_UPGRADE_DEFS: PveUpgradeDef[] = [
  // 普通兵
  { id: 'inf_hp',   unitType: UnitType.Infantry,     stat: 'hp',     maxLevel: 5, effectPerLevel: 0.10, material: MATERIALS.scrap, baseCost: 3 },
  { id: 'inf_dmg',  unitType: UnitType.Infantry,     stat: 'damage', maxLevel: 5, effectPerLevel: 0.10, material: MATERIALS.scrap, baseCost: 3 },
  // 盾兵
  { id: 'shd_hp',   unitType: UnitType.ShieldBearer, stat: 'hp',     maxLevel: 5, effectPerLevel: 0.12, material: MATERIALS.lead,  baseCost: 2 },
  { id: 'shd_dmg',  unitType: UnitType.ShieldBearer, stat: 'damage', maxLevel: 5, effectPerLevel: 0.10, material: MATERIALS.lead,  baseCost: 2 },
  // 弓箭兵
  { id: 'arc_dmg',  unitType: UnitType.Archer,       stat: 'damage', maxLevel: 5, effectPerLevel: 0.12, material: MATERIALS.binding, baseCost: 1 },
  { id: 'arc_hp',   unitType: UnitType.Archer,       stat: 'hp',     maxLevel: 5, effectPerLevel: 0.10, material: MATERIALS.binding, baseCost: 1 },
];

/** 按 id 查升级定义。 */
export function getUpgradeDef(id: string): PveUpgradeDef | undefined {
  return PVE_UPGRADE_DEFS.find((d) => d.id === id);
}

/**
 * 从 currentLevel 升到 currentLevel+1 的材料消耗；已满级返回 null。
 */
export function upgradeCost(
  def: PveUpgradeDef,
  currentLevel: number,
): { material: MaterialId; amount: number } | null {
  if (currentLevel >= def.maxLevel) return null;
  return { material: def.material, amount: def.baseCost * (currentLevel + 1) };
}

// ── 蓝图构造（硬墙）─────────────────────────────────────────────────────────

/** 深克隆 UNIT_BLUEPRINTS（每个蓝图全是基本类型字段，浅拷贝即足够独立）。 */
function cloneBlueprints(): Record<UnitType, UnitBlueprint> {
  const out = {} as Record<UnitType, UnitBlueprint>;
  for (const key of Object.keys(UNIT_BLUEPRINTS) as UnitType[]) {
    out[key] = { ...UNIT_BLUEPRINTS[key] };
  }
  return out;
}

/**
 * PvP / netplay 路径：只读常量克隆，签名里没有任何升级来源 → 编译期不可能串味。
 * 配 test/hardwall.test.ts：满级 SaveData 下其结果仍与 UNIT_BLUEPRINTS 逐字相等。
 */
export function buildPvpBlueprints(): Record<UnitType, UnitBlueprint> {
  return cloneBlueprints();
}

/**
 * campaign 路径：常量克隆 + 三步注入链（EQUIPMENT_DESIGN §9）：
 *   applyPveUpgrades（单位养成/trait）→ applyEquipment（装备词条）→ clampEffectCaps（跨源封顶）。
 * @param levels SaveData.pveUpgrades（升级 id → 等级）。
 * @param equip  穿戴装备 + 实例库存（SaveData.gear + equipmentInv）；缺省 = 无装备，链退化为仅 upgrades。
 */
export function buildCampaignBlueprints(
  levels: Record<string, number>,
  equip?: EngineEquipmentInput,
  unitLevels?: Partial<Record<UnitType, number>>,
): Record<UnitType, UnitBlueprint> {
  const bp = cloneBlueprints();
  applyPveUpgrades(bp, levels);
  applyUnitLevels(bp, unitLevels);
  applyEquipment(bp, equip);
  clampEffectCaps(bp);
  return bp;
}

/**
 * SLG 围攻路径（S8-3，SLG_DESIGN §5.2 / §6.2）：与 campaign 共用同一棵养成树和注入点
 * （PvE 攒的装备直接是 SLG 战力）。当前与 buildCampaignBlueprints 逐字等价，独立命名是为了
 *   ①把「天梯红线」表达在类型层面（siege 走这个、netplay/pvp 永远走 buildPvpBlueprints，
 *     后者签名无升级参 → 编译期不可能串味，§6.1 硬墙单测原样守护）；
 *   ②给未来 SLG 专属 buff（科技/家族增益，不影响 PvE）留唯一落点。
 * @param levels 服务器权威 pveUpgrades（升级 id → 等级）。
 * @param equip  攻方权威养成快照里的装备（SaveData.gear + equipmentInv）；服务器复算围攻时随快照传入
 *               （EQUIPMENT_DESIGN §10：客户端篡改本地穿戴改不了「这套装备能否破城」）。缺省 = 无装备。
 */
export function buildSiegeBlueprints(
  levels: Record<string, number>,
  equip?: EngineEquipmentInput,
  unitLevels?: Partial<Record<UnitType, number>>,
): Record<UnitType, UnitBlueprint> {
  const bp = cloneBlueprints();
  applyPveUpgrades(bp, levels);
  applyUnitLevels(bp, unitLevels);
  applyEquipment(bp, equip);
  clampEffectCaps(bp);
  return bp;
}

/**
 * 把升级等级以乘算修饰叠加到蓝图（原地改）。未知 id / 0 级 / 超 maxLevel 都安全钳制。
 * 唯一的 SaveData→blueprint 注入点（§5.2）。
 */
export function applyPveUpgrades(
  bp: Record<UnitType, UnitBlueprint>,
  levels: Record<string, number>,
): void {
  for (const def of PVE_UPGRADE_DEFS) {
    const lvl = Math.max(0, Math.min(levels[def.id] ?? 0, def.maxLevel));
    if (lvl === 0) continue;
    const mult = 1 + def.effectPerLevel * lvl;
    const u = bp[def.unitType];
    switch (def.stat) {
      case 'hp':
        u.hp = Math.round(u.hp * mult);
        break;
      case 'damage':
        u.attack = Math.round(u.attack * mult);
        break;
      case 'speed':
        u.speed = u.speed * mult;
        break;
    }
  }
}
