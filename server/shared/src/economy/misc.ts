// Economy config — small standalone knobs: rewarded ads, rename cost, anti-RMT anomaly threshold.
// 2026-08-11 split (independent function modules form, see ../economy.ts's header). Zero cross-file
// dependency within economy/*.

/** Rewarded ads (§2.1). 10 coins per ad (decided 2026-06-27, original 50 was too high; revisit after launch based on performance). */
export const ADS_REWARD_COINS = 10;
export const ADS_DAILY_CAP = 5;
export const ADS_MIN_INTERVAL_MS = 10 * 60 * 1000; // 10min minimum interval between two ads (2026-07-21, was 30min — DailyScene "Ads" tab)

/**
 * Rewarded-ad stamina refill (ECONOMY_NUMBERS STAMINA_REFILL_AD, 2026-09-27). CrazyGames build only
 * (CRAZYGAMES_LAUNCH §4): its own daily counter, independent of the coin ads above.
 */
export const STAMINA_AD_AMOUNT = 30;
export const STAMINA_AD_DAILY_CAP = 3;
/** The only `x-nw-platform` the stamina-ad endpoint serves. */
export const STAMINA_AD_CLIENT_PLATFORM = 'crazygames';

/** Rename cost (coins). Deducted once per display-name change (commercial wallet deducts → meta renames). */
export const RENAME_COST = 500;

/**
 * Anti-RMT coin-anomaly audit (2026-07-26): an account whose ledger shows more than this many coins
 * gained in a single UTC day from non-recharge sources (grants/refunds/rewards — anything but `reason:'recharge'`)
 * is flagged into the OPS anti-cheat review queue (`AntiCheatReviewDoc.kind:'coin_anomaly'`) for manual review.
 * Real-money recharges are excluded by design — a whale buying coins is not an anomaly.
 */
export const COIN_ANOMALY_DAILY_THRESHOLD = 3000;
