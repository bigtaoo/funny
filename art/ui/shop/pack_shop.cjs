/**
 * pack_shop.cjs — Shop card item art source processing + export as compressed transparent PNG.
 *
 * Follows the same white-background-removal pipeline as decos-b/pack_labels.cjs, with two differences:
 *   - NO recolor: shop item art is full-color (gold/amber doodle), so the original RGB is kept —
 *     only the near-white paper background is knocked out to alpha.
 *   - Palette-quantized PNG output (limited-palette doodles compress well), to shrink the assets.
 *
 * Pipeline per image:
 *   1. Load → knock out near-white background: a pixel is "background" when it is bright AND
 *      desaturated (min channel near 255). alpha ramps 0→255 across [WHITE_HI..WHITE_LO] of the
 *      min channel, so the dark ink outline and saturated gold fill stay fully opaque and only the
 *      anti-aliased white edge fades. Original RGB is preserved (no tint).
 *   2. Crop surrounding transparent whitespace using the content bounding box.
 *   3. Scale proportionally so the long edge = LONG_EDGE (source art is huge; the shop card renders
 *      it small — 512 is plenty crisp on hi-dpi while cutting file size hard).
 *   4. Export palette PNG → client/src/assets/shop/<name>.png (transparent background, full color).
 *
 * Usage:    node pack_shop.cjs
 * Requires: reuses client/node_modules/sharp.
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp'));

const LONG_EDGE = 512;   // shop cards render the art small; 512 is ample and keeps files light
const ALPHA_TRIM = 16;   // bbox threshold: ignore near-transparent fringe when cropping
const WHITE_LO = 236;    // min-channel at/below this → fully opaque (content)
const WHITE_HI = 250;    // min-channel at/above this → fully transparent (paper)

// Source file (as dropped in art/ui/shop) → shop asset name. Source is a full-color doodle on white paper.
const JOBS = [
  { src: '7d0c5054-97e9-4403-8a94-5fde2589425f.png', name: 'year_card' },
  { src: 'VDL630e1Xq0xlQFshHW2lw_1784275065029_na1fn_L2hvbWUvdWJ1bnR1L3J1bmVfc3RvbmVfZG9vZGxl.webp', name: 'protect_stone' },
  { src: '8rLJAVtAm0w22vk3ZC4exQ_1784275235795_na1fn_L2hvbWUvdWJ1bnR1L2dhY2hhX3N0YXJ0ZXJfcGFja19kb29kbGU.webp', name: 'starter_draw' },
  { src: 'NYauhRHwcSyqcmsgOgse7U_1784275405018_na1fn_L2hvbWUvdWJ1bnR1L3N0YXJ0ZXJfZ3Jvd3RoX2J1bmRsZV9kb29kbGU.webp', name: 'starter_growth' },
];

const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets/shop');

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
      const mn = Math.min(r, g, b);
      // Bright + desaturated paper knock-out. Saturated gold (low min channel) stays opaque; only
      // the near-white background and its anti-aliased fringe fade out.
      let a;
      if (mn >= WHITE_HI) a = 0;
      else if (mn <= WHITE_LO) a = 255;
      else a = Math.round(255 * (WHITE_HI - mn) / (WHITE_HI - WHITE_LO));
      if (ch === 4) a = Math.min(a, data[i + 3]);
      const di = (y * W + x) * 4;
      out[di] = r; out[di + 1] = g; out[di + 2] = b; out[di + 3] = a;
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

  const scale = Math.min(1, LONG_EDGE / Math.max(cropW, cropH));
  const newW = Math.max(1, Math.round(cropW * scale));
  const newH = Math.max(1, Math.round(cropH * scale));
  const info2 = await sharp(cropBuf, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize(newW, newH, { fit: 'fill' })
    .png({ palette: true, quality: 90, compressionLevel: 9, effort: 10 })
    .toFile(path.join(OUT_DIR, `${job.name}.png`));

  return { name: job.name, w: newW, h: newH, kb: +(info2.size / 1024).toFixed(1) };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  for (const job of JOBS) rows.push(await process(job));
  console.log(`✅ Shop card art packed → ${OUT_DIR}`);
  console.table(rows);
}

main().catch((e) => { console.error(e); process.exit(1); });
