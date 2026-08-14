/**
 * pack_tab_icons.cjs — Process tabicon_*.{webp,png} source images (AI-generated, white background,
 * single dark-ink line art) into transparent PNGs, baking TWO recolored variants per source:
 *   - `{name}_active.png`   — RGB overridden to white (#ffffff), for the active tab cell (dark fill).
 *   - `{name}_inactive.png` — RGB overridden to mid-grey (#686868, matches sketchUi.ts's `C.mid`),
 *                             for the inactive tab cell (paper fill).
 *
 * This mirrors decos-b's pack_labels.cjs "bake the ink color at pack time" trick (there's no
 * runtime-tint-an-AI-PNG precedent in this codebase — vector icons tint live via PIXI Graphics
 * `color` param, but a raster asset needs the color baked into two separate exports instead), just
 * emitting two colors per source instead of one — see design/product/tab-icon-art-prompts.md.
 *
 * Pipeline per source image:
 *   1. Load → compute alpha = 255 - luminance (white bg → transparent, ink → opaque, anti-aliased
 *      edges → semi-transparent), independently for each of the two target colors.
 *   2. Override RGB with the target ink color, keep the alpha computed in step 1.
 *   3. Crop surrounding whitespace using the content bounding box.
 *   4. Scale proportionally so the long edge = LONG_EDGE.
 *   5. Export both variants to client/src/assets/tabicons/.
 *
 * Usage:    node pack_tab_icons.cjs
 * Requires: reuses client/node_modules/sharp (no separate install needed).
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp'));

const LONG_EDGE = 128;  // source is AI-res; runtime displays at ~28-40px, this leaves headroom
const ALPHA_TRIM = 16;

const INK_ACTIVE   = { r: 0xff, g: 0xff, b: 0xff }; // white — active tab cell (dark fill)
const INK_INACTIVE = { r: 0x68, g: 0x68, b: 0x68 }; // C.mid — inactive tab cell (paper fill)

// Source file (in this dir) → asset name. Add a row here for each new tab icon pilot batch.
const JOBS = [
  { src: 'tabicon_roster.webp', name: 'roster' },
  { src: 'tabicon_equip.webp',  name: 'equip' },
  { src: 'tabicon_skin.webp',   name: 'skin' },
];

const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets/tabicons');

async function recolor(rawData, W, H, ch, ink) {
  const out = Buffer.alloc(W * H * 4);
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const r = rawData[i], g = rawData[i + 1], b = rawData[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let a = Math.round(255 - lum);
      if (a < 0) a = 0; else if (a > 255) a = 255;
      if (ch === 4) a = Math.min(a, rawData[i + 3]);
      const di = (y * W + x) * 4;
      out[di] = ink.r; out[di + 1] = ink.g; out[di + 2] = ink.b; out[di + 3] = a;
      if (a > ALPHA_TRIM) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // empty image (no content)

  const cropW = maxX - minX + 1, cropH = maxY - minY + 1;
  const cropBuf = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const si = ((y + minY) * W + (x + minX)) * 4;
      const di = (y * cropW + x) * 4;
      cropBuf[di] = out[si]; cropBuf[di + 1] = out[si + 1];
      cropBuf[di + 2] = out[si + 2]; cropBuf[di + 3] = out[si + 3];
    }
  }

  const scale = LONG_EDGE / Math.max(cropW, cropH);
  const newW = Math.max(1, Math.round(cropW * scale));
  const newH = Math.max(1, Math.round(cropH * scale));
  const buf = await sharp(cropBuf, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize(newW, newH, { fit: 'fill' }).png().toBuffer();
  return { buf, w: newW, h: newH };
}

async function process(job) {
  const file = path.join(__dirname, job.src);
  if (!fs.existsSync(file)) {
    console.warn(`⚠️  skip ${job.name}: source not found (${job.src}) — drop the AI-generated file here first`);
    return [];
  }
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: ch } = info;

  const rows = [];
  for (const [suffix, ink] of [['active', INK_ACTIVE], ['inactive', INK_INACTIVE]]) {
    const result = await recolor(data, W, H, ch, ink);
    if (!result) throw new Error(`${job.name}: empty image (no content)`);
    const outName = `${job.name}_${suffix}.png`;
    await sharp(result.buf).toFile(path.join(OUT_DIR, outName));
    rows.push({ name: outName, w: result.w, h: result.h });
  }
  return rows;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  for (const job of JOBS) rows.push(...(await process(job)));
  if (!rows.length) {
    console.error('No source files found — see design/product/tab-icon-art-prompts.md for the prompts, drop AI output as tabicon_*.webp next to this script.');
    process.exit(1);
  }
  console.log(`✅ Packed ${rows.length} PNG(s) → ${OUT_DIR}`);
  console.table(rows);
}

main().catch((e) => { console.error(e); process.exit(1); });
