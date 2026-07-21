// Native rewarded-ad bridge contract (IAP_CREDENTIALS.md §2.1) — mirrors iap.ts's
// getNativeBilling()/NwBillingBridge pattern for AdMob instead of StoreKit/Play Billing.
//
// The Capacitor iOS shell injects `window.NWAds` (AppDelegate.swift's NWBridgeViewController)
// backed by the Google Mobile Ads SDK. Plain web / WeChat / CrazyGames never see this global —
// WebPlatform.hasRewardedAd() falls back to false there (CrazyGames overrides it with its own SDK).

/** Native rewarded-ad bridge injected on `window` by the Capacitor iOS shell, if any. */
export interface NwAdsBridge {
  readonly kind: 'admob';
  /**
   * Runs the native AdMob rewarded-ad flow. `accountId` is forwarded to the native side as the
   * AdMob Server-Side-Verification `customRewardText` so the SSV callback (`/ads/callback/admob`)
   * can credit the right account — the resolved `adToken` itself is not independently verifiable
   * and is only used for the client-side replay-dedup check.
   * Rejects if the user closes the ad before earning the reward, or the ad fails to load/present.
   */
  showRewarded(accountId: string): Promise<{ adToken: string; platform: 'admob_client' }>;
}

/** Reads the injected native ads bridge, if any (validated shape). */
export function getNativeAds(): NwAdsBridge | null {
  const b = (globalThis as { NWAds?: NwAdsBridge }).NWAds;
  if (b && typeof b.showRewarded === 'function' && b.kind === 'admob') return b;
  return null;
}
