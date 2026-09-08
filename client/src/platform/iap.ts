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
 * One store transaction the native layer received OUTSIDE a purchase() call and has not been told to
 * finish yet: an Ask-to-Buy approval, a restore on another device, a renewal, or anything a previous
 * install left unreported (iOS/StoreKit 2 only — AppDelegate.swift's Transaction.updates listener).
 *
 * `productKey` is the key this code base names the product by ('t499', 'monthly_card', …), not
 * Apple's product id — the native side owns that mapping, so the reporting side can route by key
 * without duplicating the table (platform/appleUnfinishedTransactions.ts).
 */
export interface NativePendingTx {
  transactionId: string;
  productKey: string;
}

/**
 * Native billing bridge injected on `window` by the Capacitor plugin. When absent,
 * the web bundle is running in a plain browser and recharge falls back to Paddle.
 */
export interface NwBillingBridge {
  /** Which native store this device bills through. */
  readonly kind: 'apple' | 'google';
  /**
   * Run the native purchase UI for a coin tier (e.g. 't499') or a non-coin product key. Resolves
   * with the value the server verifies via POST /iap/verify { platform: kind, receipt }: a store
   * receipt on Google / older iOS binaries, a bare Apple transaction id on a StoreKit 2 one — the
   * server accepts either, which is why this field name did not have to change with the client.
   * Rejects if the user cancels or the purchase fails.
   *
   * `appAccountToken` (iOS, optional) is the UUID /bootstrap handed out for this account. Attaching
   * it is what lets a later renewal notification name its owner even if this purchase is never
   * reported. An older native binary ignores the argument, so callers pass it unconditionally.
   */
  purchase(tierId: string, appAccountToken?: string): Promise<{ receipt: string }>;
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
  /**
   * Transactions the store delivered outside a purchase() call and is still waiting to have
   * finished. Optional for the same reason as `receipt`: an OTA JS update can be running on a native
   * binary that predates it (IOS_RELEASE.md §11), and a bridge without it is not broken — it is a
   * StoreKit 1 shell, where these arrived through the purchase path or not at all.
   */
  pending?(): Promise<NativePendingTx[]>;
  /**
   * Tell the store the content for `transactionId` was delivered, so it stops redelivering it.
   *
   * Only ever called after the SERVER confirms the grant. That ordering is the whole point of having
   * this as a separate call: a transaction finished before the server knows about it is money taken
   * for content nothing will ever deliver, with no record anywhere that it happened.
   */
  finish?(transactionId: string): Promise<void>;
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

/**
 * The bridge's unfinished-transaction reader, when this shell has one (StoreKit 2 binaries only).
 * Feature-detected separately from the bridge itself — see NwBillingBridge.pending's doc comment.
 */
export function getNativePendingReader(): (() => Promise<NativePendingTx[]>) | null {
  const b = getNativeBilling();
  return b && typeof b.pending === 'function' ? b.pending.bind(b) : null;
}

/**
 * Tell the store a transaction's content was delivered. Resolves to false when this shell has no
 * `finish` (a StoreKit 1 binary, which finished the transaction itself at purchase time) or when the
 * call fails — neither is worth failing a purchase the server has already granted.
 */
export async function finishNativeTransaction(transactionId: string): Promise<boolean> {
  const b = getNativeBilling();
  if (!b || typeof b.finish !== 'function') return false;
  try {
    await b.finish(transactionId);
    return true;
  } catch {
    // The store keeps the transaction and offers it again next launch; the grant already happened
    // and is idempotent, so the worst case is one redundant report later.
    return false;
  }
}
