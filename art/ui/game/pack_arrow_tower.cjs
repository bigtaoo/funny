#!/usr/bin/env node
// pack_arrow_tower.cjs — process the battle arrow-tower AI image into the client asset.
//
// Design + prompt: design/product/battle-arrow-tower-art.md
// Run: NODE_PATH="$(pwd)/client/node_modules" node art/ui/game/pack_arrow_tower.cjs <source-file> [--tint #313290] [--no-tint] [--out path.png]
// `--out` scores a candidate draw without touching the client asset — use it for trial rounds.
//
// Pipeline (same lineage as pack_spells.cjs + pack_base_atlas.js, and it must stay that way):
//   near-white → transparent   (paper background is cream #faf6ee; leaving white would show a white box)
//   → trim transparent edges
//   → resize long edge to 256  (matches game_base.png 324x256 / game_infantry_barracks.png 256x171)
//   → hardenAlpha()            (NOT optional — see below)
//   → tint to the family ink   (#313290, the barracks blue; luminance preserved, chroma replaced)
//   → client/src/assets/buildings/game_arrow_tower.png
//
// Why hardenAlpha: AI sources have feathered edges, and the downscale to 256 smears every edge
// over several more pixels. The two stack into a wide half-transparent band that reads in-game as
// "this building looks washed out / translucent" — exactly the 2026-07-25 base tier-1/2 report
// (design/game/UI_DESIGN_LOG_2026-06_07.md). Snap outside [LOW,HIGH] to 0/255, remap the band.
//
// The script prints the acceptance metrics from battle-arrow-tower-art.md so a bad draw is caught
// here rather than after wiring: bbox aspect, 56px paper contrast, ink spread, opaque share.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SRC_DIR = __dirname;
const OUT_PATH = path.resolve(__dirname, '../../../client/src/assets/buildings/game_arrow_tower.png');

const LONG_EDGE = 256;
const WHITE_THRESHOLD = 240;   // r,g,b all >= this → background white → transparent
const ALPHA_HARD_LOW = 90;     // same band as pack_base_atlas.js
const ALPHA_HARD_HIGH = 170;
const FAMILY_INK = '#313290';  // game_infantry_barracks.png measured ink mean rgb(49,50,144)

// Acceptance thresholds (design/product/battle-arrow-tower-art.md §验收清单)
// opaqueMin is calibrated against the shipped family, not copied from the base-atlas log:
// measured opaque/visible = game_base 94.9%, game_infantry_barracks 91.2%, old hut 81.3%.
const WANT = { aspectMin: 0.95, aspectMax: 1.10, contrastMin: 115, middleMin: 75, opaqueMin: 90 };

const PAPER_LUM = 246;         // cream paper #faf6ee luminance, what the sprite is composited over
const SPRITE_SIZE = 56;        // BuildingView.SPRITE_SIZE — the box the art actually renders in

function parseArgs(argv) {
  const rest = [];
  let tint = FAMILY_INK;
  let out = OUT_PATH;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-tint') tint = null;
    else if (argv[i] === '--tint') tint = argv[++i];
    else if (argv[i] === '--out') out = path.resolve(argv[++i]); // trial rounds: score a candidate without touching the client
    else rest.push(argv[i]);
  }
  return { src: rest[0], tint, out };
}

function hardenAlpha(raw) {
  for (let i = 3; i < raw.length; i += 4) {
    const a = raw[i];
    if (a <= ALPHA_HARD_LOW) raw[i] = 0;
    else if (a >= ALPHA_HARD_HIGH) raw[i] = 255;
    else raw[i] = Math.round(((a - ALPHA_HARD_LOW) / (ALPHA_HARD_HIGH - ALPHA_HARD_LOW)) * 255);
  }
}

/** Ink bbox + horizontal ink distribution + opaque share, on the final full-res asset. */
async function measureAsset(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: c } = info;

  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  let opaque = 0, visible = 0;
  const quarters = [0, 0, 0, 0];
  let inkTotal = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * c;
      const a = data[i + 3];
      if (a < 24) continue;
      visible++;
      if (a >= 250) opaque++;
      const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (lum < 160) {
        inkTotal++;
        quarters[Math.min(3, Math.floor((x / w) * 4))]++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }

  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  return {
    w, h,
    bbox: `${bw}x${bh}`,
    aspect: bw / bh,
    middleShare: (100 * (quarters[1] + quarters[2])) / inkTotal,
    opaqueShare: (100 * opaque) / visible,
  };
}

/** Mean darkness of the ink against cream paper, at the size the board actually renders it. */
async function measure56(file) {
  const { data, info } = await sharp(file)
    .resize(SPRITE_SIZE, SPRITE_SIZE, { fit: 'fill' })  // BuildingView forces a square — measure what ships
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const c = info.channels;
  let n = 0, sum = 0;
  for (let i = 0; i < data.length; i += c) {
    const a = data[i + 3];
    if (a < 24) continue;
    const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const eff = PAPER_LUM - (lum * (a / 255) + PAPER_LUM * (1 - a / 255)); // darkness once composited on paper
    if (eff > 40) { n++; sum += eff; }
  }
  return { contrast: sum / n, inkShare: (100 * n) / (SPRITE_SIZE * SPRITE_SIZE) };
}

function verdict(ok) { return ok ? 'PASS' : 'FAIL'; }

(async () => {
  const { src, tint, out } = parseArgs(process.argv.slice(2));
  if (!src) {
    console.error('usage: pack_arrow_tower.cjs <source-file-in-art/ui/game> [--tint #313290] [--no-tint] [--out path.png]');
    process.exit(2);
  }
  const srcPath = path.isAbsolute(src) ? src : path.join(SRC_DIR, src);
  if (!fs.existsSync(srcPath)) {
    console.error(`source not found: ${srcPath}`);
    process.exit(2);
  }

  // 1. near-white → transparent
  const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let cleared = 0;
  for (let i = 0; i < data.length; i += channels) {
    if (data[i] >= WHITE_THRESHOLD && data[i + 1] >= WHITE_THRESHOLD && data[i + 2] >= WHITE_THRESHOLD) {
      data[i + 3] = 0;
      cleared++;
    }
  }

  // 2. trim → resize long edge (RGBA raw back out, so alpha can be hardened after the resize)
  let pipeline = sharp(data, { raw: { width, height, channels } })
    .trim()
    .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: false });
  if (tint) pipeline = pipeline.tint(tint); // preserves luminance, replaces chroma → exact family ink

  const resized = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // 3. harden the alpha band, then encode
  hardenAlpha(resized.data);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(resized.data, { raw: { width: resized.info.width, height: resized.info.height, channels: 4 } })
    .png().toFile(out);

  // 4. acceptance metrics
  const a = await measureAsset(out);
  const s = await measure56(out);
  const kb = (fs.statSync(out).size / 1024).toFixed(0);

  console.log(`\n${path.basename(src)} ${width}x${height} → ${a.w}x${a.h}  ${kb} KB  (cleared ${((cleared / (width * height)) * 100).toFixed(0)}% white${tint ? `, tinted ${tint}` : ', untinted'})`);
  console.log(`  → ${out}\n`);
  console.log('acceptance (design/product/battle-arrow-tower-art.md §验收清单):');
  console.log(`  ink bbox            ${a.bbox}  aspect ${a.aspect.toFixed(2)}   want ${WANT.aspectMin}–${WANT.aspectMax}   ${verdict(a.aspect >= WANT.aspectMin && a.aspect <= WANT.aspectMax)}`);
  console.log(`  56px paper contrast ${s.contrast.toFixed(0)} / 246                want >= ${WANT.contrastMin}     ${verdict(s.contrast >= WANT.contrastMin)}   (barracks 122, old hut 84)`);
  console.log(`  middle-half ink     ${a.middleShare.toFixed(0)}%                     want >= ${WANT.middleMin}%     ${verdict(a.middleShare >= WANT.middleMin)}   (old hut 59% — 41% was trees)`);
  console.log(`  opaque share        ${a.opaqueShare.toFixed(1)}%                   want >= ${WANT.opaqueMin}%   ${verdict(a.opaqueShare >= WANT.opaqueMin)}   (family: base 94.9, barracks 91.2, old hut 81.3)`);
  console.log(`  56px ink coverage   ${s.inkShare.toFixed(1)}%                     (barracks 27%, informational)\n`);
})().catch((e) => { console.error(e); process.exit(1); });
