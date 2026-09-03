// Real IAP receipt verification (S4-1 / C1).
// Supported platforms: apple (App Store StoreKit 1 receipt), google (Google Play),
//                      wechat (WeChat Pay V3), stripe (Web).
// Dev stub retained: when NW_IAP_DEV=true or real credentials are absent, receipts with a tier: prefix hit the stub logic.
//
// Receipt format convention:
//   apple   → base64 encoded App Store receipt data
//   google  → "${productId}:${purchaseToken}"
//   wechat  → transaction_id
//   stripe  → payment_intent_id
//
// The receiptId idempotency key is assembled by the caller as `${platform}:${receipt}`;
// commercial.rechargeVerify guards idempotency — this file does not repeat that check.
//
// ── Split (2026-08-10, independent function module range 6) ──
// This file was already a set of mutually-independent per-platform verify functions sharing only the
// product/amount resolution helpers and a couple of types — no class, no shared mutable state — a
// textbook independent-function-module split, by platform: `iap/{types,productResolve,apple,google,
// wechat,stripe,devStub}.ts`. This file keeps only the `createReceiptVerifier` factory, which wires
// env-var-derived credentials into a `dispatch` closure over the per-platform verify functions —
// identical to the original body, just importing what used to be same-file private functions.
import type { IapTierMap, VerifyAppleSubscriptions, VerifyReceipt } from './iap/types';
import { appleVerify, appleSubscriptionTransactions } from './iap/apple';
import { googleVerify, type GoogleServiceAccount } from './iap/google';
import { wxPayVerify } from './iap/wechat';
import { stripeVerify } from './iap/stripe';
import { devVerify } from './iap/devStub';
import { usdCentsForCoins } from '@nw/shared';

export type { AppleSubscriptionTx, IapTierMap, IapProductKind, IapVerifyResult, VerifyAppleSubscriptions, VerifyReceipt } from './iap/types';

/**
 * Build the receipt-verification function. Supports four platforms:
 * - apple: NW_APPLE_PASSWORD (App Store shared secret)
 * - google: NW_GOOGLE_SERVICE_ACCOUNT_JSON (service-account JSON string) + NW_GOOGLE_PACKAGE_NAME
 * - wechat: NW_WX_PAY_MCH_ID + NW_WX_PAY_API_KEY_V3
 * - stripe: NW_STRIPE_SECRET_KEY
 * - dev stub: when NW_IAP_DEV=true or all real credentials are absent, tier:xxx receipts hit stub logic.
 *   **Hardening (L2-3)**: In production (NODE_ENV=production) the dev stub is forcibly disabled — it will
 *   neither be accidentally enabled by NW_IAP_DEV=true nor fall back due to missing credentials.
 *   Missing credentials in production → verification returns failure (fail closed), never awards coins.
 *   A process with NW_IAP_DEV=true incorrectly set is rejected at commercial startup (index.ts); this is the second line of defence.
 */
export function createReceiptVerifier(tierMap: IapTierMap): VerifyReceipt {
  const applePassword = process.env.NW_APPLE_PASSWORD ?? '';
  const googleSaJson = process.env.NW_GOOGLE_SERVICE_ACCOUNT_JSON ?? '';
  const googlePackage = process.env.NW_GOOGLE_PACKAGE_NAME ?? 'com.nw.game';
  const mchId = process.env.NW_WX_PAY_MCH_ID ?? '';
  const wxApiKey = process.env.NW_WX_PAY_API_KEY_V3 ?? '';
  const stripeKey = process.env.NW_STRIPE_SECRET_KEY ?? '';
  const isProd = process.env.NODE_ENV === 'production';
  const devEnabled =
    !isProd &&
    (process.env.NW_IAP_DEV === 'true' ||
      (!applePassword && !googleSaJson && !mchId && !stripeKey));

  let googleSa: GoogleServiceAccount | null = null;
  if (googleSaJson) {
    try {
      googleSa = JSON.parse(googleSaJson) as GoogleServiceAccount;
    } catch {
      console.error('NW_GOOGLE_SERVICE_ACCOUNT_JSON parse error — Google Play disabled');
    }
  }

  const dispatch = async (platform: string, receipt: string) => {
    if (
      devEnabled &&
      (platform === 'dev' || platform.startsWith('dev-') || receipt.startsWith('tier:') || receipt.startsWith('product:'))
    ) {
      return devVerify(receipt, tierMap);
    }

    switch (platform) {
      case 'apple':
        if (!applePassword) return { ok: false, coins: 0 };
        return appleVerify(receipt, tierMap, applePassword);
      case 'google':
        if (!googleSa) return { ok: false, coins: 0 };
        return googleVerify(receipt, tierMap, googleSa, googlePackage);
      case 'wechat':
        if (!mchId || !wxApiKey) return { ok: false, coins: 0 };
        return wxPayVerify(receipt, tierMap, mchId, wxApiKey);
      case 'stripe':
        if (!stripeKey) return { ok: false, coins: 0 };
        return stripeVerify(receipt, tierMap, stripeKey);
      default:
        return { ok: false, coins: 0 };
    }
  };

  // Single attach point for usdCents (GACHA_DESIGN §13): every platform branch above resolves `coins` to an
  // exact IAP_TIERS value via resolveCoinsFromProductId/resolveCoinsFromAmount, so the reverse lookup is safe
  // — avoids threading tier/usdCents through each of the four platform-specific verify functions individually.
  return async (platform: string, receipt: string) => {
    const result = await dispatch(platform, receipt);
    if (!result.ok) return result;
    return { ...result, usdCents: usdCentsForCoins(result.coins) };
  };
}

/**
 * The reader the auto-renewal sync uses (IOS_RELEASE.md §4.1b), or null when Apple is unconfigured.
 *
 * Deliberately NOT part of `createReceiptVerifier`'s dispatch, and deliberately with no dev-stub
 * branch. That verifier answers "is this one receipt good for one product", which every platform can
 * answer and a stub can fake; this reads a list of *already-paid-for* periods and hands each one a
 * grant with no further gate — the single-slot check that normally stops a card from stacking is
 * bypassed for renewals (see subscriptionCardBuy's `renewal` flag), because Apple has already taken
 * the money for a period that overlaps the running one. A forgeable receipt there would mint
 * subscription time on demand, so the only accepted input is one Apple itself just validated.
 * Null (no NW_APPLE_PASSWORD) means the sync route reports "nothing to sync" rather than granting.
 */
export function createAppleSubscriptionReader(): VerifyAppleSubscriptions {
  const applePassword = process.env.NW_APPLE_PASSWORD ?? '';
  if (!applePassword) return null;
  return (receipt: string) => appleSubscriptionTransactions(receipt, applePassword);
}
