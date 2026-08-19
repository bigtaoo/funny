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
import { resMotifPlacement, resMotifJitter, RES_LEVEL_LABEL_MIN_LEVEL, RES_LEVEL_LABEL_MIN_TP, RES_MOTIF_SIZE_FRAC, type ResMotifFrameRead } from '@nw/shared';
import atlasData from '../../src/assets/slg/world_atlas.json';

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
