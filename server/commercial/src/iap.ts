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

import { createHmac, createSign, randomBytes } from 'node:crypto';
import type { IAP_TIERS } from '@nw/shared';

export type IapTierMap = typeof IAP_TIERS;

export interface IapVerifyResult {
  ok: boolean;
  coins: number;
}

// ── Product ID → tier mapping ──────────────────────────────────────────────────────

/**
 * Maps an App Store / Google Play product_id to a coin-tier name.
 * Reads NW_IAP_PRODUCT_MAP first (format: `productId:tier,...`);
 * falls back to the built-in default table (bundle prefix can be overridden via NW_IAP_BUNDLE, default com.nw).
 */
function resolveCoinsFromProductId(productId: string, tierMap: IapTierMap): number {
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
  const bundle = process.env.NW_IAP_BUNDLE ?? 'com.nw';
  const DEFAULTS: Record<string, string> = {
    [`${bundle}.coins.small`]: 'small',
    [`${bundle}.coins.mid`]: 'mid',
    [`${bundle}.coins.large`]: 'large',
  };
  const tier = DEFAULTS[productId];
  return tier && tierMap[tier] ? tierMap[tier]! : 0;
}

// ── Apple App Store (StoreKit 1 receipt verification) ─────────────────────────────────

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
async function appleVerify(
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
    throw new Error(`apple verify failed: ${(e as Error).message}`);
  }

  if (data.status !== 0) return { ok: false, coins: 0 };

  // latest_receipt_info is a flat array (containing all renewals/consumables); fall back to receipt.in_app.
  const inApps: AppleInApp[] = data.latest_receipt_info ?? data.receipt?.in_app ?? [];
  if (inApps.length === 0) return { ok: false, coins: 0 };

  // Take the most recent transaction.
  const latest = inApps.reduce((a, b) =>
    Number(a.purchase_date_ms) >= Number(b.purchase_date_ms) ? a : b,
  );
  const coins = resolveCoinsFromProductId(latest.product_id, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins };
}

// ── Google Play（androidpublisher v3）─────────────────────────────────────────

interface GoogleServiceAccount {
  private_key: string;
  client_email: string;
}

/** Build an RS256 JWT from a service-account private key and exchange it for an OAuth2 access token. */
async function getGoogleAccessToken(sa: GoogleServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  ).toString('base64url');
  const sigInput = `${header}.${claim}`;
  const signer = createSign('RSA-SHA256');
  signer.update(sigInput);
  const sig = signer.sign(sa.private_key, 'base64url');
  const jwt = `${sigInput}.${sig}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!resp.ok) throw new Error(`google oauth2 token HTTP ${resp.status}`);
  const json = (await resp.json()) as { access_token?: string };
  if (!json.access_token) throw new Error('google oauth2: no access_token in response');
  return json.access_token;
}

interface GooglePurchase {
  purchaseState?: number; // 0 = purchased
  consumptionState?: number;
  orderId?: string;
}

/**
 * Google Play Purchases.products.get verification.
 * receipt format: `${productId}:${purchaseToken}` (colon-separated)
 * purchaseState === 0 means successfully purchased.
 */
async function googleVerify(
  receipt: string,
  tierMap: IapTierMap,
  sa: GoogleServiceAccount,
  packageName: string,
): Promise<IapVerifyResult> {
  const colonIdx = receipt.indexOf(':');
  if (colonIdx < 0) return { ok: false, coins: 0 };
  const productId = receipt.slice(0, colonIdx);
  const purchaseToken = receipt.slice(colonIdx + 1);
  if (!productId || !purchaseToken) return { ok: false, coins: 0 };

  let accessToken: string;
  try {
    accessToken = await getGoogleAccessToken(sa);
  } catch (e) {
    throw new Error(`google auth failed: ${(e as Error).message}`);
  }

  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${packageName}/purchases/products/${productId}/tokens/${purchaseToken}`;

  let resp: Response;
  try {
    resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (e) {
    throw new Error(`google play fetch failed: ${(e as Error).message}`);
  }

  if (resp.status === 404) return { ok: false, coins: 0 };
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`google play query error ${resp.status}: ${body}`);
  }

  const data = (await resp.json()) as GooglePurchase;
  if (data.purchaseState !== 0) return { ok: false, coins: 0 };

  const coins = resolveCoinsFromProductId(productId, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins };
}

// ── WeChat Pay V3 ─────────────────────────────────────────────────────────────

/**
 * WeChat Pay V3 API-Key HMAC-SHA256 authentication (simplified approach).
 * The full approach requires a merchant RSA private-key signature (WECHATPAY2-SHA256-RSA2048);
 * here we use the V3 APIKey + HMAC scheme to query `v3/pay/transactions/id/{transactionId}`,
 * suitable for small-to-medium projects that do not need certificate management.
 *
 * Environment variables:
 *   NW_WX_PAY_MCH_ID        Merchant ID
 *   NW_WX_PAY_API_KEY_V3    V3 APIKey (32 bytes, generated on the merchant platform)
 *
 * receipt = transaction_id (the unique payment ID in the WeChat Pay system, provided by the wx.requestPayment callback)
 */
async function wxPayVerify(
  transactionId: string,
  tierMap: IapTierMap,
  mchId: string,
  apiKeyV3: string,
): Promise<IapVerifyResult> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString('hex');
  const url = `/v3/pay/transactions/id/${transactionId}?mchid=${mchId}`;
  const message = `GET\n${url}\n${timestamp}\n${nonce}\n\n`;
  const signature = createHmac('sha256', apiKeyV3).update(message).digest('base64');
  const authorization =
    `WECHATPAY2-SHA256-RSA2048 ` +
    `mchid="${mchId}",nonce_str="${nonce}",timestamp="${timestamp}",` +
    `serial_no="NA",signature="${signature}"`;

  const fullUrl = `https://api.mch.weixin.qq.com${url}`;
  let resp: Response;
  try {
    resp = await fetch(fullUrl, {
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'User-Agent': 'NW-server/1.0',
      },
    });
  } catch (e) {
    throw new Error(`wx pay fetch failed: ${(e as Error).message}`);
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`wx pay query error ${resp.status}: ${body}`);
  }
  const data = (await resp.json()) as {
    trade_state?: string;
    amount?: { total?: number; currency?: string };
    transaction_id?: string;
  };

  if (data.trade_state !== 'SUCCESS') return { ok: false, coins: 0 };

  // amount.total is in fen (smallest unit); match to a tier to award the corresponding coins.
  const amountFen = data.amount?.total ?? 0;
  const coins = resolveCoinsFromAmount(amountFen, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins };
}

// ── Stripe ──────────────────────────────────────────────────────────────────

/**
 * Stripe payment intent verification.
 * Environment variable: NW_STRIPE_SECRET_KEY (sk_live_… or sk_test_…)
 *
 * receipt = payment_intent_id (e.g. pi_xxx)
 * amount unit is cents (USD); match to a tier to award coins.
 */
async function stripeVerify(
  paymentIntentId: string,
  tierMap: IapTierMap,
  secretKey: string,
): Promise<IapVerifyResult> {
  let resp: Response;
  try {
    resp = await fetch(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}`, {
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Stripe-Version': '2024-04-10',
      },
    });
  } catch (e) {
    throw new Error(`stripe fetch failed: ${(e as Error).message}`);
  }
  if (resp.status === 404) return { ok: false, coins: 0 };
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`stripe query error ${resp.status}: ${body}`);
  }
  const data = (await resp.json()) as {
    status?: string;
    amount?: number;
    currency?: string;
  };

  if (data.status !== 'succeeded') return { ok: false, coins: 0 };
  const amountCents = data.amount ?? 0;
  const coins = resolveCoinsFromAmount(amountCents, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins };
}

// ── dev stub ───────────────────────────────────────────────────────────────────

function devVerify(receipt: string, tierMap: IapTierMap): IapVerifyResult {
  if (!receipt) return { ok: false, coins: 0 };
  const tier = receipt.startsWith('tier:') ? receipt.slice(5) : 'small';
  const coins = tierMap[tier];
  return coins ? { ok: true, coins } : { ok: true, coins: tierMap['small']! };
}

// ── Tier resolution (by amount) ──────────────────────────────────────────────────────────

/**
 * Reverse-lookup the coin tier from a payment amount (smallest currency unit), shared by WeChat/Stripe.
 * Built-in defaults (WeChat fen / Stripe cents):
 *   600 fen / 99 cents → small (600 coins)
 *   3000 fen / 499 cents → mid (3300 coins)
 *   10000 fen / 1499 cents → large (11800 coins)
 */
function resolveCoinsFromAmount(amount: number, tierMap: IapTierMap): number {
  const raw = process.env.NW_IAP_AMOUNT_MAP;
  if (raw) {
    for (const pair of raw.split(',')) {
      const [a, t] = pair.trim().split(':');
      if (Number(a) === amount && t && tierMap[t]) return tierMap[t]!;
    }
    return 0;
  }
  const DEFAULTS: [number, string][] = [
    [99, 'small'], [600, 'small'],
    [499, 'mid'], [3000, 'mid'],
    [1499, 'large'], [10000, 'large'],
  ];
  for (const [a, tier] of DEFAULTS) {
    if (a === amount && tierMap[tier]) return tierMap[tier]!;
  }
  return 0;
}

// ── Factory ─────────────────────────────────────────────────────────────────────

export type VerifyReceipt = (platform: string, receipt: string) => Promise<IapVerifyResult>;

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

  return async (platform: string, receipt: string): Promise<IapVerifyResult> => {
    if (
      devEnabled &&
      (platform === 'dev' || platform.startsWith('dev-') || receipt.startsWith('tier:'))
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
}
