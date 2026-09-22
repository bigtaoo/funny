/**
 * baseCriticalRing.ui.ts — regression test for the base critical-HP ring (2026-09-22 sprite-bake
 * rewrite, `claudedocs/client-render-budget.md` §13).
 *
 * Background: `applyCriticalRing()` used to `clear()` + `drawRoundedRect()` `ringGfx` on every frame
 * a base is critical, with `pad` breathing 6 -> 15px. It is now stroked ONCE at `CRIT_RING_PAD_MAX`
 * (in `buildBaseRef`, via `buildBases()`), and the breath is a `scale` transform (same formula as
 * `HUDView`'s `upgradeGlow`) + `alpha` — no geometry touched on the per-frame path. This was never
 * covered directly; only exercised incidentally by scenes that build a full BoardView.
 *
 * Builds real BaseRef objects via the module's own `buildBases()` (not a hand-rolled BaseRef) so the
 * test can't drift from whatever `buildBaseRef()` actually wires up — which needs a real castle
 * texture (`PIXI.Texture.from(baseTexUrl)`), so this lives in test/ui/ (data-URI asset stub, no
 * `document` needed for the crossOrigin path) rather than the default suite (per-file real URLs,
 * which `determineCrossOrigin` cannot resolve headless — see vitest.ui.config.ts / stubBinaryAssets).
 *
 * Run with: npm run test:ui
 */
import '../harness/pixiHeadless';
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { Side } from '@nw/engine/types';
import {
  buildBases, applyCriticalRing, setBaseCritical,
  CRIT_RING_SPEED, CRIT_RING_PAD_MIN, CRIT_RING_PAD_MAX,
  type BasesHost,
} from '../../src/render/BoardView/bases';
import type { ILayout, Rect } from '../../src/layout/ILayout';

function rect(x: number, y: number, w: number, h: number): Rect { return { x, y, w, h }; }

/** Minimal ILayout — buildBases only calls playerBaseRect()/enemyBaseRect(); setBaseCritical also
 *  reads localSide (via sideToOwner) to route owner 0/1 to playerBase/enemyBase. */
function fakeLayout(): ILayout {
  return {
    localSide: Side.Bottom,
    playerBaseRect: () => rect(860, 840, 200, 120),
    enemyBaseRect:  () => rect(860, 60,  200, 120),
  } as unknown as ILayout;
}

/** `t` such that `sin(t * CRIT_RING_SPEED) === target` (target in [-1, 1]). */
function tFor(sinTarget: number): number {
  return Math.asin(sinTarget) / CRIT_RING_SPEED;
}

describe('applyCriticalRing()', () => {
  it('does nothing when the base is not critical — ring stays hidden, no geometry touched', () => {
    const { playerBase } = buildBases(fakeLayout(), new PIXI.Container());
    expect(playerBase.critical).toBe(false);
    expect(playerBase.ringGfx.visible).toBe(false);
    applyCriticalRing(playerBase, 5 /* arbitrary t */);
    expect(playerBase.ringGfx.visible).toBe(false);
  });

  it('does nothing for a null base (call-site guard)', () => {
    expect(() => applyCriticalRing(null, 0)).not.toThrow();
  });

  it('at the throb\'s widest point (pad = PAD_MAX), the ring is shown at scale 1', () => {
    const { playerBase } = buildBases(fakeLayout(), new PIXI.Container());
    playerBase.critical = true;
    applyCriticalRing(playerBase, tFor(1)); // sin = 1 -> p = 1 -> pad = CRIT_RING_PAD_MAX
    expect(playerBase.ringGfx.visible).toBe(true);
    expect(playerBase.ringGfx.scale.x).toBeCloseTo(1, 6);
    expect(playerBase.ringGfx.scale.y).toBeCloseTo(1, 6);
    expect(playerBase.ringGfx.alpha).toBeCloseTo(0.85, 6); // 0.35 + 0.5*p, p=1
  });

  it('at the throb\'s narrowest point (pad = PAD_MIN), scale shrinks to the exact ratio formula', () => {
    const { playerBase } = buildBases(fakeLayout(), new PIXI.Container());
    playerBase.critical = true;
    applyCriticalRing(playerBase, tFor(-1)); // sin = -1 -> p = 0 -> pad = CRIT_RING_PAD_MIN
    const { rect: r } = playerBase;
    const expectedScaleX = (r.w + CRIT_RING_PAD_MIN * 2) / (r.w + CRIT_RING_PAD_MAX * 2);
    const expectedScaleY = (r.h + CRIT_RING_PAD_MIN * 2) / (r.h + CRIT_RING_PAD_MAX * 2);
    expect(playerBase.ringGfx.scale.x).toBeCloseTo(expectedScaleX, 6);
    expect(playerBase.ringGfx.scale.y).toBeCloseTo(expectedScaleY, 6);
    expect(playerBase.ringGfx.alpha).toBeCloseTo(0.35, 6); // 0.35 + 0.5*p, p=0
    // A non-square base rect (w !== h here) must not collapse to a single uniform scale — the two
    // axes breathe independently because the pad is applied to a rect, not a circle.
    expect(expectedScaleX).not.toBeCloseTo(expectedScaleY, 3);
  });

  it('the ring is stroked once and never re-triangulated by the per-frame path', () => {
    const { playerBase } = buildBases(fakeLayout(), new PIXI.Container());
    playerBase.critical = true;
    const geom = playerBase.ringGfx.geometry as unknown as { dirty: number };
    applyCriticalRing(playerBase, tFor(1));
    const dirtyAfterFirst = geom.dirty;
    for (let i = 0; i < 30; i++) applyCriticalRing(playerBase, tFor(1) + i * 0.001);
    expect(geom.dirty).toBe(dirtyAfterFirst); // scale/alpha writes never touch GraphicsGeometry
  });
});

describe('setBaseCritical()', () => {
  function host(playerBase: ReturnType<typeof buildBases>['playerBase'], enemyBase: ReturnType<typeof buildBases>['enemyBase']): BasesHost {
    return { layout: fakeLayout(), container: new PIXI.Container(), playerBase, enemyBase };
  }

  it('routes owner 0 to playerBase (localSide = Bottom) and flips .critical', () => {
    const { playerBase, enemyBase } = buildBases(fakeLayout(), new PIXI.Container());
    const h = host(playerBase, enemyBase);
    setBaseCritical(h, 0, true);
    expect(playerBase.critical).toBe(true);
    expect(enemyBase.critical).toBe(false);
  });

  it('routes owner 1 to enemyBase', () => {
    const { playerBase, enemyBase } = buildBases(fakeLayout(), new PIXI.Container());
    const h = host(playerBase, enemyBase);
    setBaseCritical(h, 1, true);
    expect(enemyBase.critical).toBe(true);
    expect(playerBase.critical).toBe(false);
  });

  it('turning critical off hides the ring WITHOUT clearing its geometry (no per-toggle re-stroke)', () => {
    const { playerBase, enemyBase } = buildBases(fakeLayout(), new PIXI.Container());
    const h = host(playerBase, enemyBase);
    setBaseCritical(h, 0, true);
    applyCriticalRing(playerBase, tFor(1)); // make the ring actually visible first
    expect(playerBase.ringGfx.visible).toBe(true);
    const indicesBefore = playerBase.ringGfx.geometry.graphicsData.length;
    expect(indicesBefore).toBeGreaterThan(0);

    setBaseCritical(h, 0, false);
    expect(playerBase.critical).toBe(false);
    expect(playerBase.ringGfx.visible).toBe(false);
    // The old implementation called ringGfx.clear() here; the new one must not, since the ring is
    // meant to be stroked exactly once (in buildBaseRef) for the lifetime of the base.
    expect(playerBase.ringGfx.geometry.graphicsData.length).toBe(indicesBefore);
  });

  it('is idempotent — setting the same state twice does not toggle it back', () => {
    const { playerBase, enemyBase } = buildBases(fakeLayout(), new PIXI.Container());
    const h = host(playerBase, enemyBase);
    setBaseCritical(h, 0, true);
    setBaseCritical(h, 0, true);
    expect(playerBase.critical).toBe(true);
  });
});
