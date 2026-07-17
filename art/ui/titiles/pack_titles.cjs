// Title medal icon packing script (TITLE_DESIGN.md — 称号墙 icon cards).
//
// Input: 4 AI-generated white-background doodles in this directory (single dark-ink
// medal-on-ribbon line art, distinguished by the engraved motif). Processing: near-white
// pixels → transparent → trim transparent edges → scale long edge to 256 → transparent
// PNG-32 (same "remove white background" pipeline as spells/decor).
// Output: client/src/assets/title_*.png, consumed by client/src/render/titleArt.ts
// (TitlesScene tints the sprite per owned/equipped/locked state, same as the old
// programmatic 'medal' glyph did).
//
// Reuses client's sharp. After updating an image, overwrite the source file and re-run
// `node pack_titles.cjs`.

const path = require('path');
const sharp = require(path.join(__dirname, '../../../client/node_modules/sharp'));

const SRC = __dirname;
const OUT = path.join(__dirname, '../../../client/src/assets');
const LONG_EDGE = 256;
const WHITE_THRESHOLD = 240; // all three r,g,b channels >= this value → classified as background white → made transparent

// UUID source file → target name (titleId key, sans the `event.`/`ach.` source prefix)
const MAP = {
  'bb531ace-12ec-4e63-9280-62328263edee.png': 'title_founder.png',    // event.founder — flag planted + laurel wreath
  'b015b9b2-ad86-4d4a-b43b-75edc7cdf7a3.png': 'title_conqueror.png',  // ach.all_chapters — crossed swords over cracked shield
  'cedf9df8-ea21-40f3-b2f6-ad0684e015d3.png': 'title_veteran.png',    // ach.pvp.veteran — chevrons + battle scratch
  '3d1d9434-2024-4853-9755-ad3c928ec84f.png': 'title_newbie.png',     // event.newbie — sprouting seedling
};

async function processOne(srcFile, outName) {
  const srcPath = path.join(SRC, srcFile);

  // 1. Read raw RGBA
  const { data, info } = await sharp(srcPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // 2. Near-white → transparent
  let cleared = 0;
  for (let i = 0; i < data.length; i += channels) {
    if (data[i] >= WHITE_THRESHOLD && data[i + 1] >= WHITE_THRESHOLD && data[i + 2] >= WHITE_THRESHOLD) {
      data[i + 3] = 0;
      cleared++;
    }
  }

  // 3. Rebuild → trim transparent edges → scale proportionally to long edge 256 → PNG
  const outPath = path.join(OUT, outName);
  const meta = await sharp(data, { raw: { width, height, channels } })
    .trim()
    .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: false })
    .png()
    .toFile(outPath);

  const pct = ((cleared / (width * height)) * 100).toFixed(0);
  console.log(`${outName.padEnd(24)} ${width}x${height} → ${meta.width}x${meta.height}  (cleared ${pct}%)`);
}

(async () => {
  for (const [src, out] of Object.entries(MAP)) {
    await processOne(src, out);
  }
  console.log('Done → client/src/assets/');
})().catch((e) => { console.error(e); process.exit(1); });
