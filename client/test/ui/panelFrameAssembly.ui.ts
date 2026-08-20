// panelFrame assembly + cost gate.
//
// The UI harness deliberately runs with NO renderer, which is also the signal
// `sketchPanel` uses to fall back to the old live-SketchPen border. To exercise the
// atlas path here we hand `setBakeRenderer` a stub: `bakeLazy` only needs
// `resolution` plus a `render()` it can call, and a benchmark does not care that the
// RenderTexture stays blank — the cost being measured is geometry building and
// sprite assembly on the CPU, not rasterisation.
//
// The numbers at the bottom are a REGRESSION GATE, not a micro-benchmark: they are
// generous multiples of what was measured (2026-08-20, see
// design/product/panel-frame-art-prompts.md §0) so a slow machine or a cold JIT
// cannot fail the run, while a return to per-render `SketchPen.rect` — 132,300
// vertices and 8.6 ms over this same panel set — blows straight through them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { setBakeRenderer, clearBakeCache } from '../../src/render/bake';
import { sketchPanel, ui } from '../../src/render/sketchUi';
import { resetFrameAtlas, tierIndexFor, weightIndexFor } from '../../src/render/panelFrame';

/** The real world-map HUD panel set (headerHud.ts / hud.ts), the case that motivated this. */
const HUD_PANELS: [string, number, number][] = [
  ['header stat bar', 300, 78],
  ['buff row A', 300, 30],
  ['buff row B', 300, 30],
  ['march btn', 300, 44],
  ['replay btn', 300, 44],
  ['march list', 300, 220],
  ['recall btn', 96, 36],
  ['instant btn', 120, 36],
  ['rep badge', 300, 40],
  ['chat bar', 1920, 56],
  ['chat badge', 22, 18],
  ['zoom btn', 90, 44],
  ['toast', 520, 60],
];

function installStubRenderer(): void {
  const stub = {
    resolution: 1,
    render: (): void => undefined,
  } as unknown as PIXI.IRenderer;
  setBakeRenderer(stub);
}

function teardownRenderer(): void {
  setBakeRenderer(null as unknown as PIXI.IRenderer);
  clearBakeCache();
  resetFrameAtlas();
}

function panel(w: number, h: number): PIXI.Container {
  return sketchPanel(w, h, { fill: ui.dark, border: ui.accent, width: 2 });
}

/** Every Graphics under `node`, with its total vertex count. */
function geometryCost(node: PIXI.Container): { verts: number; nonBatchable: number } {
  let verts = 0, nonBatchable = 0;
  const walk = (n: PIXI.Container): void => {
    if (n instanceof PIXI.Graphics) {
      const geo = n.geometry as unknown as { points: number[]; batchable: boolean; updateBatches(): void };
      geo.updateBatches();
      verts += geo.points.length / 2;
      if (!geo.batchable) nonBatchable++;
    }
    for (const c of n.children) if (c instanceof PIXI.Container) walk(c);
  };
  walk(node);
  return { verts, nonBatchable };
}

describe('panelFrame — atlas assembly', () => {
  beforeAll(installStubRenderer);
  afterAll(teardownRenderer);

  it('builds a panel out of a fill Graphics plus frame sprites', () => {
    const p = panel(300, 220);
    const sprites = p.children.filter(c => c instanceof PIXI.Sprite);
    const graphics = p.children.filter(c => c instanceof PIXI.Graphics);
    expect(graphics).toHaveLength(1);                 // just the flat fill
    expect(p.getChildIndex(graphics[0]!)).toBe(0);    // …and it sits under the frame
    expect(sprites.length).toBeGreaterThanOrEqual(8); // 4 corners + >=1 window per side
  });

  it('draws every frame slice from ONE baseTexture, so the whole frame batches', () => {
    const bases = new Set<PIXI.BaseTexture>();
    for (const [, w, h] of HUD_PANELS) {
      for (const c of panel(w, h).children) {
        if (c instanceof PIXI.Sprite) bases.add(c.texture.baseTexture);
      }
    }
    expect(bases.size).toBe(1);
  });

  it('places every frame slice on a whole pixel', () => {
    // Fractional placement makes consecutive strip windows sample the atlas at
    // different subpixel phases, which shows up as a step where two windows meet.
    // Panel sizes are often screen fractions, so the fractional case is the norm.
    for (const [w, h] of [[300.4, 220.7], [519.5, 59.5], [1920.25, 56.5]]) {
      for (const c of panel(w!, h!).children) {
        if (!(c instanceof PIXI.Sprite)) continue;
        expect(Number.isInteger(c.x), `x=${c.x}`).toBe(true);
        expect(Number.isInteger(c.y), `y=${c.y}`).toBe(true);
      }
    }
  });

  it('keeps the frame inside the panel rect', () => {
    for (const [name, w, h] of HUD_PANELS) {
      const p = panel(w, h);
      if (!p.children.some(c => c instanceof PIXI.Sprite)) continue;   // fell back
      const b = p.getBounds();
      expect(b.width, name).toBeLessThanOrEqual(w + 1);
      expect(b.height, name).toBeLessThanOrEqual(h + 1);
    }
  });

  it('varies the border between two same-size panels via the seed', () => {
    const a = sketchPanel(300, 220, { fill: ui.dark, border: ui.accent, width: 2, seed: 1 });
    const b = sketchPanel(300, 220, { fill: ui.dark, border: ui.accent, width: 2, seed: 999 });
    const frames = (p: PIXI.Container) => p.children
      .filter((c): c is PIXI.Sprite => c instanceof PIXI.Sprite)
      .map(c => `${c.texture.frame.x},${c.texture.frame.width}`).join('|');
    expect(frames(a)).not.toBe(frames(b));
  });

  it('falls back to a bare Graphics when the panel is too small to seat two corners', () => {
    // Chat's 22x18 unread badge. A 1.1px jitter is plainly visible at that size, so
    // the fallback loses nothing — and small panels were never the performance case.
    const p = sketchPanel(22, 18, { fill: ui.dark, border: ui.accent, width: 2 });
    expect(p).toBeInstanceOf(PIXI.Graphics);
  });

  it('snaps width and amplitude to the baked tiers', () => {
    expect(weightIndexFor(1.0)).toBe(0);
    expect(weightIndexFor(1.9)).toBe(1);
    expect(weightIndexFor(5)).toBe(2);
    expect(tierIndexFor(300, 30)).toBe(0);     // short side drives the tier
    expect(tierIndexFor(300, 78)).toBe(1);
    expect(tierIndexFor(300, 220)).toBe(2);
  });
});

describe('panelFrame — cost gate over the world-map HUD panel set', () => {
  beforeAll(installStubRenderer);
  afterAll(teardownRenderer);

  it('stays far below the per-render SketchPen cost it replaced', () => {
    // The very first panel pays for the whole atlas (every weight x tier: 18 strips
    // + 36 corner cells). That is the one-time cost the per-render saving buys back.
    const tAtlas = performance.now();
    panel(300, 220);
    const atlasMs = performance.now() - tAtlas;
    expect(atlasMs).toBeLessThan(400);
    for (let i = 0; i < 5; i++) for (const [, w, h] of HUD_PANELS) panel(w, h);   // warm

    const t0 = performance.now();
    const panels = HUD_PANELS.map(([, w, h]) => panel(w, h));
    const build = performance.now() - t0;

    let verts = 0, nonBatchable = 0, fellBack = 0;
    for (const p of panels) {
      const c = geometryCost(p);
      verts += c.verts;
      nonBatchable += c.nonBatchable;
      if (!p.children.some(ch => ch instanceof PIXI.Sprite)) fellBack++;
    }

    // Only the 22x18 chat badge is too small to frame, and its live-pen fallback is
    // the one Graphics that stays non-batchable — by design, and cheap at that size.
    expect(fellBack).toBe(1);
    expect(nonBatchable).toBe(fellBack);
    // Measured 2026-08-20 on the dev machine: ~0.6 ms and ~700 vertices (of which
    // ~650 are that one fallback badge). Was 8.6 ms / 132,300 verts / 13 flushes.
    expect(verts).toBeLessThan(2000);
    expect(build).toBeLessThan(4);
    console.log(
      `panelFrame cost over ${HUD_PANELS.length} world-map HUD panels: ` +
      `build=${build.toFixed(2)}ms verts=${verts} nonBatchable=${nonBatchable} fellBack=${fellBack} ` +
      `(pre-atlas baseline: 8.60ms / 132300 / 13 / 0); one-time atlas build ${atlasMs.toFixed(1)}ms`,
    );
  });
});
