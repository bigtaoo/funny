// Build the Windows taskbar/exe icon for the NW Tool desktop shell (tools/desktop-shell).
//
// Why a hand-built .ico instead of letting electron-builder derive one from a single PNG:
// electron-builder takes `build/icon.png` (1024²) and emits whichever sizes it likes, all
// resampled from that one 1024 bitmap. Windows then asks for 16/24/32 px — the taskbar sizes —
// and gets bitmaps that were squeezed down 40× in one step, so the crest's ink outlines turn to
// grey mush. ADR-027 already splits the logo into master (≥128px) and simple (≤64px) exactly
// because of this; the shell was on the simple variant already, but still went through the
// one-source-bitmap path. Here every entry is resampled on its own with an explicit filter, and
// the set includes the small sizes Windows actually renders in the taskbar.
//
// Source is `art/logo/logo-simple.png` (flat, no paper texture, no tape) — the ≤64px variant per
// ADR-027. The master crest is never an input here at any size.
//
// Run: node art/scripts/make-desktop-icon.mjs
// Out: tools/desktop-shell/build/icon.ico
//
// The installed app only picks this up after a repack (`npm run pack` in tools/desktop-shell);
// Windows also caches shell icons, so an old pinned shortcut can keep showing the previous art.

import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'art/logo/logo-simple.png');
const OUT = path.join(ROOT, 'tools/desktop-shell/build/icon.ico');

// 16/24/32 are the taskbar and alt-tab sizes, 48 is Explorer's medium view, 64/128/256 cover the
// larger shell views and the installer. electron-builder rejects an .ico without a 256 entry.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// Flat art loses its outline weight when it is downscaled far; a small unsharp pass at the sizes
// that shrink the most puts the ink edge back without ringing. Measured by eye on the contact
// sheet the script prints below — anything stronger haloes the shield rim at 16px.
function sharpenFor(size) {
  if (size <= 24) return { sigma: 0.6 };
  if (size <= 48) return { sigma: 0.4 };
  return null;
}

const pngs = [];
for (const size of SIZES) {
  let img = sharp(SRC).resize(size, size, {
    fit: 'contain',
    kernel: 'lanczos3',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });
  const s = sharpenFor(size);
  if (s) img = img.sharpen(s);
  pngs.push({ size, buf: await img.png({ compressionLevel: 9 }).toBuffer() });
}

// ICO container: 6-byte ICONDIR + one 16-byte ICONDIRENTRY per image + the PNG payloads.
// PNG-compressed entries are read by Windows Vista and later at every size.
const HEADER = 6;
const ENTRY = 16;
const dir = Buffer.alloc(HEADER + ENTRY * pngs.length);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(pngs.length, 4);

let offset = dir.length;
pngs.forEach(({ size, buf }, i) => {
  const at = HEADER + ENTRY * i;
  dir.writeUInt8(size === 256 ? 0 : size, at); // 0 means 256
  dir.writeUInt8(size === 256 ? 0 : size, at + 1);
  dir.writeUInt8(0, at + 2); // palette size: 0 for truecolour
  dir.writeUInt8(0, at + 3); // reserved
  dir.writeUInt16LE(1, at + 4); // colour planes
  dir.writeUInt16LE(32, at + 6); // bits per pixel
  dir.writeUInt32LE(buf.length, at + 8);
  dir.writeUInt32LE(offset, at + 12);
  offset += buf.length;
});

writeFileSync(OUT, Buffer.concat([dir, ...pngs.map((p) => p.buf)]));
console.log(`${path.relative(ROOT, OUT)}  ${pngs.map((p) => p.size).join('/')}  ${offset} bytes`);
