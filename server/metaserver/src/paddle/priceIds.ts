// Paddle NW_PADDLE_PRICE_IDS resolution (2026-08-11 split, independent function modules form,
// claudedocs/server.md's "拆分形态的优先级" 形态① — see paddle.ts's header for the full split). Five
// functions that all parse the same "tierKey:priceId,..." env-var format for a different lookup
// direction; zero shared state, zero cross-file calls — the DAG root every other paddle/*.ts file
// depends on.
import { IAP_TIERS, IAP_TIERS_LIST } from '@nw/shared';

/**
 * Resolves a Paddle price ID to coins using NW_PADDLE_PRICE_IDS env var.
 * Format: "t499:pri_xxx,t999:pri_yyy,..."  (tier key → Paddle price ID)
 * Returns 0 if the price ID is not mapped.
 */
export function coinsForPriceId(priceId: string): number {
  const raw = process.env.NW_PADDLE_PRICE_IDS ?? '';
  for (const pair of raw.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 0) continue;
    const tierKey = pair.slice(0, colonIdx).trim();
    const pid = pair.slice(colonIdx + 1).trim();
    if (pid === priceId && IAP_TIERS[tierKey]) return IAP_TIERS[tierKey]!;
  }
  return 0;
}

/**
 * Resolves a Paddle price ID to its real USD price (GACHA_DESIGN §13), via the same tier-key mapping as
 * coinsForPriceId. Returns 0 if the price ID is not mapped or the tier is unknown to IAP_TIERS_LIST.
 */
export function usdCentsForPriceId(priceId: string): number {
  const raw = process.env.NW_PADDLE_PRICE_IDS ?? '';
  for (const pair of raw.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 0) continue;
    const tierKey = pair.slice(0, colonIdx).trim();
    const pid = pair.slice(colonIdx + 1).trim();
    if (pid === priceId) {
      const def = IAP_TIERS_LIST.find((t) => t.id === tierKey);
      if (def) return def.usdCents;
    }
  }
  return 0;
}

/**
 * Resolves a Paddle price ID to a subscription product via the same NW_PADDLE_PRICE_IDS mapping as
 * coinsForPriceId, using the reserved tier keys `monthly_card` / `year_card` (GACHA_DESIGN §5) instead
 * of an IAP_TIERS coin lookup. Returns null if the price ID isn't mapped to either.
 */
export function subscriptionForPriceId(priceId: string): 'monthly' | 'year' | null {
  const raw = process.env.NW_PADDLE_PRICE_IDS ?? '';
  for (const pair of raw.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 0) continue;
    const tierKey = pair.slice(0, colonIdx).trim();
    const pid = pair.slice(colonIdx + 1).trim();
    if (pid !== priceId) continue;
    if (tierKey === 'monthly_card') return 'monthly';
    if (tierKey === 'year_card') return 'year';
  }
  return null;
}

/**
 * Resolves a Paddle price ID to a starter pack product (GACHA_DESIGN §6, ¥6/¥30 first-purchase-funnel
 * SKUs), same reserved-key mapping style as subscriptionForPriceId.
 */
export function starterProductForPriceId(priceId: string): 'starter_draw' | 'starter_growth' | null {
  const raw = process.env.NW_PADDLE_PRICE_IDS ?? '';
  for (const pair of raw.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 0) continue;
    const tierKey = pair.slice(0, colonIdx).trim();
    const pid = pair.slice(colonIdx + 1).trim();
    if (pid !== priceId) continue;
    if (tierKey === 'starter_draw' || tierKey === 'starter_growth') return tierKey;
  }
  return null;
}

/**
 * Resolves a tier key to a Paddle price ID using NW_PADDLE_PRICE_IDS env var.
 * Returns null if the tier is not mapped.
 */
export function priceIdForTier(tierId: string): string | null {
  const raw = process.env.NW_PADDLE_PRICE_IDS ?? '';
  for (const pair of raw.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx < 0) continue;
    const tierKey = pair.slice(0, colonIdx).trim();
    const pid = pair.slice(colonIdx + 1).trim();
    if (tierKey === tierId && pid) return pid;
  }
  return null;
}
