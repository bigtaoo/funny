// C1: Apple App Store + Google Play IAP receipt verification unit tests.
// Coverage: valid receipt mapped to coins, forged receipt rejected, sandbox retry, Google purchaseState non-zero, dev stub.
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createReceiptVerifier } from '../src/iap';
import { IAP_TIERS, DEV_STUB_DEFAULT_TIER } from '@nw/shared';

const TIER_MAP = { small: 600, mid: 3300, large: 11800 };
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
  delete process.env.NW_APPLE_PASSWORD;
  delete process.env.NW_GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.NW_GOOGLE_PACKAGE_NAME;
  delete process.env.NW_IAP_BUNDLE;
  delete process.env.NW_IAP_PRODUCT_MAP;
  delete process.env.NW_IAP_DEV;
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

// ── Apple ────────────────────────────────────────────────────────────────────

describe('apple verify', () => {
  const password = 'shared-secret';

  function makeVerifier() {
    process.env.NW_APPLE_PASSWORD = password;
    process.env.NW_IAP_BUNDLE = BUNDLE;
    return createReceiptVerifier(TIER_MAP);
  }

  it('returns coins for valid prod receipt with small product', async () => {
    mockFetch((_url, init) => {
      const body = JSON.parse((init?.body as string) ?? '{}');
      expect(body.password).toBe(password);
      return Promise.resolve(
        jsonResp({
          status: 0,
          latest_receipt_info: [
            { product_id: 'com.nw.coins.small', transaction_id: 'tx1', purchase_date_ms: '1000' },
          ],
        }),
      );
    });

    const verify = makeVerifier();
    const result = await verify('apple', 'base64receipt==');
    expect(result).toEqual({ ok: true, coins: 600 });
  });

  it('retries sandbox when prod returns status 21007', async () => {
    let callCount = 0;
    mockFetch((url) => {
      callCount++;
      if (callCount === 1) {
        expect(url).toContain('buy.itunes.apple.com');
        return Promise.resolve(jsonResp({ status: 21007 }));
      }
      expect(url).toContain('sandbox.itunes.apple.com');
      return Promise.resolve(
        jsonResp({
          status: 0,
          latest_receipt_info: [
            { product_id: 'com.nw.coins.large', transaction_id: 'tx2', purchase_date_ms: '2000' },
          ],
        }),
      );
    });

    const verify = makeVerifier();
    const result = await verify('apple', 'base64receipt==');
    expect(callCount).toBe(2);
    expect(result).toEqual({ ok: true, coins: 11800 });
  });

  it('rejects forged receipt (status !== 0)', async () => {
    mockFetch(() => Promise.resolve(jsonResp({ status: 21002 }))); // invalid receipt

    const verify = makeVerifier();
    const result = await verify('apple', 'forged==');
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('rejects unknown product_id', async () => {
    mockFetch(() =>
      Promise.resolve(
        jsonResp({
          status: 0,
          latest_receipt_info: [
            { product_id: 'com.unknown.product', transaction_id: 'tx3', purchase_date_ms: '1000' },
          ],
        }),
      ),
    );

    const verify = makeVerifier();
    const result = await verify('apple', 'base64receipt==');
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('picks latest transaction when multiple in_app entries present', async () => {
    mockFetch(() =>
      Promise.resolve(
        jsonResp({
          status: 0,
          latest_receipt_info: [
            { product_id: 'com.nw.coins.small', transaction_id: 'tx_old', purchase_date_ms: '500' },
            { product_id: 'com.nw.coins.mid', transaction_id: 'tx_new', purchase_date_ms: '9000' },
          ],
        }),
      ),
    );

    const verify = makeVerifier();
    const result = await verify('apple', 'base64receipt==');
    expect(result).toEqual({ ok: true, coins: 3300 });
  });

  it('returns ok:false when NW_APPLE_PASSWORD is not set', async () => {
    // password not set; factory returns false immediately
    process.env.NW_IAP_DEV = 'false';
    const verify = createReceiptVerifier(TIER_MAP);
    const result = await verify('apple', 'base64receipt==');
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('supports custom product map via NW_IAP_PRODUCT_MAP', async () => {
    process.env.NW_APPLE_PASSWORD = password;
    process.env.NW_IAP_PRODUCT_MAP = 'custom.product.gold:large';

    mockFetch(() =>
      Promise.resolve(
        jsonResp({
          status: 0,
          latest_receipt_info: [
            { product_id: 'custom.product.gold', transaction_id: 'txC', purchase_date_ms: '1000' },
          ],
        }),
      ),
    );

    const verify = createReceiptVerifier(TIER_MAP);
    const result = await verify('apple', 'base64receipt==');
    expect(result).toEqual({ ok: true, coins: 11800 });
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
      expect(url).toContain('com.nw.coins.mid');
      expect((init?.headers as Record<string, string>)?.['Authorization']).toBe('Bearer fake-token');
      return Promise.resolve(jsonResp({ purchaseState: 0, orderId: 'GPA.123' }));
    });

    const verify = makeVerifier();
    const result = await verify('google', 'com.nw.coins.mid:purchase-token-xyz');
    expect(result).toEqual({ ok: true, coins: 3300 });
  });

  it('rejects when purchaseState !== 0', async () => {
    mockFetch((url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return Promise.resolve(jsonResp({ access_token: 'fake-token' }));
      }
      return Promise.resolve(jsonResp({ purchaseState: 2 })); // cancelled
    });

    const verify = makeVerifier();
    const result = await verify('google', 'com.nw.coins.small:token-cancelled');
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
    const result = await verify('google', 'com.nw.coins.large:invalid-token');
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
    const result = await verify('google', 'com.nw.coins.small:token');
    expect(result).toEqual({ ok: false, coins: 0 });
  });
});

// ── dev stub ───────────────────────────────────────────────────────────────────

describe('dev stub', () => {
  it('returns coins for tier: prefix receipt when all credentials missing', async () => {
    process.env.NW_IAP_DEV = 'false'; // dev stub auto-enabled when no credentials present
    const verify = createReceiptVerifier(TIER_MAP);
    expect(await verify('apple', 'tier:small')).toEqual({ ok: true, coins: 600 });
    expect(await verify('google', 'tier:large')).toEqual({ ok: true, coins: 11800 });
    expect(await verify('dev', 'tier:mid')).toEqual({ ok: true, coins: 3300 });
  });

  it('grants the default tier for a receipt with no tier: prefix (E2E topup_ path)', async () => {
    // Regression guard: the dev stub's fallback tier must be a real key of IAP_TIERS.
    // The feat(iap) retier (small/mid/large → t099…t9999) previously left the fallback
    // pointing at the removed `small` tier, so `topup_*` receipts resolved to undefined coins.
    process.env.NW_IAP_DEV = 'false';
    const verify = createReceiptVerifier(IAP_TIERS);
    const expected = IAP_TIERS[DEV_STUB_DEFAULT_TIER];
    expect(expected).toBeGreaterThan(0);
    expect(await verify('dev', 'topup_abc123')).toEqual({ ok: true, coins: expected });
  });

  it('dev stub disabled when real credentials present and NW_IAP_DEV not set', async () => {
    process.env.NW_APPLE_PASSWORD = 'real-password';
    mockFetch(() => Promise.resolve(jsonResp({ status: 21002 }))); // invalid receipt
    const verify = createReceiptVerifier(TIER_MAP);
    // tier: prefix no longer routes through the stub; it goes through real apple verification (which returns failure)
    const result = await verify('apple', 'tier:small');
    expect(result).toEqual({ ok: false, coins: 0 });
  });
});

// ── Production hardening (L2-3): dev stub is forcibly disabled under NODE_ENV=production; missing credentials fail closed ──

describe('production hardening (L2-3)', () => {
  it('production + no credentials → dev stub disabled, verification fail closed (no coins granted)', async () => {
    process.env.NODE_ENV = 'production';
    // No real credentials present; in non-production this would auto-enable the dev stub, but in production it must be disabled.
    const verify = createReceiptVerifier(TIER_MAP);
    expect(await verify('dev', 'tier:large')).toEqual({ ok: false, coins: 0 });
    expect(await verify('apple', 'tier:small')).toEqual({ ok: false, coins: 0 });
    expect(await verify('stripe', 'tier:mid')).toEqual({ ok: false, coins: 0 });
  });

  it('production + NW_IAP_DEV=true → dev stub still forcibly disabled (second line of defence)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.NW_IAP_DEV = 'true'; // accidentally enabled
    const verify = createReceiptVerifier(TIER_MAP);
    expect(await verify('dev', 'tier:large')).toEqual({ ok: false, coins: 0 });
  });

  it('non-production + no credentials → dev stub enabled as normal (local integration testing unaffected)', async () => {
    process.env.NODE_ENV = 'development';
    const verify = createReceiptVerifier(TIER_MAP);
    expect(await verify('dev', 'tier:large')).toEqual({ ok: true, coins: 11800 });
  });
});
