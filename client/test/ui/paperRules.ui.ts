/**
 * paperRules.ui.ts — the notebook page is a fill plus two meshes off ONE small strip atlas (sprite
 * windows on the Canvas fallback), and a new page size costs no bake (ADR-099, ADR-104).
 *
 * The regression this guards: every `(w, h, rule x)` used to mint a full-page RenderTexture whose
 * bake triangulated ~28 page-wide SketchPen lines — 20-27 ms per new size on a desktop, a full
 * backbuffer of GPU memory each. A fake bake renderer (the same one sceneGeometryBudget uses) is
 * enough to see the cache: `bakeEntries()` lists every texture the bake layer holds.
 *
 * Since ADR-104 the WebGL page is fill + rules mesh + margin mesh (it was 76-86 sprites). The
 * meshes must be the sprites, quad for quad: one test lays the same pages both ways and compares
 * every corner and texture coordinate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { bakeEntries, clearBakeCache, setBakeRenderer, setDesignScale, resetDesignScaleForTest } from '../../src/render/bake';
import { buildPaperBackground, marginLineX } from '../../src/render/sketchUi';
import { resetPaperRules } from '../../src/render/paperRules';

function fakeRenderer(resolution = 1, type = PIXI.RENDERER_TYPE.WEBGL): void {
  setBakeRenderer({ resolution, type, render: () => {} } as unknown as PIXI.IRenderer);
}

function sprites(page: PIXI.DisplayObject): PIXI.Sprite[] {
  return (page as PIXI.Container).children.filter((c): c is PIXI.Sprite => c instanceof PIXI.Sprite);
}

function meshes(page: PIXI.DisplayObject): PIXI.Mesh[] {
  return (page as PIXI.Container).children.filter((c): c is PIXI.Mesh => c instanceof PIXI.Mesh);
}

interface Quad { x0: number; y0: number; x1: number; y1: number; verts: number[]; uvs: number[] }

/** A mesh's quads (4 vertices each, in the sprite's TL TR BR BL order), with their bounds. */
function quads(m: PIXI.Mesh): Quad[] {
  const v = m.geometry.getBuffer('aVertexPosition').data as unknown as Float32Array;
  const uv = m.geometry.getBuffer('aTextureCoord').data as unknown as Float32Array;
  const out: Quad[] = [];
  for (let i = 0; i < v.length; i += 8) {
    const xs = [v[i]!, v[i + 2]!, v[i + 4]!, v[i + 6]!];
    const ys = [v[i + 1]!, v[i + 3]!, v[i + 5]!, v[i + 7]!];
    out.push({
      x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys),
      verts: Array.from(v.subarray(i, i + 8)), uvs: Array.from(uv.subarray(i, i + 8)),
    });
  }
  return out;
}

/** The margin rule's mesh (the second one; the rules mesh always comes first). */
function marginMesh(page: PIXI.DisplayObject): PIXI.Mesh {
  const m = meshes(page)[1];
  if (!m) throw new Error('no margin mesh');
  return m;
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

  it('is a single rect fill plus two meshes on the atlas texture (was 76-86 sprites)', () => {
    const page = buildPaperBackground('t', 1920, 1080) as PIXI.Container;
    expect(page.children).toHaveLength(3);
    expect(page.children[0]).toBeInstanceOf(PIXI.Graphics);
    const ms = meshes(page);
    expect(ms).toHaveLength(2);
    expect(sprites(page)).toHaveLength(0);
    expect(new Set(ms.map((m) => m.texture.baseTexture)).size).toBe(1);
    expect(quads(ms[0]!).length).toBeGreaterThan(27);
    expect((buildPaperBackground('t', 1920, 1080, { marginLine: false }) as PIXI.Container).children).toHaveLength(2);
  });

  it('every ruled line spans the whole width, one line per round(h / 28) px', () => {
    const w = 3000, h = 1080;
    const ms = meshes(buildPaperBackground('t', w, h, { marginLine: false }));
    expect(ms).toHaveLength(1);
    const byRow = new Map<number, number>();
    for (const q of quads(ms[0]!)) byRow.set(q.y0, (byRow.get(q.y0) ?? 0) + (q.x1 - q.x0));
    const gap = Math.round(h / 28);
    expect(byRow.size).toBe(Math.ceil(h / gap) - 1);
    for (const covered of byRow.values()) expect(covered).toBe(w);
  });

  it('draws the red rule at railX (or 9% of w) down the whole height, and not at all without it', () => {
    const w = 1280, h = 631;
    const centres = (page: PIXI.DisplayObject) => quads(marginMesh(page)).map((q) => (q.x0 + q.x1) / 2);
    const def = quads(marginMesh(buildPaperBackground('t', w, h)));
    expect(def.reduce((n, q) => n + (q.y1 - q.y0), 0)).toBe(h);
    for (const c of centres(buildPaperBackground('t', w, h))) expect(c).toBe(marginLineX(w));
    for (const c of centres(buildPaperBackground('t', w, h, { railX: 260 }))) expect(c).toBe(260);
    expect(meshes(buildPaperBackground('t', w, h, { marginLine: false }))).toHaveLength(1);
  });

  it('tints the atlas: faint blue rules, red margin', () => {
    const [rules, margin] = meshes(buildPaperBackground('t', 1280, 631));
    expect(rules!.tint).not.toBe(margin!.tint);
  });

  it('shares one geometry per page shape, and a destroyed page does not break the next one', () => {
    const a = buildPaperBackground('a', 1920, 1080) as PIXI.Container;
    const b = buildPaperBackground('b', 1920, 1080) as PIXI.Container;
    const shared = meshes(a)[0]!.geometry;
    expect(meshes(b)[0]!.geometry).toBe(shared);
    expect(meshes(buildPaperBackground('c', 1921, 1080))[0]!.geometry).not.toBe(shared);
    a.destroy({ children: true });
    b.destroy({ children: true });
    expect(shared.refCount).toBe(0);
    const again = meshes(buildPaperBackground('d', 1920, 1080))[0]!;
    expect(again.geometry).toBe(shared);
    expect(quads(again).length).toBeGreaterThan(27);
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
    for (const type of [PIXI.RENDERER_TYPE.WEBGL, PIXI.RENDERER_TYPE.CANVAS]) {
      for (const [res, scales] of [[1, [0.25, 0.3, 0.5625, 0.7, 0.8125, 1]], [1.25, [1, 0.9]]] as const) {
        fakeRenderer(res, type);
        for (const scale of scales) {
          resetPaperRules(); clearBakeCache();
          setDesignScale(scale);
          expect(() => buildPaperBackground('t', 1024, 768)).not.toThrow();
          for (const m of meshes(buildPaperBackground('t', 1024, 768))) {
            for (const q of quads(m)) for (const u of q.uvs) expect(u).toBeGreaterThanOrEqual(0), expect(u).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });

  it('lays sprite windows on the Canvas fallback, all off one base texture', () => {
    fakeRenderer(1, PIXI.RENDERER_TYPE.CANVAS);
    const page = buildPaperBackground('t', 1280, 631) as PIXI.Container;
    expect(meshes(page)).toHaveLength(0);
    const sp = sprites(page);
    expect(sp.length).toBeGreaterThan(27);
    expect(new Set(sp.map((s) => s.texture.baseTexture)).size).toBe(1);
    expect(new Set(sp.map((s) => s.tint)).size).toBe(2);
  });

  it('the meshes are the sprites: same corners and texture coordinates, quad for quad', () => {
    const cases: Array<[number, number, number, { railX?: number; marginLine?: boolean }]> = [
      [1920, 1080, 1, {}], [2592, 1080, 1, { railX: 260 }], [1280, 631, 1.25, {}], [700, 480, 1, { marginLine: false }],
    ];
    for (const [w, h, res, opts] of cases) {
      fakeRenderer(res, PIXI.RENDERER_TYPE.CANVAS);
      resetPaperRules(); clearBakeCache();
      const root = new PIXI.Container();
      const spritePage = root.addChild(buildPaperBackground('s', w, h, opts) as PIXI.Container);
      spritePage.updateTransform();
      const expected = sprites(spritePage).map((sp) => {
        sp.calculateVertices();
        return { verts: Array.from((sp as unknown as { vertexData: Float32Array }).vertexData), uvs: Array.from(sp.texture._uvs.uvsFloat32), tint: sp.tint };
      });

      fakeRenderer(res, PIXI.RENDERER_TYPE.WEBGL);
      resetPaperRules(); clearBakeCache();
      const got = meshes(buildPaperBackground('m', w, h, opts))
        .flatMap((m) => quads(m).map((q) => ({ ...q, tint: m.tint })));

      expect(got.length).toBeGreaterThan(27);
      expect(got).toHaveLength(expected.length);
      got.forEach((q, i) => {
        const e = expected[i]!;
        expect(q.tint).toBe(e.tint);
        q.verts.forEach((x, n) => expect(x).toBeCloseTo(e.verts[n]!, 4));
        q.uvs.forEach((u, n) => expect(u).toBeCloseTo(e.uvs[n]!, 6));
      });
    }
  });

  it('falls back to live strokes in one Graphics without a bake renderer', () => {
    setBakeRenderer(null as unknown as PIXI.IRenderer);
    resetPaperRules();
    const page = buildPaperBackground('t', 1280, 631);
    expect(page).toBeInstanceOf(PIXI.Graphics);
  });
});
