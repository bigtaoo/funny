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
  delete process.env.NW_APPLE_PASSWORD;
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
  const PW = 'shared-secret';

  it('throws (not ok:false) when verifyReceipt answers with a 5xx', async () => {
    mockFetch(() => Promise.resolve(jsonResp({}, 503)));
    await expect(appleVerify('receipt==', TIER_MAP, PW)).rejects.toThrow(
      'apple verify failed: apple verifyReceipt HTTP 503',
    );
  });

  it('throws when the request itself fails, keeping the original error as `cause`', async () => {
    const net = new Error('ECONNRESET');
    mockFetch(() => Promise.reject(net));
    await expect(appleVerify('receipt==', TIER_MAP, PW)).rejects.toMatchObject({
      message: 'apple verify failed: ECONNRESET',
      cause: net,
    });
  });

  it('throws when the sandbox retry (status 21007) fails too', async () => {
    let call = 0;
    mockFetch(() => {
      call++;
      return Promise.resolve(call === 1 ? jsonResp({ status: 21007 }) : jsonResp({}, 500));
    });
    await expect(appleVerify('receipt==', TIER_MAP, PW)).rejects.toThrow('apple verifyReceipt HTTP 500');
  });

  // Older receipts (and StoreKit responses for non-renewing products) carry the transactions under
  // receipt.in_app instead of the flat latest_receipt_info.
  it('falls back to receipt.in_app when latest_receipt_info is absent', async () => {
    mockFetch(() =>
      Promise.resolve(
        jsonResp({
          status: 0,
          receipt: { in_app: [{ product_id: 'com.nw.coins.t099', transaction_id: 'tx1', purchase_date_ms: '1000' }] },
        }),
      ),
    );
    await expect(appleVerify('receipt==', TIER_MAP, PW)).resolves.toEqual({ ok: true, coins: IAP_TIERS.t099 });
  });

  it('rejects a status-0 receipt that contains no transactions at all', async () => {
    mockFetch(() => Promise.resolve(jsonResp({ status: 0 })));
    await expect(appleVerify('receipt==', TIER_MAP, PW)).resolves.toEqual({ ok: false, coins: 0 });
  });

  it('rejects a status-0 receipt whose in_app list is empty', async () => {
    mockFetch(() => Promise.resolve(jsonResp({ status: 0, receipt: { in_app: [] } })));
    await expect(appleVerify('receipt==', TIER_MAP, PW)).resolves.toEqual({ ok: false, coins: 0 });
  });

  // The "latest transaction" reduce must not depend on the store's ordering: the newest entry wins
  // whether it arrives first or last (iap.test.ts covers last-is-newest).
  it('picks the newest transaction when it is listed FIRST', async () => {
    mockFetch(() =>
      Promise.resolve(
        jsonResp({
          status: 0,
          latest_receipt_info: [
            { product_id: 'com.nw.coins.t999', transaction_id: 'new', purchase_date_ms: '9000' },
            { product_id: 'com.nw.coins.t099', transaction_id: 'old', purchase_date_ms: '1000' },
          ],
        }),
      ),
    );
    await expect(appleVerify('receipt==', TIER_MAP, PW)).resolves.toEqual({ ok: true, coins: IAP_TIERS.t999 });
  });

  it('returns the non-coin SKU (coins:0) for a subscription product_id', async () => {
    mockFetch(() =>
      Promise.resolve(
        jsonResp({
          status: 0,
          latest_receipt_info: [{ product_id: 'com.nw.sub.monthly', transaction_id: 'tx1', purchase_date_ms: '1000' }],
        }),
      ),
    );
    await expect(appleVerify('receipt==', TIER_MAP, PW)).resolves.toEqual({
      ok: true,
      coins: 0,
      product: 'monthly_card',
    });
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
