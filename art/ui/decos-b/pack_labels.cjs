/**
 * pack_labels.cjs — Group B "battlefield corner handwritten annotations" source image processing + recolor + export as transparent PNG.
 *
 * Uses the same white-background removal pipeline as Group A pack_decos.cjs, with an additional "recolor" step:
 *   1. Load image → remove white background: alpha = 255 - luminance (anti-aliasing grey edges retained as semi-transparent).
 *   2. Override line RGB with the target ink color (keeping the alpha computed in step 1, so edges remain smooth).
 *      — Source images are mostly black/dark line drawings; the spec designates pen colors (red marker / blue pen / red ballpoint),
 *        following the "blue for us, red for enemy" rule: BOSS/here=red (authority/imaginary enemy), START/WIN=blue (player side).
 *   3. Crop surrounding whitespace using content bounding box.
 *   4. Scale proportionally so that the long edge = LONG_EDGE (high-resolution source, scaled down at runtime as needed for corner placement).
 *   5. Export to client/src/assets/decor/battle/label_*.png (transparent background, single color).
 *
 * Usage:    node pack_labels.cjs
 * Requires: reuses client/node_modules/sharp.
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp'));

const LONG_EDGE = 256;   // High-resolution source; corner labels are scaled down as needed
const ALPHA_TRIM = 16;

// Target ink colors (spec §6.2 Group B + blue for us, red for enemy)
const INK_BLUE = { r: 38, g: 58, b: 122 };   // Blue pen (player side)
const INK_RED  = { r: 208, g: 38, b: 44 };   // Red marker / red ballpoint (authority/imaginary enemy)

// Source file → asset name + target ink color (source is white-background dark line drawing; overridden to spec pen color during packing)
const JOBS = [
  { src: 'label_boss.webp',       name: 'label_boss',       ink: INK_RED  },
  { src: 'label_start.webp',      name: 'label_start',      ink: INK_BLUE },
  { src: 'label_win.webp',        name: 'label_win',        ink: INK_BLUE },
  { src: 'label_arrow_here.webp', name: 'label_arrow_here', ink: INK_RED  },
];

const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets/decor/battle');

async function process(job) {
  const file = path.join(__dirname, job.src);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: ch } = info;

  let minX = W, minY = H, maxX = -1, maxY = -1;
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let a = Math.round(255 - lum);
      if (a < 0) a = 0; else if (a > 255) a = 255;
      if (ch === 4) a = Math.min(a, data[i + 3]);
      const di = (y * W + x) * 4;
      out[di] = job.ink.r; out[di + 1] = job.ink.g; out[di + 2] = job.ink.b; out[di + 3] = a;
      if (a > ALPHA_TRIM) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error(`${job.name}: empty image (no content)`);

  const cropW = maxX - minX + 1, cropH = maxY - minY + 1;
  const cropBuf = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const si = ((y + minY) * W + (x + minX)) * 4;
      const dj = (y * cropW + x) * 4;
      cropBuf[dj] = out[si]; cropBuf[dj + 1] = out[si + 1];
      cropBuf[dj + 2] = out[si + 2]; cropBuf[dj + 3] = out[si + 3];
    }
  }

  const scale = LONG_EDGE / Math.max(cropW, cropH);
  const newW = Math.max(1, Math.round(cropW * scale));
  const newH = Math.max(1, Math.round(cropH * scale));
  await sharp(cropBuf, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize(newW, newH, { fit: 'fill' })
    .png()
    .toFile(path.join(OUT_DIR, `${job.name}.png`));

  return { name: job.name, w: newW, h: newH, ink: `#${[job.ink.r, job.ink.g, job.ink.b].map((v) => v.toString(16).padStart(2, '0')).join('')}` };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  for (const job of JOBS) rows.push(await process(job));
  console.log(`✅ Group B packed → ${OUT_DIR}`);
  console.table(rows);
}

main().catch((e) => { console.error(e); process.exit(1); });
