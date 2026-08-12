// Economy config — fate points (GACHA_DESIGN §7) + subscription/starter products (§5/§6). 2026-08-11
// split (independent function modules form, see ../economy.ts's header). Zero cross-file dependency
// within economy/*.
import type { Rarity } from '../types';

/** Fate points redeemed for one self-chosen past-featured limited legendary (§7.1). */
export const FATE_POINT_REDEEM_COST = 30;

/** Monthly card (§5): 30-day subscription, 120 coins/day, 600 coins granted immediately on purchase. */
export const MONTHLY_CARD_DAYS = 30;
export const MONTHLY_CARD_DAILY_COINS = 120;
export const MONTHLY_CARD_IMMEDIATE_COINS = 600;

/**
 * Year card (§5): 365-day subscription, same 120 coins/day + 600 immediate as the monthly card — only the
 * duration is ×12. The daily claim reuses MONTHLY_CARD_DAILY_COINS (subscription is one field; claim is card-agnostic).
 * Both cards are globally single-slot: buying either is refused while any subscription is still active (buy → use up → rebuy).
 */
export const YEAR_CARD_DAYS = 365;
export const YEAR_CARD_IMMEDIATE_COINS = 600;

/**
 * Display prices only, in USD cents (matches the coin-tier convention, `IAP_TIERS_LIST.usdCents` — real
 * charge amount is whatever Paddle price/App Store product the checkout resolves to, not these numbers;
 * see `NW_PADDLE_PRICE_IDS`'s `monthly_card`/`year_card` reserved keys). Year card is ~17% off 12 monthly
 * cards (12×$4.99 = $59.99 → $49.99), surfaced in the shop as a strike-through + savings badge.
 * 2026-08-11: switched from CNY (¥30/¥298/¥360) to USD — CNY/China-region pricing deferred to a
 * separate pass once China launch is scoped (see GACHA_DESIGN.md §5/§6).
 */
export const MONTHLY_CARD_PRICE_USD_CENTS = 499;
export const YEAR_CARD_PRICE_USD_CENTS = 4999;
export const YEAR_CARD_LIST_PRICE_USD_CENTS = 5999;

/** Starter growth pack (§6.2): 3,300 coins + a 7-day monthly card; buyable once, within the first 7 days of the account. */
export const GROWTH_PACK_COINS = 3300;
export const GROWTH_PACK_CARD_DAYS = 7;
export const GROWTH_PACK_WINDOW_DAYS = 7;

/** Starter first-draw pack (§6.1): a rare+ floored 10-pull, buyable once, independent of normal pity. */
export const STARTER_DRAW_COUNT = 10;
export const STARTER_DRAW_FLOOR: Rarity = 'rare';

/** Product ids for the one-off / subscription IAP-style products (marked in wallet.starterUsed / subscription). */
export const PRODUCT_MONTHLY_CARD = 'monthly_card';
export const PRODUCT_YEAR_CARD = 'year_card';
export const PRODUCT_STARTER_DRAW = 'starter_draw';
export const PRODUCT_STARTER_GROWTH = 'starter_growth';
