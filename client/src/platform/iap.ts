// Client IAP routing + native billing bridge contract (COMMERCIAL_DESIGN §IAP client).
//
// One web bundle doubles as the native app bundle: a Capacitor shell loads the same
// build inside a WKWebView (iOS) / WebView (Android) and injects a `window.NWBilling`
// bridge backed by StoreKit / Play Billing. So the platform layer decides at runtime
// which store a coin-tier recharge routes to:
//   • native bridge present → 'apple' | 'google'  (store receipt → POST /iap/verify)
//   • plain web browser      → 'paddle'           (Paddle.js checkout → async webhook)
//   • WeChat / CrazyGames    → null               (Coins tab hidden; own channels TODO)
//
// The Swift/Kotlin implementation of the bridge lives in the native shell, out of this
// repo's build — this file only declares the contract the client depends on.

/** Which store a build routes coin-tier purchases to. null = no in-app recharge here. */
export type IapKind = 'paddle' | 'apple' | 'google';

/**
 * Native billing bridge injected on `window` by the Capacitor plugin. When absent,
 * the web bundle is running in a plain browser and recharge falls back to Paddle.
 */
export interface NwBillingBridge {
  /** Which native store this device bills through. */
  readonly kind: 'apple' | 'google';
  /**
   * Run the native purchase UI for a coin tier (e.g. 't499'). Resolves with the store
   * receipt the server verifies via POST /iap/verify { platform: kind, receipt }.
   * Rejects if the user cancels or the purchase fails.
   */
  purchase(tierId: string): Promise<{ receipt: string }>;
  /**
   * The current app-store receipt, or null when the device has none yet (fresh install, never
   * purchased). Used only by the Apple auto-renewable subscription sync (platform/appleSubscriptionSync.ts):
   * a renewal happens inside Apple's systems with no user action, and re-reading the receipt is the
   * only way the app learns about it.
   *
   * Optional because the shell can be older than the JS: OTA hot-updates ship new JS to a native
   * binary that may predate this method (IOS_RELEASE.md §11), so callers must feature-detect rather
   * than assume. Absent bridge method = no sync, which is the pre-2026-09-03 behaviour.
   */
  receipt?(): Promise<string | null>;
}

/** Reads the injected native billing bridge, if any (validated shape). */
export function getNativeBilling(): NwBillingBridge | null {
  const b = (globalThis as { NWBilling?: NwBillingBridge }).NWBilling;
  if (b && typeof b.purchase === 'function' && (b.kind === 'apple' || b.kind === 'google')) return b;
  return null;
}

/**
 * The bridge's receipt reader, when this shell has one. Checked separately from getNativeBilling's
 * shape check on purpose: `receipt` is newer than the bridge itself, so an older binary running
 * OTA-updated JS has a perfectly good bridge with no reader on it. That is not a malformed bridge —
 * purchases still work — it just means this session cannot sync renewals.
 */
export function getNativeReceiptReader(): (() => Promise<string | null>) | null {
  const b = getNativeBilling();
  return b && typeof b.receipt === 'function' ? b.receipt.bind(b) : null;
}
