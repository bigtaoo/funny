/**
 * paperRules.ui.ts — the notebook page is a fill plus sprite windows off ONE small strip atlas, and
 * a new page size costs no bake (ADR-099).
 *
 * The regression this guards: every `(w, h, rule x)` used to mint a full-page RenderTexture whose
 * bake triangulated ~28 page-wide SketchPen lines — 20-27 ms per new size on a desktop, a full
 * backbuffer of GPU memory each. A fake bake renderer (the same one sceneGeometryBudget uses) is
 * enough to see the cache: `bakeEntries()` lists every texture the bake layer holds.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { bakeEntries, clearBakeCache, setBakeRenderer, setDesignScale, resetDesignScaleForTest } from '../../src/render/bake';
import { buildPaperBackground, marginLineX } from '../../src/render/sketchUi';
import { resetPaperRules } from '../../src/render/paperRules';

function fakeRenderer(resolution = 1): void {
  setBakeRenderer({ resolution, render: () => {} } as unknown as PIXI.IRenderer);
}

function sprites(page: PIXI.DisplayObject): PIXI.Sprite[] {
  return (page as PIXI.Container).children.filter((c): c is PIXI.Sprite => c instanceof PIXI.Sprite);
}

beforeEach(() => { clearBakeCache(); resetPaperRules(); resetDesignScaleForTest(); fakeRenderer(); });
afterEach(() => { clearBakeCache(); resetPaperRules(); resetDesignScaleForTest(); setBakeRenderer(null as unknown as PIXI.IRenderer); });

describe('buildPaperBackground — strip atlas, no per-page bake', () => {
  it('new page sizes, rail positions and the rule-less map page add no bake entries', () => {
    buildPaperBackground('a', 1280, 631);
    const afterFirst = bakeEntries().length;
    expect(afterFirst).toBe(1);                       // the strip atlas itself
    buildPaperBackground('b', 1920, 1080);
    buildPaperBackground('c', 1280, 631, { railX: 260 });
    buildPaperBackground('d', 3000, 1080, { marginLine: false });
    buildPaperBackground('e', 700, 480);              // a modal-sized page
    expect(bakeEntries().map((e) => e.key)).toEqual(['paperRules:v1@1']);
  });

  it('is a single rect fill plus sprites that all come off one base texture', () => {
    const page = buildPaperBackground('t', 1280, 631) as PIXI.Container;
    const fills = page.children.filter((c) => c instanceof PIXI.Graphics);
    expect(fills).toHaveLength(1);
    const sp = sprites(page);
    expect(sp.length).toBeGreaterThan(27);
    expect(new Set(sp.map((s) => s.texture.baseTexture)).size).toBe(1);
  });

  it('every ruled line spans the whole width, one line per round(h / 28) px', () => {
    const w = 3000, h = 1080;
    const page = buildPaperBackground('t', w, h, { marginLine: false });
    const byRow = new Map<number, number>();
    for (const s of sprites(page)) {
      expect(s.rotation).toBe(0);
      byRow.set(s.y, (byRow.get(s.y) ?? 0) + s.texture.frame.width);
    }
    const gap = Math.round(h / 28);
    expect(byRow.size).toBe(Math.ceil(h / gap) - 1);
    for (const covered of byRow.values()) expect(covered).toBe(w);
  });

  it('draws the red rule at railX (or 9% of w) down the whole height, and not at all without it', () => {
    const w = 1280, h = 631;
    const rule = (page: PIXI.DisplayObject) => sprites(page).filter((s) => s.rotation !== 0);
    const def = rule(buildPaperBackground('t', w, h));
    expect(def.reduce((n, s) => n + s.texture.frame.width, 0)).toBe(h);
    const half = def[0]!.texture.frame.height / 2;
    for (const s of def) expect(s.x - half).toBe(marginLineX(w));
    for (const s of rule(buildPaperBackground('t', w, h, { railX: 260 }))) expect(s.x - half).toBe(260);
    expect(rule(buildPaperBackground('t', w, h, { marginLine: false }))).toHaveLength(0);
  });

  it('tints the atlas: faint blue rules, red margin', () => {
    const sp = sprites(buildPaperBackground('t', 1280, 631));
    const tints = new Set(sp.map((s) => s.tint));
    expect(tints.size).toBe(2);
  });

  it('re-bakes the atlas at a new on-screen scale (a rotation), sampled like the page it replaced', () => {
    buildPaperBackground('t', 1280, 631);
    setDesignScale(0.5);
    buildPaperBackground('t', 1280, 631);
    expect(bakeEntries().map((e) => e.key).sort()).toEqual(['paperRules:v1@0.5', 'paperRules:v1@1']);
  });

  it('cuts valid frames at any page resolution, fractional ones included', () => {
    // A RenderTexture is allocated in whole device pixels, so its point size can come out slightly
    // under what was asked for — the last strip once overran it and PIXI threw on a dpr-2 battle.
    for (const scale of [0.25, 0.3, 0.5625, 0.7, 0.8125, 1]) {
      resetPaperRules(); clearBakeCache();
      setDesignScale(scale);
      expect(() => buildPaperBackground('t', 1024, 768)).not.toThrow();
    }
    fakeRenderer(1.25);
    for (const scale of [1, 0.9]) {
      resetPaperRules(); clearBakeCache();
      setDesignScale(scale);
      expect(() => buildPaperBackground('t', 1024, 768)).not.toThrow();
    }
  });

  it('falls back to live strokes in one Graphics without a bake renderer', () => {
    setBakeRenderer(null as unknown as PIXI.IRenderer);
    resetPaperRules();
    const page = buildPaperBackground('t', 1280, 631);
    expect(page).toBeInstanceOf(PIXI.Graphics);
  });
});
