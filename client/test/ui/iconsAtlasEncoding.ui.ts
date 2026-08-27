// iconsAtlasEncoding.ui.ts — the third and last instance of the guard decorMergedAtlasEncoding.ui.ts
// and worldMapResMotifLevelRead.ui.ts already carry for the other two merged atlas pages.
//
// Background (claudedocs/file-formats.md, design/game/ASSET_PACKAGING.md §16): all three shared pages
// were minted by art/scripts/mergeAtlasPages.js's `png({ compressionLevel: 9, effort: 10 })`, and in
// sharp 0.32 `effort` ALONE silently switches pngsave to 8-bit palette quantisation. world_atlas was
// un-quantised 2026-08-19 and decor_merged_atlas 2026-08-20; icons_atlas was left for last because
// 30+ scene files reach it. Measured on this page before the 2026-08-27 repack: 97.8% of the icon
// pixels differed from the true source art, 119,859 of them with alpha>0, worst channel delta 254 and
// worst ALPHA delta 63/255 — the largest drift of the three pages, and invisible in any diff-by-eye.
//
// Note on the check itself: `metadata().paletteBitDepth`, same as the sibling tests. Verified it still
// discriminates by re-encoding this exact file with `png({ effort: 10 })` in-process and confirming
// that comes back `paletteBitDepth: 8` (undefined on the checked-in file). Do NOT switch to
// `isPalette`: it is set for only some palette PNGs, so a fresh regression via this repo's own tooling
// would slip past it.
import { describe, it, expect } from 'vitest';
import atlasData from '../../src/assets/icons/icons_atlas.json';

// Hardcoded on purpose (same call as the sibling tests): this pins the frame catalog against silent
// drift independently of whatever the packers currently enumerate. The three lists ARE the page — one
// per sub-atlas that still feeds it (art/scripts/mergeAssetAtlases.js's `icons` group).
const EQUIPMENT_FRAMES = [
  'wp_pencil', 'wp_pen', 'wp_marker', 'wp_highlighter',
  'ar_draft', 'ar_cardstock', 'ar_leather', 'ar_foil',
  'tk_clip', 'tk_bookmark', 'tk_sticker', 'tk_seal',
] as const;
const MATERIAL_FRAMES = ['scrap', 'lead', 'binding'] as const;
const FACTION_FRAMES = ['tao', 'anna'] as const;

// The 8 white-line frames avatarAtlas.ts used to read. presetAvatarArt.ts replaced them with
// standalone bust PNGs and the loader module was deleted, but the frames sat in this L0 boot page
// unreferenced until the 2026-08-27 repack evicted them. Asserting their ABSENCE is what keeps a
// future re-merge from quietly reinstating dead weight in the one atlas that blocks app boot — and
// nothing else can catch it, because no consumer of this atlas enumerates frames (see
// render/atlas/iconsAtlas.ts): unreachable frames throw nothing and render nothing.
const RETIRED_AVATAR_FRAMES = ['book', 'trophy', 'swords', 'castle', 'pencils', 'globe', 'coin', 'home'] as const;

type Frame = { frame: { x: number; y: number; w: number; h: number } };
const ATLAS = atlasData as { frames: Record<string, Frame>; meta: { size: { w: number; h: number } } };
const FRAMES = ATLAS.frames;
const LIVE = [...EQUIPMENT_FRAMES, ...MATERIAL_FRAMES, ...FACTION_FRAMES];

describe('icons_atlas carries exactly the equipment + material + faction frames', () => {
  it('every frame the three consumers look up is present', () => {
    expect(LIVE.filter((n) => !FRAMES[n])).toEqual([]);
  });

  it('carries nothing else — no retired avatar frames, no strays', () => {
    // Two assertions in one: the retired set specifically (the regression with a name), and the
    // total count (any OTHER stray a re-merge might add).
    expect(RETIRED_AVATAR_FRAMES.filter((n) => n in FRAMES)).toEqual([]);
    expect(Object.keys(FRAMES).sort()).toEqual([...LIVE].sort());
  });

  it('no frame is degenerate (zero-area) — a bad crop/resize lands here as a 0xN or Nx0 rect', () => {
    for (const name of LIVE) {
      const { w, h } = FRAMES[name]!.frame;
      expect(w, name).toBeGreaterThan(0);
      expect(h, name).toBeGreaterThan(0);
    }
  });

  it('equipment/material are packed at the CELL=128 their builders target, factions at FRAME=256', () => {
    // CELL / FRAME constants from art/ui/equipment/build-atlas.js, art/ui/material/build-atlas.js and
    // art/ui/camps/pack_faction_atlas.js. These are square cells, not long-edge fits, so both sides
    // must hit the number — and equipmentAtlas.ts's `sprite.scale.set(size / 128)` depends on it.
    for (const name of [...EQUIPMENT_FRAMES, ...MATERIAL_FRAMES]) {
      expect(FRAMES[name]!.frame, name).toMatchObject({ w: 128, h: 128 });
    }
    for (const name of FACTION_FRAMES) {
      expect(FRAMES[name]!.frame, name).toMatchObject({ w: 256, h: 256 });
    }
  });

  it('every frame lies inside the canvas the JSON declares', () => {
    // Catches the half of a botched reflow that the encoding check cannot see: coordinates rewritten
    // against one canvas size while `meta.size` says another. PIXI would clamp silently.
    const { w: cw, h: ch } = ATLAS.meta.size;
    for (const name of LIVE) {
      const f = FRAMES[name]!.frame;
      expect(f.x + f.w, `${name} right edge`).toBeLessThanOrEqual(cw);
      expect(f.y + f.h, `${name} bottom edge`).toBeLessThanOrEqual(ch);
    }
  });

  it('the page is packed tightly — an L0 boot texture pays its area in VRAM, not just in bytes', () => {
    // Why an area budget and not just the palette check: the pre-2026-08-27 page was 2048x768 for the
    // same art (6.00 MB decoded at RGBA8) purely because patchMergedAtlas.js's reflow used a 2048
    // width cap, which put 17 frames in one long row at 49.9% utilisation (repacked at 520 it is
    // 93.1%). Bytes on the wire went UP in that repack
    // (166 -> 294 KB, the cost of not quantising); decoded texture bytes went DOWN 74%, and on the
    // page that gates app boot that is the number that matters (ADR-073). 0.6 MB of headroom over the
    // 1.54 MB the current pack achieves — enough for a frame or two, not for a silent return to a
    // one-row layout.
    const { w, h } = ATLAS.meta.size;
    expect((w * h * 4) / (1024 * 1024)).toBeLessThan(2.2);
  });

  it('the merged page PNG is not palette-quantised', async () => {
    const sharp = (await import('sharp')).default;
    const meta = (await sharp(`${__dirname}/../../src/assets/icons/icons_atlas.png`).metadata()) as {
      paletteBitDepth?: number;
      channels?: number;
      width?: number;
      height?: number;
    };
    expect({ palette: meta.paletteBitDepth, channels: meta.channels }).toEqual({ palette: undefined, channels: 4 });
    // The PNG and the JSON must agree on the canvas, or every frame rect is measured against the
    // wrong page. Cheap to assert while the decode is already open.
    expect({ w: meta.width, h: meta.height }).toEqual(ATLAS.meta.size);
  });
});
