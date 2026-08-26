// Measures the packed icon PNGs as ART, not as code — the two things about a source image that make
// it unusable in the game are invisible to every other icon test, because they are properties of the
// drawing rather than of the tables.
//
// Both come out of the batch-7 redraw rounds (design/product/tab-icon-art-prompts-batch7.md):
//
//   1. ASPECT RATIO. `pack_tab_icons.cjs` crops to the content bounding box and normalises the LONG
//      edge to LONG_EDGE; `buildInkIcon`/`buildRasterTabIcon` then contain-fit into a SQUARE box. So a
//      tall thin drawing paints only a fraction of the cell it is given: `brush` v2 came back at
//      27x128 (4.74:1) and rendered ~6 pixels wide in a 28px tab cell, reading as a hair with a dot
//      on it — while satisfying every word of its prompt, which had constrained the bristle head
//      against the handle but never the outer silhouette. That took a human squinting at a contact
//      sheet to catch; this catches it on the next `node pack_tab_icons.cjs`.
//
//   2. ESCALATING TIERS. `armorHeavy` is defined as "the same buckler, visibly reinforced" — its
//      whole job is to read as heavier than `armor` at a glance. That used to be guarded by
//      test/ui/icons.ui.ts counting Graphics draw calls; the art replaced the draw functions, so the
//      contract has to be measured on pixels now.
//
// NOT guarded here, deliberately: whether the three hourglass tiers are *distinguishable*. The
// obvious metric says they are and always were — the rejected v1 art (dot-stipple sand, which
// dissolves at 28px and was the whole reason for the redraw) grew its ink mass by x1.78 and x1.71 per
// tier, MORE than the v2 art that actually reads (x1.25, x1.12). Ink mass measures how much ink, not
// whether it holds together, so a monotonic assertion over it would have passed the broken set and
// bought nothing but false confidence. Legibility of that family stays a 28px side-by-side eyeball,
// per the doc's 验收口径 section. The floor below is only that: a floor.
// Run: npm test
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ASSET_DIR = path.resolve(__dirname, '../../src/assets/tabicons');

/** PNG IHDR — cheaper than decoding, and all we need for a ratio. */
function pngSize(file: string): { w: number; h: number } {
  const b = fs.readFileSync(path.join(ASSET_DIR, file));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/**
 * "Ink mass": the glyph's total alpha once rendered into the 28x28 box a tab cell / affix row actually
 * draws it at, expressed in whole opaque pixels. `sharp` does the decode and resize — it is already
 * installed under client/node_modules (the pack script itself requires it from there), and the import
 * is local to this function so no other suite pays for loading it.
 */
async function inkMass28(file: string): Promise<number> {
  const sharp = (await import('sharp')).default;
  const raw = await sharp(path.join(ASSET_DIR, file))
    .resize(28, 28, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer();
  let sum = 0;
  for (let i = 3; i < raw.length; i += 4) sum += raw[i]!;
  return sum / 255;
}

describe('packed icon art — silhouette proportions', () => {
  /**
   * Ratio of long edge to short edge above which a glyph is wasting most of the square cell it gets.
   * 2.2 sits well clear of the set's median (1.24) and of every shape that is elongated on purpose
   * but still fine, while failing `brush` v2's 4.74 by a mile.
   */
  const MAX_RATIO = 2.2;

  /**
   * Bases allowed past {@link MAX_RATIO}, each because the SUBJECT is genuinely long and squashing it
   * to fit would be worse than the wasted width. Add a row here only with a reason — the point of the
   * gate is that a sliver has to be an argued decision rather than an accident of what came back from
   * the image model.
   *   `weapon` (3.28) — one upright sword, the equipment slot filter. Shipped since batch 5.
   *   `event`  (2.72) — a horizontal string of bunting; wide rather than tall, same trade.
   *   `atk`    (2.33) — an upright dagger. Already recorded as one of batch 7's weaker glyphs
   *                     (design/product/tab-icon-art-prompts-batch7.md) for exactly this reason.
   */
  const ELONGATED_ON_PURPOSE = new Set(['weapon', 'event', 'atk']);

  const files = fs.readdirSync(ASSET_DIR).filter((f) => f.endsWith('.png'));

  it('has art to measure (guards an empty or moved asset dir)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it(`keeps every glyph under ${MAX_RATIO}:1 unless it is on the elongated-on-purpose list`, () => {
    const tooThin: string[] = [];
    for (const f of files) {
      const base = f.replace(/_(active|inactive|content|accent)\.png$/, '');
      if (ELONGATED_ON_PURPOSE.has(base)) continue;
      const { w, h } = pngSize(f);
      const ratio = Math.max(w, h) / Math.min(w, h);
      if (ratio > MAX_RATIO) tooThin.push(`${f} ${w}x${h} = ${ratio.toFixed(2)}:1`);
    }
    // A failure here is a source-image problem, not a code problem: redraw with the overall
    // silhouette constrained (see the batch-7 doc's `brush` v3 prompt for the wording that works),
    // or add the base to ELONGATED_ON_PURPOSE with a reason.
    expect(tooThin).toEqual([]);
  });

  it('lists nothing in ELONGATED_ON_PURPOSE that no longer needs the exemption', () => {
    const stale = [...ELONGATED_ON_PURPOSE].filter((base) => {
      const f = files.find((x) => x.startsWith(`${base}_`));
      if (!f) return false; // gone entirely — the next test catches that
      const { w, h } = pngSize(f);
      return Math.max(w, h) / Math.min(w, h) <= MAX_RATIO;
    });
    expect(stale).toEqual([]);
  });

  it('lists nothing in ELONGATED_ON_PURPOSE that has no art at all', () => {
    const missing = [...ELONGATED_ON_PURPOSE].filter((b) => !files.some((f) => f.startsWith(`${b}_`)));
    expect(missing).toEqual([]);
  });
});

describe('packed icon art — escalating tiers', () => {
  // `armorHeavy` is the SLG shop's longer protection tier and reuses `armor`'s silhouette on purpose,
  // so "visibly reinforced" is the only thing separating them. Measured 164 vs 243 opaque pixels at
  // 28px (x1.48); the floor is set well under that so a redraw has room to move, but a heavy variant
  // that stops being heavier fails.
  it('draws armorHeavy with meaningfully more ink than armor at 28px', async () => {
    const [base, heavy] = await Promise.all([
      inkMass28('armor_active.png'), inkMass28('armorHeavy_active.png'),
    ]);
    expect(heavy / base).toBeGreaterThan(1.15);
  });

  // A floor, not a legibility check (see the file header): this catches a JOBS row copy-pasted so two
  // tiers point at the same source, or Sm and Lg swapped — mistakes that are invisible in review and
  // that no eyeball pass would be asked to look for. It does NOT establish that the tiers can be
  // told apart; the v1 art it would have passed is in art/ui/tabicons/_rejected/.
  it('orders the three hourglass tiers by ink, and never emits two identical tiers', async () => {
    const [sm, md, lg] = await Promise.all([
      inkMass28('hourglassSm_active.png'),
      inkMass28('hourglassMd_active.png'),
      inkMass28('hourglassLg_active.png'),
    ]);
    expect(sm).toBeLessThan(md!);
    expect(md).toBeLessThan(lg!);
  });
});
