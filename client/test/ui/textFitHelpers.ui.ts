// Small text-fitting helpers split out of three scenes on 2026-09-29/30 that no test named:
// LeaderboardScene/rowFit.ts fitRowName, AchievementScene/tiers.ts widestTierLabelW and
// EquipmentScene/detailHelpers.ts (affixIconKind, wrappedHeight).
//
// The headless adapter (test/harness/pixiHeadless.ts) measures text as a flat `length * 7` whatever
// the size, so these assert the helpers' own rules (scale bounds, ellipsis, caching, wrap growth)
// relative to that metric, never absolute pixel widths.
//
// Runs under vitest.ui.config.ts. Run: npm run test:ui
import { describe, it, expect, beforeEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { MAIN_AFFIX_BY_SLOT, SUB_AFFIX_POOL } from '@nw/shared/equipment';
import { fitRowName } from '../../src/scenes/LeaderboardScene/rowFit';
import { TIER_LABELS, widestTierLabelW } from '../../src/scenes/AchievementScene/tiers';
import { affixIconKind, wrappedHeight } from '../../src/scenes/EquipmentScene/detailHelpers';
import { INK_ICON_ART } from '../../src/render/icons';
import { measuredWidth } from '../../src/render/pixiText';
import { txt, ui as C } from '../../src/render/sketchUi';
import { currentFontFloor, resetFontScaleForTest } from '../../src/render/fontScale';

const ELLIPSIS = '…';

describe('fitRowName (leaderboard row names)', () => {
  beforeEach(() => resetFontScaleForTest());

  /** A label at `size` and the unscaled width `full` would draw at. */
  const probe = (full: string, size: number) => {
    const lbl = txt(full, size, C.dark);
    const fullW = measuredWidth(lbl);
    return { lbl, fullW };
  };

  it('a name that fits is drawn whole at scale 1', () => {
    const size = 40;
    const { lbl, fullW } = probe('Player1234', size);
    lbl.text = 'stale';
    lbl.scale.set(0.5);
    fitRowName(lbl, 'Player1234', size, fullW + 1);
    expect(lbl.text).toBe('Player1234');
    expect(lbl.scale.x).toBe(1);
  });

  it('a slightly long name shrinks to fit, whole, down to 0.8', () => {
    const size = 40;
    const name = 'Player1234';
    const { lbl, fullW } = probe(name, size);
    const maxW = fullW * 0.9;
    fitRowName(lbl, name, size, maxW);
    expect(lbl.text).toBe(name);
    expect(lbl.scale.x).toBeCloseTo(0.9, 5);
    expect(measuredWidth(lbl)).toBeLessThanOrEqual(maxW + 1e-6);
  });

  it('past 0.8 the name is cut with an ellipsis and held at 0.8 instead of shrinking further', () => {
    const size = 40;
    const name = 'A'.repeat(24);
    const { lbl, fullW } = probe(name, size);
    const maxW = fullW * 0.4;
    fitRowName(lbl, name, size, maxW);
    expect(lbl.scale.x).toBeCloseTo(0.8, 5);
    expect(lbl.text.endsWith(ELLIPSIS)).toBe(true);
    expect(lbl.text.length).toBeLessThan(name.length);
    expect(measuredWidth(lbl)).toBeLessThanOrEqual(maxW + 1e-6);
  });

  it('never scales under the legibility floor: near the floor it cuts without shrinking', () => {
    // size just above the floor: floor/size > 0.8, so the min scale is the floor's share, not 0.8.
    const floor = currentFontFloor();
    const size = Math.round(floor * 1.1);
    const name = 'B'.repeat(24);
    const { lbl, fullW } = probe(name, size);
    fitRowName(lbl, name, size, fullW * 0.5);
    expect(lbl.scale.x * size).toBeGreaterThanOrEqual(floor - 1e-6);
    expect(lbl.text.endsWith(ELLIPSIS)).toBe(true);
  });

  it('a size at or under the floor is never shrunk at all', () => {
    const floor = currentFontFloor();
    const name = 'C'.repeat(24);
    const { lbl, fullW } = probe(name, floor);
    fitRowName(lbl, name, floor, fullW * 0.95);
    expect(lbl.scale.x).toBe(1);
    expect(lbl.text.endsWith(ELLIPSIS)).toBe(true);
  });
});

describe('widestTierLabelW (achievement tier column)', () => {
  it('is the widest of the tier labels at that size', () => {
    const size = 30;
    const widths = TIER_LABELS.map((l) => {
      const t = txt(l, size, C.dark, true);
      const w = measuredWidth(t);
      t.destroy(true);
      return w;
    });
    expect(widestTierLabelW(size)).toBe(Math.max(...widths));
  });

  it('measures each size once and answers later calls from the cache', () => {
    const orig = PIXI.TextMetrics.measureText;
    let calls = 0;
    PIXI.TextMetrics.measureText = ((...args: Parameters<typeof orig>) => {
      calls++;
      return orig(...args);
    }) as typeof orig;
    try {
      const first = widestTierLabelW(31);
      expect(calls).toBeGreaterThan(0); // a new size is measured...
      calls = 0;
      expect(widestTierLabelW(31)).toBe(first);
      expect(calls).toBe(0); // ...and the same size again is not
    } finally {
      PIXI.TextMetrics.measureText = orig;
    }
  });
});

describe('affixIconKind (equipment detail affix rows)', () => {
  const rollable = [
    ...Object.values(MAIN_AFFIX_BY_SLOT).flat().map((a) => a.id),
    ...SUB_AFFIX_POOL.map(([id]) => id),
  ];

  it.each(rollable)('%s has an icon that exists in the ink icon set', (id) => {
    const kind = affixIconKind(id);
    expect(kind).not.toBeNull();
    expect(Object.keys(INK_ICON_ART)).toContain(kind);
  });

  it('strips the m_/s_/k_ prefix only', () => {
    expect(affixIconKind('m_atk')).toBe('atk');
    expect(affixIconKind('k_atk')).toBe('atk');
    expect(affixIconKind('atk')).toBe('atk');
    expect(affixIconKind('s_critmult')).toBe('critmult');
  });

  it('an unknown affix has no icon', () => {
    expect(affixIconKind('s_luck')).toBeNull();
    expect(affixIconKind('')).toBeNull();
  });
});

describe('wrappedHeight (equipment detail fine print)', () => {
  const long = 'protect this item from being used as fusion material and from demotion';

  it('grows when the same line wraps into a narrower column', () => {
    const wide = wrappedHeight(long, 10_000);
    const narrow = wrappedHeight(long, 120);
    expect(narrow).toBeGreaterThan(wide * 2);
  });

  it('a line that fits is one line high whatever the width', () => {
    expect(wrappedHeight('short', 10_000)).toBe(wrappedHeight('short', 2_000));
  });
});
