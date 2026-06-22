// 经济数值单一来源（ECONOMY_BALANCE.md §2~4）。纯数据，无 DB / 无 PIXI。
// meta 用它列商品/盲盒池 + 算 dupe 退币；commercial 用它跑盲盒 RNG。两端同源避免漂移。
import type { Rarity } from './types';
import type { RankId } from './ladder';
import { UNIT_CARD_POOL_ID, unitCardPoolItems } from './unitCards';

export const RARITY_ORDER: Rarity[] = ['common', 'rare', 'epic', 'legendary'];

/** 标准池稀有度权重（§4.1）。 */
export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 700,
  rare: 230,
  epic: 60,
  legendary: 10,
};

export interface GachaPoolDef {
  id: string;
  costSingle: number; // §3.2 单抽
  costTen: number; // §3.2 十连
  pityThreshold: number; // 大保底：累计 N 抽必出 legendary（§4.2）
  tenFloor: Rarity; // 十连保底最低稀有度（§4.2，每 10 抽至少 1 个 epic+）
  dupePolicy: 'shards' | 'coins'; // openapi 顶层兼容字段；细分按稀有度见 DUPE_*
  itemsByRarity: Record<Rarity, string[]>;
}

/**
 * 盲盒材料奖励（E7 §4）：`mat_*` 前缀 itemId → 入库数量。
 * 发货端（metaserver/economy.ts deliverOrder）据此分流到 save.materials，不走皮肤 dupe 退币。
 * 数量 DRAFT [可调]：tier 越高稀有材料越多，但绝对量刻意压低（材料主 faucet 仍是关卡掉落）。
 */
export const GACHA_MATERIAL_GRANTS: Record<string, Record<string, number>> = {
  mat_scrap: { scrap: 10 },
  mat_lead: { lead: 3 },
  mat_binding: { binding: 1 },
};

// 占位皮肤池（真实皮肤内容待美术）；RNG 先按稀有度 tier 滚，再 tier 内均匀挑。
// E7：标准池加入材料格（mat_*，发货走材料分流）+ 装备格（defId，发货走装备分流）。
// "材料为主 + 装备成品低概率彩头"（ADR-017）：common 材料占 3/7，rare 材料 2/8，
// epic/legendary 装备格 ≤ 皮肤格数，保持装备为彩头（DRAFT [可调]）。
export const GACHA_POOLS: GachaPoolDef[] = [
  {
    id: 'standard',
    costSingle: 150,
    costTen: 1350,
    pityThreshold: 90,
    tenFloor: 'epic',
    dupePolicy: 'coins',
    itemsByRarity: {
      // common: 4 皮肤 + 3 材料格 → 材料出率 43%
      common: ['skin_c1', 'skin_c2', 'skin_c3', 'skin_c4', 'mat_scrap', 'mat_scrap', 'mat_scrap'],
      // rare: 3 皮肤 + 2 材料格 + 3 精良装备 → 材料出率 25%，fine 装备 38%
      rare: ['skin_r1', 'skin_r2', 'skin_r3', 'mat_lead', 'mat_lead', 'wp_pen', 'ar_cardstock', 'tk_bookmark'],
      // epic: 2 皮肤 + 1 材料格 + 3 稀有装备 → 装备彩头 50%
      epic: ['skin_e1', 'skin_e2', 'mat_binding', 'wp_marker', 'ar_leather', 'tk_sticker'],
      // legendary: 1 皮肤 + 3 史诗装备 → 装备彩头 75%（极稀有 tier，每拉 ~2%）
      legendary: ['skin_l1', 'wp_highlighter', 'ar_foil', 'tk_seal'],
    },
  },
  // 单位卡池（S12-C，养成 ≠ 外观，独立池）：item = cardKey（infantry:1 …），稀有度映射卡级见
  // unitCards.GACHA_RARITY_TO_CARD_LEVEL（common→T1 … legendary→T4）。发货端按 poolId 走单位卡
  // 入库（cardInventory + 重算 unitLevels），**不走皮肤 dupe 退币**（集卡天然重复，全部入库）。
  // 定价/保底沿用皮肤池占位 `[可调]`（§3.2）；dupePolicy 仅 openapi 顶层兼容字段，单位卡发货不读。
  {
    id: UNIT_CARD_POOL_ID,
    costSingle: 150,
    costTen: 1350,
    pityThreshold: 90,
    tenFloor: 'epic',
    dupePolicy: 'coins',
    itemsByRarity: unitCardPoolItems(),
  },
];

export interface ShopItemDef {
  id: string;
  cost: number;
  kind: string; // skin | item …
  grants: string; // 发货时写进 inventory 的 itemId
  rarity: Rarity;
}

// 商店直购定价（§3.1，legendary 仅盲盒产出不直售）。
// protect_enhance：强化保护道具（E7 §6.2），失败时保留材料不损耗，大 R 向消耗品。
// kind='item' → 发货写 save.inventory.items[grants]，而非 skins（见 metaserver/economy.ts deliverOrder）。
export const SHOP_ITEMS: ShopItemDef[] = [
  { id: 'skin_shop_c1', cost: 300, kind: 'skin', grants: 'skin_shop_c1', rarity: 'common' },
  { id: 'skin_shop_r1', cost: 800, kind: 'skin', grants: 'skin_shop_r1', rarity: 'rare' },
  { id: 'skin_shop_e1', cost: 1800, kind: 'skin', grants: 'skin_shop_e1', rarity: 'epic' },
  { id: 'protect_enhance', cost: 500, kind: 'item', grants: 'protect_enhance', rarity: 'rare' },
];

// 重复转化（§4.3）。设计原意 common/rare → 碎片，epic/legendary → 退币；但碎片落在客户端同步段
// materials，会被客户端 PUT 覆盖（权威冲突），且碎片兑换表本就「待定」。S5 先统一退币（权威钱包、
// 幂等、无同步冲突）：common/rare 用小额占位，epic/legendary 按 §4.3。碎片路径待 materials 权威定后再接。
export const DUPE_REFUND_COINS: Record<Rarity, number> = {
  common: 10,
  rare: 50,
  epic: 400,
  legendary: 1500,
};

/** 激励广告（§2.1）。 */
export const ADS_REWARD_COINS = 50;
export const ADS_DAILY_CAP = 5;
export const ADS_MIN_INTERVAL_MS = 30 * 60 * 1000; // 30min 两条广告最短间隔（C2）

/** 改名消耗（金币）。改一次展示名扣此数（commercial 钱包扣币 → meta 改名）。 */
export const RENAME_COST = 500;

/** IAP 档位 → 到账金币（§2.2，首充双倍等钩子后期再叠）。 */
export const IAP_TIERS: Record<string, number> = {
  small: 600,
  mid: 3300,
  large: 11800,
};

/**
 * 分段单局胜利金币（§2.3b，持续 faucet）。高段更高，配合每日上限防通胀。
 * 仅 ranked 胜局发放（含掉线/认输判胜、对等裁判判定的诚实胜方）。
 */
export const VICTORY_COINS_BY_RANK: Record<RankId, number> = {
  bronze: 5,
  silver: 5,
  gold: 5,
  platinum: 8,
  diamond: 8,
  star: 12,
  master: 12,
  grandmaster: 18,
  king: 18,
};

/** 每日可领胜利金币的对局上限（超出仍计积分/战绩，不发币，§2.3b）。 */
export const VICTORY_DAILY_WIN_CAP = 10;

/** 段位 → 单局胜利金币（未知段位回退最低档）。 */
export function victoryCoinsForRank(rank: string): number {
  return VICTORY_COINS_BY_RANK[rank as RankId] ?? VICTORY_COINS_BY_RANK.bronze;
}

export function findGachaPool(id: string): GachaPoolDef | undefined {
  return GACHA_POOLS.find((p) => p.id === id);
}

export function findShopItem(id: string): ShopItemDef | undefined {
  return SHOP_ITEMS.find((i) => i.id === id);
}

export function gachaCost(pool: GachaPoolDef, count: number): number {
  return count === 10 ? pool.costTen : pool.costSingle * count;
}

/** 展开成 openapi GachaPool.entries（客户端展示用，tier 内权重均分）。 */
export function poolEntries(
  pool: GachaPoolDef,
): { itemId: string; weight: number; rarity: Rarity }[] {
  const out: { itemId: string; weight: number; rarity: Rarity }[] = [];
  for (const rarity of RARITY_ORDER) {
    const items = pool.itemsByRarity[rarity];
    if (items.length === 0) continue;
    const perItem = Math.round(RARITY_WEIGHTS[rarity] / items.length);
    for (const itemId of items) out.push({ itemId, weight: perItem, rarity });
  }
  return out;
}
