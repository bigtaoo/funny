/**
 * pack_city_bld.cjs — Process CityScene ("Home Desk") building sketches into a
 * PixiJS-ready atlas, replacing the programmatic icons.ts/emoji placeholders for
 * desk / cabinet / drillYard / wall / satchel (see CityScene.ts BLD_GLYPH / BLD_ICON).
 *
 * Same shelf-packing + TexturePacker JSON as slg-map/pack_buildings.cjs, but background
 * removal differs in two ways because these particular AI sources drew deliberate faint
 * "paper grain" hatching flecks scattered across the empty background (asked for in the
 * gen prompt), at the same luminance range as real anti-aliased ink-line edges:
 *   1. Hard THRESHOLD (like pack_titles.cjs) instead of pack_buildings.cjs's continuous
 *      `alpha = 255 - luminance` — continuous alpha renders the grain as a faint but
 *      visible translucent haze once composited; a binary cutoff is closer to intent.
 *   2. Connected-component denoise: the hard cutoff alone still leaves the grain flecks
 *      as fully opaque specks. Real ink strokes are long connected curves (large pixel
 *      components); grain flecks are isolated dots/hatch marks (tiny components). Any
 *      opaque component smaller than MIN_COMPONENT_AREA is discarded as grain, not line art.
 * Ink lines are neutral (not tinted) — matches every other hand-drawn atlas in this game
 * (building_atlas / res_atlas / city_atlas).
 *
 * Usage:    node pack_city_bld.cjs
 * Requires: reuses client/node_modules/sharp (no separate install needed).
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp'));

const LONG_EDGE = 256;  // rendered small (~60px in the building grid) but kept hi-res for crisp downscale
const PAD = 2;
const ATLAS_W = 512;
const ALPHA_TRIM = 16;
const WHITE_THRESHOLD = 240; // all three r,g,b channels >= this value → background → transparent (see pack_titles.cjs)
const MIN_COMPONENT_AREA = 40; // opaque 4-connected blobs smaller than this (px, at source resolution) are discarded as grain
const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets/slg');

// Source UUID file → frame name (CityScene BuildingKey)
const JOBS = [
  { src: 'd1ad058f-72f0-4ae6-a9fd-182bc03e5f5d.png', name: 'bld_desk' },
  { src: '7cd50fb1-0078-4cc3-ac8e-81d5c357ec1a.png', name: 'bld_cabinet' },
  { src: 'cee04bf0-1cfb-4dc8-947d-a345a402fb3a.png', name: 'bld_drillYard' },
  { src: '5f9b776c-ce01-4963-97cd-b25246d2ca84.png', name: 'bld_wall' },
  { src: '4ca138ad-89f7-4da7-9875-227af987e22f.png', name: 'bld_satchel' },
];

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

// Zeroes the alpha channel of any 4-connected opaque blob smaller than MIN_COMPONENT_AREA.
// `data` is raw RGBA (channels=4), mutated in place. Iterative stack-based flood fill —
// images run up to ~2000x2000px, a recursive version would blow the call stack.
function denoiseSmallComponents(data, W, H) {
  const visited = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const blobPixels = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (visited[start] || data[start * 4 + 3] === 0) continue;
    let sp = 0, bp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    while (sp > 0) {
      const p = stack[--sp];
      blobPixels[bp++] = p;
      const x = p % W, y = (p / W) | 0;
      const neighbors = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const n of neighbors) {
        if (n >= 0 && !visited[n] && data[n * 4 + 3] !== 0) {
          visited[n] = 1;
          stack[sp++] = n;
        }
      }
    }
    if (bp < MIN_COMPONENT_AREA) {
      for (let i = 0; i < bp; i++) data[blobPixels[i] * 4 + 3] = 0;
    }
  }
}

async function loadSprite(job) {
  const file = path.join(__dirname, job.src);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: ch } = info;

  // Pass 1: hard-threshold background → binary alpha mask (RGBA, so index math below assumes ch===4).
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const isBg = r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD;
      let a = isBg ? 0 : 255;
      if (ch === 4) a = Math.min(a, data[i + 3]);
      data[i + 3] = a;
    }
  }

  // Pass 2: drop small isolated components (paper-grain hatching flecks, not real line art).
  denoiseSmallComponents(data, W, H);

  // Pass 3: content bounding box, computed AFTER denoise so cleared grain doesn't pad the crop.
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      if (data[i + 3] > ALPHA_TRIM) {
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
      const si = ((y + minY) * W + (x + minX)) * ch;
      const di = (y * cropW + x) * 4;
      cropBuf[di] = data[si]; cropBuf[di + 1] = data[si + 1];
      cropBuf[di + 2] = data[si + 2]; cropBuf[di + 3] = data[si + 3];
    }
  }

  const scale = LONG_EDGE / Math.max(cropW, cropH);
  const newW = Math.max(1, Math.round(cropW * scale));
  const newH = Math.max(1, Math.round(cropH * scale));
  const buf = await sharp(cropBuf, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize(newW, newH, { fit: 'fill' }).png().toBuffer();

  return { name: job.name, buf, w: newW, h: newH };
}

async function main() {
  const sprites = [];
  for (const job of JOBS) sprites.push(await loadSprite(job));

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

  const canvas = sharp({ create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  const composites = sprites.map((s) => ({ input: s.buf, left: s.x, top: s.y }));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const atlasPng = path.join(OUT_DIR, 'city_bld_atlas.png');
  await canvas.composite(composites).png({ palette: true, compressionLevel: 9, effort: 10 }).toFile(atlasPng);

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
    meta: { app: 'pack_city_bld.cjs', image: 'city_bld_atlas.png', format: 'RGBA8888', size: { w: ATLAS_W, h: ATLAS_H }, scale: '1' },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'city_bld_atlas.json'), JSON.stringify(json, null, 2));

  const kb = (fs.statSync(atlasPng).size / 1024).toFixed(1);
  console.log(`✅ Packed ${sprites.length} frames → client/src/assets/slg/city_bld_atlas.png (${ATLAS_W}×${ATLAS_H}, ${kb} KB) + city_bld_atlas.json`);
  console.table(sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, x: s.x, y: s.y })));
}

main().catch((e) => { console.error(e); process.exit(1); });
