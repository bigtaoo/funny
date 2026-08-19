#!/usr/bin/env node
// resContactSheet.js — render the 5 resource types x l1-l10 as ONE sheet, at the size and opacity
// the game actually draws them on a tile.
//
// Why this exists: every judgement in design/product/slg-resource-art.md §6 was made by looking at
// source drawings side by side at full resolution, and that view is systematically misleading. What
// lands on a tile is the frame scaled by the baked `nw.sizeMul` (which folds in the frame's own
// equivalent edge, so two frames of very different pixel sizes land at the same footprint) and dimmed
// by `nw.alphaMul`. A drawing that looks dense at 128px can read as an empty smudge at 40, and the
// level read is a comparison BETWEEN tiers — invisible unless the tiers sit next to each other at the
// size the player sees. That mismatch is what produced the bug this whole rebuild came from: ink l4
// rendered heavier than ink l10 while every source file looked fine.
//
// It reads the same `nw` block the renderer reads, so the sheet cannot flatter the atlas: if the
// baked read is wrong, the sheet shows it wrong. The diamond behind each cell is the tile outline at
// the same pitch, so "does this overflow its tile" is answerable by eye too.
//
// Run: node art/scripts/resContactSheet.js [--tp=160] [--atlas=<path>] [--out=<path>]
//   --tp     tile pitch in screen px (default 160; the game's L1 is designWidth/11, see zoom.ts)
//   --atlas  atlas JSON to read (default client/src/assets/slg/world_atlas.json — what the game loads)
//   --out    output PNG (default art/slg/slg-map/res_contact_sheet.png)
const fs = require('fs');
const path = require('path');
let sharp;
try { sharp = require('sharp'); }
catch { sharp = require(path.resolve(__dirname, '../../client/node_modules/sharp')); }

const ROOT = path.resolve(__dirname, '../..');
const RES_TYPES = ['ink', 'paper', 'graphite', 'metal', 'sticker'];
const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// Must match @nw/shared's RES_MOTIF_SIZE_FRAC and the client's isometric ratio. Duplicated here
// rather than imported because this is a plain CJS art script with no TS toolchain; the sheet is a
// diagnostic, and a stale constant here would make it lie, so both are asserted in the header row.
const MOTIF_SIZE_FRAC = 0.30;
const ISO_RATIO = 0.5;

const arg = (name, dflt) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const TP = Number(arg('tp', 160));
const ATLAS = path.resolve(ROOT, arg('atlas', 'client/src/assets/slg/world_atlas.json'));
const OUT = path.resolve(ROOT, arg('out', 'art/slg/slg-map/res_contact_sheet.png'));

const CELL_W = Math.round(TP * 1.05);
const CELL_H = Math.round(TP * 0.85);
const LABEL_W = 110;
const HEADER_H = 40;
const FOOT_H = 34;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function main() {
  const json = JSON.parse(fs.readFileSync(ATLAS, 'utf8'));
  const pngPath = path.join(path.dirname(ATLAS), json.meta?.image ?? path.basename(ATLAS).replace(/\.json$/, '.png'));
  const { data: page, info } = await sharp(pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const W = LABEL_W + CELL_W * LEVELS.length;
  const H = HEADER_H + CELL_H * RES_TYPES.length + FOOT_H;
  const composites = [];
  const notes = [];

  // Background + grid + tile diamonds + labels, as one SVG underlay.
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`
    + `<rect width="${W}" height="${H}" fill="#faf7f0"/>`;
  for (let c = 0; c < LEVELS.length; c++) {
    const cx = LABEL_W + c * CELL_W + CELL_W / 2;
    svg += `<text x="${cx}" y="26" font-family="monospace" font-size="18" fill="#555" text-anchor="middle">l${LEVELS[c]}</text>`;
  }
  for (let r = 0; r < RES_TYPES.length; r++) {
    const cy = HEADER_H + r * CELL_H + CELL_H / 2;
    svg += `<text x="${LABEL_W - 12}" y="${cy + 6}" font-family="monospace" font-size="18" fill="#555" text-anchor="end">${esc(RES_TYPES[r])}</text>`;
    for (let c = 0; c < LEVELS.length; c++) {
      const cx = LABEL_W + c * CELL_W + CELL_W / 2;
      const hw = TP / 2, hh = (TP * ISO_RATIO) / 2;
      svg += `<polygon points="${cx},${cy - hh} ${cx + hw},${cy} ${cx},${cy + hh} ${cx - hw},${cy}" `
        + `fill="none" stroke="#d8d0c0" stroke-width="1"/>`;
    }
  }
  svg += `<text x="${LABEL_W}" y="${H - 12}" font-family="monospace" font-size="13" fill="#777">`
    + `tp=${TP}px  MOTIF_SIZE_FRAC=${MOTIF_SIZE_FRAC}  size &amp; alpha from each frame's baked nw  `
    + `(${path.relative(ROOT, ATLAS).replace(/\\/g, '/')})</text>`;
  svg += '</svg>';
  composites.push({ input: Buffer.from(svg), left: 0, top: 0 });

  for (let r = 0; r < RES_TYPES.length; r++) {
    for (let c = 0; c < LEVELS.length; c++) {
      const name = `res_${RES_TYPES[r]}_l${LEVELS[c]}`;
      const f = json.frames?.[name];
      if (!f) { notes.push(`${name}: absent from the atlas`); continue; }
      const nw = f.nw;
      if (!nw) { notes.push(`${name}: no baked nw — drawn unscaled`); }

      // Exactly what the renderer computes, minus the per-tile jitter (which is what the sheet is
      // meant to hold still): scale = tp * MOTIF_SIZE_FRAC * sizeMul, alpha = alphaMul.
      const scale = TP * MOTIF_SIZE_FRAC * (nw ? nw.sizeMul : 1 / Math.max(f.frame.w, f.frame.h));
      const w = Math.max(1, Math.round(f.frame.w * scale));
      const h = Math.max(1, Math.round(f.frame.h * scale));
      const alpha = nw ? nw.alphaMul : 1;

      // Cut the cell out of the page by hand (sharp's extract + composite premultiplies, which
      // shifts anti-aliased edges), dim it, then let sharp do the resample.
      const cut = Buffer.alloc(f.frame.w * f.frame.h * 4);
      for (let y = 0; y < f.frame.h; y++) {
        const from = ((f.frame.y + y) * info.width + f.frame.x) * 4;
        page.copy(cut, y * f.frame.w * 4, from, from + f.frame.w * 4);
      }
      if (alpha < 1) for (let i = 3; i < cut.length; i += 4) cut[i] = Math.round(cut[i] * alpha);

      const sprite = await sharp(cut, { raw: { width: f.frame.w, height: f.frame.h, channels: 4 } })
        .resize(w, h, { fit: 'fill' }).png().toBuffer();
      composites.push({
        input: sprite,
        left: LABEL_W + c * CELL_W + Math.round((CELL_W - w) / 2),
        top: HEADER_H + r * CELL_H + Math.round((CELL_H - h) / 2),
      });
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(OUT);

  console.log(`✓ ${W}x${H} -> ${path.relative(process.cwd(), OUT)}`);
  // sticker legitimately has no l1-l5 (it only spawns on level>=6 tiles), so an empty run there is
  // expected; anything else in this list is a real gap.
  if (notes.length) console.log(notes.map((n) => `  · ${n}`).join('\n'));
}

main().catch((err) => { console.error(err); process.exit(1); });
