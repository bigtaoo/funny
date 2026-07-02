/**
 * pack_terrain.cjs — Process terrain_*.{webp,png} SLG map ground tiles and pack them into a PixiJS-ready atlas.
 *
 * 7 hand-drawn ground textures (grass / mountain / river / gate / keep / center / stronghold), each a full-bleed
 * square tile (no whitespace border — see design/product/slg-terrain-art.md §1/§3). Unlike the res_* motifs
 * (pack_resources.cjs), these are NOT cropped to a content bounding box and keep their opaque paper background:
 * the renderer draws the whole square as a PIXI.Sprite and clips it into the diamond tile shape at runtime
 * (WorldMapScene.drawTileL1), so the source frame must stay a full untrimmed square.
 *
 * Processing pipeline (all in memory, no intermediate files):
 *   1. Load image, flatten to opaque RGB (drop any incidental alpha).
 *   2. Resize to a fixed TILE_SIZE square (source canvases are already square).
 *   3. Grid-pack into a single atlas PNG (PAD spacing to prevent bleeding).
 *   4. Export terrain_atlas.png + terrain_atlas.json (TexturePacker JSON-Hash, parsed directly by PIXI.Spritesheet).
 *   5. Copy both into client/src/assets/slg/ for the game to consume.
 *
 * Usage:    node pack_terrain.cjs
 * Requires: reuses client/node_modules/sharp (no separate install needed).
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp'));

const TILE_SIZE = 256;  // ground tile target edge (full-frame texture, seen up close while panning)
const PAD = 2;          // per-frame spacing inside the atlas
const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets/slg');

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

async function loadTile(file) {
  const name = path.basename(file).replace(/\.(webp|png)$/i, '');
  const buf = await sharp(file).flatten({ background: '#ffffff' })
    .resize(TILE_SIZE, TILE_SIZE, { fit: 'fill' }).png().toBuffer();
  return { name, buf, w: TILE_SIZE, h: TILE_SIZE };
}

async function main() {
  const files = fs.readdirSync(__dirname)
    .filter((f) => /^terrain_.*\.(webp|png)$/i.test(f))
    .sort();
  if (!files.length) { console.error('No terrain_*.{webp,png} files found'); process.exit(1); }

  const tiles = [];
  for (const f of files) tiles.push(await loadTile(path.join(__dirname, f)));

  // Fixed-size grid packing (all frames are identical TILE_SIZE squares)
  const cols = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const ATLAS_W = nextPow2(cols * (TILE_SIZE + PAD) + PAD);
  const ATLAS_H = nextPow2(rows * (TILE_SIZE + PAD) + PAD);
  tiles.forEach((t, i) => {
    t.x = PAD + (i % cols) * (TILE_SIZE + PAD);
    t.y = PAD + Math.floor(i / cols) * (TILE_SIZE + PAD);
  });

  // Composite atlas (compressed PNG: palette + max effort)
  const canvas = sharp({ create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } });
  const composites = tiles.map((t) => ({ input: t.buf, left: t.x, top: t.y }));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const atlasPng = path.join(OUT_DIR, 'terrain_atlas.png');
  await canvas.composite(composites).png({ palette: true, compressionLevel: 9, effort: 10 }).toFile(atlasPng);

  // Export JSON (TexturePacker JSON-Hash) — frame names have no extension, for use as textures['terrain_grass']
  const frames = {};
  for (const t of [...tiles].sort((a, b) => a.name.localeCompare(b.name))) {
    frames[t.name] = {
      frame: { x: t.x, y: t.y, w: t.w, h: t.h },
      rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: t.w, h: t.h },
      sourceSize: { w: t.w, h: t.h },
    };
  }
  const json = {
    frames,
    meta: { app: 'pack_terrain.cjs', image: 'terrain_atlas.png', format: 'RGBA8888', size: { w: ATLAS_W, h: ATLAS_H }, scale: '1' },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'terrain_atlas.json'), JSON.stringify(json, null, 2));

  const kb = (fs.statSync(atlasPng).size / 1024).toFixed(1);
  console.log(`✅ Packed ${tiles.length} frames → client/src/assets/slg/terrain_atlas.png (${ATLAS_W}×${ATLAS_H}, ${kb} KB) + terrain_atlas.json`);
  console.table(tiles.map((t) => ({ name: t.name, w: t.w, h: t.h, x: t.x, y: t.y })));
}

main().catch((e) => { console.error(e); process.exit(1); });
