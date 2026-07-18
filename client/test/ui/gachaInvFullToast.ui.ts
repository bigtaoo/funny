// Regression coverage for the "inventory full → mail/coin overflow" toast (2026-07-18): players
// used to keep drawing gacha pulls while the card roster (150) / equipment inventory (300) was full
// with zero feedback, silently losing pulls to coin conversion. GachaScene now shows one summary
// toast after the reveal overlay is dismissed, driven by the server's `overflow` response field.
import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, t } from '../../src/i18n';
import { GachaScene, type GachaSceneCallbacks, type GachaDrawResult } from '../../src/scenes/GachaScene';
import * as log from '../../src/net/log';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function buildGacha(drawResult: GachaDrawResult): GachaScene {
  const cb: GachaSceneCallbacks = {
    onBack() {},
    getCoins: () => 1000,
    getPity: () => 0,
    getFatePoints: () => 0,
    loadPools: async () => [{ id: 'standard', name: 'Standard', kind: 'static', drawOneCost: 150, drawTenCost: 1350, items: [] }],
    draw: async () => drawResult,
    redeemFate: async () => ({ ok: true, granted: 'placeholder' }),
  };
  return new GachaScene(createLayout(1920, 1080), new InputManager(), cb);
}

/** Drive a real draw() + reveal-dismiss round trip via the scene's private handlers (no public API for this — mirrors gachaResultCard.ui.ts's direct-field-access approach). */
async function drawThenDismiss(scene: GachaScene): Promise<void> {
  // The constructor kicks off loadPools() without awaiting it (fire-and-forget); onDraw no-ops
  // without a resolved pool, so force one directly rather than racing the real async load.
  (scene as unknown as { pools: unknown[] }).pools = [{ id: 'standard', name: 'Standard', kind: 'static', drawOneCost: 150, drawTenCost: 1350, items: [] }];
  await (scene as unknown as { onDraw(count: 1 | 10): Promise<void> }).onDraw(10);
  (scene as unknown as { dismissReveal(): void }).dismissReveal();
}

describe('GachaScene — inventory-full overflow toast', () => {
  it('shows nothing when overflow is all-zero', async () => {
    const spy = vi.spyOn(log, 'showToastMessage');
    const scene = buildGacha({
      ok: true,
      results: [{ itemId: 'lichuang', rarity: 'rare', duplicate: false }],
      overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 },
    });
    await drawThenDismiss(scene);
    expect(spy).not.toHaveBeenCalled();
    scene.destroy();
    spy.mockRestore();
  });

  it('mailed-only overflow shows the "mailed" toast with the combined card+equipment count', async () => {
    const spy = vi.spyOn(log, 'showToastMessage');
    const scene = buildGacha({
      ok: true,
      results: [],
      overflow: { cardMailed: 7, cardCompensatedCoins: 0, equipMailed: 3, equipCompensatedCoins: 0 },
    });
    await drawThenDismiss(scene);
    expect(spy).toHaveBeenCalledWith(t('gacha.invFull.mailed', { count: 10 }), 'success');
    scene.destroy();
    spy.mockRestore();
  });

  it('coin-compensation-only overflow shows the "compensated" toast with the combined coin amount', async () => {
    const spy = vi.spyOn(log, 'showToastMessage');
    const scene = buildGacha({
      ok: true,
      results: [],
      overflow: { cardMailed: 0, cardCompensatedCoins: 100, equipMailed: 0, equipCompensatedCoins: 20 },
    });
    await drawThenDismiss(scene);
    expect(spy).toHaveBeenCalledWith(t('gacha.invFull.compensated', { coins: 120 }), 'success');
    scene.destroy();
    spy.mockRestore();
  });

  it('mixed mail + compensation overflow shows the combined toast', async () => {
    const spy = vi.spyOn(log, 'showToastMessage');
    const scene = buildGacha({
      ok: true,
      results: [],
      overflow: { cardMailed: 10, cardCompensatedCoins: 100, equipMailed: 0, equipCompensatedCoins: 0 },
    });
    await drawThenDismiss(scene);
    expect(spy).toHaveBeenCalledWith(t('gacha.invFull.mailedAndCompensated', { mailed: 10, coins: 100 }), 'success');
    scene.destroy();
    spy.mockRestore();
  });

  it('a failed draw never triggers the overflow toast', async () => {
    const spy = vi.spyOn(log, 'showToastMessage');
    const scene = buildGacha({ ok: false, key: 'gacha.error' });
    await drawThenDismiss(scene);
    expect(spy).not.toHaveBeenCalledWith(expect.stringContaining('gacha.invFull'), expect.anything());
    scene.destroy();
    spy.mockRestore();
  });
});
