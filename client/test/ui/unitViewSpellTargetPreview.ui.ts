// UnitView.setSpellTargetPreview — direct unit coverage (2026-08-08 spell-target outline fix).
// gameRendererSpellTargetPreview.ui.ts already covers the *hit-test* logic end-to-end through
// GameRenderer/input.ts (which unit ids end up in the preview set for a given spell/anchor). This
// file covers the *rendering* side directly: does setSpellTargetPreview actually call
// StickmanRuntime.setOutlineFlash the way it's supposed to.
//
// In the headless PIXI test environment the .tao binary asset is stubbed (vitest.ui.config.ts's
// stubBinaryAssets → a 1x1 PNG that jszip can't parse), so StickmanRuntime.loadAsset() always
// rejects and UnitView never actually builds a real stickman container for a unit spawned through
// the normal sync() path — every unit renders as the circle-placeholder fallback, same root cause
// documented in unit-view-tao-asset-imports-not-unit-testable.md. Rather than fight that, these
// tests inject a fake runtime straight into UnitView's private `stickmanRuntimes` map (same
// technique test/ui/marchTokenAnimation.ui.ts uses for its pooled march-token runtimes) — this
// exercises setSpellTargetPreview's actual diff/call logic without depending on asset resolution.

import { describe, it, expect, vi } from 'vitest';
import { createLayout } from '../../src/layout/ScalingManager';
import { BoardView } from '../../src/render/BoardView';
import { UnitView } from '../../src/render/UnitView';
import { fx } from '../../src/render/theme';

function makeFakeRuntime() {
  return { setOutlineFlash: vi.fn() };
}

function buildUnitView() {
  const boardView = new BoardView(createLayout(800, 1280));
  const unitView = new UnitView(boardView);
  return { boardView, unitView };
}

/** Direct access to the private stickmanRuntimes map — see file header. */
function runtimesOf(unitView: UnitView): Map<number, ReturnType<typeof makeFakeRuntime>> {
  return (unitView as any).stickmanRuntimes;
}

describe('UnitView.setSpellTargetPreview', () => {
  it('lights up every previewed unit with a live stickman runtime, in the meteor/rockslide target color', () => {
    const { unitView } = buildUnitView();
    const a = makeFakeRuntime();
    const b = makeFakeRuntime();
    runtimesOf(unitView).set(1, a);
    runtimesOf(unitView).set(2, b);

    unitView.setSpellTargetPreview(new Set([1, 2]));

    expect(a.setOutlineFlash).toHaveBeenCalledTimes(1);
    expect(b.setOutlineFlash).toHaveBeenCalledTimes(1);
    const [colorA, alphaA] = a.setOutlineFlash.mock.calls[0];
    const [colorB, alphaB] = b.setOutlineFlash.mock.calls[0];
    // Same hue as the board's target-rect fill (BoardView's HIGHLIGHT_METEOR) — one signal, not two.
    expect(colorA).toBe(fx.meteor);
    expect(colorB).toBe(fx.meteor);
    expect(alphaA).toBeGreaterThan(0);
    expect(alphaA).toBeLessThanOrEqual(1);
    expect(alphaB).toBe(alphaA);

    unitView.destroy();
  });

  it('clears exactly the units that drop out of the set on the next call, leaves survivors alone', () => {
    const { unitView } = buildUnitView();
    const stays  = makeFakeRuntime();
    const drops  = makeFakeRuntime();
    const joins  = makeFakeRuntime();
    runtimesOf(unitView).set(1, stays);
    runtimesOf(unitView).set(2, drops);
    runtimesOf(unitView).set(3, joins);

    unitView.setSpellTargetPreview(new Set([1, 2])); // hovering anchor A: units 1 and 2 inside
    stays.setOutlineFlash.mockClear();
    drops.setOutlineFlash.mockClear();

    unitView.setSpellTargetPreview(new Set([1, 3])); // moved to anchor B: 2 drops out, 3 joins, 1 stays

    expect(drops.setOutlineFlash).toHaveBeenCalledWith(null); // cleared
    expect(joins.setOutlineFlash).toHaveBeenCalledWith(fx.meteor, expect.any(Number)); // newly lit
    expect(stays.setOutlineFlash).toHaveBeenCalledWith(fx.meteor, expect.any(Number)); // re-asserted, not cleared then relit as a visible flicker
    expect(stays.setOutlineFlash).not.toHaveBeenCalledWith(null);

    unitView.destroy();
  });

  it('clearing to an empty set turns every previously-previewed unit off', () => {
    const { unitView } = buildUnitView();
    const a = makeFakeRuntime();
    runtimesOf(unitView).set(1, a);

    unitView.setSpellTargetPreview(new Set([1]));
    a.setOutlineFlash.mockClear();

    unitView.setSpellTargetPreview(new Set());
    expect(a.setOutlineFlash).toHaveBeenCalledWith(null);

    unitView.destroy();
  });

  it('is a no-op for unit ids with no live stickman runtime (circle placeholder / already gone)', () => {
    const { unitView } = buildUnitView();
    // Id 99 was never registered in stickmanRuntimes — e.g. a circle-placeholder unit whose .tao
    // asset hasn't resolved yet, or a unit that already died and was released back to the pool.
    // Must not throw.
    expect(() => unitView.setSpellTargetPreview(new Set([99]))).not.toThrow();
    unitView.destroy();
  });

  it('is a genuine no-op when called twice with the same Set reference (10Hz refresh calling with an unchanged selection)', () => {
    const { unitView } = buildUnitView();
    const a = makeFakeRuntime();
    runtimesOf(unitView).set(1, a);

    const ids = new Set([1]);
    unitView.setSpellTargetPreview(ids);
    a.setOutlineFlash.mockClear();

    unitView.setSpellTargetPreview(ids); // same reference — GameRenderer/input.ts passes a shared
    // EMPTY_UNIT_IDS constant on every no-selection refresh tick, so this path runs constantly.
    expect(a.setOutlineFlash).not.toHaveBeenCalled();

    unitView.destroy();
  });
});
