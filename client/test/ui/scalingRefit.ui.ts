// ScalingManager.refit / fitLayout — the two halves of "the viewport changed shape" since
// 2026-10-05. The CrazyGames QA preview showed a match that outlived a resize drawn as a strip down
// the left edge: the scaling had been handed the NEW layout while the mounted scene graph was built
// against the old one. `refit` must keep containing the old design rect; only `fitLayout` (a screen
// built against the new layout) may move it. `pixiAppViews.ui.ts` pins who calls which.
//
// Run: npm run test:ui

import { describe, it, expect, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { ScalingManager, createLayout } from '../../src/layout/ScalingManager';
import { resetDesignScaleForTest } from '../../src/render/bake';
import { Side } from '../../src/game';

function fakeApp(w: number, h: number): PIXI.Application {
  return { stage: new PIXI.Container(), screen: { width: w, height: h } } as unknown as PIXI.Application;
}

afterEach(() => resetDesignScaleForTest());

describe('ScalingManager refit vs fitLayout', () => {
  it('refit contains the CURRENT design rect in the new viewport (centred, nothing cut off)', () => {
    const portrait = createLayout(400, 700, Side.Bottom);
    const scaling = new ScalingManager(fakeApp(400, 700), portrait);
    scaling.refit(722, 406);

    const { w, h } = scaling.designSize;
    expect(w).toBe(portrait.designWidth);
    expect(h).toBe(portrait.designHeight);
    const s = scaling.gameLayer.scale.x;
    expect(s).toBeCloseTo(Math.min(722 / w, 406 / h), 6);
    // Whole page on screen, centred horizontally — not pinned to the left edge.
    expect(h * s).toBeLessThanOrEqual(406 + 0.5);
    expect(scaling.gameLayer.x).toBe(Math.round((722 - w * s) / 2));
  });

  it('fitLayout then adopts the new rect at the viewport refit already recorded', () => {
    const scaling = new ScalingManager(fakeApp(400, 700), createLayout(400, 700, Side.Bottom));
    scaling.refit(722, 406);
    const landscape = createLayout(722, 406, Side.Bottom);
    scaling.fitLayout(landscape);

    expect(scaling.designSize).toEqual({ w: landscape.designWidth, h: landscape.designHeight });
    // A landscape rect at a landscape viewport fills it.
    expect(landscape.designWidth * scaling.gameLayer.scale.x).toBeCloseTo(722, 0);
    expect(landscape.designHeight * scaling.gameLayer.scale.y).toBeCloseTo(406, 0);
  });
});
