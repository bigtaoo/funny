/**
 * unitSpawnBake.test.ts — regression test for the per-unit-spawn bake helpers added 2026-09-22
 * (`claudedocs/client-render-budget.md` §13): `stickmanDraft.ts`'s `draftTexture`/`draftBakeSize`
 * (the procedural stickman body, 9,546 indices/spawn before this) and `UnitView/assets.ts`'s
 * `factionMarkerTexture`/`markerBakeSize` (the faction ground patch, 312 indices/spawn before this).
 *
 * Both were previously only exercised indirectly (`sceneGeometryBudget.ui.ts`'s "battle screen"
 * budget, a full match) — this pins the size formula and the cache-key contract directly:
 *
 *   1. Bake size tracks the real figure/marker bounds (exported STICKMAN_DRAFT_ASPECT /
 *      the rx/ry it's handed), not a hardcoded constant — a skeleton-proportion change must not
 *      silently crop the bake (see draftBakeSize's own doc comment).
 *   2. The SAME input tuple hits the SAME cached texture (this is what keeps the variant count
 *      bounded to ~unit-type x side, not one texture per spawn).
 *   3. A DIFFERENT input tuple mints a genuinely different texture — the cache key must not
 *      collapse distinct shapes together.
 *   4. Returns null with no bake renderer wired (headless UI tests) — callers must fall back to
 *      drawing live; a regression here would silently make every headless unit test either crash
 *      or render nothing.
 *
 * Run with: npm test — the default suite's include covers every *.test.ts under test/.
 */
import '../harness/pixiHeadless';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { Side } from '@nw/engine/types';
import { draftTexture, draftBakeSize, DRAFT_PAD, STICKMAN_DRAFT_ASPECT } from '../../src/render/stickmanDraft';
import { factionMarkerTexture, markerBakeSize, MARKER_PAD } from '../../src/render/UnitView/assets';
import { setBakeRenderer, clearBakeCache, bakeStats } from '../../src/render/bake';

/** Enough of a renderer for bakeLazy(): it reads `.resolution` and calls `.render()`. Same shape as
 *  sceneGeometryBudget.ui.ts's stubBakeRenderer(). */
function stubBakeRenderer(): void {
  setBakeRenderer({ resolution: 1, render: () => {} } as unknown as PIXI.IRenderer);
}

describe('draftBakeSize()', () => {
  it('height tracks targetH plus a fixed pad, not a multiple of it', () => {
    for (const h of [20, 40, 90]) {
      expect(draftBakeSize(h).h).toBe(Math.ceil(h) + DRAFT_PAD * 2);
    }
  });

  it('width tracks the figure aspect ratio scaled to targetH, not a hardcoded box', () => {
    for (const h of [20, 40, 90]) {
      const expectedW = Math.ceil(STICKMAN_DRAFT_ASPECT * h) + DRAFT_PAD * 2;
      expect(draftBakeSize(h).w).toBe(expectedW);
    }
  });

  it('grows monotonically with targetH (a bigger unit tier bakes a bigger texture)', () => {
    const small = draftBakeSize(20);
    const large = draftBakeSize(90);
    expect(large.w).toBeGreaterThan(small.w);
    expect(large.h).toBeGreaterThan(small.h);
  });
});

describe('markerBakeSize()', () => {
  it('tracks (rx, ry) plus a fixed pad on each axis independently', () => {
    const { w, h } = markerBakeSize(12, 4.4);
    expect(w).toBe(Math.ceil(12 * 1.12 * 2) + MARKER_PAD * 2);
    expect(h).toBe(Math.ceil(4.4 * 1.12 * 2) + MARKER_PAD * 2);
  });

  it('a wider marker (rx up) does not also grow the height', () => {
    const narrow = markerBakeSize(12, 4.4);
    const wide = markerBakeSize(40, 4.4);
    expect(wide.w).toBeGreaterThan(narrow.w);
    expect(wide.h).toBe(narrow.h);
  });
});

describe('draftTexture() / factionMarkerTexture() — bake identity, no renderer wired', () => {
  it('draftTexture returns null with no bake renderer (headless fallback contract)', () => {
    expect(draftTexture(Side.Bottom, 40, 1011)).toBeNull();
  });

  it('factionMarkerTexture returns null with no bake renderer', () => {
    expect(factionMarkerTexture(Side.Bottom, 0, 12, 12, 4.4)).toBeNull();
  });
});

describe('draftTexture() / factionMarkerTexture() — bake identity, renderer wired', () => {
  beforeEach(() => {
    clearBakeCache();
    stubBakeRenderer();
  });
  afterEach(() => {
    clearBakeCache();
    setBakeRenderer(null as unknown as PIXI.IRenderer);
  });

  it('draftTexture is sized from draftBakeSize(targetH)', () => {
    const tex = draftTexture(Side.Bottom, 40, 1011);
    expect(tex).not.toBeNull();
    const { w, h } = draftBakeSize(40);
    expect(tex!.baseTexture.realWidth).toBe(w);
    expect(tex!.baseTexture.realHeight).toBe(h);
  });

  it('the SAME (side, targetH, seed) hits the SAME cached texture — no re-bake per spawn', () => {
    const a = draftTexture(Side.Bottom, 40, 1011);
    const b = draftTexture(Side.Bottom, 40, 1011);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it('a different side, targetH, or seed each mint a genuinely different texture', () => {
    const base = draftTexture(Side.Bottom, 40, 1011)!;
    expect(draftTexture(Side.Top, 40, 1011)).not.toBe(base);      // side flips faction ink
    expect(draftTexture(Side.Bottom, 60, 1011)).not.toBe(base);   // different tier height
    expect(draftTexture(Side.Bottom, 40, 2027)).not.toBe(base);   // different unit type's seed
  });

  it('factionMarkerTexture is sized from markerBakeSize(rx, ry)', () => {
    const tex = factionMarkerTexture(Side.Bottom, 0, 12, 12, 4.4);
    expect(tex).not.toBeNull();
    const { w, h } = markerBakeSize(12, 4.4);
    expect(tex!.baseTexture.realWidth).toBe(w);
    expect(tex!.baseTexture.realHeight).toBe(h);
  });

  it('the SAME marker params hit the SAME cached texture', () => {
    const a = factionMarkerTexture(Side.Bottom, 0, 12, 12, 4.4);
    const b = factionMarkerTexture(Side.Bottom, 0, 12, 12, 4.4);
    expect(a).toBe(b);
  });

  it('a different rx/ry mints a different texture (distinct shapes must not share a bake)', () => {
    const a = factionMarkerTexture(Side.Bottom, 0, 12, 12, 4.4);
    const b = factionMarkerTexture(Side.Bottom, 0, 12, 20, 6);
    expect(a).not.toBe(b);
  });

  it('draft spawns for every unit type stay in the low tens of cached textures, not one per spawn', () => {
    // Same intent as the plan's own "变体上界 = 单位类型数 × 2 侧 ≈ 24 张小图" accounting: spawn the
    // same handful of (side, targetH, seed) combinations repeatedly, the way a real match would as
    // units of the same types recur, and confirm the cache stays bounded instead of growing per call.
    const combos: Array<[Side, number, number]> = [
      [Side.Bottom, 40, 1011], [Side.Top, 40, 1011],
      [Side.Bottom, 60, 3041], [Side.Top, 60, 3041],
    ];
    for (let i = 0; i < 20; i++) {
      for (const [side, h, seed] of combos) draftTexture(side, h, seed);
    }
    expect(bakeStats().count).toBe(combos.length);
  });
});
