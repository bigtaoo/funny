/**
 * bakePageResolution.test.ts — the 2026-08-25 mobile-crash fix, pinned.
 *
 * A page-sized bake is drawn in DESIGN space but only ever SEEN at `gameLayer.scale`, so sizing its
 * RenderTexture by the renderer's own resolution oversamples it by 1/scale in each axis. On the
 * iPhone 13 in-app WebView that reported the crash loop (vp 750x270 CSS px, dpr 3) that made every
 * full-page layer 9000x3240 = 111 MB, and the lobby draws three of them.
 *
 * The invariant these tests exist to hold is not "the number went down" but the two-sided bound in
 * `covers the screen without oversampling it`: a page bake must carry AT LEAST one texel per device
 * pixel (no softness) and NOT MUCH MORE than one (no waste). Every other case here is a guard on the
 * clamps that make that safe to ship — small chrome untouched, desktop never inflated, cache keyed
 * by resolution.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── PIXI stub: only RenderTexture.create + the baseTexture geometry bake reads back ─────────────
vi.mock('pixi.js-legacy', () => {
  class FakeRenderTexture {
    baseTexture: { realWidth: number; realHeight: number };
    constructor(readonly width: number, readonly height: number, readonly resolution: number) {
      // Same rounding real PIXI applies (BaseTexture's realWidth getter), so a fractional
      // resolution here produces the same whole-pixel framebuffer the GPU would get.
      this.baseTexture = {
        realWidth:  Math.round(width * resolution),
        realHeight: Math.round(height * resolution),
      };
    }
    static create({ width, height, resolution }: { width: number; height: number; resolution: number }) {
      return new FakeRenderTexture(width, height, resolution);
    }
    destroy(): void { /* no GPU here */ }
  }
  class FakeContainer { destroy(): void { /* noop */ } }
  return { RenderTexture: FakeRenderTexture, Container: FakeContainer };
});

import * as PIXI from 'pixi.js-legacy';
import {
  bake, bakeEntries, bakeLazy, bakeResolution, bakeStats, clearBakeCache, hasBakeRenderer,
  pageBakeResolution, screenBytes, setBakeRenderer, setDesignScale, resetDesignScaleForTest,
} from '../../src/render/bake';
import { createLayout } from '../../src/layout/ScalingManager';
import { Side } from '../../src/game';

/** A drawable the stub renderer is happy to "render". */
const obj = (): PIXI.DisplayObject => new PIXI.Container() as unknown as PIXI.DisplayObject;

function useRenderer(resolution: number): void {
  setBakeRenderer({ resolution, render: () => {} } as unknown as PIXI.IRenderer);
}

/** Real pixels of a bake, read back off the texture the way MemoryMonitor does. */
function realSize(tex: PIXI.Texture | null): { w: number; h: number } {
  const bt = (tex as unknown as { baseTexture: { realWidth: number; realHeight: number } }).baseTexture;
  return { w: bt.realWidth, h: bt.realHeight };
}

beforeEach(() => {
  clearBakeCache();
  resetDesignScaleForTest();
  useRenderer(1);
});

describe('pageBakeResolution', () => {
  it('is the renderer resolution until a design scale is pushed in', () => {
    // The pre-ScalingManager default has to reproduce the OLD sizing rather than guess: bake() can
    // be reached from a headless/e2e path where nothing ever computes a scale.
    useRenderer(3);
    expect(pageBakeResolution()).toBe(3);
  });

  it('is renderer resolution x design scale on the reported device', () => {
    useRenderer(3);
    setDesignScale(0.25);
    expect(pageBakeResolution()).toBe(0.75);
  });

  it('rounds UP to the next sixteenth, so a texel per device pixel is never undershot', () => {
    useRenderer(3);
    setDesignScale(844 / 2337); // iPhone 13 Safari landscape: exact scale 0.3611 -> 1.0833
    expect(pageBakeResolution()).toBe(1.125);
    expect(pageBakeResolution()).toBeGreaterThan(3 * (844 / 2337));
  });

  it('never exceeds the renderer resolution, so a magnified design rect is not inflated', () => {
    // 4K desktop: dpr 1, design rect shown at 2x. Sizing "for device pixels" would DOUBLE the
    // texture — a memory fix must not quietly grow anything.
    useRenderer(1);
    setDesignScale(2);
    expect(pageBakeResolution()).toBe(1);
  });

  it('floors a degenerate boot viewport instead of baking a smear', () => {
    // This is not hypothetical: a hidden/offscreen tab reads innerWidth 0 at startApp, so
    // createLayout(0, 0) hands ScalingManager a scale near 1/2000. Reproduced live 2026-08-25 in a
    // non-compositing browser pane. Without the floor every page layer bakes at 1/16.
    useRenderer(3);
    setDesignScale(1 / 2000);
    expect(pageBakeResolution()).toBe(0.25);
  });

  it('lets the renderer cap win over the floor, so a low-res target is never inflated', () => {
    useRenderer(0.125);
    setDesignScale(0.01);
    expect(pageBakeResolution()).toBe(0.125);
  });

  it('re-bakes at the right resolution once a real viewport arrives', () => {
    // The floor bounds the damage; the resolution-in-key is what actually repairs it.
    useRenderer(3);
    setDesignScale(1 / 2000);
    const degenerate = bake('paper', obj(), 1080, 1920, { pageScale: true });
    setDesignScale(0.3458);
    const real = bake('paper', obj(), 1080, 1920, { pageScale: true });
    expect(real).not.toBe(degenerate);
    expect(realSize(real).w).toBeGreaterThan(realSize(degenerate).w);
  });

  it('ignores a non-finite or non-positive scale rather than poisoning every later bake', () => {
    useRenderer(2);
    setDesignScale(0.5);
    setDesignScale(0);
    setDesignScale(Number.NaN);
    setDesignScale(-1);
    expect(pageBakeResolution()).toBe(1);
  });
});

describe('a page bake covers the screen without oversampling it', () => {
  // vp, dpr, and a label. Each row is a real reported or plausible client geometry.
  const CASES: Array<[string, number, number, number]> = [
    ['iPhone 13 in-app WebView, landscape (the crash)', 750, 270, 3],
    ['iPhone 13 Safari, landscape',                     844, 390, 3],
    ['iPhone 13, portrait',                             390, 664, 3],
    ['iPad mini, portrait',                             744, 1133, 2],
    ['desktop 720p, dpr 1',                            1280, 720, 1],
  ];

  it.each(CASES)('%s', (_label, vpW, vpH, dpr) => {
    const layout = createLayout(vpW, vpH, Side.Bottom);
    const scale = Math.min(vpW / layout.designWidth, vpH / layout.designHeight);
    useRenderer(dpr);
    setDesignScale(scale);

    const tex = bake('paper', obj(), layout.designWidth, layout.designHeight, { pageScale: true });
    const { w, h } = realSize(tex);

    // Device pixels the page actually occupies on this screen: its design size, shrunk by the
    // contain scale, in physical pixels.
    const needW = layout.designWidth * scale * dpr;
    const needH = layout.designHeight * scale * dpr;

    // Lower bound: at least one texel per device pixel, so nothing is softer than before.
    expect(w).toBeGreaterThanOrEqual(Math.floor(needW));
    expect(h).toBeGreaterThanOrEqual(Math.floor(needH));

    // Upper bound: the whole point. Only the resolution round-up may add slack, so 1.3x on AREA is
    // a generous ceiling — the pre-fix textures were 16x on the first row of this table.
    expect(w * h).toBeLessThan(needW * needH * 1.3);
  });

  it('is what stops the lobby asking a phone WebView for a third of a gigabyte', () => {
    // The exact reported geometry, and the exact three layers LobbyScene/build.ts bakes.
    const layout = createLayout(750, 270, Side.Bottom);
    const scale = Math.min(750 / layout.designWidth, 270 / layout.designHeight);
    useRenderer(3);
    setDesignScale(scale);

    for (const tag of ['lobbybg', 'decorc', 'wear']) {
      bake(tag, obj(), layout.designWidth, layout.designHeight, { pageScale: true });
    }
    const lobbyMB = bakeStats().bytes / (1024 * 1024);
    expect(bakeStats().count).toBe(3);
    // Pre-fix this was 3 x 111 MB. A phone must not be asked for anything near that at first paint.
    expect(lobbyMB).toBeLessThan(30);
  });
});

describe('opt-in, not global', () => {
  it('leaves a bake without pageScale at the renderer resolution', () => {
    // uiCache chrome / panelFrame atlas / boil frames ride on containers that animate above scale 1,
    // where a device-exact texture would visibly soften. They are kilobytes; they stay as they were.
    useRenderer(3);
    setDesignScale(0.25);
    const plain = realSize(bake('chrome', obj(), 100, 40));
    expect(plain).toEqual({ w: 300, h: 120 });
    const page = realSize(bake('page', obj(), 100, 40, { pageScale: true }));
    expect(page).toEqual({ w: 75, h: 30 });
  });

  it('applies to bakeLazy too, and still only draws on a miss', () => {
    useRenderer(3);
    setDesignScale(0.25);
    const draw = vi.fn(() => obj());
    const first = bakeLazy('lazy-page', draw, 200, 80, { pageScale: true });
    const second = bakeLazy('lazy-page', draw, 200, 80, { pageScale: true });
    expect(draw).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(realSize(first)).toEqual({ w: 150, h: 60 });
  });
});

describe('cache identity', () => {
  it('returns the same texture for a repeated key at an unchanged scale', () => {
    useRenderer(3);
    setDesignScale(0.25);
    const a = bake('paper', obj(), 400, 200, { pageScale: true });
    const b = bake('paper', obj(), 400, 200, { pageScale: true });
    expect(b).toBe(a);
  });

  it('does not hand back a texture baked for a different scale', () => {
    // Chrome bars sliding change the scale without necessarily changing the design rect, so the
    // pre-2026-08-25 key (tag + design size) could hit an entry sampled for a different rate and
    // stay soft for the rest of the session with nothing to blame.
    useRenderer(3);
    setDesignScale(0.25);
    const before = bake('paper', obj(), 400, 200, { pageScale: true });
    setDesignScale(0.5);
    const after = bake('paper', obj(), 400, 200, { pageScale: true });
    expect(after).not.toBe(before);
    expect(realSize(before)).toEqual({ w: 300, h: 150 });
    expect(realSize(after)).toEqual({ w: 600, h: 300 });
  });
});

describe('the two renderer-presence accessors', () => {
  it('hasBakeRenderer tracks whether one is wired', () => {
    // Callers branch on this to decide between a baked Sprite and a live Graphics (headless tests,
    // and fastText's "no real canvas either" proxy). Exercised all over the UI suite, which reports
    // no coverage — so it is pinned here, where the gate can see it.
    setBakeRenderer(null as unknown as PIXI.IRenderer);
    expect(hasBakeRenderer()).toBe(false);
    useRenderer(2);
    expect(hasBakeRenderer()).toBe(true);
  });

  it('bakeResolution stays the RAW renderer resolution, ignoring the design scale', () => {
    // Deliberate asymmetry with pageBakeResolution (see bake.ts): this is what fastText rasterizes
    // glyph canvases at, and glyph sprites do ride on containers that animate above scale 1.
    // If this ever starts tracking designScale, text goes soft on every phone.
    useRenderer(3);
    setDesignScale(0.25);
    expect(bakeResolution()).toBe(3);
    expect(pageBakeResolution()).toBe(0.75);
    setBakeRenderer(null as unknown as PIXI.IRenderer);
    expect(bakeResolution()).toBe(1);
  });
});

describe('bakeStats', () => {
  it('reports bytes and names the biggest entry by its cache key', () => {
    useRenderer(1);
    bake('small', obj(), 10, 10);
    bake('big', obj(), 1000, 500);
    const s = bakeStats();
    expect(s.count).toBe(2);
    expect(s.bytes).toBe((10 * 10 + 1000 * 500) * 4);
    // The key is what makes a report actionable — "generated texture is huge" names nothing.
    expect(s.largest?.key).toContain('big');
    expect(s.largest?.bytes).toBe(1000 * 500 * 4);
  });

  it('is empty with nothing cached, and after a clear', () => {
    expect(bakeStats()).toEqual({ count: 0, bytes: 0, largest: null });
    bake('x', obj(), 8, 8);
    clearBakeCache();
    expect(bakeStats()).toEqual({ count: 0, bytes: 0, largest: null });
  });
});

describe('bakeEntries', () => {
  it('itemises what bakeStats totals, key by key', () => {
    // The itemised form exists for a measurement that has to survive a page RELOAD, which zeroes
    // the whole cache: totals restart, the set of keys does not. So the contract that matters is
    // that every entry carries its own key and its own real size — a caller merging two walks has
    // nothing else to merge on.
    useRenderer(1);
    bake('small', obj(), 10, 10);
    bake('big', obj(), 1000, 500);
    const entries = bakeEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.key).sort()).toEqual(['big@1', 'small@1']);
    const big = entries.find((e) => e.key.startsWith('big'))!;
    expect(big).toMatchObject({ w: 1000, h: 500, bytes: 1000 * 500 * 4 });
    // The two views must not drift: the itemised bytes are the total.
    expect(entries.reduce((n, e) => n + e.bytes, 0)).toBe(bakeStats().bytes);
  });

  it('is empty with nothing cached', () => {
    expect(bakeEntries()).toEqual([]);
  });
});

describe('screenBytes', () => {
  it("is one full backbuffer at the renderer's current size", () => {
    // The denominator of the bake budget (cache/memoryBudgets.ts): counting this cache in
    // backbuffers is what makes one number fit a phone and a high-DPI desktop at once.
    setBakeRenderer({ width: 780, height: 1688, resolution: 2, render: () => {} } as unknown as PIXI.IRenderer);
    expect(screenBytes()).toBe(780 * 1688 * 4);
  });

  it('is 0 with no renderer, which callers must read as "no opinion"', () => {
    // Not "a budget of zero": a gate that divided by this before the renderer exists would report
    // on every boot. The 0 is the signal to skip the gate entirely.
    setBakeRenderer(null as unknown as PIXI.IRenderer);
    expect(screenBytes()).toBe(0);
  });
});
