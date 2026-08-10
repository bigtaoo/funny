// Split from iap.ts (2026-08-10, independent function module range 6, part 2/7).
// Product-id / amount → coin-tier or non-coin-SKU resolution, shared by all four platform verifiers.
import { IAP_TIERS_LIST } from '@nw/shared';
import { NON_COIN_PRODUCT_KINDS, type IapProductKind, type IapTierMap } from './types';

/**
 * Maps an App Store / Google Play product_id to a coin-tier name.
 * Reads NW_IAP_PRODUCT_MAP first (format: `productId:tier,...`);
 * falls back to the built-in default convention `${NW_IAP_BUNDLE}.coins.<tierId>` (e.g. com.nw.coins.t499),
 * where `<tierId>` is any key in IAP_TIERS. Derived from the tier map so it can never drift from IAP_TIERS again.
 * The bundle prefix can be overridden via NW_IAP_BUNDLE (default com.nw).
 */
export function resolveCoinsFromProductId(productId: string, tierMap: IapTierMap): number {
  const raw = process.env.NW_IAP_PRODUCT_MAP;
  if (raw) {
    for (const pair of raw.split(',')) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx < 0) continue;
      const pid = pair.slice(0, colonIdx).trim();
      const tier = pair.slice(colonIdx + 1).trim();
      if (pid === productId && tier && tierMap[tier]) return tierMap[tier]!;
    }
    return 0;
  }
  const prefix = `${process.env.NW_IAP_BUNDLE ?? 'com.nw'}.coins.`;
  if (productId.startsWith(prefix)) {
    const tier = productId.slice(prefix.length);
    if (tierMap[tier]) return tierMap[tier]!;
  }
  return 0;
}

/**
 * Maps an App Store / Google Play product_id to a non-coin SKU (subscription card / starter pack).
 * Reads NW_IAP_PRODUCT_MAP first (same `productId:kind` pairs as coin tiers); falls back to the
 * built-in convention `${NW_IAP_BUNDLE}.sub.monthly` / `.sub.year` / `.starter.draw` / `.starter.growth`.
 */
export function resolveNonCoinProduct(productId: string): IapProductKind | null {
  const raw = process.env.NW_IAP_PRODUCT_MAP;
  if (raw) {
    for (const pair of raw.split(',')) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx < 0) continue;
      const pid = pair.slice(0, colonIdx).trim();
      const kind = pair.slice(colonIdx + 1).trim();
      if (pid === productId && (NON_COIN_PRODUCT_KINDS as readonly string[]).includes(kind)) {
        return kind as IapProductKind;
      }
    }
    return null;
  }
  const bundle = process.env.NW_IAP_BUNDLE ?? 'com.nw';
  const suffixToKind: Record<string, IapProductKind> = {
    'sub.monthly': 'monthly_card',
    'sub.year': 'year_card',
    'starter.draw': 'starter_draw',
    'starter.growth': 'starter_growth',
  };
  for (const suffix of Object.keys(suffixToKind)) {
    if (productId === `${bundle}.${suffix}`) return suffixToKind[suffix]!;
  }
  return null;
}

/**
 * Amount-based counterpart of resolveNonCoinProduct, for platforms (WeChat/Stripe) whose verify
 * response carries a price rather than a stable product_id. No built-in default — subscription/starter
 * pricing (GACHA_DESIGN §5/§6) isn't finalized for these channels yet (¥298/¥30/¥6 all marked "定价待
 * 中国区上架核定"), so this fails closed (returns null) until NW_IAP_NONCOIN_AMOUNT_MAP is explicitly set,
 * same posture as resolveCoinsFromAmount's WeChat requirement.
 */
export function resolveNonCoinProductFromAmount(amount: number): IapProductKind | null {
  const raw = process.env.NW_IAP_NONCOIN_AMOUNT_MAP;
  if (!raw) return null;
  for (const pair of raw.split(',')) {
    const [a, kind] = pair.trim().split(':');
    if (Number(a) === amount && kind && (NON_COIN_PRODUCT_KINDS as readonly string[]).includes(kind)) {
      return kind as IapProductKind;
    }
  }
  return null;
}

/**
 * Reverse-lookup the coin tier from a payment amount (smallest currency unit), shared by WeChat/Stripe.
 * NW_IAP_AMOUNT_MAP (format `amount:tier,...`) takes priority. Built-in default: Stripe USD price in cents
 * → tier, derived from IAP_TIERS_LIST.usdCents (single source of truth: 99→t099 … 9999→t9999).
 * WeChat is priced in fen (CNY) and has no canonical price in the economy config, so WeChat deployments
 * MUST set NW_IAP_AMOUNT_MAP — the built-in default only matches Stripe's USD cents.
 */
export function resolveCoinsFromAmount(amount: number, tierMap: IapTierMap): number {
  const raw = process.env.NW_IAP_AMOUNT_MAP;
  if (raw) {
    for (const pair of raw.split(',')) {
      const [a, t] = pair.trim().split(':');
      if (Number(a) === amount && t && tierMap[t]) return tierMap[t]!;
    }
    return 0;
  }
  for (const def of IAP_TIERS_LIST) {
    if (def.usdCents === amount && tierMap[def.id]) return tierMap[def.id]!;
  }
  return 0;
}
