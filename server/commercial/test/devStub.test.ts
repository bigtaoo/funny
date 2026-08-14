// devVerify() unit tests (iap/devStub.ts, previously 57.1% — the `product:` prefix branch had never
// been hit directly; verifyNonCoinReceipt's own e2e coverage exercises it only indirectly through the
// full IAP verification pipeline). Pure function, no server/DB needed.
import { describe, expect, it } from 'vitest';
import { devVerify } from '../src/iap/devStub';
import type { IapTierMap } from '../src/iap/types';

const TIERS: IapTierMap = { t499: 550, t999: 1150 };

describe('devVerify', () => {
  it('empty receipt -> not ok, 0 coins', () => {
    expect(devVerify('', TIERS)).toEqual({ ok: false, coins: 0 });
  });

  describe('product: prefix (non-coin receipts: subscriptions, starter packs)', () => {
    it('a recognized product kind -> ok, 0 coins, product set', () => {
      expect(devVerify('product:monthly_card', TIERS)).toEqual({ ok: true, coins: 0, product: 'monthly_card' });
      expect(devVerify('product:year_card', TIERS)).toEqual({ ok: true, coins: 0, product: 'year_card' });
      expect(devVerify('product:starter_draw', TIERS)).toEqual({ ok: true, coins: 0, product: 'starter_draw' });
      expect(devVerify('product:starter_growth', TIERS)).toEqual({ ok: true, coins: 0, product: 'starter_growth' });
    });
    it('an unrecognized product kind -> not ok', () => {
      expect(devVerify('product:not_a_real_product', TIERS)).toEqual({ ok: false, coins: 0 });
    });
  });

  describe('tier: prefix (coin receipts)', () => {
    it('a known tier -> ok, that tier\'s coin amount', () => {
      expect(devVerify('tier:t499', TIERS)).toEqual({ ok: true, coins: 550 });
      expect(devVerify('tier:t999', TIERS)).toEqual({ ok: true, coins: 1150 });
    });
    it('an unknown tier -> falls back to the default tier\'s coin amount (still ok)', () => {
      expect(devVerify('tier:not-a-real-tier', TIERS)).toEqual({ ok: true, coins: TIERS['t499'] });
    });
  });

  it('no recognized prefix at all -> treated as the default tier', () => {
    expect(devVerify('anything-else', TIERS)).toEqual({ ok: true, coins: TIERS['t499'] });
  });
});
