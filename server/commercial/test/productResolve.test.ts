// iap/productResolve.ts — the four env-driven resolvers, called directly.
//
// These functions are the only thing standing between a store's `product_id` / paid amount and a coin
// grant, and their entire behaviour is decided by deployment env vars (NW_IAP_PRODUCT_MAP,
// NW_IAP_AMOUNT_MAP, NW_IAP_NONCOIN_AMOUNT_MAP, NW_IAP_BUNDLE). iap.test.ts reaches them only through
// appleVerify/googleVerify with one well-formed map, so the file sat at 68.96% branches — the untested
// halves being exactly the malformed-map and no-match cases (claudedocs/server-testing-coverage.md).
//
// The rule every case below pins: anything that does not resolve to an EXACT tier/SKU resolves to
// "nothing" (0 coins / null), never to a default grant. A typo in a deployment's product map must make
// purchases fail closed, not silently award the smallest — or the largest — tier.
import { afterEach, describe, expect, it } from 'vitest';
import { IAP_TIERS, IAP_TIERS_LIST } from '@nw/shared';
import {
  resolveCoinsFromAmount,
  resolveCoinsFromProductId,
  resolveNonCoinProduct,
  resolveNonCoinProductFromAmount,
} from '../src/iap/productResolve';

const TIER_MAP = IAP_TIERS;
const SMALLEST = IAP_TIERS_LIST[0]!;

afterEach(() => {
  delete process.env.NW_IAP_PRODUCT_MAP;
  delete process.env.NW_IAP_AMOUNT_MAP;
  delete process.env.NW_IAP_NONCOIN_AMOUNT_MAP;
  delete process.env.NW_IAP_BUNDLE;
});

describe('resolveCoinsFromProductId — NW_IAP_PRODUCT_MAP present', () => {
  it('skips entries with no colon and still reads the well-formed ones after them', () => {
    process.env.NW_IAP_PRODUCT_MAP = `garbage,com.shop.pack:${SMALLEST.id}`;
    expect(resolveCoinsFromProductId('com.shop.pack', TIER_MAP)).toBe(TIER_MAP[SMALLEST.id]);
  });

  it('resolves 0 for an entry naming a tier that does not exist', () => {
    process.env.NW_IAP_PRODUCT_MAP = 'com.shop.pack:t_does_not_exist';
    expect(resolveCoinsFromProductId('com.shop.pack', TIER_MAP)).toBe(0);
  });

  it('resolves 0 for an entry with an empty tier half', () => {
    process.env.NW_IAP_PRODUCT_MAP = 'com.shop.pack:';
    expect(resolveCoinsFromProductId('com.shop.pack', TIER_MAP)).toBe(0);
  });

  // The map is authoritative once set: an id the map doesn't mention must NOT fall through to the
  // built-in `${bundle}.coins.<tier>` convention, or a deployment that deliberately renamed its SKUs
  // would keep honouring the old ids.
  it('does not fall back to the built-in bundle convention for an unmapped id', () => {
    process.env.NW_IAP_PRODUCT_MAP = `com.shop.pack:${SMALLEST.id}`;
    expect(resolveCoinsFromProductId(`com.nw.coins.${SMALLEST.id}`, TIER_MAP)).toBe(0);
  });
});

describe('resolveCoinsFromProductId — built-in convention (no product map)', () => {
  it('uses the com.nw default bundle when NW_IAP_BUNDLE is unset', () => {
    expect(resolveCoinsFromProductId(`com.nw.coins.${SMALLEST.id}`, TIER_MAP)).toBe(TIER_MAP[SMALLEST.id]);
  });

  it('honours an overridden bundle prefix', () => {
    process.env.NW_IAP_BUNDLE = 'de.elk.nw';
    expect(resolveCoinsFromProductId(`de.elk.nw.coins.${SMALLEST.id}`, TIER_MAP)).toBe(TIER_MAP[SMALLEST.id]);
    expect(resolveCoinsFromProductId(`com.nw.coins.${SMALLEST.id}`, TIER_MAP)).toBe(0);
  });

  it('resolves 0 for a correct prefix with an unknown tier suffix', () => {
    expect(resolveCoinsFromProductId('com.nw.coins.t_nope', TIER_MAP)).toBe(0);
  });

  it('resolves 0 for an id that does not carry the prefix at all', () => {
    expect(resolveCoinsFromProductId('com.other.thing', TIER_MAP)).toBe(0);
  });
});

describe('resolveNonCoinProduct', () => {
  it('skips colon-less entries and resolves a mapped SKU', () => {
    process.env.NW_IAP_PRODUCT_MAP = 'junk,com.shop.sub:monthly_card';
    expect(resolveNonCoinProduct('com.shop.sub')).toBe('monthly_card');
  });

  // A map entry pointing at something that is not one of the four non-coin kinds (a typo, or a coin tier
  // reused here) must resolve to null rather than being handed on as an IapProductKind.
  it('returns null for a mapped value that is not a known non-coin kind', () => {
    process.env.NW_IAP_PRODUCT_MAP = 'com.shop.sub:mothly_card';
    expect(resolveNonCoinProduct('com.shop.sub')).toBeNull();
  });

  it('returns null for an unmapped id while a map is set (no fall-through to the convention)', () => {
    process.env.NW_IAP_PRODUCT_MAP = 'com.shop.sub:monthly_card';
    expect(resolveNonCoinProduct('com.nw.sub.monthly')).toBeNull();
  });

  it('resolves all four built-in suffixes under the default bundle', () => {
    expect(resolveNonCoinProduct('com.nw.sub.monthly')).toBe('monthly_card');
    expect(resolveNonCoinProduct('com.nw.sub.year')).toBe('year_card');
    expect(resolveNonCoinProduct('com.nw.starter.draw')).toBe('starter_draw');
    expect(resolveNonCoinProduct('com.nw.starter.growth')).toBe('starter_growth');
  });

  it('honours an overridden bundle prefix', () => {
    process.env.NW_IAP_BUNDLE = 'de.elk.nw';
    expect(resolveNonCoinProduct('de.elk.nw.sub.year')).toBe('year_card');
    expect(resolveNonCoinProduct('com.nw.sub.year')).toBeNull();
  });

  it('returns null for an id matching no suffix', () => {
    expect(resolveNonCoinProduct('com.nw.coins.t099')).toBeNull();
  });
});

describe('resolveNonCoinProductFromAmount', () => {
  // Fails closed by design (see the function's doc): WeChat/Stripe subscription pricing isn't finalized,
  // so without an explicit map no amount may ever resolve to a subscription/starter grant.
  it('returns null when NW_IAP_NONCOIN_AMOUNT_MAP is unset', () => {
    expect(resolveNonCoinProductFromAmount(2980)).toBeNull();
  });

  it('resolves a mapped amount', () => {
    process.env.NW_IAP_NONCOIN_AMOUNT_MAP = '2980:monthly_card';
    expect(resolveNonCoinProductFromAmount(2980)).toBe('monthly_card');
  });

  it('returns null for an amount the map does not mention', () => {
    process.env.NW_IAP_NONCOIN_AMOUNT_MAP = '2980:monthly_card';
    expect(resolveNonCoinProductFromAmount(999)).toBeNull();
  });

  it('returns null when the mapped kind is not a known non-coin SKU', () => {
    process.env.NW_IAP_NONCOIN_AMOUNT_MAP = '2980:month_card';
    expect(resolveNonCoinProductFromAmount(2980)).toBeNull();
  });

  it('returns null for an entry with no kind half', () => {
    process.env.NW_IAP_NONCOIN_AMOUNT_MAP = '2980';
    expect(resolveNonCoinProductFromAmount(2980)).toBeNull();
  });
});

describe('resolveCoinsFromAmount', () => {
  it('resolves a mapped amount and ignores the built-in USD table while a map is set', () => {
    process.env.NW_IAP_AMOUNT_MAP = `3000:${SMALLEST.id}`;
    expect(resolveCoinsFromAmount(3000, TIER_MAP)).toBe(TIER_MAP[SMALLEST.id]);
    expect(resolveCoinsFromAmount(SMALLEST.usdCents, TIER_MAP)).toBe(0);
  });

  it('resolves 0 when a mapped entry names an unknown tier', () => {
    process.env.NW_IAP_AMOUNT_MAP = '3000:t_nope';
    expect(resolveCoinsFromAmount(3000, TIER_MAP)).toBe(0);
  });

  it('resolves 0 for an entry with no tier half', () => {
    process.env.NW_IAP_AMOUNT_MAP = '3000';
    expect(resolveCoinsFromAmount(3000, TIER_MAP)).toBe(0);
  });

  it('falls back to the built-in USD-cents table when no map is set', () => {
    expect(resolveCoinsFromAmount(SMALLEST.usdCents, TIER_MAP)).toBe(TIER_MAP[SMALLEST.id]);
  });

  it('resolves 0 for an amount matching no tier price', () => {
    expect(resolveCoinsFromAmount(SMALLEST.usdCents + 1, TIER_MAP)).toBe(0);
  });
});
