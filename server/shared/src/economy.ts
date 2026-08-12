// Single source of truth for economy values (ECONOMY_BALANCE.md §2~4). Pure data, no DB / no PIXI.
// meta uses it to list shop items/gacha pools + compute dupe refunds; commercial uses it to run gacha RNG. Same source on both ends avoids drift.
//
// 2026-08-11 (independent function modules form, claudedocs/server.md's "拆分形态的优先级" 形态①): this
// file is a zero-class set of independent domain constants/functions — same shape as equipment.ts/
// cards.ts/mongo.ts's precedent. Split by domain into:
//   economy/rarity.ts        RARITY_ORDER / RARITY_WEIGHTS (the DAG root gacha.ts depends on)
//   economy/gacha.ts         gacha pools, fixed-odds draw, pity — depends on rarity.ts
//   economy/limitedPools.ts  time-boxed limited pools — depends on gacha.ts (derives from GACHA_POOLS)
//   economy/shop.ts          direct shop pricing + dupe refunds
//   economy/iapTiers.ts      IAP tier → coins/USD mapping
//   economy/victoryCoins.ts  per-match ranked victory coins
//   economy/subscriptions.ts fate points, monthly/year card, starter packs
//   economy/misc.ts          rewarded ads, rename cost, anti-RMT anomaly threshold
// All eight are independent of each other except the two noted dependencies (rarity → gacha →
// limitedPools); shop/iapTiers/victoryCoins/subscriptions/misc have zero dependency on any other
// economy/*.ts file. This file collapses to `export *` from all eight — `@nw/shared`'s
// `export * from './economy'` (index.ts) and every `from '@nw/shared'` import elsewhere are
// unaffected.
export * from './economy/rarity';
export * from './economy/gacha';
export * from './economy/limitedPools';
export * from './economy/shop';
export * from './economy/iapTiers';
export * from './economy/victoryCoins';
export * from './economy/subscriptions';
export * from './economy/misc';
