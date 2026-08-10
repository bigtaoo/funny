// Integration-level regression for the 2026-08-10 "recharge page bottom half blocked" fix
// (see client/src/ui/widgets/scrollPeek.ts's peekViewportH doc comment for the root cause).
//
// client/test/scrollPeek.test.ts already pins the fixed pure function's behaviour in isolation.
// This file drives the REAL ShopScene at the exact squat portrait aspect from the bug report
// (screenH/screenW ratio below the 16:9 threshold, so PortraitLayout's designHeight floors at
// 1920) and asserts, end-to-end, that:
//   1. peekViewportH is not shrinking the Coins-tab viewport (no dead gap below the fold), and
//   2. the row that used to get sacrificed for a "cleaner" peek is genuinely within the visible
//      (unmasked) region — not just numerically un-shrunk but the actual Buy button hit-rect
//      the player would tap sits above the mask's bottom edge.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts). Run: npm run test:ui
import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n } from '../../src/i18n';

vi.mock('../../src/ui/widgets/scrollPeek', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/widgets/scrollPeek')>();
  return { ...actual, peekViewportH: vi.fn(actual.peekViewportH) };
});

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

// Same squat screen size as test/ui/shopCoinsScrollBound.ui.ts (aspect 1280/800 = 1.6, below the
// 16:9 ≈ 1.778 threshold — this is what makes PortraitLayout's designHeight floor at 1920, exactly
// the condition the reported bug needed).
const [W, H] = [800, 1280];

interface Rect { x: number; y: number; w: number; h: number; }
interface Hit { rect: Rect; fn: () => void; }
interface ShopSceneInternals {
  h: number;
  landscape: boolean;
  hits: Hit[];
  regionTop: number;
  regionBottom: number;
  gridMetrics(): { listX: number; listW: number; gap: number; cols: number; cellW: number; cellH: number };
}

describe('ShopScene Coins tab — portrait squat-aspect dead-gap regression (2026-08-10)', () => {
  it('does not shrink the viewport for a thin-but-nonzero natural remainder (no wasted band below the fold)', async () => {
    const { peekViewportH } = await import('../../src/ui/widgets/scrollPeek');
    const { ShopScene } = await import('../../src/scenes/ShopScene');
    const spy = peekViewportH as unknown as { mock: { calls: unknown[][] } };
    spy.mock.calls.length = 0;

    const scene = new ShopScene(createLayout(W, H), new InputManager(), {
      onBack() {},
      getCoins: () => 1000,
      getOwnedSkins: () => [],
      loadItems: async () => [],
      buy: async () => ({ ok: true }),
      openGacha() {},
      rechargeCoins: async () => ({ ok: true }),
      redeemPromo: async () => ({ ok: true }),
      initialTab: 'coins',
    } as any) as unknown as ShopSceneInternals & { destroy(): void };

    const [availH, unit] = spy.mock.calls[spy.mock.calls.length - 1] as [number, number, number];

    // Sanity-pin that this scenario actually lands in the regression's "middle zone" — a thin but
    // nonzero remainder, below the old 28%-of-unit "comfortable" bar — so this test would have
    // failed against the pre-fix code (otherwise it'd be exercising the wrong branch entirely).
    const fullRows = Math.floor(availH / unit);
    const rem = availH - fullRows * unit;
    expect(fullRows).toBeGreaterThanOrEqual(2);
    expect(rem).toBeGreaterThan(0);
    expect(rem).toBeLessThan(unit * 0.28);

    // The actual fix: peekViewportH must return availH unchanged here, not a shrunk value.
    const returned = (peekViewportH as unknown as (...a: number[]) => number)(availH, unit, availH + unit * 3);
    expect(returned).toBe(availH);

    // End-to-end: the real scene's body mask reflects that full height — zero dead gap between
    // the mask's bottom edge and the bottom nav bar.
    expect(scene.regionBottom - scene.regionTop).toBe(availH);

    scene.destroy();
  });

  it('the row that used to be sacrificed is genuinely visible: its Buy button sits above the mask boundary', async () => {
    const { ShopScene } = await import('../../src/scenes/ShopScene');

    const scene = new ShopScene(createLayout(W, H), new InputManager(), {
      onBack() {},
      getCoins: () => 1000,
      getOwnedSkins: () => [],
      loadItems: async () => [],
      buy: async () => ({ ok: true }),
      openGacha() {},
      rechargeCoins: async () => ({ ok: true }),
      redeemPromo: async () => ({ ok: true }),
      initialTab: 'coins',
    } as any) as unknown as ShopSceneInternals & { destroy(): void };

    const { gap, cellH } = scene.gridMetrics();
    // Every Buy-button hit rect has this exact height (drawCard's btnH — see ShopScene/base.ts).
    const btnH = Math.round(cellH * 0.13);
    const buyHits = scene.hits.filter((hit) => hit.rect.h === btnH);
    // 5 WEB_COIN_TIERS, all enabled ⇒ 5 Buy buttons, all registered as hits regardless of whether
    // they're visually clipped (hit-testing isn't gated by the PIXI mask) — so this alone wouldn't
    // have caught the bug. What matters is whether their bottom edge is within the visible region.
    expect(buyHits.length).toBe(5);

    // Group by row (2 cols × 3 rows: rows 0 and 1 fully populated, row 2 has the lone 5th tier).
    // Row (fullRows-1) — the second row here — is exactly the row the pre-fix code discarded to
    // manufacture a "cleaner" peek of the row after it; row 2 (the 5th tier) is legitimately
    // expected to sit below the fold at this viewport size and is deliberately NOT asserted here.
    const rowYs = [...new Set(buyHits.map((h) => h.rect.y))].sort((a, b) => a - b);
    expect(rowYs.length).toBe(3);
    const unit = cellH + gap;
    const fullRows = Math.floor((scene.regionBottom - scene.regionTop) / unit);
    const sacrificedRowY = rowYs[fullRows - 1];
    const sacrificedRowBottom = sacrificedRowY + btnH;
    // regionTop/regionBottom are the body mask's absolute y-bounds (see maskBody in base.ts).
    expect(sacrificedRowBottom).toBeLessThanOrEqual(scene.regionBottom);

    scene.destroy();
  });
});
