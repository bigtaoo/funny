// C1: Apple App Store + Google Play IAP receipt verification unit tests.
// Coverage: valid receipt mapped to coins, forged receipt rejected, sandbox retry, Google purchaseState non-zero, dev stub.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { IAP_TIERS, DEV_STUB_DEFAULT_TIER } from '@nw/shared';
import { createReceiptVerifier } from '../src/iap';
import { appleVerify } from '../src/iap/apple';
import type { AppleTransaction } from '../src/iap/appleServerApi';
import { fakeAppleApi, tx } from './appleFakes';

// Exercise the real canonical tier map so the built-in `${bundle}.coins.<tierId>` convention is validated end to end.
const TIER_MAP = IAP_TIERS;
const BUNDLE = 'com.nw';

// ── fetch mock utilities ──────────────────────────────────────────────────────────

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

function mockFetch(impl: FetchMock) {
  vi.stubGlobal('fetch', impl);
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  vi.unstubAllGlobals();
  // clear environment variables that may have been set during a test
  delete process.env.NW_APPLE_IAP_KEY_ID;
  delete process.env.NW_APPLE_IAP_ISSUER_ID;
  delete process.env.NW_APPLE_IAP_PRIVATE_KEY_BASE64;
  delete process.env.NW_APPLE_APP_ID;
  delete process.env.NW_GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.NW_GOOGLE_PACKAGE_NAME;
  delete process.env.NW_IAP_BUNDLE;
  delete process.env.NW_IAP_PRODUCT_MAP;
  delete process.env.NW_IAP_DEV;
  delete process.env.NW_STRIPE_SECRET_KEY;
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

// ── Apple ────────────────────────────────────────────────────────────────────

describe('apple verify', () => {
  // 2026-09-07: verifyReceipt (one HTTP POST authenticated by a shared secret) was replaced by the
  // App Store Server API, so these no longer stub `fetch` — the transport, the JWT and the signature
  // check are all Apple's library's job now. What is still ours, and what these cover, is which
  // verified transaction becomes how many coins.
  const api = (transactions: AppleTransaction[]) => fakeAppleApi({ transactions });

  it('returns coins for a coin-tier product', async () => {
    process.env.NW_IAP_BUNDLE = BUNDLE;
    const result = await appleVerify('tx1', TIER_MAP, api([tx({ transactionId: 'tx1', productId: 'com.nw.coins.t099' })]));
    expect(result).toEqual({ ok: true, coins: IAP_TIERS.t099, originalTransactionId: 'tx1' });
  });

  it('returns the non-coin SKU (coins:0) plus the id renewals will be routed by', async () => {
    process.env.NW_IAP_BUNDLE = BUNDLE;
    const result = await appleVerify(
      'tx2',
      TIER_MAP,
      api([tx({ transactionId: 'tx2', originalTransactionId: 'orig-9', productId: 'com.nw.sub.monthly' })]),
    );
    expect(result).toEqual({ ok: true, coins: 0, product: 'monthly_card', originalTransactionId: 'orig-9' });
  });

  it('rejects a revoked transaction — Apple already took the money back', async () => {
    process.env.NW_IAP_BUNDLE = BUNDLE;
    const result = await appleVerify(
      'tx3',
      TIER_MAP,
      api([tx({ transactionId: 'tx3', productId: 'com.nw.coins.t099', revoked: true })]),
    );
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('rejects an id Apple does not recognise', async () => {
    const result = await appleVerify('never-existed', TIER_MAP, api([]));
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('rejects an unknown product id', async () => {
    process.env.NW_IAP_BUNDLE = BUNDLE;
    const result = await appleVerify(
      'tx4',
      TIER_MAP,
      api([tx({ transactionId: 'tx4', productId: 'com.unknown.product' })]),
    );
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('supports custom product map via NW_IAP_PRODUCT_MAP', async () => {
    process.env.NW_IAP_PRODUCT_MAP = 'custom.product.gold:t9999';
    const result = await appleVerify(
      'txC',
      TIER_MAP,
      api([tx({ transactionId: 'txC', productId: 'custom.product.gold' })]),
    );
    expect(result).toMatchObject({ ok: true, coins: IAP_TIERS.t9999 });
  });

  it('returns ok:false when Apple is unconfigured', async () => {
    // No NW_APPLE_IAP_* credentials -> createAppleServerApi() is null -> the apple branch fails closed,
    // exactly as it did when the shared secret was missing.
    process.env.NW_IAP_DEV = 'false';
    const verify = createReceiptVerifier(TIER_MAP);
    expect(await verify('apple', 'base64receipt==')).toEqual({ ok: false, coins: 0 });
  });
});

// ── Google Play ──────────────────────────────────────────────────────────────

// RSA 2048 key pair for testing (generateKeyPairSync ensures valid format).
let FAKE_SA = '';
beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  FAKE_SA = JSON.stringify({
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    client_email: 'test@project.iam.gserviceaccount.com',
  });
});

describe('google verify', () => {
  function makeVerifier() {
    process.env.NW_GOOGLE_SERVICE_ACCOUNT_JSON = FAKE_SA;
    process.env.NW_GOOGLE_PACKAGE_NAME = 'com.nw.game';
    process.env.NW_IAP_BUNDLE = BUNDLE;
    return createReceiptVerifier(TIER_MAP);
  }

  it('returns coins for valid purchase (purchaseState=0)', async () => {
    mockFetch((url, init) => {
      if (url.includes('oauth2.googleapis.com')) {
        // JWT signing may fail with a dummy key, but the mock returns a token directly
        return Promise.resolve(jsonResp({ access_token: 'fake-token' }));
      }
      expect(url).toContain('com.nw.coins.t499');
      expect((init?.headers as Record<string, string>)?.['Authorization']).toBe('Bearer fake-token');
      return Promise.resolve(jsonResp({ purchaseState: 0, orderId: 'GPA.123' }));
    });

    const verify = makeVerifier();
    const result = await verify('google', 'com.nw.coins.t499:purchase-token-xyz');
    expect(result).toEqual({ ok: true, coins: IAP_TIERS.t499, usdCents: 499 });
  });

  it('rejects when purchaseState !== 0', async () => {
    mockFetch((url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return Promise.resolve(jsonResp({ access_token: 'fake-token' }));
      }
      return Promise.resolve(jsonResp({ purchaseState: 2 })); // cancelled
    });

    const verify = makeVerifier();
    const result = await verify('google', 'com.nw.coins.t099:token-cancelled');
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('rejects 404 purchase token (invalid token)', async () => {
    mockFetch((url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return Promise.resolve(jsonResp({ access_token: 'fake-token' }));
      }
      return Promise.resolve(jsonResp({ error: 'not found' }, 404));
    });

    const verify = makeVerifier();
    const result = await verify('google', 'com.nw.coins.t9999:invalid-token');
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('rejects malformed receipt (no colon separator)', async () => {
    const verify = makeVerifier();
    const result = await verify('google', 'nocolonseparator');
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('rejects unknown product_id', async () => {
    mockFetch((url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return Promise.resolve(jsonResp({ access_token: 'fake-token' }));
      }
      return Promise.resolve(jsonResp({ purchaseState: 0 }));
    });

    const verify = makeVerifier();
    const result = await verify('google', 'com.unknown.product:valid-token');
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('returns ok:false when NW_GOOGLE_SERVICE_ACCOUNT_JSON not set', async () => {
    process.env.NW_IAP_DEV = 'false';
    const verify = createReceiptVerifier(TIER_MAP);
    const result = await verify('google', 'com.nw.coins.t099:token');
    expect(result).toEqual({ ok: false, coins: 0 });
  });
});

// ── dev stub ───────────────────────────────────────────────────────────────────

describe('dev stub', () => {
  it('returns coins for tier: prefix receipt when all credentials missing', async () => {
    process.env.NW_IAP_DEV = 'false'; // dev stub auto-enabled when no credentials present
    const verify = createReceiptVerifier(TIER_MAP);
    expect(await verify('apple', 'tier:t099')).toEqual({ ok: true, coins: IAP_TIERS.t099, usdCents: 99 });
    expect(await verify('google', 'tier:t9999')).toEqual({ ok: true, coins: IAP_TIERS.t9999, usdCents: 9999 });
    expect(await verify('dev', 'tier:t499')).toEqual({ ok: true, coins: IAP_TIERS.t499, usdCents: 499 });
  });

  it('grants the default tier for a receipt with no tier: prefix (E2E topup_ path)', async () => {
    // Regression guard: the dev stub's fallback tier must be a real key of IAP_TIERS.
    // The feat(iap) retier (small/mid/large → t099…t9999) previously left the fallback
    // pointing at the removed `small` tier, so `topup_*` receipts resolved to undefined coins.
    process.env.NW_IAP_DEV = 'false';
    const verify = createReceiptVerifier(IAP_TIERS);
    const expected = IAP_TIERS[DEV_STUB_DEFAULT_TIER];
    expect(expected).toBeGreaterThan(0);
    expect(await verify('dev', 'topup_abc123')).toEqual({ ok: true, coins: expected, usdCents: 499 });
  });

  it('dev stub disabled when real credentials present and NW_IAP_DEV not set', async () => {
    // Any one configured platform closes the stub for ALL platforms — the gate asks "is this a real
    // deployment", not "is this platform configured". Stripe is used as that signal here rather than
    // Apple so the assertion stays offline: configuring Apple for real would send the `tier:` receipt
    // to Apple's servers, which is a network call, not a unit test.
    process.env.NW_STRIPE_SECRET_KEY = 'sk_test_real';
    const verify = createReceiptVerifier(TIER_MAP);
    // `tier:` no longer routes through the stub; apple with no Apple credentials fails closed.
    const result = await verify('apple', 'tier:t099');
    expect(result).toEqual({ ok: false, coins: 0 });
  });
});

// ── usdCents attachment (GACHA_DESIGN §13, ADR-045) ───────────────────────────────
// createReceiptVerifier wraps every platform branch's result once at the end (reverse-mapping the
// resolved coin amount back to a tier's usdCents), so this is exercised regardless of which
// platform resolved the tier — a dedicated case here documents the behavior explicitly rather than
// relying only on the incidental `usdCents` field in the tests above.

describe('usdCents attachment', () => {
  it('failed verification never carries a usdCents field', async () => {
    process.env.NODE_ENV = 'production'; // forcibly disables the dev stub (L2-3) so 'apple' with no credentials fails closed
    const verify = createReceiptVerifier(TIER_MAP);
    const result = await verify('apple', 'tier:t099');
    expect(result).toEqual({ ok: false, coins: 0 });
    expect('usdCents' in result).toBe(false);
  });

  it('usdCents matches the resolved tier, not a hardcoded value, across different tiers', async () => {
    const verify = createReceiptVerifier(TIER_MAP);
    expect(await verify('dev', 'tier:t199')).toEqual({ ok: true, coins: IAP_TIERS.t199, usdCents: 199 });
    expect(await verify('dev', 'tier:t1999')).toEqual({ ok: true, coins: IAP_TIERS.t1999, usdCents: 1999 });
    expect(await verify('dev', 'tier:t4999')).toEqual({ ok: true, coins: IAP_TIERS.t4999, usdCents: 4999 });
  });
});

// ── Production hardening (L2-3): dev stub is forcibly disabled under NODE_ENV=production; missing credentials fail closed ──

describe('production hardening (L2-3)', () => {
  it('production + no credentials → dev stub disabled, verification fail closed (no coins granted)', async () => {
    process.env.NODE_ENV = 'production';
    // No real credentials present; in non-production this would auto-enable the dev stub, but in production it must be disabled.
    const verify = createReceiptVerifier(TIER_MAP);
    expect(await verify('dev', 'tier:t9999')).toEqual({ ok: false, coins: 0 });
    expect(await verify('apple', 'tier:t099')).toEqual({ ok: false, coins: 0 });
    expect(await verify('stripe', 'tier:t499')).toEqual({ ok: false, coins: 0 });
  });

  it('production + NW_IAP_DEV=true → dev stub still forcibly disabled (second line of defence)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.NW_IAP_DEV = 'true'; // accidentally enabled
    const verify = createReceiptVerifier(TIER_MAP);
    expect(await verify('dev', 'tier:t9999')).toEqual({ ok: false, coins: 0 });
  });

  it('non-production + no credentials → dev stub enabled as normal (local integration testing unaffected)', async () => {
    process.env.NODE_ENV = 'development';
    const verify = createReceiptVerifier(TIER_MAP);
    expect(await verify('dev', 'tier:t9999')).toEqual({ ok: true, coins: IAP_TIERS.t9999, usdCents: 9999 });
  });
});
