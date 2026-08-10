// Split from iap.ts (2026-08-10, independent function module range 6, part 4/7).
// Google Play (androidpublisher v3).
import { createSign } from 'node:crypto';
import { resolveCoinsFromProductId, resolveNonCoinProduct } from './productResolve';
import type { IapTierMap, IapVerifyResult } from './types';

export interface GoogleServiceAccount {
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
export async function googleVerify(
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

  const product = resolveNonCoinProduct(productId);
  if (product) return { ok: true, coins: 0, product };
  const coins = resolveCoinsFromProductId(productId, tierMap);
  if (coins === 0) return { ok: false, coins: 0 };
  return { ok: true, coins };
}
