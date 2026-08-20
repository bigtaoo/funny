#!/usr/bin/env node
// pack_arrow_tower.cjs — process the battle arrow-tower AI image into the client asset.
//
// Design + prompt: design/product/battle-arrow-tower-art.md
// Run: NODE_PATH="$(pwd)/client/node_modules" node art/ui/game/pack_arrow_tower.cjs <source-file> [--ink #313290 | --no-ink] [--thicken N] [--no-harden] [--out path.png]
// `--out` scores a candidate draw without touching the client asset — use it for trial rounds.
//
// Pipeline (same lineage as pack_spells.cjs + pack_base_atlas.js, and it must stay that way):
//   near-white → transparent   (paper background is cream #faf6ee; leaving white would show a white box)
//   → trim transparent edges
//   → resize long edge to 256  (matches game_base.png 324x256 / game_infantry_barracks.png 256x171)
//   → inkify()                 (residual grey → alpha, RGB := the family ink)
//   → thicken()                (N alpha-dilate passes AT PACK SIZE, not at 56 — see below)
//   → hardenAlpha()            (NOT optional — see below)
//   → client/src/assets/buildings/game_arrow_tower.png
//
// Why hardenAlpha: AI sources have feathered edges, and the downscale to 256 smears every edge
// over several more pixels. The two stack into a wide half-transparent band that reads in-game as
// "this building looks washed out / translucent" — exactly the 2026-07-25 base tier-1/2 report
// (design/game/UI_DESIGN_LOG_2026-06_07.md). Snap outside [LOW,HIGH] to 0/255, remap the band.
//
// Why inkify instead of sharp's .tint(): .tint() preserves luminance and replaces chroma, so on
// pure-black line art (which is what the generator returns) it is a NO-OP — measured identical
// metrics with and without it, ink stayed rgb(0,0,0). A white-background line drawing has to be
// converted the other way round: luminance becomes coverage/alpha, and the ink color is assigned.
//
// Why thicken at pack size: the board renders this at 56px, so a 1254px source's thin lines get
// averaged away (first candidate: 104/246 contrast vs the barracks' 122). Dilating AT 56 was tried
// first and blobs immediately — one pass there is a whole pixel, the stone courses fuse and the bow
// disappears (same failure as the anvil tab icons, back-arrow-art.md). One pass at 256 is ~0.2px
// once the runtime downscale lands: contrast 104 → 127, detail intact. As that doc puts it, how many
// passes a shape can take is a property of the shape — hence a flag, not a constant.
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

// Acceptance thresholds (design/product/battle-arrow-tower-art.md §验收清单).
//
// softBandMax replaces an earlier "opaque share >= 90%" check that looked calibrated but compared
// apples to oranges: the legacy assets keep their hatching tone as full-alpha GREY RGB (19.6% of
// their visible pixels), while inkify() deliberately moves tone into alpha (0% grey RGB), so an
// inkified asset always scores lower on opaque share no matter how crisp its edges are. The soft
// alpha band is what the "washed out" bug was ever about, and it is measurable either way:
// game_base 1.3%, game_infantry_barracks 2.9%, old hut 6.2% (the bad one).
//
// middleMin only catches gross cases. It cannot tell a thematically-relevant corner prop (the
// rubble pile / arrow barrel that make the bbox square) from wasted scenery (the old hut's two
// trees) — 65% vs 59% is a small gap for two very different situations. The visual check decides.
const WANT = { aspectMin: 0.95, aspectMax: 1.10, contrastMin: 115, middleMin: 55, softBandMax: 5 };
const SOFT_BAND_HI = 96;       // 24 <= alpha < 96 = the feathered band hardenAlpha exists to kill

const PAPER_LUM = 246;         // cream paper #faf6ee luminance, what the sprite is composited over
const SPRITE_SIZE = 56;        // BuildingView.SPRITE_SIZE — the box the art actually renders in

function parseArgs(argv) {
  const rest = [];
  let ink = FAMILY_INK;
  let out = OUT_PATH;
  let thicken = 1;    // 1 pass @256 is what the 2026-08-19 candidate needed; re-measure per image
  let harden = true;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--no-ink') ink = null;
    else if (argv[i] === '--ink') ink = argv[++i];
    else if (argv[i] === '--thicken') thicken = Number(argv[++i]);
    else if (argv[i] === '--no-harden') harden = false;
    else if (argv[i] === '--out') out = path.resolve(argv[++i]); // trial rounds: score a candidate without touching the client
    else rest.push(argv[i]);
  }
  return { src: rest[0], ink, out, thicken, harden };
}

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`bad ink color: ${hex}`);
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * White-background line art → colored ink on transparency: luminance becomes coverage
 * (dark stroke = opaque, light AA fringe = faint), every visible pixel takes the ink RGB.
 * This is what .tint() cannot do for black ink — see the header note.
 */
function inkify(raw, ink) {
  for (let i = 0; i < raw.length; i += 4) {
    const a = raw[i + 3];
    if (a === 0) continue;
    const lum = raw[i] * 0.299 + raw[i + 1] * 0.587 + raw[i + 2] * 0.114;
    const cov = Math.max(0, Math.min(1, (255 - lum) / 255));
    raw[i + 3] = Math.round(a * cov);
    raw[i] = ink[0]; raw[i + 1] = ink[1]; raw[i + 2] = ink[2];
  }
}

/**
 * N passes of 4-neighbour alpha dilation. RGB is already uniform ink by the time this runs,
 * so the black-fringe bug that bit the tab icons (dilating alpha while leaving stale RGB,
 * back-arrow-art.md) cannot happen here.
 */
function thickenAlpha(raw, w, h, passes) {
  for (let p = 0; p < passes; p++) {
    const src = Uint8Array.from(raw);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        let m = src[i + 3];
        if (x > 0)     { const a = src[i - 4 + 3]; if (a > m) m = a; }
        if (x < w - 1) { const a = src[i + 4 + 3]; if (a > m) m = a; }
        if (y > 0)     { const a = src[i - w * 4 + 3]; if (a > m) m = a; }
        if (y < h - 1) { const a = src[i + w * 4 + 3]; if (a > m) m = a; }
        raw[i + 3] = m;
      }
    }
  }
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
  let opaque = 0, visible = 0, soft = 0;
  const quarters = [0, 0, 0, 0];
  let inkTotal = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * c;
      const a = data[i + 3];
      if (a < 24) continue;
      visible++;
      if (a >= 250) opaque++;
      if (a < SOFT_BAND_HI) soft++;
      const lum = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      // Alpha gate as well as luminance: after inkify() every visible pixel carries the ink RGB,
      // so a luminance-only test would count the faintest AA fringe as ink and inflate the bbox.
      if (lum < 160 && a >= 96) {
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
    softBandShare: (100 * soft) / visible,
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
  const { src, ink, out, thicken, harden } = parseArgs(process.argv.slice(2));
  if (!src) {
    console.error('usage: pack_arrow_tower.cjs <source-file-in-art/ui/game> [--ink #313290] [--no-ink] [--thicken N] [--no-harden] [--out path.png]');
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

  // 2. trim → resize long edge (RGBA raw back out: ink/thicken/harden all work on the pack-size pixels)
  const resized = await sharp(data, { raw: { width, height, channels } })
    .trim()
    .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: false })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // 3. ink color → thicken → harden the alpha band, then encode
  if (ink) inkify(resized.data, parseHex(ink));
  if (thicken > 0) thickenAlpha(resized.data, resized.info.width, resized.info.height, thicken);
  if (harden) hardenAlpha(resized.data);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(resized.data, { raw: { width: resized.info.width, height: resized.info.height, channels: 4 } })
    .png().toFile(out);

  // 4. acceptance metrics
  const a = await measureAsset(out);
  const s = await measure56(out);
  const kb = (fs.statSync(out).size / 1024).toFixed(0);

  console.log(`\n${path.basename(src)} ${width}x${height} → ${a.w}x${a.h}  ${kb} KB  (cleared ${((cleared / (width * height)) * 100).toFixed(0)}% white${ink ? `, ink ${ink}` : ', original ink'}, thicken x${thicken}${harden ? '' : ', no harden'})`);
  console.log(`  → ${out}\n`);
  console.log('acceptance (design/product/battle-arrow-tower-art.md §验收清单):');
  console.log(`  ink bbox            ${a.bbox}  aspect ${a.aspect.toFixed(2)}   want ${WANT.aspectMin}–${WANT.aspectMax}   ${verdict(a.aspect >= WANT.aspectMin && a.aspect <= WANT.aspectMax)}`);
  console.log(`  56px paper contrast ${s.contrast.toFixed(0)} / 246                want >= ${WANT.contrastMin}     ${verdict(s.contrast >= WANT.contrastMin)}   (barracks 122, old hut 84)`);
  console.log(`  middle-half ink     ${a.middleShare.toFixed(0)}%                     want >= ${WANT.middleMin}%     ${verdict(a.middleShare >= WANT.middleMin)}   (gross check only — old hut 59%, corner props land here too)`);
  console.log(`  soft alpha band     ${a.softBandShare.toFixed(1)}%                    want <= ${WANT.softBandMax}%     ${verdict(a.softBandShare <= WANT.softBandMax)}   (base 1.3, barracks 2.9, old hut 6.2)`);
  console.log(`  opaque share        ${a.opaqueShare.toFixed(1)}%                   informational — inkify moves tone into alpha, so this is not comparable to the legacy assets`);
  console.log(`  56px ink coverage   ${s.inkShare.toFixed(1)}%                     (barracks 27%, informational)\n`);
})().catch((e) => { console.error(e); process.exit(1); });
