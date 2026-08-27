// The SLG resource level read, end to end: the atlas the client actually bundles, through
// @nw/shared's resMotifPlacement, out to the sprite drawTileL1 puts on a tile.
//
// Background (design/product/slg-resource-art.md §6): the retired contract normalised each frame on
// its WIDTH, so a high tier drawn as a wide cluster — which is how abundance is drawn — rendered
// SMALLER than a low tier drawn as one tall bottle. Measured on the shipped art, all four base
// resources lost ink mass at l5→l6 and ink l4 was the heaviest frame of all ten. The rebuild moved
// the whole solve into the packer (`nw.sizeMul` / `nw.alphaMul` per frame) and left the renderers
// with no level arithmetic at all.
//
// So the interesting failures are no longer arithmetic mistakes in one renderer — they are:
//   • the renderer stops consuming `nw` and silently reverts to normalising on the texture, or
//   • the atlas is rebuilt/patched and the baked curve stops being monotone (e.g. a merge tool drops
//     the `nw` block, or new art lands under-drawn).
// Neither is visible to server/shared/test/core.test.ts, which only sees synthetic inputs. Hence this
// file asserts against the REAL bundled world_atlas.json.
import { describe, it, expect, vi } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { resMotifPlacement, resMotifJitter, RES_LEVEL_LABEL_MIN_LEVEL, RES_LEVEL_LABEL_MIN_TP, RES_LEVEL_LABEL_MAX_PX, RES_LEVEL_LABEL_TP_FRAC, RES_MOTIF_SIZE_FRAC, type ResMotifFrameRead } from '@nw/shared';
import atlasData from '../../src/assets/slg/world_atlas.json';

/**
 * The two atlases this file asserts on sit in different trees, and the split is the point:
 *   · MERGED_DIR — `world_atlas.{png,json}`, the SHIPPED merged page the client actually imports.
 *   · SRC_ATLAS_PNG — `res_atlas.png`, `pack_resources.cjs`'s output and `patchMergedAtlas.js`'s
 *     stamp source. Nothing in client/src imports it, so on 2026-08-25 it moved out of
 *     client/src/assets/slg into art/ (ASSET_PACKAGING §2's "never packaged" L2 tier), where a
 *     904 KB file that no code imports reads as what it is instead of as dead shipped art.
 */
const MERGED_DIR = `${__dirname}/../../src/assets/slg`;
const SRC_ATLAS_PNG = `${__dirname}/../../../art/slg/slg-map/res_atlas.png`;

const TP = 76; // L1 tile pitch
const RES_TYPES = ['ink', 'paper', 'graphite', 'metal'] as const; // sticker only spawns at l6+
type Frame = { frame: { w: number; h: number }; nw?: ResMotifFrameRead };
const FRAMES = (atlasData as { frames: Record<string, Frame> }).frames;

function frameOf(resType: string, lv: number): Frame {
  const f = FRAMES[`res_${resType}_l${lv}`];
  if (!f) throw new Error(`atlas is missing res_${resType}_l${lv}`);
  return f;
}

/**
 * On-screen equivalent edge of a frame at level `lv` — the footprint the LEVEL_SCALE curve sets,
 * with the per-tile jitter divided back out so this measures the curve alone.
 */
function onScreenEdge(resType: string, lv: number): number {
  const f = frameOf(resType, lv);
  const p = resMotifPlacement({ tp: TP, tx: 0, ty: 0, read: f.nw ?? null, texW: f.frame.w, texH: f.frame.h });
  return (p.scale / resMotifJitter(0, 0).scale) * Math.sqrt(f.frame.w * f.frame.h);
}

describe('the bundled atlas carries a baked level read', () => {
  it('every per-level resource frame has an `nw` block (it survives the merge into world_atlas)', () => {
    // `nw` rides on the FRAME entry, not on `meta`, precisely so the page merge carries it: the merge
    // spreads each frame entry wholesale but rewrites `meta` itself. A merge tool that starts
    // rebuilding frame entries field-by-field would drop the level read here and nowhere else.
    const missing = Object.keys(FRAMES).filter((n) => /^res_[a-z]+_l\d+$/.test(n) && !FRAMES[n]!.nw);
    expect(missing).toEqual([]);
  });

  it('alpha stays a trim, never a level channel', () => {
    // The first version of the packer gate let alpha carry the read; its "solution" dimmed ink l4 to
    // 0.37 next to l9 at 1.00, which reads as a different pen rather than as less resource (§6.2 #5).
    for (const name of Object.keys(FRAMES)) {
      const nw = FRAMES[name]!.nw;
      if (!nw) continue;
      expect(nw.alphaMul).toBeGreaterThanOrEqual(0.85);
      expect(nw.alphaMul).toBeLessThanOrEqual(1);
    }
  });
});

describe('level → on-screen footprint', () => {
  for (const resType of RES_TYPES) {
    it(`${resType}: every level lands strictly larger than the one below it`, () => {
      const edges = Array.from({ length: 10 }, (_, i) => onScreenEdge(resType, i + 1));
      for (let i = 1; i < edges.length; i++) {
        expect(edges[i]).toBeGreaterThan(edges[i - 1]!);
      }
      // The explicit LEVEL_SCALE curve: 0.80 → 1.30 over l1..l10, times tp * MOTIF_SIZE_FRAC.
      expect(edges[0]!).toBeCloseTo(TP * RES_MOTIF_SIZE_FRAC * 0.80, 1);
      expect(edges[9]!).toBeCloseTo(TP * RES_MOTIF_SIZE_FRAC * 1.30, 1);
    });
  }

  it('a wide frame and a tall frame of the same level land at the same footprint', () => {
    // The retired width-normalised contract is the thing being ruled out: under it these two would
    // differ by their aspect ratio, which is exactly why drawing "more, spread sideways" shrank a tile.
    const read = { sizeMul: 0.0089, alphaMul: 1 };
    const wide = resMotifPlacement({ tp: TP, tx: 1, ty: 1, read, texW: 200, texH: 60 });
    const tall = resMotifPlacement({ tp: TP, tx: 1, ty: 1, read, texW: 60, texH: 200 });
    expect(wide.scale).toBe(tall.scale);
  });
});

describe('tiles of the same resType and level render at the same size', () => {
  // The other half of what the player circled: at the old jitter range ([0.85, 1.15]) two NEIGHBOURING
  // level-4 ink tiles could differ 1.31× in size, which reads as different land, not as noise.
  // 200 pseudo-random coordinates, seeded so this is a fixed sweep and not a flaky property test.
  function coords(n: number): [number, number][] {
    let s = 20260819;
    const next = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    return Array.from({ length: n }, () => [Math.round(next() * 1400), Math.round(next() * 1400)] as [number, number]);
  }

  for (const resType of RES_TYPES) {
    for (const lv of [1, 4, 7, 10]) {
      it(`${resType} l${lv}: no tile's footprint deviates more than 5% from the mean`, () => {
        const f = frameOf(resType, lv);
        const boxes = coords(200).map(([tx, ty]) => {
          const p = resMotifPlacement({ tp: TP, tx, ty, read: f.nw ?? null, texW: f.frame.w, texH: f.frame.h });
          return p.scale * Math.sqrt(f.frame.w * f.frame.h); // sprite footprint; rotation excluded on purpose
        });
        const mean = boxes.reduce((a, b) => a + b, 0) / boxes.length;
        for (const b of boxes) expect(Math.abs(b - mean) / mean).toBeLessThan(0.05);
        // Extremal spread, for the record: jitter is [0.96, 1.04], so max/min tops out at ~1.083 —
        // every sample within ±5% of the mean is the tighter, and the perceptually relevant, statement.
        expect(Math.max(...boxes) / Math.min(...boxes)).toBeLessThan(1.09);
      });
    }
  }
});

describe('drawResMotif routes through the shared placement (a correct formula nobody calls renders nothing)', () => {
  /** A texture of the given packed-frame size; never rendered, so no GL context is needed. */
  function fakeTex(w: number, h: number): PIXI.Texture {
    return new PIXI.Texture(new PIXI.BaseTexture(undefined, { width: w, height: h }));
  }

  async function motifSprite(resType: string, lv: number, tx: number, ty: number, fogged = false): Promise<PIXI.Sprite> {
    vi.resetModules();
    const f = frameOf(resType, lv);
    const generic = FRAMES[`res_${resType}`]!;
    vi.doMock('../../src/render/atlas/resAtlasLoader', () => ({
      isResAtlasReady: () => true,
      getResTexture: () => fakeTex(generic.frame.w, generic.frame.h),
      getResLevelTexture: () => fakeTex(f.frame.w, f.frame.h),
      getResFrameRead: (name: string) => FRAMES[name]?.nw ?? null,
    }));
    const { drawResMotif } = await import('../../src/scenes/worldmap/tileGraphics');
    const g = new PIXI.Graphics();
    drawResMotif(g, resType, lv, TP, fogged, tx, ty);
    const sprites = g.children.filter((c): c is PIXI.Sprite => c instanceof PIXI.Sprite);
    expect(sprites).toHaveLength(1);
    return sprites[0]!;
  }

  it('scale, alpha, rotation and offset all come from resMotifPlacement + the baked nw', async () => {
    const f = frameOf('graphite', 8);
    const sp = await motifSprite('graphite', 8, 41, 17);
    const want = resMotifPlacement({ tp: TP, tx: 41, ty: 17, read: f.nw!, texW: f.frame.w, texH: f.frame.h });
    expect(sp.scale.x).toBeCloseTo(want.scale, 10);
    expect(sp.scale.y).toBeCloseTo(want.scale, 10);
    expect(sp.alpha).toBeCloseTo(want.alpha, 10);
    expect(sp.rotation).toBeCloseTo(want.rotation, 10);
    expect(sp.x).toBeCloseTo(want.x, 10);
    expect(sp.y).toBeCloseTo(want.y, 10);
  });

  it('the drawn size tracks the level even on one fixed tile — the read the player relies on', async () => {
    const sizes: number[] = [];
    for (let lv = 1; lv <= 10; lv++) {
      const sp = await motifSprite('metal', lv, 5, 5);
      sizes.push(sp.scale.x * Math.sqrt(sp.texture.width * sp.texture.height));
    }
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]!);
  });

  it('under fog it draws the generic type frame dimmed, with no level detail', async () => {
    const sp = await motifSprite('ink', 9, 3, 3, true);
    expect(sp.alpha).toBeCloseTo(0.35, 10);
    // The generic frame, not the l9 one — fog reveals the resource TYPE only.
    expect(sp.texture.width).toBe(FRAMES['res_ink']!.frame.w);
  });
});

describe('the Lv.N label (§6.2 #7)', () => {
  // Why a label exists at all: measurement showed ink mass and object count pull against each other,
  // so the drawing can carry "roughly how rich" but not "exactly which tier" (§6.7) — and the tier is
  // what decides whether a march into that garrison survives. Why not on every tile: resourceDensity
  // is 1.0, so every tile on screen is a resource tile.
  async function labels(level: number, tp: number): Promise<PIXI.BitmapText[]> {
    const { drawResLevelLabel } = await import('../../src/scenes/worldmap/tileGraphics');
    const g = new PIXI.Graphics();
    drawResLevelLabel(g, level, tp);
    return g.children.filter((c): c is PIXI.BitmapText => c instanceof PIXI.BitmapText && c.visible);
  }

  it('labels the high tiers, where misjudging the garrison actually costs an army', async () => {
    for (let lv = RES_LEVEL_LABEL_MIN_LEVEL; lv <= 10; lv++) {
      const [label] = await labels(lv, 120);
      expect(label?.text).toBe(`Lv.${lv}`);
    }
  });

  it('draws nothing below l6, or the map would be wall-to-wall text at resourceDensity 1.0', async () => {
    for (let lv = 1; lv < RES_LEVEL_LABEL_MIN_LEVEL; lv++) {
      expect(await labels(lv, 120)).toHaveLength(0);
    }
  });

  it('draws nothing when zoomed out past legibility', async () => {
    expect(await labels(9, RES_LEVEL_LABEL_MIN_TP - 1)).toHaveLength(0);
    expect(await labels(9, RES_LEVEL_LABEL_MIN_TP)).toHaveLength(1);
  });

  it('caps the glyph size, so zooming in does not turn the map into a wall of text', async () => {
    // The l6+ threshold does NOT bound how many labels land on screen: level 6+ is 11.9% of the real
    // map's resource tiles but arrives in saturated blocks (a 32x32 run where every tile is 6+), and
    // inside one of those every visible tile is labelled — 650/650 at 1920x1080, 2706/3660 at
    // 1080x2340. What keeps the layer readable is therefore the label's weight, and `tp` at this same
    // zoom tier is 98 on a 1080-wide portrait design vs 174 on a 1920 landscape one. Uncapped, that
    // is 13px and 23px for the same tier; at 23px the type outweighs the artwork it annotates
    // (slg-resource-art.md §6.12).
    const [phone] = await labels(8, 98);
    const [desktop] = await labels(8, 174);
    expect(phone?.fontSize).toBe(13);
    expect(desktop?.fontSize).toBe(RES_LEVEL_LABEL_MAX_PX);
    expect(RES_LEVEL_LABEL_MAX_PX).toBeLessThan(Math.round(174 * RES_LEVEL_LABEL_TP_FRAC));
  });

  it('reuses ONE pooled BitmapText per tile slot — never a PIXI.Text, never a fresh object per draw', async () => {
    // Both halves matter and both are about the same leak: `new PIXI.Text` per tile allocates a
    // canvas-backed texture per label (claudedocs/client-memory-leak.md), and re-creating even a
    // BitmapText on every draw would churn objects on every pan frame across a full screen of tiles.
    const { drawResLevelLabel } = await import('../../src/scenes/worldmap/tileGraphics');
    const g = new PIXI.Graphics();
    drawResLevelLabel(g, 7, 120);
    const first = g.children[0];
    expect(first).toBeInstanceOf(PIXI.BitmapText);
    expect(g.children.some((c) => c instanceof PIXI.Text)).toBe(false);
    for (const lv of [8, 9, 10, 6]) drawResLevelLabel(g, lv, 120);
    expect(g.children).toHaveLength(1);
    expect(g.children[0]).toBe(first);
    expect((first as PIXI.BitmapText).text).toBe('Lv.6');
  });

  it('hiding reuses the same child too, so a slot panned onto a low-level tile keeps no stale text', async () => {
    const { drawResLevelLabel } = await import('../../src/scenes/worldmap/tileGraphics');
    const g = new PIXI.Graphics();
    drawResLevelLabel(g, 9, 120);
    drawResLevelLabel(g, 2, 120);
    expect(g.children).toHaveLength(1);
    expect(g.children[0]!.visible).toBe(false);
  });
});

// ── Invariants of the shipped atlas artifacts ──────────────────────────────────────────────────────
// Everything above tests the level READ. This block tests the atlas FILES, because the resource
// pipeline (art/slg/slg-map/pack_resources.cjs -> art/scripts/patchMergedAtlas.js) has no tests of its
// own and both bugs found on 2026-08-20 were silent: neither changed a number anyone looks at, and
// both are one word away from coming back. Asserting on the committed artifacts catches them by
// effect, which is the part that matters and the part that survives a rewrite of those scripts.
describe('the shipped atlas artifacts', () => {
  const EXPECTED_RES_FRAMES = [
    ...['ink', 'paper', 'graphite', 'metal'].flatMap((t) => Array.from({ length: 10 }, (_, i) => `res_${t}_l${i + 1}`)),
    ...[6, 7, 8, 9, 10].map((lv) => `res_sticker_l${lv}`),   // sticker only spawns at level >= 6
    'res_ink', 'res_paper', 'res_graphite', 'res_metal', 'res_sticker', // generic fallback / fogged frames
  ];

  it('carries exactly the 50 resource frames — no more, no fewer', async () => {
    // `res_contact_sheet.png` is written INTO art/slg/slg-map/ by art/scripts/resContactSheet.js and
    // matches the packer's own source pattern `^res_.*\.(webp|png)$`, so the second pack after a sheet
    // exists packed the sheet as a 51st frame: the pipeline's output fed back in as its input,
    // spending atlas on a picture of the atlas. Nothing failed and no number moved.
    //
    // Asserted on res_atlas.json, NOT on the merged world_atlas.json this file otherwise reads. That
    // is where the bug lands, and only there: patchMergedAtlas.js copies frames the merged page
    // already has and reports the rest as skipped, so a spurious 51st frame never reaches the merged
    // page at all. Checked against world_atlas this test passes with the bug present — verified.
    const srcJson = (await import('../../../art/slg/slg-map/res_atlas.json')).default as unknown as
      { frames: Record<string, unknown> };
    const res = Object.keys(srcJson.frames);
    expect(res.sort()).toEqual([...EXPECTED_RES_FRAMES].sort());
  });

  it('every visible pixel of every resource frame is neutral ink', async () => {
    // Two rules collapse into one assertion. (1) Frames are force-greyscaled at pack time because a
    // generation run that happens to favour a blue cast (measured b-r +6..+51 in the 2026-08-19 batch)
    // reads on the map as a different pen next to the neutral frames it sits beside (§6.6). (2) The
    // per-level colour band is gone: sticker's tan->gold ramp was measured to contribute nothing on
    // screen and was retired, and the note in the packer asks anyone who wants per-level colour back to
    // bake it into `nw` rather than re-add a tint pass (§6.12.6). A re-added tint pass, or a dropped
    // greyscale step, both colour the strokes and land here.
    //
    // Only pixels at or above ALPHA_TRIM count, and that bound is load-bearing rather than defensive.
    // Written without it this failed at a spread of 37 on the palette-quantised atlas — but measuring
    // it showed every one of those pixels was under the alpha floor, i.e. invisible, and 0% of VISIBLE
    // pixels were non-neutral either before or after. So this assertion does NOT catch quantisation
    // (the palette test below does, and quantisation's real damage was to alpha, not hue); over-tight
    // here it would have failed for a reason that has nothing to do with what it is guarding.
    const ALPHA_TRIM = 16;
    const sharp = (await import('sharp')).default;
    const png = `${__dirname}/../../../art/slg/slg-map/res_atlas.png`;
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const offenders: string[] = [];
    for (const name of Object.keys(FRAMES).filter((n) => n.startsWith('res_'))) {
      const f = (FRAMES[name] as unknown as { frame: { x: number; y: number; w: number; h: number } }).frame;
      let worst = 0;
      for (let y = f.y; y < f.y + f.h; y++) {
        for (let x = f.x; x < f.x + f.w; x++) {
          const i = (y * info.width + x) * info.channels;
          if (data[i + 3]! < ALPHA_TRIM) continue;
          worst = Math.max(worst, Math.abs(data[i]! - data[i + 1]!), Math.abs(data[i]! - data[i + 2]!));
        }
      }
      if (worst > 2) offenders.push(`${name} (max channel spread ${worst})`);
    }
    expect(offenders).toEqual([]);
  });

  it('every generic motif frame clears the UI ink floor, and no level frame is levelled to it', async () => {
    // The five tierless res_<type> frames are the game's resource ICON — CityScene's resource bar at
    // 33px and its five producer cards at 60px, plus WorldMapScene's header HUD and territory panel —
    // and they were failing at it. Measured 2026-08-27: paper carried 0.019 perceptual ink against the
    // ink bottle's 0.165 beside it in the same bar, i.e. eight times less, and the player reported
    // exactly those two as invisible. The cause is coverage, not a light pen (paper's stroke core is
    // luma 49, graphite's is 21): these are hairline outlines, and an area-correct resize keeps a
    // stroke's colour while dropping its alpha. pack_resources.cjs lifts them back to UI_INK_FLOOR.
    //
    // Asserted on the artifact rather than on the packer's logs because the lift is easy to lose by
    // accident and impossible to notice: drop it and nothing fails, no number anyone reads moves, and
    // the icons quietly go pale again. The `_lN` half of the assertion is the other guard — a well
    // meaning "why not level everything" would flatten the ink differences that ARE the level read
    // (§6.3), so at least one level frame must stay measurably under the floor. res_paper_l1 sits far
    // below it by design, and if it ever does not, the floor has spread where it must not go.
    //
    // Measured on the MERGED page with FRAMES' own coordinates, i.e. the exact pixels the client
    // samples — not on res_atlas.png, which the game never loads and whose frames sit at completely
    // different coordinates (reading one with the other's rectangles is how the first draft of this
    // test "found" res_sticker at 0.009: it was measuring empty atlas somewhere else entirely).
    const UI_INK_FLOOR = 0.070;
    const sharp = (await import('sharp')).default;
    const { data, info } = await sharp(`${MERGED_DIR}/world_atlas.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ink = (name: string): number => {
      const f = (FRAMES[name] as unknown as { frame: { x: number; y: number; w: number; h: number } }).frame;
      let m = 0;
      for (let y = f.y; y < f.y + f.h; y++) {
        for (let x = f.x; x < f.x + f.w; x++) {
          const i = (y * info.width + x) * 4;
          const luma = (0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!) / 255;
          m += (data[i + 3]! / 255) * (1 - luma);
        }
      }
      return m / (f.w * f.h);
    };
    const under = ['ink', 'paper', 'graphite', 'metal', 'sticker']
      .map((t) => ({ frame: `res_${t}`, ink: Number(ink(`res_${t}`).toFixed(4)) }))
      .filter((r) => r.ink < UI_INK_FLOOR);
    expect(under).toEqual([]);
    expect(ink('res_paper_l1')).toBeLessThan(UI_INK_FLOOR);
  });

  it('neither atlas PNG is palette-quantised, and the frames keep their alpha resolution', async () => {
    // Both PNGs in this pipeline were written with sharp's `palette: true` at some point, and in sharp
    // 0.32 ANY of palette/quality/colours/dither/effort silently switches on 8-bit quantisation. It was
    // fixed for the merged page's reflow branch in §6.11, left in its in-place branch until §6.12.7,
    // and left in the packer's own res_atlas encode until §6.12.8 — three sites, same trap, each silent.
    //
    // The damage is on ALPHA, not colour: quantising res_atlas cut it from 240 distinct alpha values to
    // 143, and alpha IS the artwork here (frames are white-knocked-out line art, so alpha carries every
    // stroke and every anti-aliased edge). Asserting the encoding rather than the pixels is what makes
    // this checkable at all — a quantised page still looks approximately right.
    const sharp = (await import('sharp')).default;
    // The two PNGs no longer live side by side: res_atlas moved to art/ on 2026-08-25 (it is a
    // pipeline intermediate the client never imports — see pack_resources.cjs OUT_DIRS), while
    // world_atlas is the shipped merged page.
    for (const name of [SRC_ATLAS_PNG, `${MERGED_DIR}/world_atlas.png`]) {
      // `paletteBitDepth` is absent from sharp's bundled Metadata type but is returned at runtime
      // (sharp 0.32) whenever the PNG is palette-encoded — undefined is what "not quantised" looks like.
      const meta = await sharp(name).metadata() as { paletteBitDepth?: number; channels?: number };
      const label = name.split('/').pop();
      expect({ label, palette: meta.paletteBitDepth, channels: meta.channels }).toEqual({ label, palette: undefined, channels: 4 });
    }
    const { data } = await sharp(SRC_ATLAS_PNG).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphas = new Set<number>();
    for (let i = 3; i < data.length; i += 4) if (data[i]! >= 16) alphas.add(data[i]!);
    expect(alphas.size).toBeGreaterThan(200);
  });

  it('every resource frame in the merged page is byte-identical to res_atlas', async () => {
    // patchMergedAtlas.js copies frames from res_atlas into world_atlas. It used sharp's `composite`,
    // which premultiplies alpha to blend and rounds back, drifting every anti-aliased edge pixel by
    // 1-2 — on frames a given patch has no business touching at all. Frames land in non-overlapping
    // rectangles, so blending has nothing to contribute and raw row copies are both correct and
    // exactly checkable. This assertion is what makes "did that repack disturb the art?" answerable.
    const sharp = (await import('sharp')).default;
    const srcJson = (await import('../../../art/slg/slg-map/res_atlas.json')).default as unknown as
      { frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }> };
    const src = await sharp(SRC_ATLAS_PNG).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const dst = await sharp(`${MERGED_DIR}/world_atlas.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const drifted: string[] = [];
    for (const [name, sf] of Object.entries(srcJson.frames)) {
      const df = (FRAMES[name] as unknown as { frame: { x: number; y: number; w: number; h: number } } | undefined)?.frame;
      if (!df) { drifted.push(`${name} missing from world_atlas`); continue; }
      expect([df.w, df.h]).toEqual([sf.frame.w, sf.frame.h]);
      for (let row = 0; row < df.h && !drifted.includes(name); row++) {
        const a = ((sf.frame.y + row) * src.info.width + sf.frame.x) * 4;
        const b = ((df.y + row) * dst.info.width + df.x) * 4;
        if (Buffer.compare(src.data.subarray(a, a + df.w * 4), dst.data.subarray(b, b + df.w * 4)) !== 0) drifted.push(name);
      }
    }
    expect(drifted).toEqual([]);
  });
});
