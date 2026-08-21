// decorMergedAtlasEncoding.ui.ts — the same class of regression worldMapResMotifLevelRead.ui.ts
// guards for the SLG res/world atlas pair, for the OTHER merged page: decor_merged_atlas.png.
//
// Background (claudedocs/file-formats.md, 2026-08-20): pack_labels.cjs and pack_decos_c.cjs each
// write their own throwaway intermediate (never committed — nothing loads it directly), which
// art/scripts/patchMergedAtlas.js then restamps into client/src/assets/decor/decor_merged_atlas.png,
// the page the client actually bundles. That restamp is where a real, previously silent bug was
// caught: decor_merged_atlas.png was itself palette-quantised (mergeAtlasPages.js's own
// `png({ effort: 10 })` — `effort` alone triggers sharp's 8-bit-palette trap, same as the sites fixed
// upstream for res_atlas/world_atlas). Nothing threw and the page still looked approximately right;
// only the PNG's own encoding metadata gives this away.
//
// Note on the check itself: mirrors the sibling test's `metadata().paletteBitDepth` — verified it
// still discriminates under the currently pinned sharp 0.35.3 by re-encoding this exact file with
// `png({ effort: 10 })` and confirming that comes back `paletteBitDepth: 8` (undefined on the
// checked-in, non-quantised file). Don't reach for `isPalette` instead: it turned out to be set only
// for SOME palette PNGs (observed true on the pre-fix decor_merged_atlas.png, but undefined on a
// same-process `effort: 10` re-encode of world_atlas.png/decor_merged_atlas.png) — a real regression
// via this repo's own tooling lands on `paletteBitDepth`, not `isPalette`.
import { describe, it, expect } from 'vitest';
import atlasData from '../../src/assets/decor/decor_merged_atlas.json';

// Hardcoded on purpose (same call as EXPECTED_RES_FRAMES in the sibling test): this pins the frame
// catalog against silent drift (a re-merge dropping a frame, or a source webp renamed) independently
// of whatever the packers currently enumerate.
const LABEL_FRAMES = ['label_boss', 'label_start', 'label_win', 'label_arrow_here'] as const;
const DECOC_FRAMES = [
  'decoc_airplane', 'decoc_castle', 'decoc_catapult', 'decoc_compass', 'decoc_crown', 'decoc_inkblot',
  'decoc_inkblot_outline', 'decoc_shield', 'decoc_soldier', 'decoc_soldiers', 'decoc_swords', 'decoc_thinking',
] as const;

type Frame = { frame: { x: number; y: number; w: number; h: number } };
const FRAMES = (atlasData as { frames: Record<string, Frame> }).frames;

describe('decor_merged_atlas carries the labels + decos-c frames', () => {
  it('every label_* and decoc_* frame from the packers is present in the merged page', () => {
    const missing = [...LABEL_FRAMES, ...DECOC_FRAMES].filter((n) => !FRAMES[n]);
    expect(missing).toEqual([]);
  });

  it('no frame is degenerate (zero-area) — a bad crop/resize lands here as a 0×N or N×0 rect', () => {
    for (const name of [...LABEL_FRAMES, ...DECOC_FRAMES]) {
      const { w, h } = FRAMES[name]!.frame;
      expect(w, name).toBeGreaterThan(0);
      expect(h, name).toBeGreaterThan(0);
    }
  });

  it('labels are packed at the long-edge=256 the packer targets; decos-c at long-edge=128', () => {
    // LONG_EDGE constants from pack_labels.cjs / pack_decos_c.cjs respectively — proportional scaling
    // means exactly one side hits the target and the other is <=.
    for (const name of LABEL_FRAMES) {
      const { w, h } = FRAMES[name]!.frame;
      expect(Math.max(w, h), name).toBe(256);
    }
    for (const name of DECOC_FRAMES) {
      const { w, h } = FRAMES[name]!.frame;
      expect(Math.max(w, h), name).toBe(128);
    }
  });

  it('the merged page PNG is not palette-quantised', async () => {
    // The bug this guards: quantising a page built from many independently-drawn sub-atlases (this
    // page holds decor Group A + Group B labels + Group C icons, drawn at different times with
    // different ink colours) drifts alpha on every anti-aliased edge by up to 12-38/255 — invisible in
    // a diff-by-eye, real once you've decoded the pixels. Asserting the encoding rather than pixel
    // values is what makes this checkable without a golden-image fixture.
    const sharp = (await import('sharp')).default;
    const meta = await sharp(`${__dirname}/../../src/assets/decor/decor_merged_atlas.png`).metadata() as
      { paletteBitDepth?: number; channels?: number };
    expect({ palette: meta.paletteBitDepth, channels: meta.channels }).toEqual({ palette: undefined, channels: 4 });
  });
});
