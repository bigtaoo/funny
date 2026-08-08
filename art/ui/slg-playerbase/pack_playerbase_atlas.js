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

// ── Content fit: SEPARATE width and height budgets (2026-08-02) ────────────────────────────────
// UNLIKE the city atlas — whose source art bakes in a big isometric ground plate that visually equals
// the 3×3 plot, leaving the actual building small and WIDE within it — this "stationery fortress" art
// has NO ground plate: the object (pencil-case camp, book-fort, …) fills its own square source frame
// edge-to-edge and is drawn TALL (the prompts grade level progression by height). A single square
// CONTENT_SCALE therefore fit it to ~0.78 of the cell in BOTH axes, and since the renderer draws the
// cell as a BASE_SPRITE_TILES-wide square, that came out ~2.5 tiles tall — while the 3×3 plot is only
// BASE_FOOTPRINT*ISO_RATIO = 1.5 tiles tall on screen (2:1 isometric). The building overhung its own
// plot by a full tile of height, covering ~2 rows of tiles behind it (2026-08-02 report). The old
// CONTENT_SCALE=0.8 shrank both axes together and so could never fix the ASPECT that caused it.
// Now the two axes are budgeted independently and `fit: 'inside'` honours whichever binds:
//   width  — the content should reach exactly the plot's OWN width (BASE_FOOTPRINT tiles) within the
//            BASE_SPRITE_TILES-wide sprite cell the renderer scales this frame up to — i.e. the same
//            ~7% overhang-then-clip margin `city_atlas` gets from filling its cell edge-to-edge, not a
//            few more tiles of comfort room. (2026-08-08: the original 0.8 was exactly that — a
//            comfort margin left over from the pre-ground-plate art below — leaving every frame
//            visibly narrower than its 3×3 diamond, worst on the low levels players see most; see the
//            git history of this comment for the before/after renders.)
//   height — derived from the plot's real screen height, times a small allowance for spires/flags
// Kept deliberately proportional (no non-uniform squash) so the hand-drawn isometric perspective isn't
// distorted; the cost is that frames whose own aspect is narrower than the target (most of levels
// 2-10 — the ground plate itself is properly wide, but taller upper structure keeps height-binding
// first) still fall short of the full plot width. That remaining gap is a real content trade-off, not
// a formula bug: matching it exactly would need HEIGHT_BUDGET_K raised enough to let those frames grow
// ~40% taller first, which reopens the 2026-08-02 "covers the rows behind it" overhang this budget
// exists to prevent (verified by rendering the sprite+mask geometry standalone before touching this
// constant — see design/product/player-base-image-prompts.md § "接入现状"). The real fix for those
// remaining levels is art whose ground plate reaches the frame edge without the upper structure also
// growing taller — a follow-up art pass, not a script constant.
// Mirrors of client-side constants (worldmap/constants.ts, render/isoGrid.ts, @nw/shared core.ts) —
// this script is standalone Node with no TS import path, so keep them in sync by hand.
const BASE_SPRITE_TILES = 3.2;
const BASE_FOOTPRINT = 3;
const ISO_RATIO = 0.5;
/** How far above the plot's own screen height the building may legitimately rise (spires, flagpoles). */
const HEIGHT_BUDGET_K = 1.2;
const CONTENT_W_FRAC = BASE_FOOTPRINT / BASE_SPRITE_TILES;
const CONTENT_H_FRAC = (BASE_FOOTPRINT * ISO_RATIO * HEIGHT_BUDGET_K) / BASE_SPRITE_TILES;

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

  const innerW = Math.round(CELL * CONTENT_W_FRAC);
  const innerH = Math.round(CELL * CONTENT_H_FRAC);
  const fitted = await sharp(Buffer.from(data), { raw: { width, height, channels: 4 } })
    .extract({ left, top, width: cw, height: ch })
    .resize(innerW, innerH, { fit: 'inside', background: { r: 0, g: 0, b: 0, alpha: 0 } })
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
    const srcPath = path.join(SRC_DIR, file);
    if (!fs.existsSync(srcPath)) {
      console.warn(`skip ${name}: ${file} not found in ${SRC_DIR}`);
      continue;
    }
    const dx = (i % COLS) * CELL;
    const dy = Math.floor(i / COLS) * CELL;
    const { buf: cellBuf, contentTop } = await makeCell(srcPath);
    console.log(`${name.padEnd(14)} ← ${file.padEnd(20)} → (${dx},${dy})  contentTop=${contentTop.toFixed(2)}`);
    composites.push({ input: cellBuf, left: dx, top: dy });
    frames[name] = {
      frame: { x: dx, y: dy, w: CELL, h: CELL },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: CELL, h: CELL },
      sourceSize: { w: CELL, h: CELL },
      // Non-standard field, see pack_city_atlas.js — read directly off the raw JSON by
      // playerBaseAtlasLoader.getPlayerBaseContentTopFracForLevel.
      contentTop,
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
