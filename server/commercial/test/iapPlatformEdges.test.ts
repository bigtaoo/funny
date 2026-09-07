// Apple/Google/Stripe verifier failure paths + createReceiptVerifier's credential gates.
//
// iap.test.ts drives the happy paths and the "credential absent" gates for apple/google;
// iapWechatStripe.test.ts does the same for the other two. What was left unexecuted (apple 58.82%,
// google 66.66% branches — claudedocs/server-testing-coverage.md) is everything that happens when the
// STORE misbehaves: a 5xx from Apple, a socket error mid-verify, an OAuth response with no token, a
// receipt whose in_app list is empty or lives under the legacy key, a product_id that is a subscription
// rather than a coin tier.
//
// Two invariants run through all of it, and both matter for money:
//   • an inconclusive verification must THROW, not return ok:false. rechargeVerify maps ok:false to
//     INVALID_RECEIPT — a permanent "your receipt is fake" the client never retries — while a thrown
//     error surfaces as a 400/INTERNAL_ERROR the caller can retry once the store is back. Turning "Apple
//     had a bad minute" into "your purchase is invalid" costs a paying player their coins.
//   • a non-coin SKU (subscription card / starter pack) must come back as `{ok:true, coins:0, product}`,
//     never as coins. That `product` is what verifyNonCoinReceipt matches against the caller's expected
//     SKU, so a monthly-card receipt cannot be replayed to claim a starter pack.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { IAP_TIERS } from '@nw/shared';
import { appleVerify } from '../src/iap/apple';
import type { AppleServerApi, AppleTransaction } from '../src/iap/appleServerApi';
import { APIException } from '@apple/app-store-server-library';
import { fakeAppleApi, tx } from './appleFakes';
import { googleVerify, type GoogleServiceAccount } from '../src/iap/google';
import { stripeVerify } from '../src/iap/stripe';
import { createReceiptVerifier } from '../src/iap';

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

function mockFetch(impl: FetchMock): void {
  vi.stubGlobal('fetch', impl);
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const TIER_MAP = IAP_TIERS;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.NW_GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.NW_GOOGLE_PACKAGE_NAME;
  delete process.env.NW_WX_PAY_MCH_ID;
  delete process.env.NW_WX_PAY_API_KEY_V3;
  delete process.env.NW_STRIPE_SECRET_KEY;
  delete process.env.NW_IAP_BUNDLE;
  delete process.env.NW_IAP_PRODUCT_MAP;
  delete process.env.NW_IAP_DEV;
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

// ── Apple ────────────────────────────────────────────────────────────────────
describe('appleVerify — the App Store misbehaving', () => {
  // 2026-09-07: rewritten for the App Store Server API. Several old cases were deleted rather than
  // translated because the shapes they guarded against cannot occur any more: `getTransactionInfo(id)`
  // answers with exactly one transaction, so there is no in_app/latest_receipt_info fallback, no empty
  // transaction list, and no "pick the newest of several" reduce to get wrong. What survives is the
  // invariant at the top of this file, which the new transport makes just as easy to break.

  const oneTx = (over: Partial<AppleTransaction> = {}) =>
    fakeAppleApi({ transactions: [tx({ transactionId: 'tx1', productId: 'com.nw.coins.t099', ...over })] });

  /** An API whose lookup fails the way a struggling App Store does. */
  function failingApi(err: unknown): AppleServerApi {
    const api = fakeAppleApi({});
    api.verifyTransaction = async () => { throw err; };
    return api;
  }

  it('throws (not ok:false) when Apple answers with a 5xx', async () => {
    // The distinction this file exists for: ok:false becomes a permanent INVALID_RECEIPT the client
    // never retries, so "Apple had a bad minute" must not be reported as "your purchase is fake".
    const api = failingApi(new APIException(503));
    await expect(appleVerify('tx1', TIER_MAP, api)).rejects.toBeInstanceOf(APIException);
  });

  it('throws when the request itself fails', async () => {
    const net = new Error('ECONNRESET');
    await expect(appleVerify('tx1', TIER_MAP, failingApi(net))).rejects.toThrow('ECONNRESET');
  });

  it('returns ok:false — not a throw — for an id Apple genuinely does not have', async () => {
    // The one case where a negative answer IS conclusive: both environments agree the id is unknown.
    await expect(appleVerify('nope', TIER_MAP, fakeAppleApi({}))).resolves.toEqual({ ok: false, coins: 0 });
  });

  it('rejects a revoked transaction rather than granting it again', async () => {
    process.env.NW_IAP_BUNDLE = 'com.nw';
    await expect(appleVerify('tx1', TIER_MAP, oneTx({ revoked: true }))).resolves.toEqual({ ok: false, coins: 0 });
  });

  it('returns the non-coin SKU (coins:0) for a subscription product id', async () => {
    process.env.NW_IAP_BUNDLE = 'com.nw';
    await expect(
      appleVerify('tx1', TIER_MAP, oneTx({ productId: 'com.nw.sub.monthly', originalTransactionId: 'o1' })),
    ).resolves.toEqual({ ok: true, coins: 0, product: 'monthly_card', originalTransactionId: 'o1' });
  });
});

// ── Google Play ──────────────────────────────────────────────────────────────
describe('googleVerify — malformed receipts and a misbehaving Google', () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const SA: GoogleServiceAccount = { private_key: privateKey as unknown as string, client_email: 'svc@nw.iam' };
  const PKG = 'com.nw.game';
  const OAUTH = 'https://oauth2.googleapis.com/token';

  /** Answers the OAuth token exchange, then hands the Play query to `play`. */
  function mockGoogle(play: FetchMock, token: () => Promise<Response> = () => Promise.resolve(jsonResp({ access_token: 'tok' }))) {
    mockFetch((url, init) => (url === OAUTH ? token() : play(url, init)));
  }

  it('rejects a receipt whose purchase token half is empty', async () => {
    mockFetch(() => Promise.reject(new Error('must not be called')));
    await expect(googleVerify('com.nw.coins.t099:', TIER_MAP, SA, PKG)).resolves.toEqual({ ok: false, coins: 0 });
  });

  it('rejects a receipt whose product id half is empty', async () => {
    mockFetch(() => Promise.reject(new Error('must not be called')));
    await expect(googleVerify(':token-only', TIER_MAP, SA, PKG)).resolves.toEqual({ ok: false, coins: 0 });
  });

  it('throws when the OAuth token exchange answers non-2xx', async () => {
    mockGoogle(() => Promise.resolve(jsonResp({})), () => Promise.resolve(jsonResp({ error: 'invalid_grant' }, 401)));
    await expect(googleVerify('com.nw.coins.t099:tok', TIER_MAP, SA, PKG)).rejects.toThrow(
      'google auth failed: google oauth2 token HTTP 401',
    );
  });

  it('throws when the OAuth response carries no access_token', async () => {
    mockGoogle(() => Promise.resolve(jsonResp({})), () => Promise.resolve(jsonResp({ token_type: 'Bearer' })));
    await expect(googleVerify('com.nw.coins.t099:tok', TIER_MAP, SA, PKG)).rejects.toThrow(
      'google auth failed: google oauth2: no access_token in response',
    );
  });

  it('throws when the purchase query request itself fails', async () => {
    const net = new Error('ETIMEDOUT');
    mockGoogle(() => Promise.reject(net));
    await expect(googleVerify('com.nw.coins.t099:tok', TIER_MAP, SA, PKG)).rejects.toMatchObject({
      message: 'google play fetch failed: ETIMEDOUT',
      cause: net,
    });
  });

  // 404 is a verdict ("no such purchase" → invalid receipt); any other non-2xx is inconclusive and must
  // throw, carrying the body so the operator can see what Google actually said.
  it('throws with the response body on a non-404 error status', async () => {
    mockGoogle(() => Promise.resolve(new Response('quota exceeded', { status: 429 })));
    await expect(googleVerify('com.nw.coins.t099:tok', TIER_MAP, SA, PKG)).rejects.toThrow(
      'google play query error 429: quota exceeded',
    );
  });

  it('returns the non-coin SKU (coins:0) for a starter-pack product_id', async () => {
    mockGoogle((url) => {
      expect(url).toContain(`${PKG}/purchases/products/com.nw.starter.growth/tokens/tok`);
      return Promise.resolve(jsonResp({ purchaseState: 0 }));
    });
    await expect(googleVerify('com.nw.starter.growth:tok', TIER_MAP, SA, PKG)).resolves.toEqual({
      ok: true,
      coins: 0,
      product: 'starter_growth',
    });
  });
});

// ── Stripe ───────────────────────────────────────────────────────────────────
describe('stripeVerify — succeeded intent with no amount', () => {
  it('treats a missing amount as 0 and rejects rather than matching a tier', async () => {
    mockFetch(() => Promise.resolve(jsonResp({ status: 'succeeded' })));
    await expect(stripeVerify('pi_1', TIER_MAP, 'sk_test_x')).resolves.toEqual({ ok: false, coins: 0 });
  });
});

// ── createReceiptVerifier dispatch ───────────────────────────────────────────
describe('createReceiptVerifier — per-platform credential gates', () => {
  it('logs and disables Google Play when the service-account JSON does not parse', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.NW_GOOGLE_SERVICE_ACCOUNT_JSON = '{ this is not json';
    const verify = createReceiptVerifier(TIER_MAP);
    expect(err).toHaveBeenCalledWith('NW_GOOGLE_SERVICE_ACCOUNT_JSON parse error — Google Play disabled');
    // Fail closed: a deployment with a broken credential must not award coins, and must not silently
    // fall back to the dev stub either (the stub is off here because a credential IS configured).
    await expect(verify('google', 'com.nw.coins.t099:tok')).resolves.toEqual({ ok: false, coins: 0 });
  });

  it('rejects wechat when only half the WeChat Pay credentials are configured', async () => {
    process.env.NW_WX_PAY_MCH_ID = 'mch_1'; // NW_WX_PAY_API_KEY_V3 deliberately absent
    const verify = createReceiptVerifier(TIER_MAP);
    await expect(verify('wechat', 'wx_txn_1')).resolves.toEqual({ ok: false, coins: 0 });
  });

  it('dispatches to WeChat Pay once both credentials are present', async () => {
    process.env.NW_WX_PAY_MCH_ID = 'mch_1';
    process.env.NW_WX_PAY_API_KEY_V3 = 'key_v3';
    process.env.NW_IAP_AMOUNT_MAP = `3000:t499`;
    mockFetch((url) => {
      expect(url).toContain('api.mch.weixin.qq.com');
      return Promise.resolve(jsonResp({ trade_state: 'SUCCESS', amount: { total: 3000 } }));
    });
    const verify = createReceiptVerifier(TIER_MAP);
    await expect(verify('wechat', 'wx_txn_1')).resolves.toEqual({
      ok: true,
      coins: IAP_TIERS.t499,
      usdCents: 499,
    });
    delete process.env.NW_IAP_AMOUNT_MAP;
  });

  it('rejects stripe when NW_STRIPE_SECRET_KEY is absent', async () => {
    process.env.NW_APPLE_PASSWORD = 'pw'; // some credential exists, so the dev stub stays off
    const verify = createReceiptVerifier(TIER_MAP);
    await expect(verify('stripe', 'pi_1')).resolves.toEqual({ ok: false, coins: 0 });
  });

  it('dispatches to Stripe once the secret key is present', async () => {
    process.env.NW_STRIPE_SECRET_KEY = 'sk_test_x';
    mockFetch((url) => {
      expect(url).toContain('api.stripe.com/v1/payment_intents/pi_1');
      return Promise.resolve(jsonResp({ status: 'succeeded', amount: 499, currency: 'usd' }));
    });
    const verify = createReceiptVerifier(TIER_MAP);
    await expect(verify('stripe', 'pi_1')).resolves.toEqual({ ok: true, coins: IAP_TIERS.t499, usdCents: 499 });
  });

  it('rejects an unknown platform outright', async () => {
    process.env.NW_APPLE_PASSWORD = 'pw';
    const verify = createReceiptVerifier(TIER_MAP);
    await expect(verify('nintendo', 'whatever')).resolves.toEqual({ ok: false, coins: 0 });
  });
});
