// Split from iap.ts (2026-08-10, independent function module range 6, part 3/7).
// Apple App Store (StoreKit 1 receipt verification).
import { resolveCoinsFromProductId, resolveNonCoinProduct } from './productResolve';
import type { IapTierMap, IapVerifyResult } from './types';

const APPLE_PROD_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

interface AppleInApp {
  product_id: string;
  transaction_id: string;
  purchase_date_ms: string;
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

  let data: AppleVerifyResponse;
  try {
    data = await applePost(APPLE_PROD_URL, payload);
    if (data.status === 21007) {
      data = await applePost(APPLE_SANDBOX_URL, payload);
    }
  } catch (e) {
    throw new Error(`apple verify failed: ${(e as Error).message}`, { cause: e });
  }

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
