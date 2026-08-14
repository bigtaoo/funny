/**
 * pack_emblem_atlas.js — build the family/sect emblem icon atlas from the 24
 * fixed-pool totem doodles in this folder (art/icons), per
 * design/product/family-emblem-art-prompts.md.
 *
 * Sources are AI-generated (GPT Image 2) opaque webp images: dark ink line art on
 * a plain white background — unlike the faction totems (art/ui/camps), there is no
 * pre-existing alpha channel to lift the linework from. So this script combines:
 *   - decos-style white-background removal (art/ui/decos/pack_decos.cjs):
 *     alpha = 255 - luminance, so the white background goes fully transparent and
 *     the ink line becomes opaque (anti-aliased edges land in between);
 *   - faction-style recolour + fixed-cell layout (art/ui/camps/pack_faction_atlas.js):
 *     discard the source ink colour and rebuild as WHITE lines on transparent, so
 *     the client can `tint` each emblem to whatever accent colour a family/sect
 *     picks at runtime — same single-colour-source contract as the faction totems.
 *
 * Output: client/src/assets/emblems/emblems.{png,json} (TexturePacker JSON-Hash),
 * frame names = `emblem_<key>` (matches the source file's basename), so a future
 * `getEmblemIconTexture(key)` can look frames up directly, mirroring
 * client/src/render/atlas/spriteAtlas.ts's createAtlasLoader contract.
 *
 * Run: node art/icons/pack_emblem_atlas.js   (needs client/node_modules/sharp)
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.join(__dirname, '../../client/node_modules/sharp'));

const HERE = __dirname;
const OUT_DIR = path.join(HERE, '../../client/src/assets/emblems');
const FRAME = 256;    // atlas cell size (matches faction totems)
const CONTENT = 224;  // emblem fits within this, leaving a transparent margin
const ALPHA_TRIM = 16; // ignore near-transparent noise when computing the bbox
const COLS = 6;        // 6x4 grid for the 24-emblem pool

/** Load a source webp, strip the white background, crop to the inked bbox, recolour to white lines on transparent. */
async function whiteLineFrame(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: ch } = info;

  // White-background removal (pack_decos.cjs contract): alpha = 255 - luminance.
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let a = Math.round(255 - lum);
      if (a < 0) a = 0; else if (a > 255) a = 255;
      data[i + 3] = a;
      if (a > ALPHA_TRIM) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error(`${file}: empty image (no content)`);

  const cw = maxX - minX + 1, ch2 = maxY - minY + 1;
  const out = Buffer.alloc(cw * ch2 * 4);
  for (let y = 0; y < ch2; y++) {
    for (let x = 0; x < cw; x++) {
      const a = data[((minY + y) * W + (minX + x)) * 4 + 3];
      const o = (y * cw + x) * 4;
      out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = a; // white line, source colour discarded
    }
  }
  // Fit within CONTENT (preserve aspect), then centre on a FRAME transparent square.
  const fitted = await sharp(out, { raw: { width: cw, height: ch2, channels: 4 } })
    .resize(CONTENT, CONTENT, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  const pad = (FRAME - CONTENT) / 2;
  return sharp(fitted).extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

async function main() {
  const files = fs.readdirSync(HERE)
    .filter((f) => /^emblem_.*\.webp$/i.test(f))
    .sort();
  if (!files.length) { console.error('No emblem_*.webp files found in', HERE); process.exit(1); }
  console.log(`Found ${files.length} emblem sources`);

  const frames = {};
  const composites = [];
  for (let i = 0; i < files.length; i++) {
    const key = files[i].replace(/\.webp$/i, '');
    const buf = await whiteLineFrame(path.join(HERE, files[i]));
    const col = i % COLS, row = Math.floor(i / COLS);
    const x = col * FRAME, y = row * FRAME;
    composites.push({ input: buf, left: x, top: y });
    frames[key] = {
      frame: { x, y, w: FRAME, h: FRAME },
      rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: FRAME, h: FRAME },
      sourceSize: { w: FRAME, h: FRAME },
    };
  }

  const rows = Math.ceil(files.length / COLS);
  const atlasW = COLS * FRAME, atlasH = rows * FRAME;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await sharp({ create: { width: atlasW, height: atlasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 })
    .toFile(path.join(OUT_DIR, 'emblems.png'));

  const json = {
    frames,
    meta: { app: 'pack_emblem_atlas.js', image: 'emblems.png', format: 'RGBA8888', size: { w: atlasW, h: atlasH }, scale: '1' },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'emblems.json'), JSON.stringify(json, null, 2));

  console.log(`✅ Packed ${files.length} frames → emblems.png (${atlasW}x${atlasH}) + emblems.json`);
  console.table(files.map((f, i) => ({ key: f.replace(/\.webp$/i, ''), col: i % COLS, row: Math.floor(i / COLS) })));
}

main().catch((e) => { console.error(e); process.exit(1); });
