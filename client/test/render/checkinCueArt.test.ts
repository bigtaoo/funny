// The check-in calendar's focal cue art (2026-09-05, RETENTION_DESIGN §10.16): an arrow that points
// into the claimable cell and a starburst drawn behind it. Packed by pack_tab_icons.cjs like a tab
// icon but deliberately not one — never in `TAB_ICON_RASTER`, never dispatched through `buildIcon`,
// and carrying a single opt-in ink (`checkinCue`) instead of the tab triple, which is why
// `tabIconContentVariant.test.ts` excludes both bases. These are the contracts that replace the
// ones it skips.
//
// The contract worth a file of its own is the INK. These two glyphs exist only to point at one
// green box, and the green is baked into the PNG at pack time while the box's own green is a
// constant in panels.ts — two independent copies of one colour, in two languages, that no compiler
// or renderer will ever compare. Drift is silent and reads as "the arrow isn't part of the cell".
// Run: npm test
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const ASSET_DIR = path.resolve(__dirname, '../../src/assets/tabicons');
const PACKER = path.resolve(__dirname, '../../../art/ui/tabicons/pack_tab_icons.cjs');
const PANELS = path.resolve(__dirname, '../../src/scenes/DailyScene/panels.ts');
const BASES = ['cueArrow', 'cueBurst'] as const;
const INK = 'checkinCue';

/** Width/height straight out of the PNG's IHDR chunk — no image decoder needed. */
function pngSize(file: string): { w: number; h: number } {
  const buf = fs.readFileSync(path.join(ASSET_DIR, file));
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/**
 * The palette (PLTE chunk) of a quantised PNG — the packer writes `png({ palette: true })`, so every
 * ink these files contain is one of at most 256 entries here, and the baked ink is whichever entry
 * the strokes use. Walking the chunk list is enough; no pixel decoding needed.
 */
function pngPalette(file: string): number[] {
  const buf = fs.readFileSync(path.join(ASSET_DIR, file));
  let off = 8;   // skip the PNG signature
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'PLTE') {
      const out: number[] = [];
      for (let i = 0; i < len; i += 3) {
        out.push((buf[off + 8 + i]! << 16) | (buf[off + 9 + i]! << 8) | buf[off + 10 + i]!);
      }
      return out;
    }
    off += 12 + len;
  }
  return [];
}

describe('check-in cue art', () => {
  it('ships one PNG per cue, in the checkinCue ink only (no tab inks, no back-button inks)', () => {
    for (const base of BASES) {
      expect(fs.existsSync(path.join(ASSET_DIR, `${base}_${INK}.png`)), `${base}_${INK}.png`).toBe(true);
      for (const other of ['active', 'inactive', 'content', 'accent']) {
        expect(
          fs.existsSync(path.join(ASSET_DIR, `${base}_${other}.png`)),
          `${base}_${other}.png should not exist`,
        ).toBe(false);
      }
    }
  });

  // Two copies of one colour that nothing compares at build or draw time: the packer's INKS table
  // bakes it into the pixels, panels.ts's INK_CLAIMABLE strokes the cell's border with it. If they
  // drift the page still renders — the arrow simply stops looking like it belongs to the box.
  it('bakes exactly the green that panels.ts draws the claimable cell in', () => {
    const inkRow = /checkinCue:\s*\{\s*r:\s*(0x[0-9a-f]{2}),\s*g:\s*(0x[0-9a-f]{2}),\s*b:\s*(0x[0-9a-f]{2})/i
      .exec(fs.readFileSync(PACKER, 'utf8'));
    expect(inkRow, 'checkinCue row in pack_tab_icons.cjs INKS').not.toBeNull();
    const packerInk = (Number(inkRow![1]) << 16) | (Number(inkRow![2]) << 8) | Number(inkRow![3]);

    const cellInk = /INK_CLAIMABLE\s*=\s*(0x[0-9a-f]{6})/i.exec(fs.readFileSync(PANELS, 'utf8'));
    expect(cellInk, 'INK_CLAIMABLE in DailyScene/panels.ts').not.toBeNull();
    expect(packerInk).toBe(Number(cellInk![1]));

    // …and that the packed pixels really carry it, not just the table that claims to.
    for (const base of BASES) {
      expect(pngPalette(`${base}_${INK}.png`), `${base} palette`).toContain(packerInk);
    }
  });

  // Both cues are positioned as squares (`buildRasterTabIcon(url, size, size)`, sized off the
  // calendar cell's height): a redraw at a lopsided aspect would contain-fit into a much smaller
  // box than intended and quietly shrink, rather than fail.
  it('stays roughly square, which is what the sizing assumes', () => {
    for (const base of BASES) {
      const { w, h } = pngSize(`${base}_${INK}.png`);
      expect(w / h, `${base} aspect`).toBeGreaterThan(0.8);
      expect(w / h, `${base} aspect`).toBeLessThan(1.25);
    }
  });

  // The burst is drawn UNDER the cell, so only its outer ends show. If a redraw fills the middle
  // (a sun disc, a solid star — every one of those is in the prompt's Avoid list for this reason),
  // the visible result is a green rectangle bleeding out from behind the cell.
  it('keeps the burst hollow in the middle, where the cell covers it', () => {
    const buf = fs.readFileSync(path.join(ASSET_DIR, `cueBurst_${INK}.png`));
    const { w, h } = pngSize(`cueBurst_${INK}.png`);
    let off = 8;
    const idat: Buffer[] = [];
    let bitDepth = 0, colorType = 0;
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('ascii', off + 4, off + 8);
      if (type === 'IHDR') { bitDepth = buf[off + 16]!; colorType = buf[off + 17]!; }
      if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
      off += 12 + len;
    }
    // Palette PNG, 8bpp — anything else means the packer's encode changed and this reader is lying.
    expect({ bitDepth, colorType }).toEqual({ bitDepth: 8, colorType: 3 });
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const alpha = trnsAlpha(buf);
    // Un-filter enough to read the middle rows: PNG scanlines each carry a filter byte, and the
    // packer's output uses per-row filters, so reconstruct properly rather than sampling blind.
    const stride = w + 1;
    const px = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) {
      const filter = raw[y * stride]!;
      for (let xi = 0; xi < w; xi++) {
        const cur = raw[y * stride + 1 + xi]!;
        const a = xi > 0 ? px[y * w + xi - 1]! : 0;
        const b = y > 0 ? px[(y - 1) * w + xi]! : 0;
        const c = xi > 0 && y > 0 ? px[(y - 1) * w + xi - 1]! : 0;
        px[y * w + xi] = filter === 0 ? cur
          : filter === 1 ? (cur + a) & 0xff
            : filter === 2 ? (cur + b) & 0xff
              : filter === 3 ? (cur + ((a + b) >> 1)) & 0xff
                : (cur + paeth(a, b, c)) & 0xff;
      }
    }
    // A DISC, not a box, and a small one. Measured on the accepted art: a square sample of the
    // nominal hole size reads 13.6% inked (its corners fall outside the circle and catch the
    // diagonal rays), and even a disc at 0.22·w reads 5.4% (the rays' inner ends reach further in
    // than the prompt asked, and the pack-time dilation grows them inward too). Neither number
    // means "filled". Sample the deep centre instead, where hollow art is unambiguously empty and
    // every failure this guards — sun disc, solid star, filled centre — is near 100%.
    let inked = 0, total = 0;
    const r = Math.min(w, h) * 0.15;
    for (let y = 0; y < h; y++) {
      for (let xi = 0; xi < w; xi++) {
        const dx = xi - w / 2, dy = y - h / 2;
        if (dx * dx + dy * dy > r * r) continue;
        total++;
        if ((alpha[px[y * w + xi]!] ?? 255) > 32) inked++;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(inked / total, 'inked share of the burst centre').toBeLessThan(0.02);
  });
});

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Per-palette-entry alpha from the tRNS chunk (entries past its length are fully opaque). */
function trnsAlpha(buf: Buffer): number[] {
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (buf.toString('ascii', off + 4, off + 8) === 'tRNS') {
      return [...buf.subarray(off + 8, off + 8 + len)];
    }
    off += 12 + len;
  }
  return [];
}
