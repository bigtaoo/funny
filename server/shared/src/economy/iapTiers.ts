// Economy config — IAP tiers (§2.2 USD, ECONOMY_BALANCE.md §2.2). 2026-08-11 split (independent
// function modules form, see ../economy.ts's header). Zero cross-file dependency within economy/*.

/**
 * IAP tiers → coins credited (§2.2 USD, ECONOMY_BALANCE.md §2.2).
 * Keys are tier IDs used in NW_IAP_PRODUCT_MAP / NW_PADDLE_PRICE_IDS.
 * iOS/Android: t099 / t199 also available; web (Paddle) starts at t499.
 */
export const IAP_TIERS: Record<string, number> = {
  t099:  100,
  t199:  210,
  t499:  550,
  t999:  1150,
  t1999: 2400,
  t4999: 6500,
  t9999: 13500,
};

/** Ordered list of tiers for UI display. Omitting `mobileOnly` means the tier is sold everywhere (web + iOS/Android). */
export interface IapTierDef {
  id: string;
  usdCents: number;   // price in cents for display ($4.99 → 499)
  coins: number;      // total coins including bonus
  base: number;       // base coins (without bonus)
  bestValue?: boolean;
  mobileOnly?: boolean;  // true = iOS/Android app stores only, NOT sold on Paddle web (fixed per-txn fee makes small tiers uneconomic)
}

export const IAP_TIERS_LIST: IapTierDef[] = [
  { id: 't099',  usdCents:  99,  base: 100,   coins: 100,   mobileOnly: true },
  { id: 't199',  usdCents: 199,  base: 200,   coins: 210,   mobileOnly: true },
  { id: 't499',  usdCents: 499,  base: 500,   coins: 550   },
  { id: 't999',  usdCents: 999,  base: 1000,  coins: 1150  },
  { id: 't1999', usdCents: 1999, base: 2000,  coins: 2400,  bestValue: true },
  { id: 't4999', usdCents: 4999, base: 5000,  coins: 6500  },
  { id: 't9999', usdCents: 9999, base: 10000, coins: 13500 },
];

/** First-purchase coin multiplier (applied once per account lifetime). */
export const FIRST_PURCHASE_BONUS_MULTIPLIER = 2;

/**
 * Reverse-lookup a tier id from its (pre-bonus) coin grant. IAP_TIERS values are pairwise distinct,
 * so this is unambiguous. Used to recover the real USD price of a recharge for the cumulative-recharge
 * counter (GACHA_DESIGN §13), which the receipt-verification path only reports as a coin amount.
 */
export function tierIdForCoins(coins: number): string | undefined {
  return Object.entries(IAP_TIERS).find(([, c]) => c === coins)?.[0];
}

/** USD cents (display price) for a given tier id, or 0 if unknown. */
export function usdCentsForTier(tierId: string): number {
  return IAP_TIERS_LIST.find((t) => t.id === tierId)?.usdCents ?? 0;
}

/** USD cents for a (pre-bonus) coin grant, via tierIdForCoins. 0 if the amount matches no known tier. */
export function usdCentsForCoins(coins: number): number {
  const tier = tierIdForCoins(coins);
  return tier ? usdCentsForTier(tier) : 0;
}

/**
 * Fallback tier for the dev IAP stub when a receipt has no `tier:` prefix
 * (e.g. E2E `topup_<uid>` receipts). Must be a key of IAP_TIERS; the standard
 * web entry tier (t499 = 550 coins, > RENAME_COST) so dev top-ups are useful.
 */
export const DEV_STUB_DEFAULT_TIER = 't499';
