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

/** 装备幂等账本（合成/托管）TTL（秒）：保留 7 天，覆盖客户端重试 + worldsvc 退还窗口（§18.2）。 */
export const EQUIPMENT_IDEM_TTL_SEC = 7 * 24 * 3600;

/** 分解返还比例 / 等级门槛（§6.3，ADR-012）。 */
export const SALVAGE_REFUND_RATIO = 0.7;
export const SALVAGE_MAX_LEVEL = 4; // +5 及以上不可分解

// ── 强化（E3，EQUIPMENT_DESIGN §6 / ECONOMY_NUMBERS §5.2，DRAFT [可调]）────────
//
// 强化把实例 level +1（0→9），走概率、可失败。失败不掉级不碎，只损耗本次材料 + 金币
// （温和档，§6.1）。金币/材料的主 sink 来自高级低成功率的持续失败损耗（§6.2）。
// 数值终点是 ECONOMY_NUMBERS §5（待铺），下方先给可跑占位（README §0：数值活在代码）。

/**
 * 强化成功率（按当前等级 fromLevel，0→1 起算）。EQUIPMENT_DESIGN §6.1：每升一级 −10%，
 * 0→1=90%、1→2=80%…8→9=10%（与 ECONOMY_NUMBERS §5.2 的 +1→2=80%…+8→9=10% 衔接，
 * §6.1 起点 0→1=90%）。fromLevel ≥ 9 = 已满级（返回 0，调用方先拦 ENHANCE_MAX_LEVEL）。
 */
export function enhanceSuccessRate(fromLevel: number): number {
  if (fromLevel < 0 || fromLevel >= EQUIP_MAX_LEVEL) return 0;
  return (EQUIP_MAX_LEVEL - fromLevel) / 10; // 0→0.9, 8→0.1
}

/** 强化单次消耗（材料 + 金币），随等级递增（DRAFT，权威 ECONOMY_NUMBERS §5.2）。 */
export interface EnhanceCost {
  materials: Record<string, number>;
  coins: number;
}

/**
 * 强化 fromLevel→fromLevel+1 的消耗（DRAFT [可调]）：低级吃碎屑、中级起加铅芯、高级起加装订线，
 * 金币随级线性增。成功/失败都扣（失败损耗是核心 sink，§6.2）。
 */
export function enhanceCost(fromLevel: number): EnhanceCost {
  const lv = Math.max(0, Math.min(fromLevel, EQUIP_MAX_LEVEL - 1));
  const materials: Record<string, number> = { scrap: 4 + 2 * lv };
  if (lv >= 3) materials.lead = lv - 2; // +3 起需铅芯
  if (lv >= 6) materials.binding = lv - 5; // +6 起需装订线
  return { materials, coins: 40 * (lv + 1) };
}

/**
 * 强化掷骰（**服务器权威**，确定性绑定 idempotencyKey + fromLevel）：同 key 重放/重试结果固定，
 * 杜绝"网络重试改命"（§18.2）。种子混入 fromLevel，使同 key 连续强化不同级各自独立。
 */
export function rollEnhanceSuccess(seedKey: string, fromLevel: number): boolean {
  const rng = seededRng(hashSeed(`enhance:${seedKey}:${fromLevel}`));
  return rng() < enhanceSuccessRate(fromLevel);
}

/**
 * 分解返还（§6.3，ADR-012）：返还该 defId **打造基础成本**的 SALVAGE_REFUND_RATIO（70%，向下取整），
 * 强化投入不返还（失败损耗是核心 sink，不能靠分解漏回）。不可合成件（无 craftCost）返还空。
 * 调用方负责先校验 level ≤ SALVAGE_MAX_LEVEL（+5 起不可分解）。
 */
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

// ── 合成词条 roll（E2，EQUIPMENT_DESIGN §7.2/§7.4/§7.5，DRAFT [可调]）─────────
//
// 合成产出一件 +0 基础装备：1 条槽位锁定主词条（m_*）+ 按稀有度 N 条副词条（s_*）。
// 词条 id ↔ 引擎字段映射 + 强化放大活在 @nw/engine（balance/equipment.ts AFFIX_FIELD_MAP）；
// 本处只决定「开出哪些 id + roll 什么值」。具体数值区间/权重终点是 ECONOMY_NUMBERS §5（待铺），
// 下方常量先给可跑占位（README §0：数值活在代码，调参只动这些常量）。

/** 主词条按槽位锁定（§7.4；暴击未落地 → trinket 退化 m_spd）。value = +0 基础值（百分比/flat）。 */
export const MAIN_AFFIX_BY_SLOT: Record<EquipSlot, { id: string; base: number }> = {
  weapon: { id: 'm_atk', base: 8 }, // 攻击 +8%（base，随强化放大）
  armor: { id: 'm_hp', base: 10 }, // 生命 +10%
  trinket: { id: 'm_spd', base: 6 }, // 移速 +6%
};

/** 副词条池（§7.5 战力类，rare/epic 才 roll）。每条 [id, 最小值, 最大值]（DRAFT）。 */
export const SUB_AFFIX_POOL: ReadonlyArray<readonly [string, number, number]> = [
  ['s_atk', 3, 6],
  ['s_hp', 4, 8],
  ['s_armor', 2, 5],
  ['s_spd', 2, 5],
  ['s_atkspd', 3, 6],
];

/** 稀有度 → 合成时 roll 的副词条条数（§7.2；epic 的特技槽 proc 框架未落地，本切片不 roll k_*）。 */
export const CRAFT_SUB_AFFIX_COUNT: Record<EquipRarity, number> = {
  common: 0,
  fine: 1,
  rare: 2,
  epic: 2,
};

/**
 * 确定性小 PRNG（mulberry32）：合成 roll 用，种子由 idempotencyKey 派生，
 * 同 key 重放产同一件（即便幂等账本未命中也可复现，杜绝"重试改命"）。
 */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串 → 32 位整型种子（FNV-1a）。 */
function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 合成一件 +0 基础装备的词条（主词条 + 按稀有度 N 条不重复副词条）。
 * @param defId 装备定义 id（决定槽位/稀有度）。
 * @param seedKey 确定性种子源（用 idempotencyKey，保证重放一致）。
 * @returns affixes 数组（Affix[] 结构，{id,value}），未知 defId → 抛错由调用方处理。
 */
export function rollCraftedAffixes(defId: string, seedKey: string): { id: string; value: number }[] {
  const def = EQUIPMENT_DEFS[defId];
  if (!def) throw new Error(`unknown defId: ${defId}`);
  const rng = seededRng(hashSeed(`${defId}:${seedKey}`));
  const out: { id: string; value: number }[] = [];
  // 主词条（槽位锁定，base 值；随强化由 engine 放大）
  const main = MAIN_AFFIX_BY_SLOT[def.slot];
  out.push({ id: main.id, value: main.base });
  // 副词条：从池中不重复抽 N 条
  const n = CRAFT_SUB_AFFIX_COUNT[def.rarity];
  const pool = [...SUB_AFFIX_POOL];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    const [id, lo, hi] = pool.splice(idx, 1)[0]!;
    const value = lo + Math.floor(rng() * (hi - lo + 1));
    out.push({ id, value });
  }
  return out;
}

/** 背包独立实例数（堆叠件不计；本切片实例库存全为独立件，直接计 key 数）。 */
export function equipmentInvCount(inv: Record<string, unknown> | undefined): number {
  return inv ? Object.keys(inv).length : 0;
}

/**
 * 装备拍卖冷启动参考单价（每件，按稀有度，DRAFT）：价格护栏滑窗样本不足时回退（AUCTION_DESIGN §4.A/§4.G）。
 * 装备 qty 恒 1，故"单价"即整件估值。演算去 ECONOMY_NUMBERS §5。
 */
export const EQUIP_AUCTION_REF_PRICE_BY_RARITY: Record<EquipRarity, number> = {
  common: 50,
  fine: 150,
  rare: 400,
  epic: 1200,
};
