// service/walletView.ts's stateless helpers: the dev receipt stub and the two doc → config converters.
//
// walletView.test.ts covers the projection's firstPurchaseUsed field; nothing covered devVerifyReceipt's
// own decision tree (80.64% branches, claudedocs/server-testing-coverage.md), even though it IS the
// receipt verifier for every test fixture and every dev/CI deployment in this package — WalletCore falls
// back to it whenever `deps.verifyReceipt` is absent. Its rules decide whether a local `topup_` receipt
// grants coins or a non-coin SKU, so a change here silently re-shapes what the whole e2e suite thinks a
// purchase does. Note this is NOT iap/devStub.ts's devVerify (tested in devStub.test.ts) — that one is
// the one wired into createReceiptVerifier; this one is the in-package fallback, and the two differ.
//
// The converters are the read path of admin-authored pools: strip the Mongo/audit fields back to the
// config shape, and — the branch that was missing — carry the OPTIONAL fields only when actually present,
// so `fillerLegendaries: undefined` / `costTen: undefined` never reaches buildLimitedPool or the ×10 price.
import { describe, expect, it } from 'vitest';
import { DEV_STUB_DEFAULT_TIER, IAP_TIERS, usdCentsForTier } from '@nw/shared';
import { customConfigFromDoc, devVerifyReceipt, limitedConfigFromDoc } from '../src/service/base';
import type { CustomGachaPoolDoc, DerivedGachaPoolDoc } from '../src/db';

describe('devVerifyReceipt', () => {
  it('rejects an empty receipt', () => {
    expect(devVerifyReceipt('dev', '')).toEqual({ ok: false, coins: 0, usdCents: 0 });
  });

  it('resolves a known non-coin SKU from a product: receipt', () => {
    expect(devVerifyReceipt('dev', 'product:year_card')).toEqual({
      ok: true,
      coins: 0,
      usdCents: 0,
      product: 'year_card',
    });
  });

  // A product: receipt naming something outside the four non-coin kinds must fail rather than fall
  // through to the coin-tier path (where the unknown tier would then be defaulted into a coin grant).
  it('rejects a product: receipt naming an unknown kind', () => {
    expect(devVerifyReceipt('dev', 'product:battle_pass')).toEqual({ ok: false, coins: 0, usdCents: 0 });
  });

  it('grants the named tier for a tier: receipt', () => {
    expect(devVerifyReceipt('dev', 'tier:t999')).toEqual({
      ok: true,
      coins: IAP_TIERS.t999,
      usdCents: usdCentsForTier('t999'),
    });
  });

  // Both fall back to the default tier, and — importantly — usdCents falls back WITH it, so
  // totalRechargeCents can't be bumped by a price that doesn't match the coins actually granted.
  it('falls back to the default tier for an unknown tier id', () => {
    expect(devVerifyReceipt('dev', 'tier:t_nope')).toEqual({
      ok: true,
      coins: IAP_TIERS[DEV_STUB_DEFAULT_TIER],
      usdCents: usdCentsForTier(DEV_STUB_DEFAULT_TIER),
    });
  });

  it('falls back to the default tier for a receipt with no recognized prefix (the E2E topup_ path)', () => {
    expect(devVerifyReceipt('dev', 'topup_abc123')).toEqual({
      ok: true,
      coins: IAP_TIERS[DEV_STUB_DEFAULT_TIER],
      usdCents: usdCentsForTier(DEV_STUB_DEFAULT_TIER),
    });
  });
});

describe('limitedConfigFromDoc', () => {
  const base: DerivedGachaPoolDoc = {
    _id: 'lp1',
    id: 'lp1',
    name: 'Spring',
    featuredLegendary: 'skin_l1',
    startAt: 10,
    endAt: 20,
    createdBy: 'admin1',
    createdAt: 5,
  };

  it('drops the Mongo/audit fields and omits fillerLegendaries when the doc has none', () => {
    const cfg = limitedConfigFromDoc(base);
    expect(cfg).toEqual({ id: 'lp1', name: 'Spring', featuredLegendary: 'skin_l1', startAt: 10, endAt: 20 });
    expect(Object.keys(cfg)).not.toContain('fillerLegendaries');
  });

  it('carries fillerLegendaries when the doc has them', () => {
    expect(limitedConfigFromDoc({ ...base, fillerLegendaries: ['max', 'lena'] })).toEqual({
      id: 'lp1',
      name: 'Spring',
      featuredLegendary: 'skin_l1',
      startAt: 10,
      endAt: 20,
      fillerLegendaries: ['max', 'lena'],
    });
  });
});

describe('customConfigFromDoc', () => {
  const base: CustomGachaPoolDoc = {
    _id: 'cp1',
    kind: 'custom',
    id: 'cp1',
    name: 'Festival',
    costSingle: 200,
    startAt: 0,
    endAt: 100,
    categories: [{ category: 'material', weight: 1, items: [{ itemId: 'mat_scrap', weight: 1 }] }],
    createdBy: 'admin1',
    createdAt: 5,
  };

  it('omits costTen when the doc has none (so the ×10 price stays derived from costSingle)', () => {
    const cfg = customConfigFromDoc(base);
    expect(Object.keys(cfg)).not.toContain('costTen');
    expect(cfg).toMatchObject({ id: 'cp1', name: 'Festival', costSingle: 200, startAt: 0, endAt: 100 });
  });

  it('carries an explicit costTen', () => {
    expect(customConfigFromDoc({ ...base, costTen: 1800 })).toMatchObject({ costTen: 1800 });
  });
});
