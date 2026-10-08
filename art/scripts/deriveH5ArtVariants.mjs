// Derive the compressed H5 base files from their `.hires` siblings (ASSET_PACKAGING §9 / §23).
//
// The `.hires` convention: `webpack --env TARGET=mobile` swaps any imported `foo.png` for a sibling
// `foo.hires.png` when one exists; every other target (web, crazygames, wechat*) ships `foo.png`.
// So for each set below the `.hires` file is the full-resolution original that the native app keeps,
// and the base file is a downscaled copy for the network-loaded builds. Call sites never change.
//
// Idempotent and reproducible: the `.hires` file is the source of truth and is never rewritten. On
// the first run for a file that has no `.hires` sibling yet and exceeds the set's cap, the
// committed file is RENAMED to `<name>.hires.png` (bytes untouched) before the base is derived from
// it. A file already within the cap is left alone and gets no sibling.
//
// Resize: sharp Lanczos3, aspect preserved, format kept (PNG), alpha kept when the source has it.
// Encode: every original here is an 8-bit palette PNG, and so is every base file —
// `palette` = libimagequant at quality 90 (the encode exportUnitCardArt.mjs already uses for the card
// art). Lanczos creates in-between colours the originals' 60-110 entry palettes never had, so
// re-quantising is what makes the smaller image also the smaller file: a 384 px bust re-encoded at
// quality 100 (or truecolor) comes out within ~10% of — or LARGER than — its 512 px original, while
// quality 90 lands at ~55% and still measures ~44-46 dB PSNR against the unquantised Lanczos
// result. `palette100` (PWA icons, not resized) keeps the default quality so only the encode changes.
// Either way a truecolor encode is taken instead if it is somehow smaller.
//
// Run: node art/scripts/deriveH5ArtVariants.mjs [--check]
//   --check: write nothing, exit 1 if any base file is missing/oversized or a sibling is orphaned.

import sharp from '../../client/node_modules/sharp/lib/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = process.argv.includes('--check');

/**
 * Display-size reasoning lives in design/game/ASSET_PACKAGING.md §23; the short version:
 * - Unit card full art: only the gacha single-pull reveal ever draws it (render/cardArt.ts
 *   `artUrlForBox`), and only for max/lena/mara — the other six full exports are not reachable
 *   from any card that exists. 1400 px long edge = max/mara lose 4-6%, lena/medic/runner are
 *   already under it; berserker/harpy/splitter/ironclad drop the most bytes.
 * - Bust portraits: drawn only inside `buildPortraitIcon`'s avatar circle; the largest site is
 *   ProfilePopup. Measured at 384 px: ≤ 1.02 device px per source px on phones, iPads and
 *   ≤ 1000-CSS-px-tall dpr-2 desktops; only a 5K-class window (~1330 CSS px tall, dpr 2) magnifies
 *   the tightest-cropped portrait 1.32x — not magnifying there would need ~506 px, i.e. no cut.
 */
const SETS = [
  { dir: 'client/src/assets/units', fit: { longEdge: 1400 }, encode: 'palette' },
  { dir: 'client/src/assets/avatars/preset', fit: { width: 384 }, encode: 'palette' },
  { dir: 'client/src/assets/avatars/hero', fit: { width: 384 }, encode: 'palette' },
  { dir: 'client/src/assets/avatars/skin', fit: { width: 384 }, encode: 'palette' },
  // PWA / home-screen icons (copied by webpack's CopyPlugin, not imported; the mobile build copies
  // the `.hires` file under the base name — see webpack.config.js). Same pixel size, palette only.
  { dir: 'client/public', only: ['icon-512.png', 'icon-192.png', 'apple-touch-icon.png'], fit: null, encode: 'palette100' },
];

const HIRES = /\.hires\.png$/i;

/** Target size for a source of `w`×`h` under `fit`, or null when it already fits. */
function targetSize(w, h, fit) {
  if (!fit) return { w, h };
  const k = fit.longEdge ? fit.longEdge / Math.max(w, h) : fit.width / w;
  return k < 1 ? { w: Math.round(w * k), h: Math.round(h * k) } : null;
}

async function encode(pipeline, kind) {
  const truecolor = () => pipeline.clone().png({ palette: false, effort: 10, compressionLevel: 9 }).toBuffer();
  const quality = kind === 'palette100' ? 100 : 90;
  const pal = await pipeline.clone().png({ palette: true, quality, effort: 10, compressionLevel: 9 }).toBuffer();
  const tc = await truecolor();
  return pal.length <= tc.length ? pal : tc;
}

let problems = 0;
for (const set of SETS) {
  const dir = path.join(ROOT, set.dir);
  const names = fs.readdirSync(dir).filter((n) => /\.png$/i.test(n) && !HIRES.test(n) && (!set.only || set.only.includes(n)));
  for (const name of names) {
    const base = path.join(dir, name);
    const hires = base.replace(/\.png$/i, '.hires.png');
    if (!fs.existsSync(hires)) {
      const m = await sharp(base).metadata();
      if (set.fit && !targetSize(m.width, m.height, set.fit)) continue; // already within the cap
      if (CHECK) { console.log(`✖ ${set.dir}/${name}: over the cap and no .hires sibling`); problems++; continue; }
      fs.renameSync(base, hires);
    }
    const m = await sharp(hires).metadata();
    const size = targetSize(m.width, m.height, set.fit);
    if (!size) { console.log(`✖ ${set.dir}/${name}: .hires sibling is not larger than the cap`); problems++; continue; }
    if (CHECK) {
      const b = await sharp(base).metadata();
      const ok = b.width === size.w && b.height === size.h;
      if (!ok) { console.log(`✖ ${set.dir}/${name}: ${b.width}x${b.height}, expected ${size.w}x${size.h}`); problems++; }
      continue;
    }
    let pipeline = sharp(hires);
    if (size.w !== m.width || size.h !== m.height) pipeline = pipeline.resize(size.w, size.h, { kernel: 'lanczos3' });
    const out = await encode(pipeline, set.encode);
    fs.writeFileSync(base, out);
    const kib = (n) => `${(n / 1024).toFixed(0)}K`;
    console.log(`${(set.dir.replace('client/', '') + '/' + name).padEnd(44)} ${`${m.width}x${m.height}`.padStart(9)} -> ${`${size.w}x${size.h}`.padEnd(9)} ${kib(fs.statSync(hires).size).padStart(6)} -> ${kib(out.length).padStart(5)}`);
  }
}
if (problems) { console.error(`\n${problems} problem(s).`); process.exit(1); }
