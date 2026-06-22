// 装备目录 + 数值函数 —— 客户端镜像（EQUIPMENT_DESIGN §3/§6/§17）。
//
// 这是 server/shared/src/equipment.ts **纯数据 + 数值函数**部分的客户端镜像。
// 客户端 webpack 只 alias `@nw/engine`（零依赖）；`@nw/shared` 带 mongodb/jsonwebtoken，
// 客户端无法 import。故 UI 展示所需的「目录 / 合成成本 / 强化成功率成本 / 分解返还」在此镜像一份。
//
// ⚠️ 改字段三处同步（与 SaveData.ts 同纪律）：本文件 ↔ server/shared/src/equipment.ts。
//    服务器仍是唯一权威：UI 据此**预览**成本/成功率，真实扣费/掷骰以服务器回执为准。
//    主词条随强化放大的系数（ENHANCE_COEFF_PER_LEVEL）直接从 @nw/engine 取，不在此重复。

import type { EquipSlot, EquipRarity } from './SaveData';

export interface EquipDef {
  defId: string;
  slot: EquipSlot;
  rarity: EquipRarity;
  /** 媒材皮（文具），i18n/渲染用。 */
  media: string;
  /** 合成配方（材料 id → 数量）；undefined = 不可合成（仅掉落/抽卡来源）。 */
  craftCost?: Record<string, number>;
}

// 目录（§17.2，3 槽 × 4 稀有度 = 12 件）。与 server/shared 同源。
export const EQUIPMENT_DEFS: Record<string, EquipDef> = {
  // 武器 weapon
  wp_pencil: { defId: 'wp_pencil', slot: 'weapon', rarity: 'common', media: 'pencil', craftCost: { scrap: 5 } },
  wp_pen: { defId: 'wp_pen', slot: 'weapon', rarity: 'fine', media: 'pen', craftCost: { scrap: 8, lead: 2 } },
  wp_marker: { defId: 'wp_marker', slot: 'weapon', rarity: 'rare', media: 'marker', craftCost: { lead: 6, binding: 2 } },
  wp_highlighter: { defId: 'wp_highlighter', slot: 'weapon', rarity: 'epic', media: 'highlighter' },
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

/** 可合成的装备定义（有 craftCost），按目录顺序。锻造 tab 列表来源。 */
export function craftableDefs(): EquipDef[] {
  return Object.values(EQUIPMENT_DEFS).filter((d) => d.craftCost);
}

/** 强化等级上限（+0..+9）。 */
export const EQUIP_MAX_LEVEL = 9;
/** 背包独立实例硬上限（ADR-012）。 */
export const EQUIPMENT_INV_CAP = 300;
/** 分解返还比例 / 等级门槛（§6.3，ADR-012）。 */
export const SALVAGE_REFUND_RATIO = 0.7;
export const SALVAGE_MAX_LEVEL = 4; // +5 及以上不可分解

/**
 * 强化成功率（按当前等级 fromLevel）：0→1=90%、1→2=80%…8→9=10%。
 * fromLevel ≥ 9 = 已满级（0）。与 server/shared enhanceSuccessRate 同公式。
 */
export function enhanceSuccessRate(fromLevel: number): number {
  if (fromLevel < 0 || fromLevel >= EQUIP_MAX_LEVEL) return 0;
  return (EQUIP_MAX_LEVEL - fromLevel) / 10;
}

export interface EnhanceCost {
  materials: Record<string, number>;
  coins: number;
}

/** 强化 fromLevel→fromLevel+1 的消耗（与 server/shared enhanceCost 同公式，DRAFT）。 */
export function enhanceCost(fromLevel: number): EnhanceCost {
  const lv = Math.max(0, Math.min(fromLevel, EQUIP_MAX_LEVEL - 1));
  const materials: Record<string, number> = { scrap: 4 + 2 * lv };
  if (lv >= 3) materials.lead = lv - 2;
  if (lv >= 6) materials.binding = lv - 5;
  return { materials, coins: 40 * (lv + 1) };
}

/** 分解返还（打造成本 × 70% 向下取整；不可合成件返还空）。与 server/shared salvageRefund 同公式。 */
export function salvageRefund(defId: string): Record<string, number> {
  const def = EQUIPMENT_DEFS[defId];
  if (!def?.craftCost) return {};
  const out: Record<string, number> = {};
  for (const [mat, qty] of Object.entries(def.craftCost)) {
    const r = Math.floor(qty * SALVAGE_REFUND_RATIO);
    if (r > 0) out[mat] = r;
  }
  return out;
}

/** 词条类型（id 前缀自描述，见 @nw/engine balance/equipment.ts）。 */
export function affixKind(id: string): 'main' | 'sub' | 'skill' | 'unknown' {
  if (id.startsWith('m_')) return 'main';
  if (id.startsWith('s_')) return 'sub';
  if (id.startsWith('k_')) return 'skill';
  return 'unknown';
}

/** 洗练消耗：目标稀有度 → 需消耗的素材装备稀有度（与 server/shared REFORGE_MATERIAL_RARITY 同源）。 */
export const REFORGE_MATERIAL_RARITY: Partial<Record<EquipRarity, EquipRarity>> = {
  fine: 'common',
  rare: 'fine',
  epic: 'rare',
};

/** 保护道具 id（E7）。存 save.inventory.items[PROTECT_ENHANCE_ITEM_ID]，值为持有数量。 */
export const PROTECT_ENHANCE_ITEM_ID = 'protect_enhance';
