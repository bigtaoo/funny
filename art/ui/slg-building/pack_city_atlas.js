#!/usr/bin/env node
// pack_city_atlas.js — process the SLG city images into a PixiJS spritesheet atlas.
//
// Frames (see design/product/city-image-prompts.md):
//   city_lv1..city_lv4  — the original 4 tier images (fallback when a per-level frame is absent):
//                         camp / wooden fort / stone castle / grand citadel (lv 1-2 / 3-5 / 6-8 / 9-10).
//   city_l2/l4/l5/l7/l8/l10 — per-level art so adjacent levels visibly progress. getCityTextureForLevel()
//                         prefers city_l{level} and falls back to city_lv{tier}, so missing levels
//                         (1/3/6/9) still render their tier image.
//
// Backgrounds vary per source (light graph paper, dark vignette, solid blue-grey, already-cut webp).
// We remove the background with a region-growing flood fill seeded from the image border: a pixel joins
// the background if it is within TSTEP colour distance of an already-background neighbour. This follows
// smooth backgrounds / vignette gradients and stops at the building's strong ink silhouette. Images that
// already ship meaningful transparency (the webp) skip colour-keying and keep their alpha.
//
// Run: node art/ui/slg-building/pack_city_atlas.js
//   optional: node art/ui/slg-building/pack_city_atlas.js --debug   (also writes _debug_preview.png)
const fs = require('fs');
const path = require('path');
let sharp;
try { sharp = require('sharp'); }
catch { sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp')); }

const SRC_DIR = __dirname;
const OUT_DIRS = [
  path.resolve(__dirname, '../../../client/src/assets/slg'),
  path.resolve(__dirname, '../../../tools/map-editor/src/assets/slg'),
];

const CELL = 256;
const COLS = 4;
const PAD_FRAC = 0.02;   // padding around cropped content, fraction of source width
const TSTEP = 33;        // gradient step: neighbour joins bg if within this of its bg neighbour (follows vignettes)
const TSEED = 72;        // absolute: neighbour also joins bg if within this of the sampled border colour
                         // (bridges thin grid lines on light graph paper; ink silhouette keeps the building safe)
const PRECUT_ALPHA_FRAC = 0.02; // if >2% pixels are already transparent, treat image as pre-cut
const HALO_ALPHA = 110;         // in pre-cut images, alpha below this is treated as background halo

const FILES = [
  { file: 'city_lv1.png',  name: 'city_lv1' },
  { file: 'city_lv2.png',  name: 'city_lv2' },
  { file: 'city_lv3.png',  name: 'city_lv3' },
  { file: 'city_lv4.png',  name: 'city_lv4' },
  { file: 'city_l2.png',   name: 'city_l2'  },
  { file: 'city_l4.png',   name: 'city_l4'  },
  { file: 'city_l5.png',   name: 'city_l5'  },
  { file: 'city_l7.png',   name: 'city_l7'  },
  { file: 'city_l8.png',   name: 'city_l8'  },
  { file: 'city_l10.webp', name: 'city_l10' },
];

// Remove background in-place (set alpha=0) via region-growing flood fill from the border.
// Returns the content bounding box of the surviving (opaque) pixels.
function cutBackground(data, width, height) {
  const N = width * height;
  const bg = new Uint8Array(N);           // 1 = background
  const stack = new Int32Array(N);        // pixel indices to visit
  let sp = 0;

  const push = (p) => { if (!bg[p]) { bg[p] = 1; stack[sp++] = p; } };

  // Seed: entire border ring, and accumulate the average border colour as the reference background.
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

  // 8-connectivity so the fill can slip past thin diagonal barriers (flag poles, spire tips) and
  // reach background pockets trapped between towers.
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

// Return a 256×256 RGBA buffer with the source's building cut out, cropped, and contain-fit.
async function makeCell(srcPath) {
  const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const N = width * height;

  // Pre-cut detection: many already-transparent pixels → keep alpha, just crop.
  let transparent = 0;
  for (let p = 0; p < N; p++) if (data[p * 4 + 3] < 16) transparent++;
  const preCut = transparent > N * PRECUT_ALPHA_FRAC;

  let box;
  if (preCut) {
    // Drop faint semi-transparent halo/panel pixels some pre-cut sources bake in (e.g. city_lv4's
    // graph-paper panel at alpha≈62); the real building is fully opaque. Then crop to what survives.
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
  // No bottom pad: the building's foot must be flush with the crop's bottom edge so that after the
  // bottom-align composite below it lands on the cell's bottom edge.
  const ch = Math.min(height, box.maxY + 1) - top;

  // Fit the cropped building into the cell preserving aspect (fit: 'inside' touches one axis and never
  // upscales past the cell), then composite it BOTTOM-CENTER onto a transparent CELL² canvas. Bottom-
  // aligning makes every frame's building foot sit at the cell's bottom edge (base fraction ≈ 1.0 for
  // all art), so the renderer's bottom-center anchor lands the foot on the plot uniformly. The old
  // `fit: 'contain'` centred the art, leaving a variable empty margin below short/wide buildings
  // (measured base fraction ranged 0.74–1.0) that made those cities float back off their plot.
  const fitted = await sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
    .extract({ left, top, width: cw, height: ch })
    .resize(CELL, CELL, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const fm = await sharp(fitted).metadata();
  const fittedH = fm.height ?? CELL;
  const buf = await sharp({ create: { width: CELL, height: CELL, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fitted, left: Math.round((CELL - (fm.width ?? CELL)) / 2), top: CELL - fittedH }])
    .png()
    .toBuffer();
  return { buf, contentTop: (CELL - fittedH) / CELL };
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
    const dx = (i % COLS) * CELL;
    const dy = Math.floor(i / COLS) * CELL;
    const { buf: cellBuf, contentTop } = await makeCell(path.join(SRC_DIR, file));
    console.log(`${name.padEnd(9)} ← ${file.padEnd(14)} → (${dx},${dy})  contentTop=${contentTop.toFixed(2)}`);
    composites.push({ input: cellBuf, left: dx, top: dy });
    frames[name] = {
      frame: { x: dx, y: dy, w: CELL, h: CELL },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: CELL, h: CELL },
      sourceSize: { w: CELL, h: CELL },
      // Non-standard field (ignored by PIXI's Spritesheet parser, read directly off the raw JSON by
      // cityAtlasLoader.getCityContentTopFracForLevel): fraction of the CELL that's transparent padding
      // above the bottom-aligned building art. Every tier/level fills a different amount of the fixed
      // 256px cell (a lv1 camp barely reaches halfway; a lv10 citadel nearly fills it), so anything that
      // positions itself relative to the sprite's full height — e.g. the ADR-026 HP bar in
      // WorldMapRenderer/city.ts — must offset by the ACTUAL art top, not the cell top, or it floats far
      // above short buildings (2026-07-22 bug: bar rendered a full tile-height+ above a lv1 camp roof).
      contentTop,
    };
  }

  const atlasPng = await sharp({
    create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    // Quantize to a palette for a much smaller PNG; the doodle art has few distinct colours.
    .png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 })
    .toBuffer();

  const atlasJson = {
    frames,
    meta: { image: 'city_atlas.png', format: 'RGBA8888', size: { w: ATLAS_W, h: ATLAS_H }, scale: '1' },
  };

  for (const dir of OUT_DIRS) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'city_atlas.png'), atlasPng);
    fs.writeFileSync(path.join(dir, 'city_atlas.json'), JSON.stringify(atlasJson, null, 2));
    console.log(`✓ ${path.relative(path.resolve(__dirname, '../../..'), dir)}/city_atlas.{png,json}  (${(atlasPng.length / 1024).toFixed(1)} KB)`);
  }

  if (debug) {
    // Composite the atlas over magenta so transparency vs white halo is obvious when viewed.
    const preview = await sharp({
      create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } },
    }).composite([{ input: atlasPng, left: 0, top: 0 }]).png().toBuffer();
    fs.writeFileSync(path.join(SRC_DIR, '_debug_preview.png'), preview);
    console.log('✓ _debug_preview.png (over magenta)');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
