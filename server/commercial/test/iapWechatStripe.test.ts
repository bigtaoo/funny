// wxPayVerify / stripeVerify unit tests (previously zero coverage — server-test-backlog).
//
// NOTE ON SCOPE: unlike the task's original framing ("webhook signature verification, HMAC
// comparison, reject tampered payload / missing signature header / malformed signature"), these
// two functions are NOT webhook-signature verifiers. Reading src/iap/wechat.ts and src/iap/stripe.ts
// shows they are receipt-verification functions that poll the provider's REST API by receipt id
// (WeChat transaction_id / Stripe payment_intent_id) and inspect the returned trade_state/status +
// amount. wxPayVerify does build an HMAC-SHA256 signed Authorization header, but that signature is
// for the OUTGOING request commercial makes to WeChat's API — there is no inbound webhook payload or
// signature header to validate here. There is no separate webhook-receiver code path in this package
// (see iap.ts, which only wires these two functions into createReceiptVerifier by platform).
//
// So this file tests what the functions actually do, mirroring the existing apple/google verify
// test style in iap.test.ts (mock global.fetch, assert ok/coins/product outcomes, request shape,
// and error propagation for non-2xx / network failures).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { IAP_TIERS } from '@nw/shared';
import { wxPayVerify } from '../src/iap/wechat';
import { stripeVerify } from '../src/iap/stripe';

type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

function mockFetch(impl: FetchMock): void {
  vi.stubGlobal('fetch', impl);
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const TIER_MAP = IAP_TIERS;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NW_IAP_AMOUNT_MAP;
  delete process.env.NW_IAP_NONCOIN_AMOUNT_MAP;
});

// ── WeChat Pay V3 ────────────────────────────────────────────────────────────
describe('wxPayVerify', () => {
  const MCH_ID = 'mch_test_123';
  const API_KEY = 'test-api-key-v3';

  it('returns coins when trade_state is SUCCESS and the amount matches a configured tier', async () => {
    process.env.NW_IAP_AMOUNT_MAP = '3000:t499'; // WeChat is fen — requires the explicit amount map
    mockFetch((url, init) => {
      expect(url).toBe(`https://api.mch.weixin.qq.com/v3/pay/transactions/id/tx_1?mchid=${MCH_ID}`);
      const auth = (init?.headers as Record<string, string>)?.Authorization ?? '';
      expect(auth).toContain('WECHATPAY2-SHA256-RSA2048');
      expect(auth).toContain(`mchid="${MCH_ID}"`);
      expect(auth).toMatch(/signature="[^"]+"/);
      return Promise.resolve(jsonResp({ trade_state: 'SUCCESS', amount: { total: 3000 } }));
    });

    const result = await wxPayVerify('tx_1', TIER_MAP, MCH_ID, API_KEY);
    expect(result).toEqual({ ok: true, coins: IAP_TIERS.t499 });
  });

  it('rejects when trade_state is not SUCCESS', async () => {
    mockFetch(() => Promise.resolve(jsonResp({ trade_state: 'NOTPAY', amount: { total: 3000 } })));
    const result = await wxPayVerify('tx_2', TIER_MAP, MCH_ID, API_KEY);
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('rejects when the amount matches no configured tier (no NW_IAP_AMOUNT_MAP)', async () => {
    mockFetch(() => Promise.resolve(jsonResp({ trade_state: 'SUCCESS', amount: { total: 123456 } })));
    const result = await wxPayVerify('tx_3', TIER_MAP, MCH_ID, API_KEY);
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('resolves a non-coin product via NW_IAP_NONCOIN_AMOUNT_MAP', async () => {
    process.env.NW_IAP_NONCOIN_AMOUNT_MAP = '3000:monthly_card';
    mockFetch(() => Promise.resolve(jsonResp({ trade_state: 'SUCCESS', amount: { total: 3000 } })));
    const result = await wxPayVerify('tx_4', TIER_MAP, MCH_ID, API_KEY);
    expect(result).toEqual({ ok: true, coins: 0, product: 'monthly_card' });
  });

  it('throws when the WeChat API responds with a non-2xx status', async () => {
    mockFetch(() =>
      Promise.resolve(new Response('mchid invalid', { status: 401, headers: { 'Content-Type': 'text/plain' } })),
    );
    await expect(wxPayVerify('tx_5', TIER_MAP, MCH_ID, API_KEY)).rejects.toThrow(/wx pay query error 401/);
  });

  it('throws when the fetch call itself fails (network error)', async () => {
    mockFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(wxPayVerify('tx_6', TIER_MAP, MCH_ID, API_KEY)).rejects.toThrow(/wx pay fetch failed: ECONNREFUSED/);
  });

  it('treats a missing amount as 0 (no crash) and rejects', async () => {
    mockFetch(() => Promise.resolve(jsonResp({ trade_state: 'SUCCESS' })));
    const result = await wxPayVerify('tx_7', TIER_MAP, MCH_ID, API_KEY);
    expect(result).toEqual({ ok: false, coins: 0 });
  });
});

// ── Stripe ───────────────────────────────────────────────────────────────────
describe('stripeVerify', () => {
  const SECRET_KEY = 'sk_test_abc123';

  it('returns coins when status is succeeded and amount matches the default USD-cents tier table', async () => {
    mockFetch((url, init) => {
      expect(url).toBe('https://api.stripe.com/v1/payment_intents/pi_1');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);
      expect(headers['Stripe-Version']).toBe('2024-04-10');
      return Promise.resolve(jsonResp({ status: 'succeeded', amount: 499, currency: 'usd' }));
    });

    const result = await stripeVerify('pi_1', TIER_MAP, SECRET_KEY);
    expect(result).toEqual({ ok: true, coins: IAP_TIERS.t499 });
  });

  it('rejects when status is not succeeded', async () => {
    mockFetch(() => Promise.resolve(jsonResp({ status: 'requires_payment_method', amount: 499 })));
    const result = await stripeVerify('pi_2', TIER_MAP, SECRET_KEY);
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('rejects when the amount matches no known tier', async () => {
    mockFetch(() => Promise.resolve(jsonResp({ status: 'succeeded', amount: 12345 })));
    const result = await stripeVerify('pi_3', TIER_MAP, SECRET_KEY);
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('resolves a non-coin product via NW_IAP_NONCOIN_AMOUNT_MAP', async () => {
    process.env.NW_IAP_NONCOIN_AMOUNT_MAP = '698:year_card';
    mockFetch(() => Promise.resolve(jsonResp({ status: 'succeeded', amount: 698 })));
    const result = await stripeVerify('pi_4', TIER_MAP, SECRET_KEY);
    expect(result).toEqual({ ok: true, coins: 0, product: 'year_card' });
  });

  it('returns ok:false coins:0 without throwing on a 404 (unknown payment intent)', async () => {
    mockFetch(() => Promise.resolve(new Response('{}', { status: 404 })));
    const result = await stripeVerify('pi_missing', TIER_MAP, SECRET_KEY);
    expect(result).toEqual({ ok: false, coins: 0 });
  });

  it('throws when Stripe responds with a non-2xx, non-404 status', async () => {
    mockFetch(() =>
      Promise.resolve(new Response('invalid api key', { status: 401, headers: { 'Content-Type': 'text/plain' } })),
    );
    await expect(stripeVerify('pi_5', TIER_MAP, SECRET_KEY)).rejects.toThrow(/stripe query error 401/);
  });

  it('throws when the fetch call itself fails (network error)', async () => {
    mockFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(stripeVerify('pi_6', TIER_MAP, SECRET_KEY)).rejects.toThrow(/stripe fetch failed: ECONNREFUSED/);
  });
});
