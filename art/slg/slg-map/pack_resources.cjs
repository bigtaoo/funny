/**
 * pack_resources.cjs — Process res_*.{webp,png} SLG map resource motifs and pack them into a PixiJS-ready atlas.
 *
 * 5 stationery motifs (one per SLG season resource): res_ink / res_paper / res_graphite / res_metal / res_sticker,
 * plus per-level bespoke frames `res_<type>_l<n>` dropped in as white-bg source files. Every frame here is a real
 * hand-drawn image loaded from disk — NOTHING is composited/baked at build time anymore (the old l1–5 dice-pip
 * count-trays + synthetic heaps were replaced by bespoke l1–5 art on 2026-07-17, see slg-resource-art.md §5).
 * Coverage: paper/ink/graphite/metal l1–l10 bespoke; sticker l6–l10 bespoke (no l1–5, only spawns on lvl≥6).
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

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

// ── Per-level tier colour band (sticker only) ──────────────────────────────────
// Level legibility (l1→l10, taller/fuller/more-scatter) is now carried entirely by the bespoke art's
// own silhouette — the map renderer draws each level frame width-normalised (on-screen width = const,
// height follows the frame's aspect ratio, see client/src/render/tileGraphics.ts drawResMotif), so a
// taller-drawn frame reads as a higher tier with zero renderer change.
// The colour band below survives ONLY for sticker (铜钱): its l6→l10 tan→gold ramp reads as "copper
// coin → gold", a thematic bonus. paper/ink/graphite/metal keep their original black ink at every
// level (read by silhouette, consistent l1–l10) — see tintLevelFrame's exemption.
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
  // paper/ink/graphite/metal are bespoke hand-drawn art at EVERY level (l1–l10) — keep their original
  // black ink so the whole ramp reads by silhouette and stays consistent (2026-07-17: exemption widened
  // from l6+ to all levels when l1–5 became bespoke too). Only sticker keeps the band (its tan→gold ramp
  // reads as copper→gold, a thematic cue for the currency resource).
  if (/^res_(paper|ink|graphite|metal)_/.test(sprite.name)) return sprite;
  const { data, info } = await sharp(sprite.buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  applyBand(data, info.width, info.height, lv);
  const buf = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return { ...sprite, buf };
}

async function processImage(file, longEdge) {
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

  // Proportional scale: long edge = longEdge
  const scale = longEdge / Math.max(cropW, cropH);
  const newW = Math.max(1, Math.round(cropW * scale));
  const newH = Math.max(1, Math.round(cropH * scale));
  const buf = await sharp(cropBuf, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize(newW, newH, { fit: 'fill' }).png().toBuffer();

  return { name, buf, w: newW, h: newH };
}

const loadSprite = (file) => processImage(file, LONG_EDGE);

async function main() {
  const files = fs.readdirSync(__dirname)
    .filter((f) => /^res_.*\.(webp|png)$/i.test(f))
    .sort();
  if (!files.length) { console.error('No res_*.{webp,png} files found'); process.exit(1); }

  const sprites = [];
  for (const f of files) sprites.push(await loadSprite(path.join(__dirname, f)));

  // Tier colour band — sticker only (paper/ink/graphite/metal are exempt at every level, see tintLevelFrame).
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
