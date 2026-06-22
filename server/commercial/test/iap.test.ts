// C1：Apple App Store + Google Play IAP 验签单测。
// 覆盖：正常验签映射金币、伪造收据被拒、sandbox 重试、Google purchaseState 非 0、dev 桩。
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createReceiptVerifier } from '../src/iap';

const TIER_MAP = { small: 600, mid: 3300, large: 11800 };
const BUNDLE = 'com.nw';

// ── fetch mock 工具 ──────────────────────────────────────────────────────────

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

afterEach(() => {
  vi.unstubAllGlobals();
  // 清除测试中可能设置的环境变量
  delete process.env.NW_APPLE_PASSWORD;
  delete process.env.NW_GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.NW_GOOGLE_PACKAGE_NAME;
  delete process.env.NW_IAP_BUNDLE;
  delete process.env.NW_IAP_PRODUCT_MAP;
  delete process.env.NW_IAP_DEV;
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
    // 不设置 password，工厂直接返回 false
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

// 测试用 RSA 2048 密钥对（generateKeyPairSync 确保格式有效）。
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
        // JWT 签名可能失败（dummy key），但 mock 直接返回 token
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

// ── dev 桩 ───────────────────────────────────────────────────────────────────

describe('dev stub', () => {
  it('returns coins for tier: prefix receipt when all credentials missing', async () => {
    process.env.NW_IAP_DEV = 'false'; // 无凭据时自动启用 dev
    const verify = createReceiptVerifier(TIER_MAP);
    expect(await verify('apple', 'tier:small')).toEqual({ ok: true, coins: 600 });
    expect(await verify('google', 'tier:large')).toEqual({ ok: true, coins: 11800 });
    expect(await verify('dev', 'tier:mid')).toEqual({ ok: true, coins: 3300 });
  });

  it('dev stub disabled when real credentials present and NW_IAP_DEV not set', async () => {
    process.env.NW_APPLE_PASSWORD = 'real-password';
    mockFetch(() => Promise.resolve(jsonResp({ status: 21002 }))); // invalid receipt
    const verify = createReceiptVerifier(TIER_MAP);
    // tier: prefix 不再走桩，而是走真实 apple 验签（返回失败）
    const result = await verify('apple', 'tier:small');
    expect(result).toEqual({ ok: false, coins: 0 });
  });
});
