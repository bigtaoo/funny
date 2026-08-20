// Re-derive the unit card-art PNGs in client/src/assets/units from their art/ masters.
//
// Why: client/src/assets is meant to hold publish-ready bytes (webpack's asset/resource rule
// just copies pngs verbatim — no imagemin/pngquant/oxipng step exists anywhere in the build,
// see webpack.config.js:76). Historically these files were dropped in straight from the art
// masters (art/units/<name>/*.png, art/skins/<name>/<name>.png) with whatever encoder the art
// tool happened to use (mostly 32-bit truecolor+alpha, uncompressed-ish) — same resolution as
// the master, just sitting there uncompressed in the repo, with zero consistency between units
// (some had already been manually downsized/quantized at some point, some hadn't — see git
// history on this file for exact deltas).
//
// Two different real display ceilings (client-modules audit, 2026-08-20), so two different
// long-edge caps:
// - Base unit card art (UNITS below): largest real display is GachaScene's reveal card at ~648
//   logical px portrait / up to ~1150px on a wide desktop window — everything else (roster/shop/
//   codex/detail) tops out under 320px. Capped at 2200px (≈1150 × ~2x DPR headroom) — none of
//   today's masters actually exceed it, so nothing gets resized yet; the cap exists so a future
//   oversized master gets caught automatically.
// - Skins (SKINS below): only ever shown in ShopScene's skin-purchase card, a ~300px square
//   contain-box (never the big reveal-card treatment). Capped at 900px (300 × 3x DPR — covers
//   even the highest-density phones) — several masters (756-940px native) are trimmed down by
//   this, which is why e.g. skin_infantry/skin_shieldbearer don't shrink as much as the base
//   units below despite the same encode step; they're being right-sized for real DPR3 need
//   rather than left at native master resolution or at some earlier ad hoc smaller export.
//
// Encode: sharp's palette:true PNG path runs libimagequant (quantize to ≤256 colors + dithering)
// then zlib at max effort — same trick pngquant uses, no extra native tool required (sharp
// already vendors imagequant, see `sharp.versions.imagequant`). Verify each output visually
// after running this (illustration art with soft gradients can show banding under quantization) —
// this script also prints a truecolor (non-palette, still max zlib effort) size next to the
// palette one so you can eyeball whether the given unit is worth keeping truecolor.
//
// Run: node art/scripts/exportUnitCardArt.mjs
// Out: client/src/assets/units/<name>.png, client/src/assets/units/skins/skin_<name>.png

import sharp from '../../client/node_modules/sharp/lib/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT_DIR = path.join(ROOT, 'client/src/assets/units');
const UNIT_MAX_LONG_EDGE = 2200; // see header note — nothing today actually exceeds this one.
const SKIN_MAX_LONG_EDGE = 900; // see header note — trims several skin masters down to this.

// name → master art file (masters live under art/, one folder per unit; filenames aren't
// uniform because each was authored/exported at a different time — see art/units/*/).
const UNITS = {
  archer: 'art/units/archer/card.png',
  infantry: 'art/units/infantry/infantry.png',
  shieldbearer: 'art/units/shieldbearer/shield_bearer.png',
  berserker: 'art/units/berserker/berserker.png',
  splitter: 'art/units/splitter/splitter.png',
  harpy: 'art/units/harpy/harpy.png',
  ironclad: 'art/units/ironclad/Ironclad.png',
  lena: 'art/units/lena/lena.png',
  mara: 'art/units/mara/mara.png',
  max: 'art/units/max/max.png',
  medic: 'art/units/medic/medic.png',
  runner: 'art/units/runner/runner.png',
};

// skin_<name> → master (art/skins/<name>/<name>.png is the clean per-unit export; the loose
// art/skins/<name>.png siblings are older/rawer duplicates, not used here).
const SKINS = {
  skin_archer: 'art/skins/archer/archer.png',
  skin_infantry: 'art/skins/infantry/infantry.png',
  skin_lena: 'art/skins/lena/lena.png',
  skin_mara: 'art/skins/mara/mara.png',
  skin_max: 'art/skins/max/max.png',
  skin_shieldbearer: 'art/skins/shieldbearer/shieldbearer.png',
};

async function derive(srcRel, outAbs, maxLongEdge) {
  const srcAbs = path.join(ROOT, srcRel);
  const src = sharp(srcAbs);
  const meta = await src.metadata();
  const longEdge = Math.max(meta.width, meta.height);
  const resize = longEdge > maxLongEdge ? maxLongEdge / longEdge : null;
  const base = resize
    ? sharp(srcAbs).resize(Math.round(meta.width * resize), Math.round(meta.height * resize), { kernel: 'lanczos3' })
    : sharp(srcAbs);

  // quality:90 (not the 100 default) — gives libimagequant room to drop a handful of palette
  // entries where the art doesn't need all 256 (medic/runner: ~10-25% smaller for it), while
  // staying high enough that flat-shaded character art with anti-aliased edges doesn't band.
  // Spot-checked visually against the pre-existing committed PNGs before landing this value.
  const paletteBuf = await base.clone().png({ palette: true, effort: 10, compressionLevel: 9, quality: 90 }).toBuffer();
  const truecolorBuf = await base.clone().png({ palette: false, effort: 10, compressionLevel: 9 }).toBuffer();
  // Palette (quantized) is smaller in virtually every case for this kind of flat-shaded /
  // limited-gradient character art; fall back to truecolor only if quantization somehow loses.
  const out = paletteBuf.length <= truecolorBuf.length ? paletteBuf : truecolorBuf;
  const kind = out === paletteBuf ? 'palette' : 'truecolor';

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, out);
  const before = fs.statSync(srcAbs).size;
  console.log(
    `${path.basename(outAbs).padEnd(24)} ${(meta.width + 'x' + meta.height).padEnd(11)} ` +
    `${resize ? '(resized)' : '(as-is)  '} ${kind.padEnd(9)} ` +
    `${(before / 1024).toFixed(0).padStart(6)}K -> ${(out.length / 1024).toFixed(0).padStart(6)}K ` +
    `(palette ${(paletteBuf.length / 1024).toFixed(0)}K / truecolor ${(truecolorBuf.length / 1024).toFixed(0)}K)`
  );
}

for (const [name, src] of Object.entries(UNITS)) {
  await derive(src, path.join(OUT_DIR, `${name}.png`), UNIT_MAX_LONG_EDGE);
}
for (const [name, src] of Object.entries(SKINS)) {
  await derive(src, path.join(OUT_DIR, 'skins', `${name}.png`), SKIN_MAX_LONG_EDGE);
}
