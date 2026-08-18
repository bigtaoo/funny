// Derive the store app icons from the existing logo — no new art needed.
//
// `art/logo/logo-simple.png` (the flat variant, 1024², drawn for small sizes) is the base rather
// than `logo.png` (the hand-drawn watercolour crest): at the ~60px a store listing actually renders,
// the drawn version's thin ink lines and ruled-paper texture collapse into mush, while the flat one
// still reads as three crossed pens. Verified by tiling both at 60/120px before choosing.
//
// Apple requires 1024×1024 with NO alpha channel and NO rounded corners (the OS masks it), so the
// crest is composited onto an opaque deep-navy plate and the alpha channel is dropped. Google Play
// accepts alpha but the same opaque plate keeps the two stores' icons identical.
//
// Run: node art/scripts/make-store-icons.mjs
// Out: art/store/icons/{ios_appicon_1024,play_icon_512}.png

import sharp from '../../client/node_modules/sharp/lib/index.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'art/store/icons');
const SRC = path.join(ROOT, 'art/logo/logo-simple.png');
// ui.dark-adjacent navy, same family as the crest's own outline (#2E4055 — the notebook-cover blue
// that runs through the story art and skin palettes).
const PLATE = { r: 0x2e, g: 0x40, b: 0x55, alpha: 1 };
// Crest occupies 86% of the frame: enough breathing room that iOS's rounded-rect mask never clips a
// shield corner, without the icon reading as a small stamp on a big plate.
const FILL = 0.86;

mkdirSync(OUT, { recursive: true });

async function icon(size, file) {
  const trimmed = await sharp(SRC).trim().toBuffer();
  const inner = Math.round(size * FILL);
  const art = await sharp(trimmed)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const pad = Math.round((size - inner) / 2);
  await sharp({ create: { width: size, height: size, channels: 4, background: PLATE } })
    .composite([{ input: art, top: pad, left: pad }])
    .flatten({ background: PLATE })
    .removeAlpha()
    .png()
    .toFile(path.join(OUT, file));
  const m = await sharp(path.join(OUT, file)).metadata();
  console.log(`${file}  ${m.width}x${m.height}  channels=${m.channels}  alpha=${m.hasAlpha}`);
}

await icon(1024, 'ios_appicon_1024.png');
await icon(512, 'play_icon_512.png');
