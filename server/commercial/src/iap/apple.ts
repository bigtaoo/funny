// Apple App Store verification (2026-09-07: App Store Server API, replacing the deprecated
// verifyReceipt endpoint and its shared secret).
//
// The transport, credentials, environment fallback and signature verification all live in
// appleServerApi.ts. What is left here is the part that is ours rather than Apple's: turning a
// verified transaction into "how many coins / which SKU", using the same productId conventions every
// other platform verifier shares (productResolve.ts).
//
// ── What the caller passes in ──
// `receiptOrTransactionId` is whatever the client sent. Today's shipped iOS binary is StoreKit 1 and
// sends a base64 app receipt, so it is unwrapped locally to a transaction id first; a StoreKit 2
// client (IOS_RELEASE.md §6, phase B) will send a bare transaction id and skip that step. Both work
// without a flag, which is what lets the server migrate ahead of the app.
import { resolveCoinsFromProductId, resolveNonCoinProduct } from './productResolve';
import { transactionIdFromReceipt, type AppleServerApi, type AppleTransaction } from './appleServerApi';
import type { AppleSubscriptionTx, IapTierMap, IapVerifyResult } from './types';

/** Accept either form: a StoreKit 1 receipt blob to unwrap, or an already-bare transaction id. */
function toTransactionId(receiptOrTransactionId: string): string {
  return transactionIdFromReceipt(receiptOrTransactionId) ?? receiptOrTransactionId;
}

/**
 * Verify one Apple purchase and resolve what it bought.
 *
 * Fails closed on everything: an id Apple does not know, a revoked/refunded transaction, or a product
 * id that maps to neither a coin tier nor a known SKU all return `ok: false` and grant nothing.
 */
export async function appleVerify(
  receiptOrTransactionId: string,
  tierMap: IapTierMap,
  api: AppleServerApi,
): Promise<IapVerifyResult> {
  const tx = await api.verifyTransaction(toTransactionId(receiptOrTransactionId));
  if (!tx) return { ok: false, coins: 0 };
  // Apple already took the money back — granting here would be paying for a refund out of our pocket.
  if (tx.revoked) return { ok: false, coins: 0 };

  const product = resolveNonCoinProduct(tx.productId);
  if (product) {
    return { ok: true, coins: 0, product, originalTransactionId: tx.originalTransactionId };
  }
  const coins = resolveCoinsFromProductId(tx.productId, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins, originalTransactionId: tx.originalTransactionId };
}

/** The two SKUs that renew; anything else in a history is not a subscription period. */
function subscriptionProductOf(tx: AppleTransaction): 'monthly_card' | 'year_card' | null {
  const product = resolveNonCoinProduct(tx.productId);
  return product === 'monthly_card' || product === 'year_card' ? product : null;
}

/**
 * Every auto-renewable subscription period Apple has on file for this purchase, oldest first.
 *
 * Used by the cold-start sync (IOS_RELEASE.md §4.1b) as the reconciliation net behind the
 * notification webhook: a renewal normally arrives as a DID_RENEW notification, and this catches the
 * ones a delivery failure or a downtime window lost. Each period is granted under
 * `apple:<transactionId>` and subscriptionCardBuy is idempotent on that, so overlap between the two
 * paths is free — the same period arriving twice grants once.
 *
 * Refunded/revoked periods are dropped. Returns [] rather than throwing for any input Apple rejects:
 * the caller runs unprompted at boot, so there is nobody to show an error to.
 */
export async function appleSubscriptionTransactions(
  receiptOrTransactionId: string,
  api: AppleServerApi,
): Promise<AppleSubscriptionTx[]> {
  const history = await api
    .transactionHistory(toTransactionId(receiptOrTransactionId))
    .catch(() => [] as AppleTransaction[]);

  const out: AppleSubscriptionTx[] = [];
  for (const tx of history) {
    if (tx.revoked) continue;
    const product = subscriptionProductOf(tx);
    if (!product) continue;
    out.push({
      transactionId: tx.transactionId,
      originalTransactionId: tx.originalTransactionId,
      product,
      purchasedMs: tx.purchasedMs,
    });
  }
  // Oldest first: periods are granted in the order they were paid for, so a long-dormant account's
  // first sync extends the subscription in the sequence the player actually bought it. Apple returns
  // its history newest-first, so this is a real reordering, not a formality.
  out.sort((a, b) => a.purchasedMs - b.purchasedMs);
  return out;
}
