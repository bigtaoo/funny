/**
 * pack_avatar_atlas.cjs — build the player-avatar icon atlas from the 8
 * AI-generated white-background doodles in this directory (avatar.ts's
 * AVATAR_DEFS, indices 0-7: book/trophy/swords/castle/pencils/globe/coin/home).
 *
 * Same "white lines on transparent, tinted per-slot at runtime" contract as
 * the faction totem atlas (art/ui/camps/pack_faction_atlas.js): source ink is
 * discarded and rebuilt as alpha-only white, so the client can composite each
 * icon over its coloured avatar disc without baking a colour choice into the art.
 *
 * Output: client/src/assets/avatars/avatars.png (+ .json spritesheet), frame
 * names match AVATAR_DEFS' IconKind strings so avatarAtlas.ts can look them up
 * directly by key.
 *
 * Run: node art/ui/head/pack_avatar_atlas.cjs   (needs client/node_modules/sharp)
 */
const path = require('path');
const fs = require('fs');
const sharp = require(path.join(__dirname, '../../../client/node_modules/sharp'));

const HERE = __dirname;
const OUT_DIR = path.join(HERE, '../../../client/src/assets/avatars');
const FRAME = 256;    // atlas cell size
const CONTENT = 224;  // icon fits within this, leaving a transparent margin
const WHITE_THRESHOLD = 240; // r,g,b all >= this → background white → transparent

// Source UUID file → avatar icon key (must match AVATAR_DEFS in render/avatar.ts).
const MAP = {
  '7c3f2927-a1a3-4035-b4c5-847cec7a78dc.png': 'book',
  '3ca3e625-af0f-4d1b-9e1a-a31c148fcca5.png': 'trophy',
  'b9b55d21-fef9-4f45-b31b-d020560efae4.png': 'swords',
  '260c6a5c-a433-4bf5-a29f-0231a1181ff3.png': 'castle',
  '938b93b5-8310-4542-b926-0d0a17e9c1b1.png': 'pencils',
  '869156b9-f654-41ae-b5f5-0075f099be10.png': 'globe',
  'c65c003c-2dc3-4d41-8cc8-d684151f46e9.png': 'coin',
  '0771d3ad-b8aa-42fc-a66a-be7a038a1909.png': 'home',
};

/** Load a source doodle, turn ink → white-on-transparent, crop to bbox. */
async function whiteLineFrame(file) {
  const { data, info } = await sharp(path.join(HERE, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels } = info;

  // Near-white → transparent; remaining ink → white RGB, alpha = darkness.
  let minX = W, minY = H, maxX = 0, maxY = 0;
  for (let i = 0, p = 0; i < data.length; i += channels, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const isWhite = r >= WHITE_THRESHOLD && g >= WHITE_THRESHOLD && b >= WHITE_THRESHOLD;
    const lum = (r + g + b) / 3;
    const alpha = isWhite ? 0 : Math.min(255, Math.round(255 - lum));
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = alpha;
    if (alpha > 8) {
      const x = p % W, y = (p / W) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const cw = Math.max(1, maxX - minX + 1), ch = Math.max(1, maxY - minY + 1);
  const cropped = await sharp(data, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left: minX, top: minY, width: cw, height: ch })
    .png().toBuffer();

  // Fit within CONTENT (preserve aspect), then centre on a FRAME transparent square.
  const fitted = await sharp(cropped)
    .resize(CONTENT, CONTENT, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  const pad = (FRAME - CONTENT) / 2;
  return sharp(fitted).extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const entries = Object.entries(MAP);
  const frames = {};
  const composites = [];
  for (let i = 0; i < entries.length; i++) {
    const [file, key] = entries[i];
    const buf = await whiteLineFrame(file);
    composites.push({ input: buf, left: i * FRAME, top: 0 });
    frames[key] = { frame: { x: i * FRAME, y: 0, w: FRAME, h: FRAME }, sourceSize: { w: FRAME, h: FRAME }, spriteSourceSize: { x: 0, y: 0, w: FRAME, h: FRAME } };
    console.log(`${key.padEnd(8)} ← ${file}`);
  }
  const atlasW = FRAME * entries.length, atlasH = FRAME;
  await sharp({ create: { width: atlasW, height: atlasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites).png({ compressionLevel: 9 }).toFile(path.join(OUT_DIR, 'avatars.png'));

  const json = { frames, meta: { image: 'avatars.png', format: 'RGBA8888', size: { w: atlasW, h: atlasH }, scale: '1' } };
  fs.writeFileSync(path.join(OUT_DIR, 'avatars.json'), JSON.stringify(json, null, 2));
  console.log('wrote', path.join(OUT_DIR, 'avatars.png'), atlasW + 'x' + atlasH);
})().catch((e) => { console.error(e); process.exit(1); });
