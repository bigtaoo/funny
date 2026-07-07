/**
 * pack_resources.cjs — Process res_*.{webp,png} SLG map resource motifs and pack them into a PixiJS-ready atlas.
 *
 * 5 stationery motifs (one per SLG season resource): res_ink / res_paper / res_graphite / res_metal / res_sticker.
 * The 10 per-resource levels are NOT baked here — richness/defense/level/color are composed at runtime by the
 * map renderer (see design/product/slg-resource-art.md §3). This script only produces the 5 single-unit motifs.
 *
 * Processing pipeline (all in memory, no intermediate files):
 *   1. Load image → remove white background: alpha = 255 - luminance (white bg → transparent, ink lines → opaque,
 *      anti-aliased grey edges → semi-transparent), original line color preserved.
 *   2. Crop surrounding whitespace using the content bounding box.
 *   3. Scale proportionally so the long edge = LONG_EDGE (128px; map icons are viewed closely + clustered).
 *   4. Shelf-pack into a single atlas PNG (PAD spacing to prevent bleeding).
 *   5. Export res_atlas.png + res_atlas.json (TexturePacker JSON-Hash, parsed directly by PIXI.Spritesheet).
 *   6. Copy both into client/src/assets/slg/ for the game to consume.
 *
 * Usage:    node pack_resources.cjs
 * Requires: reuses client/node_modules/sharp (no separate install needed).
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp'));

const LONG_EDGE = 128;  // map-resource motif target long edge (closely viewed + clustered → C-group resolution)
const PAD = 2;          // per-frame spacing inside the atlas
const ATLAS_W = 512;    // atlas width (fixed)
const ALPHA_TRIM = 16;  // alpha threshold for considering a pixel "has content" during crop
const OUT_DIRS = [
  path.resolve(__dirname, '../../../client/src/assets/slg'),
  path.resolve(__dirname, '../../../tools/map-editor/src/assets/slg'),  // §5.8: keep both byte-identical
];

// ── Baked low-tier count frames (§5.4/§5.7) ───────────────────────────────────
// l1–5 read the exact level by COUNTING motif tokens on a tray background (dice-pip
// slots). We bake `res_<type>_l1..l5` here so getResLevelTexture() picks them up with
// zero runtime code change (same path as the l6–10 real art). bgA covers l1–3, bgB l4–5.
const TOKEN_FRAC = 0.40;  // token long edge as a fraction of the background long edge
const BAKE = [
  { type: 'paper',    token: 'res_paper',    bgA: 'resbg_paper_a',    bgB: 'resbg_paper_b'    },
  { type: 'ink',      token: 'res_ink',      bgA: 'resbg_ink_a',      bgB: 'resbg_ink_b'      },
  { type: 'graphite', token: 'res_graphite', bgA: 'resbg_graphite_a', bgB: 'resbg_graphite_b' },
];
// Dice-pip slot layouts, as (fx,fy) fractions of the background box. Count = level.
// Slots sit inside the tray's interior; composited back-to-front (top rows first).
// Left/right columns just clear the centre so each token stays countable; the two
// vertical rows overlap slightly so a column reads as a small stack of sheets.
const C = [0.51, 0.56];
const TL = [0.30, 0.45], TR = [0.72, 0.45], BL = [0.30, 0.68], BR = [0.72, 0.68], BC = [0.51, 0.70];
const DICE = {
  1: [C],
  2: [TL, BR],            // diagonal
  3: [TL, TR, BC],        // triangle
  4: [TL, TR, BL, BR],    // four corners
  5: [TL, TR, BL, BR, C], // four corners + centre
};

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

// ── Per-level tier encoding (§5.9): height ramp + colour band ──────────────────
// The map renderer draws a level frame width-normalised (on-screen width = const, height follows
// the frame's aspect ratio — see client/src/render/tileGraphics.ts drawResMotif). So to make tier
// legible when the whole map is zoomed out (where dice-pip counting fails) we bake TWO zoom-proof
// cues straight into the frames, with zero renderer change:
//   1. HEIGHT RAMP  — each level is emitted at a fixed 128 width and a target height that grows with
//      level, filled by a taller/denser motif heap → higher tier reads as a physically taller icon.
//   2. COLOUR BAND  — a desaturated per-band multiply (cool → warm → gold) so tier still separates by
//      hue even at 1-tile-per-few-pixels, and even for adjacent levels of equal height.
const FRAME_W = 128;
const RATIO_MIN = 0.60, RATIO_MAX = 1.45;                 // frame height/width at l1 … l10
const ratioFor = (lv) => RATIO_MIN + ((lv - 1) / 9) * (RATIO_MAX - RATIO_MIN);
const targetH  = (lv) => Math.round(FRAME_W * ratioFor(lv));
const HEAP_COUNT = [0, 1, 1, 2, 3, 4, 5, 6, 7, 8, 10];     // motif tokens per level (index = level)

// Desaturated tier bands, paper-cohesive (low = cool slate → mid = tan → high = amber → l10 = gold).
// Applied as a partial multiply so the pencil linework survives. [r,g,b] per level, index = level.
const BAND = [
  null,
  [0x9f, 0xb2, 0xc6], [0x9f, 0xb2, 0xc6], // l1–2 cool slate-blue
  [0xa6, 0xb8, 0x8c], [0xa6, 0xb8, 0x8c], // l3–4 sage
  [0xd6, 0xc2, 0x8a], [0xd6, 0xc2, 0x8a], // l5–6 warm tan
  [0xd8, 0x9f, 0x60], [0xd8, 0x9f, 0x60], // l7–8 amber
  [0xcf, 0x78, 0x4d],                     // l9   rust
  [0xe6, 0xb4, 0x22],                     // l10  gold
];
const BAND_STRENGTH = 0.72;

/** Partial-multiply tier tint over the opaque pixels of a raw RGBA buffer (in place). */
function applyBand(buf, w, h, lv) {
  const c = BAND[lv];
  if (!c) return;
  const s = BAND_STRENGTH;
  for (let i = 0; i < w * h; i++) {
    if (buf[i * 4 + 3] === 0) continue;
    for (let k = 0; k < 3; k++) {
      const src = buf[i * 4 + k];
      buf[i * 4 + k] = Math.round(src * (1 - s) + (src * c[k] / 255) * s);
    }
  }
}

/** Decode a packed level frame's PNG buffer, apply its tier band, re-encode. Returns a new sprite. */
async function tintLevelFrame(sprite) {
  const m = /_l(\d+)$/.exec(sprite.name);
  if (!m) return sprite;
  const lv = Number(m[1]);
  // paper/ink/graphite l6–10 are bespoke hand-drawn art — keep their original colours (they read by
  // silhouette, not band). Their l1–5 (baked count trays) still get the band: that's the low-tier hue cue.
  if (/^res_(paper|ink|graphite)_/.test(sprite.name) && lv >= 6) return sprite;
  const { data, info } = await sharp(sprite.buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  applyBand(data, info.width, info.height, lv);
  const buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return { ...sprite, buf };
}

/**
 * Synthesize `res_<type>_l1..l10` for a type that has only a single motif (ink/graphite/metal/sticker —
 * no bespoke per-level art like paper). Each level is a bottom-aligned heap of HEAP_COUNT[lv] motif
 * tokens on a FRAME_W×targetH(lv) transparent frame, so height + density both ramp with tier.
 */
async function bakeHeapFrames(type, tokenFile) {
  // fill: true → interiors opaque (like the paper sheets), so faint pencil motifs (graphite/sticker)
  // stay visible at map zoom and the tier band lands on a real area, not just thin linework.
  const tok = await processImage(tokenFile, Math.round(FRAME_W * 0.50), { fill: true }); // token long edge ≈ 64px
  const out = [];
  for (let lv = 1; lv <= 10; lv++) {
    const H = targetH(lv);
    const n = HEAP_COUNT[lv];
    const step = tok.w * 0.72;                              // horizontal spacing (slight overlap)
    const perRow = Math.max(1, Math.floor((FRAME_W - tok.w) / step) + 1);
    const rowH = tok.h * 0.52;                              // vertical spacing (stack upward)
    const composites = [];
    let placed = 0, row = 0;
    while (placed < n) {
      const inRow = Math.min(perRow, n - placed);
      const rowW = (inRow - 1) * step + tok.w;
      const x0 = (FRAME_W - rowW) / 2;
      const y = H - tok.h - row * rowH;
      for (let c = 0; c < inRow; c++) {
        const jitter = (((placed * 2654435761) >>> 0) % 7) - 3; // deterministic (no Math.random)
        const left = Math.max(0, Math.min(FRAME_W - tok.w, Math.round(x0 + c * step + jitter)));
        const top  = Math.max(0, Math.min(H - tok.h, Math.round(y)));
        composites.push({ input: tok.buf, left, top });
        placed++;
      }
      row++;
    }
    const buf = await sharp({ create: { width: FRAME_W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(composites).png().toBuffer();
    out.push({ name: `res_${type}_l${lv}`, buf, w: FRAME_W, h: H });
  }
  return out;
}

// Synthetic per-level heaps for the single-motif types (paper keeps its bespoke trays + real art).
const HEAP_TYPES = [
  { type: 'metal',    token: 'res_metal' },
  { type: 'sticker',  token: 'res_sticker' },
];

/**
 * Make a line-art shape's interior opaque white (in-place, raw RGBA).
 * Background removal leaves the body transparent (alpha≈0) and only the ink outline
 * opaque, so stacked tokens would show through each other. We flood-fill the exterior
 * from the borders through transparent pixels; any transparent pixel NOT reached is
 * enclosed by the outline (the sheet's face) → paint it opaque white. Ink pixels stay.
 * Result: a solid white card with a dark edge, so a pile of them reads as a real stack.
 */
function fillInteriorWhite(buf, w, h, thresh = 32) {
  const ext = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const idx = y * w + x;
    if (ext[idx] || buf[idx * 4 + 3] > thresh) return;
    ext[idx] = 1; stack.push(idx);
  };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const idx = stack.pop(), x = idx % w, y = (idx / w) | 0;
    push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
  }
  for (let i = 0; i < w * h; i++) {
    if (!ext[i] && buf[i * 4 + 3] <= thresh) {
      buf[i * 4] = 255; buf[i * 4 + 1] = 255; buf[i * 4 + 2] = 255; buf[i * 4 + 3] = 255;
    }
  }
}

async function processImage(file, longEdge, opts = {}) {
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

  // Opaque-white the interior for baked count tokens (so stacked sheets occlude)
  if (opts.fill) fillInteriorWhite(cropBuf, cropW, cropH);

  // Proportional scale: long edge = longEdge
  const scale = longEdge / Math.max(cropW, cropH);
  const newW = Math.max(1, Math.round(cropW * scale));
  const newH = Math.max(1, Math.round(cropH * scale));
  const buf = await sharp(cropBuf, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize(newW, newH, { fit: 'fill' }).png().toBuffer();

  return { name, buf, w: newW, h: newH };
}

const loadSprite = (file) => processImage(file, LONG_EDGE);

/**
 * Bake `res_<type>_l1..l5` count frames: composite N motif tokens (dice-pip slots)
 * over the tray background. Returns sprite objects ready for the packer, or [] if
 * this type's source images (token / backgrounds) aren't present.
 */
async function bakeCountFrames(cfg) {
  const dir = __dirname;
  const has = (f) => fs.existsSync(path.join(dir, f));
  const src = (base) => ['.webp', '.png'].map((e) => base + e).find((f) => has(f));
  const tokenSrc = src(cfg.token), bgASrc = src(cfg.bgA), bgBSrc = src(cfg.bgB);
  if (!tokenSrc || !bgASrc || !bgBSrc) return [];  // TBD types skipped silently

  const bgA = await loadSprite(path.join(dir, bgASrc));
  const bgB = await loadSprite(path.join(dir, bgBSrc));
  const tokLong = Math.round(LONG_EDGE * TOKEN_FRAC);
  const tok = await processImage(path.join(dir, tokenSrc), tokLong, { fill: true });

  const out = [];
  for (let lv = 1; lv <= 5; lv++) {
    const bg = lv <= 3 ? bgA : bgB;
    const slots = [...DICE[lv]].sort((a, b) => a[1] - b[1]);  // back-to-front
    const composites = [{ input: bg.buf, left: 0, top: 0 }];
    for (const [fx, fy] of slots) {
      let left = Math.round(fx * bg.w - tok.w / 2);
      let top = Math.round(fy * bg.h - tok.h / 2);
      left = Math.max(0, Math.min(bg.w - tok.w, left));
      top = Math.max(0, Math.min(bg.h - tok.h, top));
      composites.push({ input: tok.buf, left, top });
    }
    const buf = await sharp({ create: { width: bg.w, height: bg.h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(composites).png().toBuffer();
    out.push({ name: `res_${cfg.type}_l${lv}`, buf, w: bg.w, h: bg.h });
  }
  return out;
}

async function main() {
  const files = fs.readdirSync(__dirname)
    .filter((f) => /^res_.*\.(webp|png)$/i.test(f))
    .sort();
  if (!files.length) { console.error('No res_*.{webp,png} files found'); process.exit(1); }

  const sprites = [];
  for (const f of files) sprites.push(await loadSprite(path.join(__dirname, f)));

  // Baked paper l1–5 count frames (motif tokens over tray backgrounds); l6–10 are real art loaded above.
  for (const cfg of BAKE) sprites.push(...await bakeCountFrames(cfg));

  // Synthetic l1–10 heaps for the single-motif types (ink/graphite/metal/sticker).
  for (const cfg of HEAP_TYPES) {
    const src = ['.webp', '.png'].map((e) => cfg.token + e).find((f) => fs.existsSync(path.join(__dirname, f)));
    if (src) sprites.push(...await bakeHeapFrames(cfg.type, path.join(__dirname, src)));
  }

  // Tier colour band on every per-level frame (paper trays/art + all heaps) — the zoom-proof hue cue.
  for (let i = 0; i < sprites.length; i++) sprites[i] = await tintLevelFrame(sprites[i]);

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

  // Composite atlas (compressed PNG: palette + max effort)
  const composites = sprites.map((s) => ({ input: s.buf, left: s.x, top: s.y }));
  const atlasBuf = await sharp({ create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites).png({ palette: true, compressionLevel: 9, effort: 10 }).toBuffer();

  // Export JSON (TexturePacker JSON-Hash) — frame names have no extension, for use as textures['res_ink']
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
    meta: { app: 'pack_resources.cjs', image: 'res_atlas.png', format: 'RGBA8888', size: { w: ATLAS_W, h: ATLAS_H }, scale: '1' },
  };

  // Write byte-identical copies to every consumer (§5.8: client + map-editor)
  for (const dir of OUT_DIRS) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'res_atlas.png'), atlasBuf);
    fs.writeFileSync(path.join(dir, 'res_atlas.json'), JSON.stringify(json, null, 2));
  }

  const kb = (atlasBuf.length / 1024).toFixed(1);
  console.log(`✅ Packed ${sprites.length} frames → res_atlas.png (${ATLAS_W}×${ATLAS_H}, ${kb} KB) + res_atlas.json → ${OUT_DIRS.length} dir(s)`);
  console.table(sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, x: s.x, y: s.y })));
}

main().catch((e) => { console.error(e); process.exit(1); });
