/**
 * baseFactionGroundPatch.test.ts — regression test for the base team-color patch (2026-08-09).
 *
 * Background: the two bases had no persistent team-color cue — only the critical-HP
 * ring used factionInk, so the two identical castle sprites were indistinguishable at
 * a glance. `BoardView.drawFactionGroundPatch` adds a static, layered color wash at
 * each base's foot (same "colored ground patch under a full-color AI asset" language
 * as `UnitView.drawFactionMarker`), deliberately NOT a persistent outline —
 * art-direction.md §3.4 already rules that out (moirés against the hand-drawn ink
 * linework of the castle art).
 *
 * This test exercises the pure drawing function directly against a FakeGraphics that
 * records every fill call, without constructing the full BoardView (which pulls in
 * several bitmap/atlas asset imports not relevant here).
 *
 * Run with: npm run test:render
 */
import { describe, it, expect } from 'vitest';

// ── Minimal PIXI.Graphics stub — records every beginFill/drawEllipse pair ──────
type FillCall = { color: number; alpha: number; cx: number; cy: number; rx: number; ry: number };

class FakeGraphics {
  fills: FillCall[] = [];
  private curFill: { color: number; alpha: number } | null = null;
  beginFill(color = 0, alpha = 1): this { this.curFill = { color, alpha }; return this; }
  endFill(): this { this.curFill = null; return this; }
  drawEllipse(cx: number, cy: number, rx: number, ry: number): this {
    if (this.curFill) this.fills.push({ ...this.curFill, cx, cy, rx, ry });
    return this;
  }
  clear(): this { this.fills = []; return this; }
}

import { drawFactionGroundPatch } from '../../src/render/BoardView';
import { factionInk } from '../../src/render/theme';
import type { Rect } from '../../src/layout/ILayout';

const RECT: Rect = { x: 0, y: 0, w: 200, h: 120 };

describe('drawFactionGroundPatch', () => {
  it('draws exactly three concentric ellipses, all centered on the same point', () => {
    const g = new FakeGraphics();
    drawFactionGroundPatch(g as unknown as import('pixi.js-legacy').Graphics, factionInk.friend, RECT);
    expect(g.fills).toHaveLength(3);
    const [outer, mid, inner] = g.fills as [FillCall, FillCall, FillCall];
    expect(mid.cx).toBe(outer.cx);
    expect(mid.cy).toBe(outer.cy);
    expect(inner.cx).toBe(outer.cx);
    expect(inner.cy).toBe(outer.cy);
  });

  it('layers alpha low→high from outer to inner (soft edge, solid core)', () => {
    const g = new FakeGraphics();
    drawFactionGroundPatch(g as unknown as import('pixi.js-legacy').Graphics, factionInk.friend, RECT);
    const [outer, mid, inner] = g.fills as [FillCall, FillCall, FillCall];
    expect(outer.alpha).toBeLessThan(mid.alpha);
    expect(mid.alpha).toBeLessThan(inner.alpha);
    // None of the layers are opaque — this is meant to read as a soft wash, not a
    // solid re-color of the hand-drawn castle art.
    for (const f of g.fills) expect(f.alpha).toBeLessThan(0.5);
  });

  it('shrinks outer→inner (nested, not identical-size stacked ellipses)', () => {
    const g = new FakeGraphics();
    drawFactionGroundPatch(g as unknown as import('pixi.js-legacy').Graphics, factionInk.friend, RECT);
    const [outer, mid, inner] = g.fills as [FillCall, FillCall, FillCall];
    expect(inner.rx).toBeLessThan(mid.rx);
    expect(mid.rx).toBeLessThan(outer.rx);
    expect(inner.ry).toBeLessThan(mid.ry);
    expect(mid.ry).toBeLessThan(outer.ry);
  });

  it('uses the exact faction color passed in — friend vs enemy paint different colors', () => {
    const friendG = new FakeGraphics();
    const enemyG = new FakeGraphics();
    drawFactionGroundPatch(friendG as unknown as import('pixi.js-legacy').Graphics, factionInk.friend, RECT);
    drawFactionGroundPatch(enemyG as unknown as import('pixi.js-legacy').Graphics, factionInk.enemy, RECT);
    expect(friendG.fills.every(f => f.color === factionInk.friend)).toBe(true);
    expect(enemyG.fills.every(f => f.color === factionInk.enemy)).toBe(true);
    expect(factionInk.friend).not.toBe(factionInk.enemy);
  });

  it('scales the patch footprint with the base rect, not a fixed pixel size', () => {
    const small: Rect = { x: 0, y: 0, w: 100, h: 60 };
    const large: Rect = { x: 0, y: 0, w: 200, h: 120 }; // 2x
    const gSmall = new FakeGraphics();
    const gLarge = new FakeGraphics();
    drawFactionGroundPatch(gSmall as unknown as import('pixi.js-legacy').Graphics, factionInk.friend, small);
    drawFactionGroundPatch(gLarge as unknown as import('pixi.js-legacy').Graphics, factionInk.friend, large);
    const outerSmall = gSmall.fills[0]!;
    const outerLarge = gLarge.fills[0]!;
    expect(outerLarge.rx).toBeCloseTo(outerSmall.rx * 2, 5);
    expect(outerLarge.ry).toBeCloseTo(outerSmall.ry * 2, 5);
  });

  it('is idempotent: calling it twice on the same Graphics does not accumulate fills', () => {
    const g = new FakeGraphics();
    drawFactionGroundPatch(g as unknown as import('pixi.js-legacy').Graphics, factionInk.friend, RECT);
    drawFactionGroundPatch(g as unknown as import('pixi.js-legacy').Graphics, factionInk.friend, RECT);
    expect(g.fills).toHaveLength(3); // clear() at the top of the function, not additive
  });
});
