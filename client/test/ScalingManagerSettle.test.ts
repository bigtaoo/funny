import { describe, it, expect } from 'vitest';
import { resettledLayout } from '../src/layout/ScalingManager';
import { Side } from '../src/game';

// WebKit can report env(safe-area-inset-*) as 0 on the very first synchronous read after a
// cold load (viewport-fit=cover not yet settled) — app.ts re-reads insets once the asset-preload
// gate resolves and calls resettledLayout() to decide whether a rescale is needed. See app.ts and
// the "Safe-area boot race" note in design/game/UI_DESIGN.md.

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };
const IPHONE13_PORTRAIT = { top: 47, right: 0, bottom: 34, left: 0 };
type Insets = typeof ZERO | undefined;

/** Same viewport size on both sides of the gate — only the insets differ. */
function settle(w: number, h: number, boot: Insets, settled: Insets, side?: Side) {
  return resettledLayout({ width: w, height: h, insets: boot }, { width: w, height: h, insets: settled }, side);
}

describe('resettledLayout', () => {
  it('returns null when no settled reading is available (platform has no getSafeAreaInsets)', () => {
    expect(settle(390, 844, ZERO, undefined)).toBeNull();
  });

  it('returns null when the settled insets match the boot-time insets exactly', () => {
    expect(settle(390, 844, ZERO, { ...ZERO })).toBeNull();
    expect(settle(390, 844, IPHONE13_PORTRAIT, { ...IPHONE13_PORTRAIT })).toBeNull();
  });

  it('returns null when the boot-time read was undefined but settles to all-zero (desktop/no-notch)', () => {
    expect(settle(390, 844, undefined, ZERO)).toBeNull();
  });

  it('rebuilds the layout when the settled top inset differs from a stale 0 boot-time read', () => {
    const layout = settle(390, 844, ZERO, IPHONE13_PORTRAIT);
    expect(layout).not.toBeNull();
    // Safe drawable height shrinks by top+bottom (47+34), so the recomputed design height
    // must reflect the smaller safe-area aspect, not the raw screen aspect.
    const availH = 844 - 47 - 34;
    // 390 wide → design width 780 (layout/designSize.ts).
    expect(layout!.designHeight).toBe(Math.round(780 * (availH / 390)));
  });

  it('rebuilds when only a single inset field changed (e.g. bottom home-indicator only)', () => {
    const layout = settle(390, 844, ZERO, { ...ZERO, bottom: 34 });
    expect(layout).not.toBeNull();
  });

  it('picks up a localSide override for the rebuilt layout (netplay joiner)', () => {
    const layout = settle(1920, 1080, ZERO, { top: 0, right: 47, bottom: 0, left: 47 }, Side.Top);
    expect(layout).not.toBeNull();
    expect(layout!.localSide).toBe(Side.Top);
  });

  it('rebuilds when the viewport size changed across the gate with no inset change (reshaped iframe)', () => {
    const layout = resettledLayout({ width: 400, height: 700, insets: ZERO }, { width: 722, height: 406, insets: ZERO });
    expect(layout).not.toBeNull();
    expect(layout!.designWidth).toBeGreaterThan(layout!.designHeight);
  });

  it('rebuilds on a size change on a platform without insets, and only then', () => {
    expect(resettledLayout({ width: 400, height: 700, insets: undefined }, { width: 722, height: 406, insets: undefined })).not.toBeNull();
    expect(resettledLayout({ width: 722, height: 406, insets: undefined }, { width: 722, height: 406, insets: undefined })).toBeNull();
  });
});
