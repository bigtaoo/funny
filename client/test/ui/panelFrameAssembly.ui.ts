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
import { sketchPanel, sketchAccentBar, inkLayer, tearDownChildren, ui } from '../../src/render/sketchUi';
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

/** Counts how many times anything was actually rendered into a texture. */
let renderCalls = 0;

function installStubRenderer(): void {
  renderCalls = 0;
  const stub = {
    resolution: 1,
    render: (): void => { renderCalls++; },
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

/**
 * Split a panel's frame sprites into the pieces `addPanelFrame` lays down.
 *
 * The four corners are the first four sprites it adds — a white-box assumption, but
 * the alternative (telling a corner from a strip window by its texture shape) breaks
 * the moment a run happens to be exactly one band wide.
 */
function frameParts(p: PIXI.Container) {
  const sprites = p.children.filter((c): c is PIXI.Sprite => c instanceof PIXI.Sprite);
  const corners = sprites.slice(0, 4);          // TL, TR, BR, BL
  const windows = sprites.slice(4);
  const horizontal = windows.filter(s => s.rotation === 0);
  const vertical = windows.filter(s => s.rotation !== 0);
  return { sprites, corners, windows, horizontal, vertical };
}

/** Group by a coordinate, so the top run and the bottom run come apart. */
function groupBy(sprites: PIXI.Sprite[], key: (s: PIXI.Sprite) => number): PIXI.Sprite[][] {
  const m = new Map<number, PIXI.Sprite[]>();
  for (const s of sprites) {
    const k = key(s);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(s);
  }
  return [...m.values()];
}

describe('panelFrame — the invariants that make a seam impossible', () => {
  beforeAll(installStubRenderer);
  afterAll(teardownRenderer);

  it('lays consecutive windows down adjacent on screen AND adjacent in the strip', () => {
    // This pair is the whole reason the edges have no seams: neighbouring windows are
    // the same pen line read straight on, so there is nothing to line up. Screen
    // adjacency without strip adjacency would jump to a different part of the line;
    // strip adjacency without screen adjacency would leave a gap.
    const { horizontal, vertical } = frameParts(panel(1920, 220));   // wide enough to wrap the strip
    const runs = [
      ...groupBy(horizontal, s => s.y)
        .map(g => g.sort((a, b) => a.x - b.x).map(s => ({ along: s.x, f: s.texture.frame }))),
      ...groupBy(vertical, s => s.x)
        .map(g => g.sort((a, b) => a.y - b.y).map(s => ({ along: s.y, f: s.texture.frame }))),
    ];
    expect(runs).toHaveLength(4);
    let wrapped = 0;
    for (const run of runs) {
      expect(run.length).toBeGreaterThan(0);
      for (let i = 1; i < run.length; i++) {
        const prev = run[i - 1]!, cur = run[i]!;
        expect(cur.along).toBe(prev.along + prev.f.width);     // no gap, no overlap on screen
        if (cur.f.x === prev.f.x + prev.f.width) continue;     // carried on along the strip
        // …or reached the strip's end and restarted at its origin. Strip rows span the
        // full atlas width, so that origin is atlas x = 0.
        expect(cur.f.x).toBe(0);
        wrapped++;
      }
    }
    // A 1920px panel is wider than the 1024px strip, so at least one run must wrap —
    // which is the case the looping wobble exists for.
    expect(wrapped).toBeGreaterThan(0);
  });

  it('covers each side end to end — corners and runs leave no hole', () => {
    for (const [w, h] of [[300, 220], [1920, 56], [96, 36], [520, 60]] as [number, number][]) {
      const p = panel(w, h);
      const { corners, horizontal, vertical } = frameParts(p);
      const cw = corners[0]!.texture.frame.width;
      const noHole = (segs: [number, number][], end: number, label: string) => {
        segs.sort((a, b) => a[0] - b[0]);
        let reach = segs[0]![0];
        expect(reach, `${label} start ${w}x${h}`).toBeLessThanOrEqual(1);
        for (const [a, b] of segs) {
          expect(a, `${label} hole before ${a} (${w}x${h})`).toBeLessThanOrEqual(reach);
          reach = Math.max(reach, b);
        }
        expect(reach, `${label} end ${w}x${h}`).toBeGreaterThanOrEqual(end - 1);
      };
      // Top and bottom edges, left to right.
      for (const g of groupBy(horizontal, s => s.y)) {
        noHole([
          [corners[0]!.x, corners[0]!.x + cw], [corners[1]!.x, corners[1]!.x + cw],
          ...g.map(s => [s.x, s.x + s.texture.frame.width] as [number, number]),
        ], w, 'horizontal');
      }
      // Left and right edges, top to bottom (rotated: the texture's width runs down).
      for (const g of groupBy(vertical, s => s.x)) {
        noHole([
          [corners[0]!.y, corners[0]!.y + cw], [corners[3]!.y, corners[3]!.y + cw],
          ...g.map(s => [s.y, s.y + s.texture.frame.width] as [number, number]),
        ], h, 'vertical');
      }
    }
  });

  it('applies the quarter turn to the side edges, in the right direction', () => {
    // A missing or wrong-signed rotation still renders something, just rotated wrong,
    // so assert the shape of the result: a side window must be TALL and sit flush
    // against its own edge of the panel.
    const w = 300, h = 220;
    const { vertical } = frameParts(panel(w, h));
    expect(vertical.length).toBeGreaterThan(0);
    const bandWidths = new Set<number>();
    for (const s of vertical) {
      const b = s.getBounds();
      expect(b.height).toBeGreaterThan(b.width);
      bandWidths.add(Math.round(b.width));
      const flushLeft = Math.abs(b.x) <= 1;
      const flushRight = Math.abs(b.x + b.width - w) <= 1;
      expect(flushLeft || flushRight, `x=${b.x} width=${b.width}`).toBe(true);
    }
    expect(bandWidths.size).toBe(1);                       // one band thickness, both sides
    const xs = new Set(vertical.map(s => Math.round(s.getBounds().x)));
    expect(xs.size).toBe(2);                               // both sides, not two copies of one
  });
});

describe('panelFrame — colour, caching and the migration seam', () => {
  beforeAll(installStubRenderer);
  afterAll(teardownRenderer);

  it('tints every frame slice with the border colour', () => {
    // The atlas holds white ink; ALL colour comes from Sprite.tint (a per-vertex
    // colour in pixi's batcher, so the 30+ fill/border combos across the call sites
    // cost nothing and still batch together).
    for (const border of [ui.accent, ui.gold, ui.red, 0x123456]) {
      const { sprites } = frameParts(sketchPanel(300, 220, { fill: ui.paper, border, width: 2 }));
      expect(sprites.length).toBeGreaterThan(0);
      for (const s of sprites) expect(s.tint).toBe(border);
    }
  });

  it('keeps the fill colour and fillAlpha on the panel itself', () => {
    const p = sketchPanel(300, 220, { fill: ui.green, border: ui.dark, fillAlpha: 0.4 });
    const g = p.children.find((c): c is PIXI.Graphics => c instanceof PIXI.Graphics)!;
    const data = (g.geometry as unknown as {
      graphicsData: { fillStyle: { color: number; alpha: number } }[];
    }).graphicsData;
    expect(data[0]!.fillStyle.color).toBe(ui.green);
    expect(data[0]!.fillStyle.alpha).toBeCloseTo(0.4);
  });

  it('renders the atlas exactly once no matter how many panels are built', () => {
    teardownRenderer();
    installStubRenderer();
    expect(renderCalls).toBe(0);
    for (const [, w, h] of HUD_PANELS) panel(w, h);
    for (const [, w, h] of HUD_PANELS) panel(w, h);
    // panelFrame memoises the cut sub-textures, so this alone would still pass if the
    // bake cache underneath stopped caching — the next case covers that half.
    expect(renderCalls).toBe(1);
  });

  it('re-cuts the atlas from the bake cache rather than redrawing it', () => {
    // Drop only panelFrame's memo, leaving the bake cache intact: rebuilding must hit
    // `bakeLazy`'s cache and skip the draw entirely, landing on the same baseTexture.
    // Without this the previous case is vacuous — panelFrame's own memo hides whether
    // bake caches at all (verified by mutation: removing bake's cache leaves the case
    // above green and turns this one red).
    const base = frameParts(panel(300, 220)).sprites[0]!.texture.baseTexture;
    const before = renderCalls;
    resetFrameAtlas();
    const after = frameParts(panel(300, 220)).sprites[0]!.texture.baseTexture;
    expect(renderCalls).toBe(before);
    expect(after).toBe(base);
  });

  it('survives tearDownChildren — the shared atlas texture is never destroyed', () => {
    // tearDownChildren runs on every re-render of the world-map HUD (once a second).
    // If it freed the atlas baseTexture the next render would draw nothing, or crash
    // on a destroyed geometry — the failure class sketchUi's teardown contract exists
    // to prevent.
    const host = new PIXI.Container();
    host.addChild(panel(300, 220));
    const base = frameParts(host.children[0] as PIXI.Container).sprites[0]!.texture.baseTexture;
    expect(base.destroyed).toBe(false);
    tearDownChildren(host);
    expect(base.destroyed).toBe(false);
    // …and a fresh panel still comes off the same atlas, without re-rendering it.
    const before = renderCalls;
    const again = panel(300, 220);
    expect(frameParts(again).sprites[0]!.texture.baseTexture).toBe(base);
    expect(renderCalls).toBe(before);
  });

  it('lets callers keep drawing their own ink on a panel', () => {
    // The 18 sites that used to stroke straight into the returned Graphics go through
    // sketchAccentBar / inkLayer now that a panel is a Container.
    const p = panel(300, 220);
    const before = p.children.length;
    sketchAccentBar(p, 220, ui.gold);
    expect(p.children.length).toBe(before + 1);
    const added = p.children[p.children.length - 1] as PIXI.Graphics;
    expect(added).toBeInstanceOf(PIXI.Graphics);
    expect((added.geometry as unknown as { graphicsData: unknown[] }).graphicsData.length)
      .toBeGreaterThan(0);

    // On the small-panel fallback the panel IS a Graphics, and the accent bar draws
    // into it rather than nesting a second layer — the pre-atlas behaviour.
    const small = sketchPanel(22, 18, { fill: ui.dark, border: ui.accent, width: 2 }) as PIXI.Graphics;
    sketchAccentBar(small, 18, ui.gold);
    expect(small.children).toHaveLength(0);

    expect(inkLayer(p).parent).toBe(p);
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
