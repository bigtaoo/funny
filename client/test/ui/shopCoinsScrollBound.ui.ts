// Regression coverage for the Coins-tab scroll-bound off-by-one (2026-08-03 fix).
//
// Before: `totalH = gridH + (promoH ? promoH + gap : 0)` double-counted a trailing `gap` —
// `gridH` (rows * (cellH + gap)) already has one trailing gap baked in past the last card row,
// which is exactly the gap the promo row is positioned below. Adding another `+ gap` on top left a
// permanent gap-sized dead-scroll strip below the promo row that could never be scrolled away.
//
// This spies on peekViewportH (the one place `totalH` — the exact value the fix changes — is
// actually consumed) to verify the real code path, rather than reconstructing ShopScene's private
// layout geometry by hand.
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

const [W, H] = [800, 1280];

describe('ShopScene Coins tab — scroll bound (totalH) does not double-count the trailing gap', () => {
  it('totalH passed to peekViewportH equals gridH + promoH exactly (no extra +gap)', async () => {
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
    } as any);

    expect(spy.mock.calls.length).toBeGreaterThan(0);
    const [, unit, totalH] = spy.mock.calls[spy.mock.calls.length - 1] as [number, number, number];

    // Independently derive gridH the same way coins.ts does (5 fixed WEB_COIN_TIERS), using the
    // scene's own gridMetrics() so cols/cellH/gap always match the real render, whatever the
    // viewport size — only the arithmetic combining them (the actual fix) is under test here.
    const { gap, cellH, cols } = (scene as any).gridMetrics();
    const rows = Math.ceil(5 / cols); // WEB_COIN_TIERS.length
    const gridH = rows * (cellH + gap);
    const promoH = Math.round((scene as any).h * 0.09);

    expect(unit).toBe(cellH + gap);
    expect(totalH).toBe(gridH + promoH); // NOT gridH + promoH + gap (the old, buggy formula)
    scene.destroy();
  });

  it('regression: without redeemPromo (no promo row), totalH is exactly gridH — unaffected by the fix', async () => {
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
      initialTab: 'coins',
      // no redeemPromo
    } as any);

    const [, , totalH] = spy.mock.calls[spy.mock.calls.length - 1] as [number, number, number];
    const { gap, cellH, cols } = (scene as any).gridMetrics();
    const rows = Math.ceil(5 / cols);
    const gridH = rows * (cellH + gap);

    expect(totalH).toBe(gridH);
    scene.destroy();
  });
});
