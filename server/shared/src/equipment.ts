// 装备系统 — 机制目录与数据契约（EQUIPMENT_DESIGN.md §3 / §7 / §17）。
//
// 本文件是装备「定义目录 + 实例数据契约」的服务端权威，供：
//   · metaserver  /equipment/craft 校验配方、产实例
//   · worldsvc    拍卖装备分支：估值/价格护栏的品类键、快照校验
//   · 客户端镜像  背包/锻造/穿戴 UI（i18n key 由本表 defId 派生）
// 战斗数值（主词条放大系数、词条→引擎字段映射、跨系统封顶）活在 @nw/engine
// （`balance/equipment.ts`），本文件不复述（README §0 三铁律：数值活在代码）。
//
// 稀有度用独立 EquipRarity（common/fine/rare/epic），刻意不复用皮肤 Rarity
// （后者含 legendary，语义不同，见 types.ts 注）。

// ── 槽位 / 稀有度 ─────────────────────────────────────────────────────────
export type EquipSlot = 'weapon' | 'armor' | 'trinket';
export const EQUIP_SLOTS: readonly EquipSlot[] = ['weapon', 'armor', 'trinket'];

export type EquipRarity = 'common' | 'fine' | 'rare' | 'epic';

/** 稀有度 → 词条数（EQUIPMENT_DESIGN §7.2）：主恒 1 + 副 + 特技。 */
export const RARITY_AFFIX_SLOTS: Record<EquipRarity, { sub: number; skill: number }> = {
  common: { sub: 0, skill: 0 },
  fine: { sub: 1, skill: 0 },
  rare: { sub: 2, skill: 0 },
  epic: { sub: 2, skill: 1 },
};

// ── 装备定义目录（§17.2，3 槽 × 4 稀有度 = 12 件）────────────────────────
// defId 锁定三件事：槽位 + 稀有度 + 媒材皮（§3.1）。开出后只能强化 +级、洗练副词条，
// 不能变稀有度。craftCost 为 DRAFT [可调]（数值权威待铺 ECONOMY_NUMBERS §5，先占位）。

export interface EquipDef {
  defId: string;
  slot: EquipSlot;
  rarity: EquipRarity;
  /** 媒材皮（文具），i18n/渲染用；art-direction §9.2 映射 bone slot。 */
  media: string;
  /** 合成配方（材料 id → 数量）；undefined = 不可合成（仅掉落/抽卡来源，如部分史诗）。 */
  craftCost?: Record<string, number>;
}

export const EQUIPMENT_DEFS: Record<string, EquipDef> = {
  // 武器 weapon
  wp_pencil: { defId: 'wp_pencil', slot: 'weapon', rarity: 'common', media: 'pencil', craftCost: { scrap: 5 } },
  wp_pen: { defId: 'wp_pen', slot: 'weapon', rarity: 'fine', media: 'pen', craftCost: { scrap: 8, lead: 2 } },
  wp_marker: { defId: 'wp_marker', slot: 'weapon', rarity: 'rare', media: 'marker', craftCost: { lead: 6, binding: 2 } },
  wp_highlighter: { defId: 'wp_highlighter', slot: 'weapon', rarity: 'epic', media: 'highlighter' }, // 抽卡/极后期，不可合成
  // 护具 armor
  ar_draft: { defId: 'ar_draft', slot: 'armor', rarity: 'common', media: 'draft', craftCost: { scrap: 5 } },
  ar_cardstock: { defId: 'ar_cardstock', slot: 'armor', rarity: 'fine', media: 'cardstock', craftCost: { scrap: 8, lead: 2 } },
  ar_leather: { defId: 'ar_leather', slot: 'armor', rarity: 'rare', media: 'leather', craftCost: { lead: 6, binding: 2 } },
  ar_foil: { defId: 'ar_foil', slot: 'armor', rarity: 'epic', media: 'foil' },
  // 饰品 trinket
  tk_clip: { defId: 'tk_clip', slot: 'trinket', rarity: 'common', media: 'clip', craftCost: { scrap: 5 } },
  tk_bookmark: { defId: 'tk_bookmark', slot: 'trinket', rarity: 'fine', media: 'bookmark', craftCost: { scrap: 8, lead: 2 } },
  tk_sticker: { defId: 'tk_sticker', slot: 'trinket', rarity: 'rare', media: 'sticker', craftCost: { lead: 6, binding: 2 } },
  tk_seal: { defId: 'tk_seal', slot: 'trinket', rarity: 'epic', media: 'seal' },
};

export function getEquipDef(defId: string): EquipDef | undefined {
  return EQUIPMENT_DEFS[defId];
}

/** 强化等级上限（EQUIPMENT_DESIGN §6.1，+0..+9）。 */
export const EQUIP_MAX_LEVEL = 9;

/** 背包独立实例硬上限（EQUIPMENT_DESIGN §3.3，ADR-012，DRAFT [可调]）。 */
export const EQUIPMENT_INV_CAP = 300;

/** 分解返还比例 / 等级门槛（§6.3，ADR-012）。 */
export const SALVAGE_REFUND_RATIO = 0.7;
export const SALVAGE_MAX_LEVEL = 4; // +5 及以上不可分解
