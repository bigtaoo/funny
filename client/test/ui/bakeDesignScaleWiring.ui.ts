// The seam ADR-073's fix actually hangs on: `ScalingManager.applyScaling` pushing `gameLayer.scale`
// into `render/bake.ts` via `setDesignScale`.
//
// Why this file exists as its own test: `bakePageResolution.test.ts` covers the arithmetic, but it
// sets the scale by calling `setDesignScale()` itself — so deleting the one line in applyScaling
// that actually calls it leaves all 20 of those cases green while the 111 MB texture comes straight
// back. Same shape of gap ADR-072 recorded ("首轮测试全在场景层和视图层，漏了中间那层接线，而原 bug
// 恰恰只长在那里"). `pixiAppViews.ui.ts` covers the half above this one (onResize -> scaling.resize)
// against a mocked scaling, so between the two files the whole chain is pinned.
//
// Lives in the UI suite because it needs a REAL ScalingManager, and that needs working
// PIXI.Graphics/Container — which is exactly what the headless PIXI adapter here provides. The
// renderer is still a stub: bake() only ever reads `.resolution` off it and calls `.render()`.
//
// Run: npm run test:ui

import { describe, it, expect, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { ScalingManager, createLayout } from '../../src/layout/ScalingManager';
import {
  bake, clearBakeCache, pageBakeResolution, setBakeRenderer, resetDesignScaleForTest,
} from '../../src/render/bake';
import { Side } from '../../src/game';

/** The reported iPhone 13 in-app WebView geometry from the 2026-08-25 crash loop. */
const CRASH_VP = { w: 750, h: 270, dpr: 3 } as const;

/** Enough of a PIXI.Application for ScalingManager: a stage to parent onto, and a screen size. */
function fakeApp(w: number, h: number): PIXI.Application {
  return {
    stage: new PIXI.Container(),
    screen: { width: w, height: h },
  } as unknown as PIXI.Application;
}

function build(w: number, h: number, dpr: number) {
  setBakeRenderer({ resolution: dpr, render: () => {} } as unknown as PIXI.IRenderer);
  const layout = createLayout(w, h, Side.Bottom);
  const scaling = new ScalingManager(fakeApp(w, h), layout);
  return { scaling, layout };
}

/** Real (device) pixels of a bake, read the way MemoryMonitor's byte accounting does. */
function realSize(tex: PIXI.Texture | null): { w: number; h: number } {
  const bt = tex!.baseTexture;
  return { w: bt.realWidth, h: bt.realHeight };
}

afterEach(() => {
  clearBakeCache();
  resetDesignScaleForTest();
  setBakeRenderer(null as unknown as PIXI.IRenderer);
});

describe('ScalingManager feeds the bake layer its on-screen scale', () => {
  it('constructing one is enough — the scale is pushed from applyScaling, not by the caller', () => {
    // Nothing in this test calls setDesignScale. If applyScaling stops pushing it, designScale stays
    // at its default 1 and pageBakeResolution reports the raw dpr — the pre-fix behaviour.
    const { scaling, layout } = build(CRASH_VP.w, CRASH_VP.h, CRASH_VP.dpr);
    expect(scaling.gameLayer.scale.x).toBeCloseTo(0.25, 6);
    expect(pageBakeResolution()).toBe(0.75);
    expect(pageBakeResolution()).toBeLessThan(CRASH_VP.dpr);

    // And the texture that comes out is the whole point: 1944x810, not 9000x3240.
    const tex = bake('paper', new PIXI.Container(), layout.designWidth, layout.designHeight, { pageScale: true });
    expect(realSize(tex)).toEqual({ w: 1944, h: 810 });
    const mb = realSize(tex).w * realSize(tex).h * 4 / (1024 * 1024);
    expect(mb).toBeLessThan(10);
  });

  it('the page texture never falls below the device pixels it covers', () => {
    const { scaling, layout } = build(CRASH_VP.w, CRASH_VP.h, CRASH_VP.dpr);
    const scale = scaling.gameLayer.scale.x;
    const tex = bake('paper', new PIXI.Container(), layout.designWidth, layout.designHeight, { pageScale: true });
    const { w, h } = realSize(tex);
    expect(w).toBeGreaterThanOrEqual(Math.floor(layout.designWidth * scale * CRASH_VP.dpr));
    expect(h).toBeGreaterThanOrEqual(Math.floor(layout.designHeight * scale * CRASH_VP.dpr));
  });

  it('a resize re-pushes the scale, and the new page texture is a different one', () => {
    // The rotation path: PixiAppViews.onResize builds a fresh layout and calls scaling.resize()
    // (pinned against a mocked scaling in pixiAppViews.ui.ts); this is what the real one then does.
    const { scaling, layout } = build(CRASH_VP.w, CRASH_VP.h, CRASH_VP.dpr);
    const landscape = bake('paper', new PIXI.Container(), layout.designWidth, layout.designHeight, { pageScale: true });
    const landscapeRes = pageBakeResolution();

    const portrait = createLayout(390, 664, Side.Bottom);
    scaling.resize(390, 664, portrait);
    expect(pageBakeResolution()).not.toBe(landscapeRes);

    const after = bake('paper', new PIXI.Container(), portrait.designWidth, portrait.designHeight, { pageScale: true });
    expect(after).not.toBe(landscape);
  });

  it('a same-size re-fit is idempotent — no new texture for the same geometry', () => {
    // Mobile browsers fire resize for chrome bars and keyboards. Re-fitting to the same box must not
    // mint a second copy of every page layer (PixiAppViews has a no-change guard in front, but the
    // resolution quantization is the backstop if a caller ever bypasses it).
    const { scaling, layout } = build(CRASH_VP.w, CRASH_VP.h, CRASH_VP.dpr);
    const first = bake('paper', new PIXI.Container(), layout.designWidth, layout.designHeight, { pageScale: true });
    scaling.resize(CRASH_VP.w, CRASH_VP.h, createLayout(CRASH_VP.w, CRASH_VP.h, Side.Bottom));
    const second = bake('paper', new PIXI.Container(), layout.designWidth, layout.designHeight, { pageScale: true });
    expect(second).toBe(first);
  });

  it('the landscape aspect cap shows up as a real desk surround, drawn by the real ScalingManager', () => {
    // ADR-073 decision 2 claims "past the cap it contains to height and the desk surround takes the
    // bands". deskSurround.ui.ts asserts drawDeskSurround in isolation against a hand-rolled mirror
    // of applyScaling's math; this asserts the actual ScalingManager reaches that state at the
    // reported viewport — i.e. that the cap and the surround are really connected.
    const { scaling, layout } = build(CRASH_VP.w, CRASH_VP.h, CRASH_VP.dpr);
    expect(layout.designWidth).toBe(2592);            // capped, not 3000
    expect(scaling.deskLayer.visible).toBe(true);     // therefore bands, therefore desk
    expect(scaling.gameLayer.x).toBeGreaterThanOrEqual(2);
  });

  it('a phone that fits its design rect still draws no desk at all', () => {
    // The other side of the cap: a real phone aspect is below it, so nothing changes for real
    // devices — no bands, no surround, no extra composite.
    const { scaling } = build(844, 390, 3);
    expect(scaling.deskLayer.visible).toBe(false);
    expect(scaling.gameLayer.x).toBeLessThan(2);
  });
});
