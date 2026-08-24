// Re-derive the gacha PNGs in client/src/assets/gacha from their art/ui/gacha masters.
//
// Why: client/src/assets is meant to hold publish-ready bytes (webpack's asset/resource rule just
// copies pngs verbatim — no imagemin/pngquant/oxipng step exists anywhere in the build, see
// webpack.config.js:76). The 2026-08-20 sweep that quantized every art/**/pack_*.{js,cjs} output
// plus units/skins (see exportUnitCardArt.mjs) missed this set because its pack step didn't live
// under art/scripts at all: the now-deleted client/scripts/prepare-gacha-assets.mjs produced the
// pre-2026-08-24 bytes, and it encoded with `.png({ compressionLevel: 9 })` — which is the one
// option combination that stays *true lossless truecolor* (see the sharp note below). Result: all
// 11 files shipped as un-quantized 24/32-bit PNGs, 3274 KB for a screen that is a card back, a
// frame and a banner. This script replaces it; the resize geometry (cover-crop for the card/banner/
// monthly art, contain-with-transparent-padding for the frames so corner decoration isn't clipped)
// is carried over from it verbatim so the output stays pixel-comparable.
//
// The old script was DELETED rather than left in place: it was wired into no build step, so its only
// remaining effect would have been to silently undo ~2 MB of this saving the next time someone ran it.
//
// Output sizes — derived from the largest box each image is ever drawn into, in design-space px
// (portrait design canvas is 1080 wide × ≥1920 tall; landscape is ≥1920 wide × 1080 tall — see
// layout/PortraitLayout.ts REFERENCE_H / layout/LandscapeLayout.ts REFERENCE_W), then × a DPR
// headroom factor the way exportUnitCardArt.mjs does it:
//
// - Card backs + frames (400×560 / 480×480): GachaScene's reveal grid. A single pull (n=1) is one
//   centred card at the full grid footprint — cellW = 5×0.16w + 4×0.02w = 0.88w, cellH = 1.3×cellW
//   (reveal.ts drawReveal), i.e. 953×1239 portrait and 1687×2193 on a 16:9 landscape window (more
//   on an ultrawide, where designWidth grows past 1920). The frame sprite is stretched over that
//   exact same box. So real usage would justify ~1700×2200 design px before any DPR multiplier —
//   several times what is committed. Both are therefore left at their committed dimensions: this
//   pass is a compression fix, and re-exporting at the justified ceiling would be a large byte
//   *regression*, not a win. (The card art being drawn ~4× upscaled on a single pull is a real but
//   separate quality question — raising it costs bytes and needs an art call, so it is left alone.)
// - Banners (900×340): the pool banner is bannerW = 0.78 × contentWidth, bannerH = 0.26 × h
//   (page.ts drawBody). Widest is an ultrawide landscape window — 0.78 × 2204 ≈ 1719 design px;
//   tallest is a 9:20 phone in portrait — 0.26 × 2400 ≈ 624. Committed 900×340 sits under the
//   design-px ceiling on both axes before DPR is even considered, so it is likewise kept as-is.
// - Monthly card (560×240 → 420×180): the ONLY asset here that is genuinely oversized. It is drawn
//   solely as a ShopScene product-card thumbnail, contain-fitted into a square imgSize box of
//   round(cellH × 0.2) (card.ts — the 0.2 branch, since the monthly card always carries a status
//   line). cellH is capped at min(cellW×1.5, h×0.6) by gridMetrics(), which tops out at imgSize 138
//   design px (portrait, 2 columns; landscape is smaller still at 130). 138 × 3 = 414 → capped at a
//   420 long edge, same "3× DPR covers even the highest-density phones" rule exportUnitCardArt.mjs
//   uses for its skin thumbnails. 560 wide was ~4× the pixels actually needed.
//
// Encode: sharp's palette:true PNG path runs libimagequant (quantize to ≤256 colors + dithering)
// then zlib at max effort — same trick pngquant uses, no extra native tool required (sharp already
// vendors imagequant, see `sharp.versions.imagequant`). quality:90 (not the 100 default) matches
// the value the 2026-08-20 sweep settled on for this ink/cross-hatch art style.
//
// ⚠ sharp gotcha (confirmed on 0.32.6 and 0.35.3): passing `effort` to .png() ALONE, with no
// palette/quality, already silently quantizes to an 8-bit palette. `palette: true` toggles nothing
// extra — it just documents what `effort` was doing anyway. Only `compressionLevel` on its own
// stays true lossless truecolor (which is exactly how the old script ended up shipping 3.3 MB of
// unquantized PNG while looking like it was compressing). To check what you actually produced,
// read `metadata().paletteBitDepth` — a palette output reports 8, a truecolor one reports nothing.
// The `truecolorBuf` reference encode below therefore has to say `palette: false` explicitly.
//
// The only comparison that means anything here is new output vs. the CURRENTLY COMMITTED bytes in
// client/src/assets/gacha — several masters are larger than what's committed and one is smaller, so
// measuring against the master tells you nothing. derive() reads the existing output file before
// overwriting it and shouts if a file came out bigger.
//
// Run: node art/scripts/exportGachaArt.mjs
// Out: client/src/assets/gacha/*.png

import sharp from '../../client/node_modules/sharp/lib/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC_DIR = path.join(ROOT, 'art/ui/gacha');
const OUT_DIR = path.join(ROOT, 'client/src/assets/gacha');

// Transparent pad colour for the frames' contain fit (they are the only RGBA assets here).
const TRANSPARENT = { r: 255, g: 255, b: 255, alpha: 0 };

// out filename → { src master, target box, fit }. Masters aren't uniformly formatted (some png,
// some webp) because each was authored at a different time — sharp reads both, output is always png.
const TASKS = [
  // Result card backgrounds — 5:7 portrait, cover-cropped from the 1060×1484 masters.
  { out: 'gacha_card_common.png',    src: 'gacha_card_common.png',    w: 400, h: 560, fit: 'cover' },
  { out: 'gacha_card_rare.png',      src: 'gacha_card_rare.png',      w: 400, h: 560, fit: 'cover' },
  { out: 'gacha_card_epic.png',      src: 'gacha_card_epic.png',      w: 400, h: 560, fit: 'cover' },
  { out: 'gacha_card_legendary.png', src: 'gacha_card_legendary.png', w: 400, h: 560, fit: 'cover' },

  // Rarity frames — square, RGBA. 'contain' (not 'cover') so the corner scrollwork survives the
  // downscale; the padding has to be transparent or the frame stops being an overlay.
  { out: 'frame_common.png',    src: 'frame_common.png',    w: 480, h: 480, fit: 'contain', bg: TRANSPARENT },
  { out: 'frame_rare.png',      src: 'frame_rare.webp',     w: 480, h: 480, fit: 'contain', bg: TRANSPARENT },
  { out: 'frame_epic.png',      src: 'frame_epic.webp',     w: 480, h: 480, fit: 'contain', bg: TRANSPARENT },
  { out: 'frame_legendary.png', src: 'frame_legendary.webp', w: 480, h: 480, fit: 'contain', bg: TRANSPARENT },

  // Pool banners — cover-cropped from the 2688×1152 masters (master 2.33:1 → banner 2.65:1, so the
  // crop takes a slice off the top/bottom, not the sides).
  { out: 'banner_limited_01.png', src: 'banner_limited_01.webp', w: 900, h: 340, fit: 'cover' },
  { out: 'banner_standard.png',   src: 'banner_standard.webp',   w: 900, h: 340, fit: 'cover' },

  // Monthly card shop thumbnail — right-sized from 560×240 to 420×180 (see header note).
  { out: 'monthly_card.png', src: 'monthly_card.webp', w: 420, h: 180, fit: 'cover' },
];

// Masters with no counterpart in client/src/assets/gacha. Listed rather than silently ignored so a
// newly dropped-in master doesn't go unnoticed the next time someone runs this.
const UNUSED_MASTERS = [
  'gacha_card_rare_alt.png', // alternate rare treatment; never imported by the client (render/gachaArt.ts
                             // maps exactly one card back per Rarity). Kept in art/ as a spare.
];

let regressions = 0;

async function derive(task) {
  const srcAbs = path.join(SRC_DIR, task.src);
  const outAbs = path.join(OUT_DIR, task.out);

  const base = sharp(srcAbs).resize(task.w, task.h, {
    fit: task.fit,
    position: 'centre',
    background: task.bg ?? { r: 255, g: 255, b: 255, alpha: 1 },
  });

  const paletteBuf = await base.clone().png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toBuffer();
  // Reference truecolor encode — `palette: false` is load-bearing, see the sharp gotcha above.
  const truecolorBuf = await base.clone().png({ palette: false, effort: 10, compressionLevel: 9 }).toBuffer();
  // Palette wins in virtually every case for this flat ink/cross-hatch art; fall back to truecolor
  // only if quantization somehow loses on a given file.
  const out = paletteBuf.length <= truecolorBuf.length ? paletteBuf : truecolorBuf;
  const kind = out === paletteBuf ? 'palette' : 'truecolor';

  // Read the file we are about to replace — THIS is the baseline that matters (not the master).
  const before = fs.existsSync(outAbs) ? fs.statSync(outAbs).size : 0;
  const prevMeta = before ? await sharp(outAbs).metadata() : null;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outAbs, out);

  const resized = prevMeta && (prevMeta.width !== task.w || prevMeta.height !== task.h);
  const pct = before ? ((1 - out.length / before) * 100).toFixed(1) : '  n/a';
  console.log(
    `${task.out.padEnd(26)} ${(task.w + 'x' + task.h).padEnd(9)} ${resized ? '(resized)' : '(as-is)  '} ` +
    `${kind.padEnd(9)} ${(before / 1024).toFixed(1).padStart(7)}K -> ${(out.length / 1024).toFixed(1).padStart(7)}K ` +
    `${String(pct).padStart(5)}%  (palette ${(paletteBuf.length / 1024).toFixed(0)}K / truecolor ${(truecolorBuf.length / 1024).toFixed(0)}K)`
  );

  // Strictly greater, not >=: the baseline is the file this run is about to overwrite, so a re-run
  // against already-exported bytes reproduces them exactly. Flagging equality would make the script
  // fail on its own output — non-idempotent, and it would cry wolf every time anyone re-ran it.
  if (before && out.length > before) {
    console.log(`   ⚠ ${task.out} got BIGGER than the committed bytes — the target box above is wrong, don't ship this.`);
    regressions++;
  }
  return { before, after: out.length };
}

let totalBefore = 0;
let totalAfter = 0;
for (const task of TASKS) {
  const { before, after } = await derive(task);
  totalBefore += before;
  totalAfter += after;
}

console.log(
  `\n${'TOTAL'.padEnd(26)} ${''.padEnd(9)} ${''.padEnd(9)} ${''.padEnd(9)} ` +
  `${(totalBefore / 1024).toFixed(1).padStart(7)}K -> ${(totalAfter / 1024).toFixed(1).padStart(7)}K ` +
  `${((1 - totalAfter / totalBefore) * 100).toFixed(1).padStart(5)}%`
);
console.log(`\nUnused masters (kept, not exported): ${UNUSED_MASTERS.join(', ')}`);
if (regressions) {
  console.log(`\n✗ ${regressions} file(s) grew. Fix the caps before committing.`);
  process.exitCode = 1;
}
