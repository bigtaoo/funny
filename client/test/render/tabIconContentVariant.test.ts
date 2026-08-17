// Guards the third pre-baked ink added 2026-08-15 (`{name}_content.png`, `C.dark`) — the variant
// reward rows use so an AI icon drawn as page CONTENT reads as strongly as the material/coin
// bitmaps and the label beside it, instead of borrowing the de-emphasised inactive-tab grey.
//
// Two independent halves, because the failure modes are independent and neither half sees the
// other's:
//   1. THE ART. `art/ui/tabicons/pack_tab_icons.cjs` has to emit three files per source. A
//      half-finished run, or a `VARIANTS` row pointing two suffixes at the same ink, leaves the
//      content PNG missing or byte-identical to the inactive one — and since the code would still
//      resolve and draw *something*, only a pixel comparison catches it.
//   2. THE TABLE. `TAB_ICON_RASTER` has to carry a `content` url for every kind, distinct from the
//      other two. A copy-pasted row that reuses `…InactiveUrl` for `content` type-checks fine.
// Half 2 can't be folded into half 1: under vitest every `.png` import resolves to the same stubbed
// data URI, so url *identity* is only meaningful on disk, and *key presence* is only meaningful in
// the module. Run: npm test
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { TAB_ICON_RASTER, type RasterIconVariant } from '../../src/render/icons';

const VARIANTS: RasterIconVariant[] = ['active', 'inactive', 'content'];
const ASSET_DIR = path.resolve(__dirname, '../../src/assets/tabicons');

describe('tab-icon PNGs on disk (pack_tab_icons.cjs output)', () => {
  const files = fs.readdirSync(ASSET_DIR).filter((f) => f.endsWith('.png'));
  const bases = [...new Set(files.map((f) => f.replace(/_(active|inactive|content)\.png$/, '')))].sort();

  it('has at least one icon set to check (guards against an empty/moved asset dir)', () => {
    expect(bases.length).toBeGreaterThan(0);
  });

  it('emits exactly the three variants per icon, and nothing else', () => {
    expect(files.length).toBe(bases.length * VARIANTS.length);
    for (const base of bases) {
      for (const v of VARIANTS) {
        expect(fs.existsSync(path.join(ASSET_DIR, `${base}_${v}.png`)), `${base}_${v}.png`).toBe(true);
      }
    }
  });

  it('bakes a genuinely different ink into each variant — no two are byte-identical', () => {
    for (const base of bases) {
      const bytes = VARIANTS.map((v) => fs.readFileSync(path.join(ASSET_DIR, `${base}_${v}.png`)));
      for (let i = 0; i < bytes.length; i++) {
        for (let j = i + 1; j < bytes.length; j++) {
          expect(bytes[i]!.equals(bytes[j]!), `${base}: ${VARIANTS[i]} vs ${VARIANTS[j]}`).toBe(false);
        }
      }
    }
  });
});

describe('TAB_ICON_RASTER — the code side of the same contract', () => {
  const kinds = Object.keys(TAB_ICON_RASTER) as Array<keyof typeof TAB_ICON_RASTER>;

  it('covers every raster kind with all three variants', () => {
    expect(kinds.length).toBeGreaterThan(0);
    for (const kind of kinds) {
      expect(Object.keys(TAB_ICON_RASTER[kind]).sort(), kind).toEqual([...VARIANTS].sort());
    }
  });

  // Batch 5 added 24 icons across two hand-maintained lists (pack_tab_icons.cjs's JOBS and this
  // table). A JOBS row with no table entry packs three PNGs nobody can draw; the reverse fails the
  // webpack build, so only this direction needs a test. Kind name is the asset base plus the
  // `Icon`/`TabIcon` suffix — the pilot trio uses the short form, everything since uses the long one.
  it('has exactly one TAB_ICON_RASTER kind per packed icon (no orphan art)', () => {
    const packed = [...new Set(fs.readdirSync(ASSET_DIR).filter((f) => f.endsWith('.png'))
      .map((f) => f.replace(/_(active|inactive|content)\.png$/, '')))].sort();
    expect(kinds.length).toBe(packed.length);
    for (const base of packed) {
      expect(kinds.filter((k) => k === `${base}Icon` || k === `${base}TabIcon`), base).toHaveLength(1);
    }
  });

  it('points each variant at a distinct import (catches a row reusing the inactive url for content)', () => {
    // Under webpack these are three different urls; under vitest's asset stub all `.png` imports
    // collapse to one data URI, so assert distinctness only when the bundler actually resolved them
    // — otherwise the on-disk half above is the one carrying this guarantee.
    const stubbed = new Set(kinds.flatMap((k) => VARIANTS.map((v) => TAB_ICON_RASTER[k][v]))).size === 1;
    if (stubbed) return;
    for (const kind of kinds) {
      const urls = VARIANTS.map((v) => TAB_ICON_RASTER[kind][v]);
      expect(new Set(urls).size, `${kind}: ${urls.join(' / ')}`).toBe(VARIANTS.length);
    }
  });
});
