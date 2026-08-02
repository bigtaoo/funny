// Regression coverage for enhanceProtect.ts (EQUIPMENT_DESIGN §E7 / §6.2, ECONOMY_NUMBERS §5.4).
// enhanceProtectRun.ts is a human-read analysis script (this package's established pattern, see README —
// "run script, read printed verdict, register in ECONOMY_VERIFICATION_LOG.md"), not itself a test suite. This
// file locks in the 2026-08-02 rebalance (enhanceCost's binding threshold moved +6→+4, at the user's request,
// so protect_enhance pays off earlier — ECONOMY_NUMBERS.md §5.4) as an actual regression check: if enhanceCost
// or the protect_enhance shop price drifts again, CI catches the break-even shift instead of relying on
// someone re-running the script and reading the printed table by eye.
import { describe, expect, it } from 'vitest';
import { SHOP_ITEMS } from '@nw/shared';
import { protectValueByLevel, breakEvenLevels } from './enhanceProtect';

const PROTECT_ENHANCE_PRICE_COINS = SHOP_ITEMS.find((i) => i.id === 'protect_enhance')!.cost;

describe('protectValueByLevel', () => {
  it('covers all 9 enhance steps in order, +0->1 through +8->9', () => {
    const rows = protectValueByLevel();
    expect(rows).toHaveLength(9);
    rows.forEach((r, i) => {
      expect(r.fromLevel).toBe(i);
      expect(r.toLevel).toBe(i + 1);
    });
  });

  it('material coin-value per attempt strictly increases with level', () => {
    const rows = protectValueByLevel();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.materialCoinValuePerAttempt).toBeGreaterThan(rows[i - 1]!.materialCoinValuePerAttempt);
    }
  });

  // Pre-rebalance (binding required from +6) these were 45 / 64 / 483 / 901 / 1,320 — pins the post-rebalance
  // values (binding from +4) so a future enhanceCost tweak can't silently undo the encourage-protect intent.
  it('locks in the 2026-08-02 rebalance values for +4 through +8', () => {
    const rows = protectValueByLevel().map((r) => Math.round(r.materialCoinValuePerAttempt));
    expect(rows.slice(4)).toEqual([445, 864, 1283, 1701, 2120]);
  });

  it('leaves +0 through +3 untouched (binding doesn\'t reach that low, low levels stay "use at a loss")', () => {
    const rows = protectValueByLevel().map((r) => Math.round(r.materialCoinValuePerAttempt));
    expect(rows.slice(0, 4)).toEqual([4, 6, 8, 27]);
  });
});

describe('breakEvenLevels', () => {
  it('protect_enhance (live shop price) now breaks even from +5, not +7', () => {
    const { profitableFromLevel } = breakEvenLevels(PROTECT_ENHANCE_PRICE_COINS);
    expect(profitableFromLevel).toBe(5);
  });

  it('responds to price: a much higher price pushes break-even to a later level', () => {
    expect(breakEvenLevels(2000).profitableFromLevel).toBe(8);
  });

  it('a price above every level\'s single-attempt value never breaks even', () => {
    expect(breakEvenLevels(1_000_000).profitableFromLevel).toBeNull();
  });
});
