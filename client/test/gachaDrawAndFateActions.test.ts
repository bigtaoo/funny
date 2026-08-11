/**
 * gachaDrawAndFateActions.test.ts — direct coverage of GachaScene/core.ts's `onDraw`/`onRedeemFate`
 * busy-lock + catch/timeout branches. The 2026-08-05 client-test-audit flagged Gacha as having zero
 * busy-lock coverage of any kind, and `onRedeemFate` as never called by any test at all — every
 * other reference to `cb.redeemFate` in the suite only supplies it as a constructor-stub callback
 * for scene wiring. `onDraw`'s success/ok:false paths already have real coverage in
 * `gachaInvFullToast.ui.ts`; this file adds its busy-lock + catch/timeout branch and all of
 * `onRedeemFate`.
 *
 * `onDraw`/`onRedeemFate` are plain public methods directly on the exported `GachaSceneCore`
 * class (2026-08-11: `GachaSceneBase` mixin-chain conversion to composition — see
 * claudedocs/client-modules.md's split-form priority note; `core`'s `render` used to be a method,
 * now it's a constructor-injected field, which is why `scene.render = vi.fn()` below still works
 * unchanged), so this builds a bare object prototype-chained to `GachaSceneCore.prototype` via
 * `Object.create` instead of subclassing — same end result (the getter `pool` and the two target
 * methods run for real against plain instance fields) without invoking the real constructor.
 */
import { describe, it, expect, vi } from 'vitest';
import * as log from '../src/net/log';
import { initI18n, t } from '../src/i18n';
import { GachaSceneCore } from '../src/scenes/GachaScene/core';
import type { GachaDrawResult, FateRedeemResult } from '../src/scenes/GachaScene/core';
import type { GachaPool } from '../src/net/ApiClient';
import { BusyTracker, TimeoutError } from '../src/ui/busyTracker';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

function makePool(overrides: Partial<GachaPool> = {}): GachaPool {
  return { id: 'pool1', name: 'Standard', cost: 100, featuredLegendary: 'hero_x', ...overrides } as unknown as GachaPool;
}

/** Only the fields onDraw()/onRedeemFate() actually touch, prototype-chained to the real
 *  GachaSceneCore so `this.pool` (a getter on the prototype) and the two methods run for real. */
function buildScene(overrides: {
  pools?: GachaPool[]; poolIdx?: number;
  draw?: ReturnType<typeof vi.fn>; redeemFate?: ReturnType<typeof vi.fn>;
} = {}): any {
  const scene = Object.create(GachaSceneCore.prototype) as any;
  scene.pools = overrides.pools ?? [makePool()];
  scene.poolIdx = overrides.poolIdx ?? 0;
  scene.bt = new BusyTracker();
  scene.reveal = null;
  scene.revealOverflow = null;
  scene.render = vi.fn();
  scene.cb = {
    draw: overrides.draw ?? vi.fn(async (): Promise<GachaDrawResult> => ({ ok: true, results: [], overflow: { cardMailed: 0, cardCompensatedCoins: 0, equipMailed: 0, equipCompensatedCoins: 0 } })),
    redeemFate: overrides.redeemFate ?? vi.fn(async (): Promise<FateRedeemResult> => ({ ok: true, granted: 'hero_x' })),
  };
  return scene;
}

// ── onDraw ────────────────────────────────────────────────────────────────────

describe('GachaScene — onDraw() busy-lock', () => {
  it('a second call while the first is in flight does not re-issue the draw', async () => {
    const draw = vi.fn(() => new Promise<GachaDrawResult>(() => {})); // never resolves
    const scene = buildScene({ draw });

    void scene.onDraw(10);
    void scene.onDraw(10);
    await Promise.resolve();

    expect(draw).toHaveBeenCalledTimes(1);
    expect(scene.bt.busy).toBe(true);
  });

  it('is a no-op when there is no active pool', async () => {
    const draw = vi.fn();
    const scene = buildScene({ pools: [], draw });

    await scene.onDraw(1);

    expect(draw).not.toHaveBeenCalled();
  });
});

describe('GachaScene — onDraw() catch/timeout branch', () => {
  it('maps a TimeoutError to the network-timeout toast and unlocks', async () => {
    const draw = vi.fn().mockRejectedValueOnce(new TimeoutError());
    const scene = buildScene({ draw });
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onDraw(1);

    expect(spy).toHaveBeenCalledWith(t('common.networkTimeout'), 'error');
    expect(scene.bt.busy).toBe(false);
    expect(scene.reveal).toBeNull(); // never set on failure
  });

  it('maps any other thrown error to the generic gacha-error toast', async () => {
    const draw = vi.fn().mockRejectedValueOnce(new Error('network down'));
    const scene = buildScene({ draw });
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onDraw(10);

    expect(spy).toHaveBeenCalledWith(t('gacha.error'), 'error');
  });
});

// ── onRedeemFate ──────────────────────────────────────────────────────────────

describe('GachaScene — onRedeemFate() guards', () => {
  it('is a no-op when the active pool has no featuredLegendary', async () => {
    const redeemFate = vi.fn();
    const scene = buildScene({ pools: [makePool({ featuredLegendary: undefined })], redeemFate });

    await scene.onRedeemFate();

    expect(redeemFate).not.toHaveBeenCalled();
  });

  it('a second call while the first is in flight does not re-issue the redeem', async () => {
    const redeemFate = vi.fn(() => new Promise<FateRedeemResult>(() => {}));
    const scene = buildScene({ redeemFate });

    void scene.onRedeemFate();
    void scene.onRedeemFate();
    await Promise.resolve();

    expect(redeemFate).toHaveBeenCalledTimes(1);
    expect(scene.bt.busy).toBe(true);
  });
});

describe('GachaScene — onRedeemFate() success', () => {
  it('redeems the active pool\'s featured legendary and toasts the granted item', async () => {
    const redeemFate = vi.fn(async (): Promise<FateRedeemResult> => ({ ok: true, granted: 'Golden Phoenix' }));
    const scene = buildScene({ redeemFate });
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onRedeemFate();

    expect(redeemFate).toHaveBeenCalledWith('hero_x');
    expect(spy).toHaveBeenCalledWith(t('gacha.fate.redeemed', { item: 'Golden Phoenix' }), 'success');
    expect(scene.bt.busy).toBe(false);
  });
});

describe('GachaScene — onRedeemFate() failure', () => {
  it('a rejected result (ok:false) toasts the mapped key', async () => {
    const redeemFate = vi.fn(async (): Promise<FateRedeemResult> => ({ ok: false, key: 'gacha.fate.insufficientPoints' as never }));
    const scene = buildScene({ redeemFate });
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onRedeemFate();

    expect(spy).toHaveBeenCalledWith(t('gacha.fate.insufficientPoints' as never), 'error');
  });

  it('a TimeoutError maps to the shared network-timeout toast', async () => {
    const redeemFate = vi.fn().mockRejectedValueOnce(new TimeoutError());
    const scene = buildScene({ redeemFate });
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onRedeemFate();

    expect(spy).toHaveBeenCalledWith(t('common.networkTimeout'), 'error');
  });

  it('any other thrown error maps to the generic gacha-error toast', async () => {
    const redeemFate = vi.fn().mockRejectedValueOnce(new Error('boom'));
    const scene = buildScene({ redeemFate });
    const spy = vi.spyOn(log, 'showToastMessage');

    await scene.onRedeemFate();

    expect(spy).toHaveBeenCalledWith(t('gacha.error'), 'error');
  });
});
