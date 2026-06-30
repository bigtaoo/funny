/**
 * pack_decos_c.cjs — Group C "lobby/feature-area hand-drawn icons" source image processing + packing into a PixiJS atlas.
 *
 * Uses the same pipeline as Group A pack_decos.cjs (remove white background / crop / proportional scale / shelf packing /
 * export TexturePacker JSON-Hash), with two differences:
 *   - Long-edge LONG_EDGE = 128 (Group C contains functional icons that are more detailed than Group A corner doodles, requiring higher resolution);
 *   - Atlas width ATLAS_W = 512 (fits ~4 frames of 128px per row).
 * Also [preserves original ink color without tinting] — these are black ink line drawings; per §6.2 they are used as-is and must not be tinted to faction colors.
 *
 * Processing pipeline (all in memory, no intermediate files written):
 *   1. Load image → remove white background: alpha = 255 - luminance (white background → fully transparent, ink lines → opaque, grey anti-aliasing edges → semi-transparent), original line color preserved.
 *   2. Crop surrounding whitespace using content bounding box.
 *   3. Scale proportionally so that the long edge = LONG_EDGE.
 *   4. Shelf-pack into a single atlas PNG (with PAD spacing to prevent bleeding).
 *   5. Export to client/src/assets/decor/decor_c_atlas.png + decor_c_atlas.json.
 *
 * Frame names have no extension (e.g. `decoc_crown`), for use as textures['decoc_crown'].
 * Source images are matched by decoc_*.{webp,png} — unmatched sources (e.g. a photographed pennant) do not hit this prefix and are automatically skipped.
 *
 * Usage:    node pack_decos_c.cjs
 * Requires: reuses client/node_modules/sharp (no separate install needed).
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp'));

const LONG_EDGE = 128;  // Group C target long edge
const PAD = 2;          // per-frame spacing inside the atlas
const ATLAS_W = 512;    // atlas width (fixed; ~4 frames of 128px per row)
const ALPHA_TRIM = 16;  // alpha threshold for considering a pixel “has content” during crop

const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets/decor');

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

async function loadSprite(file) {
  const name = path.basename(file).replace(/\.(webp|png)$/i, '');
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: ch } = info;

  // Remove white background + compute content bounding box
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let a = Math.round(255 - lum);
      if (a < 0) a = 0; else if (a > 255) a = 255;
      // If the source already has an alpha channel, take the smaller value (preserve original transparency)
      if (ch === 4) a = Math.min(a, data[i + 3]);
      data[i + 3] = a;
      if (a > ALPHA_TRIM) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error(`${name}: empty image (no content)`);

  const cropW = maxX - minX + 1, cropH = maxY - minY + 1;
  const cropBuf = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const si = ((y + minY) * W + (x + minX)) * ch;
      const di = (y * cropW + x) * 4;
      cropBuf[di] = data[si]; cropBuf[di + 1] = data[si + 1];
      cropBuf[di + 2] = data[si + 2]; cropBuf[di + 3] = data[si + 3];
    }
  }

  // Proportional scale: long edge = LONG_EDGE
  const scale = LONG_EDGE / Math.max(cropW, cropH);
  const newW = Math.max(1, Math.round(cropW * scale));
  const newH = Math.max(1, Math.round(cropH * scale));
  const buf = await sharp(cropBuf, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize(newW, newH, { fit: 'fill' }).png().toBuffer();

  return { name, buf, w: newW, h: newH };
}

async function main() {
  const files = fs.readdirSync(__dirname)
    .filter((f) => /^decoc_.*\.(webp|png)$/i.test(f))
    .sort();
  if (!files.length) { console.error('No decoc_*.{webp,png} files found'); process.exit(1); }

  const sprites = [];
  for (const f of files) sprites.push(await loadSprite(path.join(__dirname, f)));

  // Shelf packing: sort by height descending, fill row by row
  sprites.sort((a, b) => b.h - a.h);
  let cx = PAD, cy = PAD, rowH = 0, usedH = 0;
  for (const s of sprites) {
    if (cx + s.w + PAD > ATLAS_W) { cx = PAD; cy += rowH + PAD; rowH = 0; }
    s.x = cx; s.y = cy;
    cx += s.w + PAD;
    if (s.h > rowH) rowH = s.h;
    usedH = cy + rowH + PAD;
  }
  const ATLAS_H = nextPow2(usedH);

  // Composite atlas
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const canvas = sharp({ create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  const composites = sprites.map((s) => ({ input: s.buf, left: s.x, top: s.y }));
  await canvas.composite(composites).png().toFile(path.join(OUT_DIR, 'decor_c_atlas.png'));

  // Export JSON (TexturePacker JSON-Hash) — frame names have no extension, for use as textures['decoc_crown']
  const frames = {};
  for (const s of [...sprites].sort((a, b) => a.name.localeCompare(b.name))) {
    frames[s.name] = {
      frame: { x: s.x, y: s.y, w: s.w, h: s.h },
      rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: s.w, h: s.h },
      sourceSize: { w: s.w, h: s.h },
    };
  }
  const json = {
    frames,
    meta: { app: 'pack_decos_c.cjs', image: 'decor_c_atlas.png', format: 'RGBA8888', size: { w: ATLAS_W, h: ATLAS_H }, scale: '1' },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'decor_c_atlas.json'), JSON.stringify(json, null, 2));

  console.log(`✅ Group C packed: ${sprites.length} frames → ${OUT_DIR}\\decor_c_atlas.png (${ATLAS_W}×${ATLAS_H}) + decor_c_atlas.json`);
  console.table(sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, x: s.x, y: s.y })));
}

main().catch((e) => { console.error(e); process.exit(1); });
