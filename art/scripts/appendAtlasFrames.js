#!/usr/bin/env node
// appendAtlasFrames.js — add/replace a SMALL, EXPLICIT set of named frames from one already-
// packed atlas into an existing merged atlas page, without touching anything else on that page.
//
// Why this exists (2026-08-09): patchMergedAtlas.js only handles "same pixel size, overwrite in
// place" — it refuses (whole script aborts, nothing written) the moment one frame's size changed,
// and silently skips any frame missing from the destination (it never grows the page). Doing a
// real full re-merge (mergeAssetAtlases.js) needs every OTHER source atlas's PNG/JSON back on
// disk too (terrain/city/playerbase/res/city_bld — deleted from the repo in the 2026-07-27
// cleanup, see patchMergedAtlas.js's header), which is a much bigger blast radius than "one or
// two building-atlas frames changed size/are new".
//
// What this does instead: for each requested frame name, if it already exists in the
// destination at the SAME size, patch its pixels in place (dst position, src content) — same
// technique as patchMergedAtlas.js. If it's missing or a different size, shelf-pack it into a
// brand-new strip appended below the page's current content (canvas height grows; every
// existing frame's x/y/w/h is left completely untouched). Only the requested frame names are
// ever modified — every other frame on the page (there can be 50+) is guaranteed byte-identical.
//
// Run: NODE_PATH="$(pwd)/client/node_modules" node art/scripts/appendAtlasFrames.js \
//        <source-atlas.json> <merged-atlas.json> <frameName> [<frameName> ...]
const fs = require('fs');
const path = require('path');
let sharp;
try { sharp = require('sharp'); }
catch { sharp = require(path.resolve(__dirname, '../../client/node_modules/sharp')); }

function loadAtlas(jsonPath) {
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const pngPath = path.join(path.dirname(jsonPath), json.meta?.image ?? path.basename(jsonPath).replace(/\.json$/, '.png'));
  return { json, jsonPath, pngPath };
}

async function main() {
  const [srcArg, dstArg, ...names] = process.argv.slice(2);
  if (!srcArg || !dstArg || names.length === 0) {
    console.error('usage: node art/scripts/appendAtlasFrames.js <source-atlas.json> <merged-atlas.json> <frameName> [<frameName> ...]');
    process.exit(1);
  }
  const src = loadAtlas(path.resolve(srcArg));
  const dst = loadAtlas(path.resolve(dstArg));

  const inPlace = []; // { name, srcFrame } — same size at an existing dst position
  const toAppend = []; // { name, srcFrame } — new frame or size changed, needs new space

  for (const name of names) {
    const sf = src.json.frames[name];
    if (!sf) { console.error(`✗ "${name}" not found in ${path.basename(src.jsonPath)}`); process.exit(1); }
    const df = dst.json.frames[name];
    if (df && sf.frame.w === df.frame.w && sf.frame.h === df.frame.h) inPlace.push({ name, sf });
    else toAppend.push({ name, sf });
  }

  const srcRaw = await sharp(src.pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const dstMeta = await sharp(dst.pngPath).metadata();
  const pageW = dstMeta.width, pageH = dstMeta.height;

  // Shelf-pack the append set into a strip starting at y=pageH, wrapping within pageW.
  const order = [...toAppend].sort((a, b) => b.sf.frame.h - a.sf.frame.h);
  let x = 0, rowY = pageH, rowH = 0, maxRowW = 0;
  const placed = [];
  for (const item of order) {
    const { w, h } = item.sf.frame;
    if (x > 0 && x + w > pageW) { rowY += rowH; x = 0; rowH = 0; }
    placed.push({ ...item, x, y: rowY });
    x += w;
    rowH = Math.max(rowH, h);
    maxRowW = Math.max(maxRowW, x);
  }
  const newPageH = toAppend.length ? rowY + rowH : pageH;

  // Extract each in-place/append frame's pixels from the source atlas as its own PNG buffer
  // (crop straight out of the raw source page, same approach patchMergedAtlas.js uses).
  async function extract(sf) {
    const { x: sx, y: sy, w, h } = sf.frame;
    const buf = Buffer.alloc(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const si = ((sy + yy) * srcRaw.info.width + (sx + xx)) * 4;
        const di = (yy * w + xx) * 4;
        srcRaw.data.copy(buf, di, si, si + 4);
      }
    }
    return sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  }

  const composites = [];
  for (const { name, sf } of inPlace) {
    composites.push({ input: await extract(sf), left: dst.json.frames[name].frame.x, top: dst.json.frames[name].frame.y });
  }
  for (const { name, sf, x: px, y: py } of placed) {
    composites.push({ input: await extract(sf), left: px, top: py });
  }

  // Build the new page: existing content unchanged, grown canvas if the append strip added
  // rows, in-place frames' old pixels zeroed first (composite blends, and a shrunk frame would
  // otherwise show old art through its new transparent margin — same fix as patchMergedAtlas.js).
  const grown = newPageH > pageH;
  const base = grown
    ? sharp({ create: { width: pageW, height: newPageH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await sharp(dst.pngPath).png().toBuffer(), left: 0, top: 0 }])
    : sharp(dst.pngPath);
  let basePng = await base.png().toBuffer();
  if (inPlace.length) {
    const { data, info } = await sharp(basePng).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const { name } of inPlace) {
      const f = dst.json.frames[name].frame;
      for (let yy = f.y; yy < f.y + f.h; yy++) {
        for (let xx = f.x; xx < f.x + f.w; xx++) {
          const p = (yy * info.width + xx) * 4;
          data[p] = 0; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = 0;
        }
      }
    }
    basePng = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  }

  const out = await sharp(basePng)
    .composite(composites)
    .png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 })
    .toBuffer();

  // Update JSON: in-place frames keep their dst x/y, take src's w/h/spriteSourceSize/sourceSize;
  // appended frames get a brand-new entry at their new shelf position.
  for (const { name, sf } of inPlace) {
    dst.json.frames[name] = { ...sf, frame: { ...sf.frame, x: dst.json.frames[name].frame.x, y: dst.json.frames[name].frame.y } };
  }
  for (const { name, sf, x: px, y: py } of placed) {
    dst.json.frames[name] = { ...sf, frame: { ...sf.frame, x: px, y: py } };
  }
  dst.json.meta.size = { w: pageW, h: newPageH };

  fs.writeFileSync(dst.pngPath, out);
  fs.writeFileSync(dst.jsonPath, JSON.stringify(dst.json, null, 2));
  console.log(`✓ patched ${inPlace.length} in place, appended ${toAppend.length} new -> ${path.relative(process.cwd(), dst.pngPath)}`);
  if (inPlace.length) console.log(`  in place: ${inPlace.map((i) => i.name).join(', ')}`);
  if (toAppend.length) console.log(`  appended: ${toAppend.map((i) => i.name).join(', ')} (page ${pageW}x${pageH} -> ${pageW}x${newPageH})`);
  console.log(`  ${(out.length / 1024).toFixed(1)} KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
