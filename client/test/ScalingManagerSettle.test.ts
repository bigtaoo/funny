import { describe, it, expect } from 'vitest';
import { resettledLayout } from '../src/layout/ScalingManager';
import { Side } from '../src/game';

// WebKit can report env(safe-area-inset-*) as 0 on the very first synchronous read after a
// cold load (viewport-fit=cover not yet settled) — app.ts re-reads insets once the asset-preload
// gate resolves and calls resettledLayout() to decide whether a rescale is needed. See app.ts and
// the "Safe-area boot race" note in design/game/UI_DESIGN.md.

const ZERO = { top: 0, right: 0, bottom: 0, left: 0 };
const IPHONE13_PORTRAIT = { top: 47, right: 0, bottom: 34, left: 0 };

describe('resettledLayout', () => {
  it('returns null when no settled reading is available (platform has no getSafeAreaInsets)', () => {
    expect(resettledLayout(390, 844, ZERO, undefined)).toBeNull();
  });

  it('returns null when the settled insets match the boot-time insets exactly', () => {
    expect(resettledLayout(390, 844, ZERO, { ...ZERO })).toBeNull();
    expect(resettledLayout(390, 844, IPHONE13_PORTRAIT, { ...IPHONE13_PORTRAIT })).toBeNull();
  });

  it('returns null when the boot-time read was undefined but settles to all-zero (desktop/no-notch)', () => {
    expect(resettledLayout(390, 844, undefined, ZERO)).toBeNull();
  });

  it('rebuilds the layout when the settled top inset differs from a stale 0 boot-time read', () => {
    const layout = resettledLayout(390, 844, ZERO, IPHONE13_PORTRAIT);
    expect(layout).not.toBeNull();
    // Safe drawable height shrinks by top+bottom (47+34), so the recomputed design height
    // must reflect the smaller safe-area aspect, not the raw screen aspect.
    const availH = 844 - 47 - 34;
    expect(layout!.designHeight).toBe(Math.max(1920, Math.round(1080 * (availH / 390))));
  });

  it('rebuilds when only a single inset field changed (e.g. bottom home-indicator only)', () => {
    const layout = resettledLayout(390, 844, ZERO, { ...ZERO, bottom: 34 });
    expect(layout).not.toBeNull();
  });

  it('picks up a localSide override for the rebuilt layout (netplay joiner)', () => {
    const layout = resettledLayout(1920, 1080, ZERO, { top: 0, right: 47, bottom: 0, left: 47 }, Side.Top);
    expect(layout).not.toBeNull();
    expect(layout!.localSide).toBe(Side.Top);
  });
});
