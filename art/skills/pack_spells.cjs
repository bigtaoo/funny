// Spell card icon packing script (art-direction §6 "Spell Card Icons")
//
// Input: 4 AI-generated white-background doodles in this directory (dark ink lines + single red marker accent).
// Processing: near-white pixels → transparent (paper background is cream #faf6ee; leaving it would expose white squares; same "remove white background" pipeline as decor)
//      → trim transparent edges → scale long edge to 256 → transparent PNG-32.
// Output: client/src/assets/spell_*.png, named spell_${SpellType}, consumed by HandView.CARD_ART_URLS.
//
// Reuses client's sharp. After updating an image, rename/overwrite the source file and re-run `node pack_spells.cjs`.

const path = require('path');
const sharp = require(path.join(__dirname, '../../client/node_modules/sharp'));

const SRC = __dirname;
const OUT = path.join(__dirname, '../../client/src/assets');
const LONG_EDGE = 256;
const WHITE_THRESHOLD = 240; // all three r,g,b channels >= this value → classified as background white → made transparent

// UUID source file → target name (SpellType enum value)
const MAP = {
  '1807861d-fa54-414f-8d0d-8c7049ad21a0.png': 'spell_meteor.png',          // meteor strike
  '4a6c4eb7-ebd3-4089-a30d-7e7388a4baa1.png': 'spell_bridge_collapse.png', // bridge collapse
  'cac12438-c655-4b99-843d-eac325e3973b.png': 'spell_rockslide.png',       // rockslide
  'e50a92fc-87db-4f8f-a687-5e51227c4c17.png': 'spell_haste.png',           // rapid charge
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
  console.log(`${outName.padEnd(26)} ${width}x${height} → ${meta.width}x${meta.height}  (cleared ${pct}%)`);
}

(async () => {
  for (const [src, out] of Object.entries(MAP)) {
    await processOne(src, out);
  }
  console.log('Done → client/src/assets/');
})().catch((e) => { console.error(e); process.exit(1); });
