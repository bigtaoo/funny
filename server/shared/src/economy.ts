// 经济数值单一来源（ECONOMY_BALANCE.md §2~4）。纯数据，无 DB / 无 PIXI。
// meta 用它列商品/盲盒池 + 算 dupe 退币；commercial 用它跑盲盒 RNG。两端同源避免漂移。
import type { Rarity } from './types';

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

// 占位皮肤池（真实皮肤内容待美术）；RNG 先按稀有度 tier 滚，再 tier 内均匀挑。
export const GACHA_POOLS: GachaPoolDef[] = [
  {
    id: 'standard',
    costSingle: 150,
    costTen: 1350,
    pityThreshold: 90,
    tenFloor: 'epic',
    dupePolicy: 'coins',
    itemsByRarity: {
      common: ['skin_c1', 'skin_c2', 'skin_c3', 'skin_c4'],
      rare: ['skin_r1', 'skin_r2', 'skin_r3'],
      epic: ['skin_e1', 'skin_e2'],
      legendary: ['skin_l1'],
    },
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
export const SHOP_ITEMS: ShopItemDef[] = [
  { id: 'skin_shop_c1', cost: 300, kind: 'skin', grants: 'skin_shop_c1', rarity: 'common' },
  { id: 'skin_shop_r1', cost: 800, kind: 'skin', grants: 'skin_shop_r1', rarity: 'rare' },
  { id: 'skin_shop_e1', cost: 1800, kind: 'skin', grants: 'skin_shop_e1', rarity: 'epic' },
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

/** IAP 档位 → 到账金币（§2.2，首充双倍等钩子后期再叠）。 */
export const IAP_TIERS: Record<string, number> = {
  small: 600,
  mid: 3300,
  large: 11800,
};

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
