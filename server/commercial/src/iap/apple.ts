// Split from iap.ts (2026-08-10, independent function module range 6, part 3/7).
// Apple App Store (StoreKit 1 receipt verification).
import { resolveCoinsFromProductId, resolveNonCoinProduct } from './productResolve';
import type { AppleSubscriptionTx, IapTierMap, IapVerifyResult } from './types';

const APPLE_PROD_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

interface AppleInApp {
  product_id: string;
  transaction_id: string;
  purchase_date_ms: string;
  /** Auto-renewable subscriptions only: when this period ends. Absent on consumables. */
  expires_date_ms?: string;
  /** Set when Apple refunded or revoked the transaction — such a period must not be granted. */
  cancellation_date_ms?: string;
}

interface AppleVerifyResponse {
  status: number;
  receipt?: { in_app?: AppleInApp[] };
  latest_receipt_info?: AppleInApp[];
}

async function applePost(url: string, body: object): Promise<AppleVerifyResponse> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`apple verifyReceipt HTTP ${resp.status}`);
  return (await resp.json()) as AppleVerifyResponse;
}

/** POST to production, retrying against sandbox on 21007 (a sandbox receipt sent to prod). */
async function appleVerifyReceipt(payload: object): Promise<AppleVerifyResponse> {
  try {
    const data = await applePost(APPLE_PROD_URL, payload);
    return data.status === 21007 ? await applePost(APPLE_SANDBOX_URL, payload) : data;
  } catch (e) {
    throw new Error(`apple verify failed: ${(e as Error).message}`, { cause: e });
  }
}

/**
 * Apple StoreKit 1 receipt verification.
 * When prod returns 21007 (sandbox receipt), automatically retries the sandbox endpoint.
 * Takes the latest entry from in_app[] (sorted by purchase_date_ms descending) and maps its product_id to coins.
 */
export async function appleVerify(
  receiptData: string,
  tierMap: IapTierMap,
  password: string,
): Promise<IapVerifyResult> {
  const payload = {
    'receipt-data': receiptData,
    password,
    'exclude-old-transactions': true,
  };

  const data = await appleVerifyReceipt(payload);
  if (data.status !== 0) return { ok: false, coins: 0 };

  // latest_receipt_info is a flat array (containing all renewals/consumables); fall back to receipt.in_app.
  const inApps: AppleInApp[] = data.latest_receipt_info ?? data.receipt?.in_app ?? [];
  if (inApps.length === 0) return { ok: false, coins: 0 };

  // Take the most recent transaction.
  const latest = inApps.reduce((a, b) =>
    Number(a.purchase_date_ms) >= Number(b.purchase_date_ms) ? a : b,
  );
  const product = resolveNonCoinProduct(latest.product_id);
  if (product) return { ok: true, coins: 0, product };
  const coins = resolveCoinsFromProductId(latest.product_id, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins };
}

/**
 * Every auto-renewable subscription period in an Apple receipt, for the launch-time sync
 * (IOS_RELEASE.md §4.1b). Distinct from `appleVerify` above in two ways that both matter:
 *
 *  • It asks for the FULL history (`exclude-old-transactions` unset). `appleVerify` answers "what did
 *    this receipt just buy", so the newest transaction is the whole answer; a sync answers "which
 *    periods has this player paid for that we have not granted yet", and a player who did not open
 *    the app for three months has three renewals sitting in the receipt. Excluding old transactions
 *    there would silently under-grant, and the player has no way to notice or complain about days
 *    they were never told about.
 *  • It returns every transaction rather than a resolved product, because each one is granted
 *    separately and idempotently under `apple:<transactionId>` (subscriptionCardBuy is keyed by
 *    orderId), which is what makes calling this on every cold start safe.
 *
 * Cancelled/refunded periods are dropped: `cancellation_date_ms` is Apple telling us it took the
 * money back, so granting the days would be paying for a refund out of our own pocket.
 * Returns [] for any receipt Apple does not accept — fail closed, same posture as appleVerify.
 */
export async function appleSubscriptionTransactions(
  receiptData: string,
  password: string,
): Promise<AppleSubscriptionTx[]> {
  const data = await appleVerifyReceipt({ 'receipt-data': receiptData, password });
  if (data.status !== 0) return [];

  const rows = data.latest_receipt_info ?? data.receipt?.in_app ?? [];
  const out: AppleSubscriptionTx[] = [];
  for (const row of rows) {
    if (row.cancellation_date_ms) continue;
    const product = resolveNonCoinProduct(row.product_id);
    if (product !== 'monthly_card' && product !== 'year_card') continue;
    out.push({
      transactionId: row.transaction_id,
      product,
      purchasedMs: Number(row.purchase_date_ms) || 0,
    });
  }
  // Oldest first: the periods are granted in the order they were paid for, so a first-ever sync of a
  // long-dormant account extends the subscription in the same sequence the player actually bought.
  out.sort((a, b) => a.purchasedMs - b.purchasedMs);
  return out;
}
