// Split from iap.ts (2026-08-10, independent function module range 6, part 7/7).
// Dev stub: when NW_IAP_DEV=true or real credentials are absent, receipts with a tier:/product:
// prefix hit this logic instead of a real platform verifier.
import { DEV_STUB_DEFAULT_TIER } from '@nw/shared';
import { NON_COIN_PRODUCT_KINDS, type IapProductKind, type IapTierMap, type IapVerifyResult } from './types';

export function devVerify(receipt: string, tierMap: IapTierMap): IapVerifyResult {
  if (!receipt) return { ok: false, coins: 0 };
  // `product:<kind>` stub (dev/e2e only): exercises the non-coin verification path (subscriptions,
  // starter packs) without needing a real store receipt — mirrors the `tier:` stub's role for coins.
  if (receipt.startsWith('product:')) {
    const kind = receipt.slice(8);
    if ((NON_COIN_PRODUCT_KINDS as readonly string[]).includes(kind)) {
      return { ok: true, coins: 0, product: kind as IapProductKind };
    }
    return { ok: false, coins: 0 };
  }
  const tier = receipt.startsWith('tier:') ? receipt.slice(5) : DEV_STUB_DEFAULT_TIER;
  const coins = tierMap[tier];
  return coins ? { ok: true, coins } : { ok: true, coins: tierMap[DEV_STUB_DEFAULT_TIER]! };
}
