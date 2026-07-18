/**
 * pack_faction_atlas.js — build the faction-totem icon atlas from the source
 * emblem art in this folder (art/ui/camps).
 *
 *   tao  ← dragon_emblem_v2.png (Eastern coiled dragon medallion)
 *   anna ← heraldic_eagle.webp  (Western heraldic eagle displayed)
 *
 * Both sources carry the linework in their ALPHA channel (dragon = white lines,
 * eagle = black lines, both with leftover RGB in the transparent regions). We
 * discard the source RGB and rebuild each as WHITE lines on transparent, so the
 * client tints them per-faction at runtime (render/factionIcon.ts, FACTION_COLOR)
 * — same single-colour-source contract as the faction dots they replace.
 *
 * Output: client/src/assets/factions/factions.png (+ .json spritesheet), frames
 * named `tao` / `anna` so getFactionIconTexture(faction) can look them up directly.
 *
 * Run: node art/ui/camps/pack_faction_atlas.js   (needs client/node_modules/sharp)
 */
const path = require('path');
const sharp = require(path.join(__dirname, '../../../client/node_modules/sharp'));

const HERE = __dirname;
const OUT_DIR = path.join(HERE, '../../../client/src/assets/factions');
const FRAME = 256;    // atlas cell size
const CONTENT = 224;  // emblem fits within this, leaving a transparent margin
const ALPHA_MIN = 16; // ignore near-transparent noise when computing the bbox

const SOURCES = [
  { key: 'tao',  file: 'dragon_emblem_v2.png' },
  { key: 'anna', file: 'heraldic_eagle.webp' },
];

/** Load a source, crop to its inked bbox, recolour to white lines on transparent. */
async function whiteLineFrame(file) {
  const { data, info } = await sharp(path.join(HERE, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > ALPHA_MIN) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const a = data[((minY + y) * W + (minX + x)) * 4 + 3];
      const o = (y * cw + x) * 4;
      out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = a;
    }
  }
  // Fit within CONTENT (preserve aspect), then centre on a FRAME transparent square.
  const fitted = await sharp(out, { raw: { width: cw, height: ch, channels: 4 } })
    .resize(CONTENT, CONTENT, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  const pad = (FRAME - CONTENT) / 2;
  return sharp(fitted).extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

(async () => {
  const frames = {};
  const composites = [];
  for (let i = 0; i < SOURCES.length; i++) {
    const { key, file } = SOURCES[i];
    const buf = await whiteLineFrame(file);
    composites.push({ input: buf, left: i * FRAME, top: 0 });
    frames[key] = { frame: { x: i * FRAME, y: 0, w: FRAME, h: FRAME }, sourceSize: { w: FRAME, h: FRAME }, spriteSourceSize: { x: 0, y: 0, w: FRAME, h: FRAME } };
  }
  const atlasW = FRAME * SOURCES.length, atlasH = FRAME;
  await sharp({ create: { width: atlasW, height: atlasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites).png({ compressionLevel: 9 }).toFile(path.join(OUT_DIR, 'factions.png'));

  const json = { frames, meta: { image: 'factions.png', format: 'RGBA8888', size: { w: atlasW, h: atlasH }, scale: '1' } };
  require('fs').writeFileSync(path.join(OUT_DIR, 'factions.json'), JSON.stringify(json, null, 2));
  console.log('wrote', path.join(OUT_DIR, 'factions.png'), atlasW + 'x' + atlasH);
})().catch((e) => { console.error(e); process.exit(1); });
