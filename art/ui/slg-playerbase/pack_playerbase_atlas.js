#!/usr/bin/env node
// pack_playerbase_atlas.js — process the player's-own-base ("desk" level 1-10) images into a PixiJS
// spritesheet atlas, separate from and thematically distinct from pack_city_atlas.js's castle/fort art
// (this set is a "stationery fortress" theme — see design/product/player-base-image-prompts.md).
//
// Frames: playerbase_l1..playerbase_l10, one per desk level, no tier fallback (unlike city_atlas).
//
// Background removal reuses pack_city_atlas.js's region-growing flood fill (see that file for the
// rationale): a pixel joins the background if it's within TSTEP colour distance of an already-background
// neighbour, or within TSEED of the sampled border colour. Pre-cut (already-transparent) sources skip
// colour-keying and just get cropped.
//
// TSEED=0 (disabled) for this batch: the pale yellow-green marker fill used throughout this art set is
// close enough to the plain-white background (colour distance ~44) that pack_city_atlas.js's TSEED=72
// absolute-distance shortcut ate straight through interior fill wherever a thin gap (pencil spires,
// ruler-wall crenellations) gave it a path from the border — shattering playerbase_l7 into slivers.
// This set's backgrounds are flat white (no graph-paper grid to bridge), so TSTEP's gradient-following
// alone cuts every frame cleanly without needing the absolute check.
//
// Run: node art/ui/slg-playerbase/pack_playerbase_atlas.js
//   optional: node art/ui/slg-playerbase/pack_playerbase_atlas.js --debug   (also writes _debug_preview.png)
const fs = require('fs');
const path = require('path');
let sharp;
try { sharp = require('sharp'); }
catch { sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp')); }

const SRC_DIR = __dirname;
const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets/slg');

const CELL = 256;
const COLS = 5;
const PAD_FRAC = 0.02;
// Fraction of the cell the (bottom-aligned, centered) building content is scaled to occupy. UNLIKE
// the city atlas — whose source art bakes in a big isometric ground plate that visually equals the
// 3×3 plot, leaving the actual building small within it — this "stationery fortress" art has NO
// ground plate: the object (dustpan, book-fort, …) fills its own source frame edge-to-edge. Fitting
// that straight into the full CELL made the on-map sprite (BASE_SPRITE_TILES=3.2 tiles) read as ~3.2
// tiles of solid building sitting on a 3-tile plot — i.e. visibly oversized/overhanging. Scaling the
// content below 1.0 reproduces the city art's breathing room: side margin (building narrower than the
// plot diamond) + headroom above (flags/spires clear the top). Foot stays flush to the cell bottom so
// the renderer's bottom-center anchor still plants it on the plot. Tune visually against the running map.
const CONTENT_SCALE = 0.8;
const TSTEP = 33;
const TSEED = 0;
const PRECUT_ALPHA_FRAC = 0.02;
const HALO_ALPHA = 110;

// Source files may be .png or .webp (mixed AI-generation batch); resolve whichever exists per level.
const FILES = Array.from({ length: 10 }, (_, i) => {
  const lv = i + 1;
  const name = `playerbase_l${lv}`;
  const ext = ['.png', '.webp'].find((e) => fs.existsSync(path.join(__dirname, name + e))) ?? '.png';
  return { file: `${name}${ext}`, name };
});

// Remove background in-place (set alpha=0) via region-growing flood fill from the border.
function cutBackground(data, width, height) {
  const N = width * height;
  const bg = new Uint8Array(N);
  const stack = new Int32Array(N);
  let sp = 0;

  const push = (p) => { if (!bg[p]) { bg[p] = 1; stack[sp++] = p; } };

  let sr = 0, sg = 0, sb = 0, sc = 0;
  const seed = (p) => { const i = p * 4; sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; sc++; push(p); };
  for (let x = 0; x < width; x++) { seed(x); seed((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
  const seedR = sr / sc, seedG = sg / sc, seedB = sb / sc;

  const dist = (a, b) => {
    const ia = a * 4, ib = b * 4;
    const dr = data[ia] - data[ib];
    const dg = data[ia + 1] - data[ib + 1];
    const db = data[ia + 2] - data[ib + 2];
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  const distSeed = (a) => {
    const ia = a * 4;
    const dr = data[ia] - seedR, dg = data[ia + 1] - seedG, db = data[ia + 2] - seedB;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };

  while (sp > 0) {
    const p = stack[--sp];
    const x = p % width;
    const y = (p - x) / width;
    const l = x > 0, r = x < width - 1, u = y > 0, d = y < height - 1;
    const tryN = (n) => { if (!bg[n] && (dist(n, p) < TSTEP || distSeed(n) < TSEED)) push(n); };
    if (l) tryN(p - 1);
    if (r) tryN(p + 1);
    if (u) tryN(p - width);
    if (d) tryN(p + width);
    if (l && u) tryN(p - width - 1);
    if (r && u) tryN(p - width + 1);
    if (l && d) tryN(p + width - 1);
    if (r && d) tryN(p + width + 1);
  }

  let minX = width, maxX = -1, minY = height, maxY = -1;
  for (let p = 0; p < N; p++) {
    if (bg[p]) { data[p * 4 + 3] = 0; continue; }
    const x = p % width;
    const y = (p - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

async function makeCell(srcPath) {
  const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const N = width * height;

  let transparent = 0;
  for (let p = 0; p < N; p++) if (data[p * 4 + 3] < 16) transparent++;
  const preCut = transparent > N * PRECUT_ALPHA_FRAC;

  let box;
  if (preCut) {
    let minX = width, maxX = -1, minY = height, maxY = -1;
    for (let p = 0; p < N; p++) {
      if (data[p * 4 + 3] < HALO_ALPHA) { data[p * 4 + 3] = 0; continue; }
      const x = p % width, y = (p - x) / width;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    box = { minX, maxX, minY, maxY };
  } else {
    box = cutBackground(data, width, height);
  }

  const pad = Math.round(width * PAD_FRAC);
  const left = Math.max(0, box.minX - pad);
  const top = Math.max(0, box.minY - pad);
  const cw = Math.min(width, box.maxX + pad + 1) - left;
  const ch = Math.min(height, box.maxY + 1) - top;

  const inner = Math.round(CELL * CONTENT_SCALE);
  const fitted = await sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
    .extract({ left, top, width: cw, height: ch })
    .resize(inner, inner, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const fm = await sharp(fitted).metadata();
  return sharp({ create: { width: CELL, height: CELL, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fitted, left: Math.round((CELL - (fm.width ?? CELL)) / 2), top: CELL - (fm.height ?? CELL) }])
    .png()
    .toBuffer();
}

async function main() {
  const debug = process.argv.includes('--debug');
  const rows = Math.ceil(FILES.length / COLS);
  const ATLAS_W = COLS * CELL;
  const ATLAS_H = rows * CELL;

  const composites = [];
  const frames = {};

  for (let i = 0; i < FILES.length; i++) {
    const { file, name } = FILES[i];
    const srcPath = path.join(SRC_DIR, file);
    if (!fs.existsSync(srcPath)) {
      console.warn(`skip ${name}: ${file} not found in ${SRC_DIR}`);
      continue;
    }
    const dx = (i % COLS) * CELL;
    const dy = Math.floor(i / COLS) * CELL;
    const cellBuf = await makeCell(srcPath);
    console.log(`${name.padEnd(14)} ← ${file.padEnd(20)} → (${dx},${dy})`);
    composites.push({ input: cellBuf, left: dx, top: dy });
    frames[name] = {
      frame: { x: dx, y: dy, w: CELL, h: CELL },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: CELL, h: CELL },
      sourceSize: { w: CELL, h: CELL },
    };
  }

  if (Object.keys(frames).length === 0) {
    console.error(`No source files found in ${SRC_DIR}. Drop playerbase_l1.png..l10.png there first.`);
    process.exit(1);
  }

  const atlasPng = await sharp({
    create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 })
    .toBuffer();

  const atlasJson = {
    frames,
    meta: { image: 'playerbase_atlas.png', format: 'RGBA8888', size: { w: ATLAS_W, h: ATLAS_H }, scale: '1' },
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'playerbase_atlas.png'), atlasPng);
  fs.writeFileSync(path.join(OUT_DIR, 'playerbase_atlas.json'), JSON.stringify(atlasJson, null, 2));
  console.log(`✓ ${path.relative(path.resolve(__dirname, '../../..'), OUT_DIR)}/playerbase_atlas.{png,json}  (${(atlasPng.length / 1024).toFixed(1)} KB)`);

  if (debug) {
    const preview = await sharp({
      create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } },
    }).composite([{ input: atlasPng, left: 0, top: 0 }]).png().toBuffer();
    fs.writeFileSync(path.join(SRC_DIR, '_debug_preview.png'), preview);
    console.log('✓ _debug_preview.png (over magenta)');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
