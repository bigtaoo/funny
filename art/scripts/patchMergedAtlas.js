#!/usr/bin/env node
// patchMergedAtlas.js — re-stamp the frames of ONE sub-atlas into an already-merged atlas page,
// in place, without re-running mergeAssetAtlases.js.
//
// Why this exists: the 2026-07-27 asset reorganisation (commit 072131d8) merged the per-theme
// atlases into shared pages (`slg/world_atlas`, `decor/decor_merged_atlas`, `icons/icons_atlas`)
// and DELETED the individual source atlases from the repo — so mergeAssetAtlases.js can no longer
// run: its inputs are gone. Repacking a single set (e.g. `node art/slg/slg-playerbase/pack_playerbase_atlas.js`)
// therefore had no way to reach the merged page the client actually loads.
//
// This script closes that gap for the common case: the repack produced frames of the SAME pixel
// size as the ones already in the merged page (same CELL constant), so each cell can simply be
// composited back over its existing rectangle. Frame coordinates in the merged JSON never change —
// only the pixels and any non-standard per-frame metadata (e.g. `contentTop`) are refreshed.
//
// Refuses to touch a frame whose size changed: that needs a real re-pack of the whole page (restore
// the deleted source atlases from git and re-run mergeAssetAtlases.js).
//
// Run: node art/scripts/patchMergedAtlas.js <source-atlas.json> <merged-atlas.json>
// e.g. node art/scripts/patchMergedAtlas.js client/src/assets/slg/playerbase_atlas.json client/src/assets/slg/world_atlas.json
const fs = require('fs');
const path = require('path');
let sharp;
try { sharp = require('sharp'); }
catch { sharp = require(path.resolve(__dirname, '../../client/node_modules/sharp')); }

/** Resolve an atlas JSON path to its {json, jsonPath, pngPath} triple (PNG name comes from meta.image). */
function loadAtlas(jsonPath) {
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const pngPath = path.join(path.dirname(jsonPath), json.meta?.image ?? path.basename(jsonPath).replace(/\.json$/, '.png'));
  return { json, jsonPath, pngPath };
}

async function main() {
  const [srcArg, dstArg] = process.argv.slice(2);
  if (!srcArg || !dstArg) {
    console.error('usage: node art/scripts/patchMergedAtlas.js <source-atlas.json> <merged-atlas.json>');
    process.exit(1);
  }
  const src = loadAtlas(path.resolve(srcArg));
  const dst = loadAtlas(path.resolve(dstArg));

  const composites = [];
  const patched = [];
  const missing = [];
  for (const [name, sf] of Object.entries(src.json.frames)) {
    const df = dst.json.frames[name];
    if (!df) { missing.push(name); continue; }
    if (sf.frame.w !== df.frame.w || sf.frame.h !== df.frame.h) {
      console.error(`✗ ${name}: size changed ${sf.frame.w}×${sf.frame.h} → ${df.frame.w}×${df.frame.h}; `
        + 'a full re-merge is required (restore the source atlases from git, run mergeAssetAtlases.js).');
      process.exit(1);
    }
    const cell = await sharp(src.pngPath)
      .extract({ left: sf.frame.x, top: sf.frame.y, width: sf.frame.w, height: sf.frame.h })
      .png().toBuffer();
    composites.push({ input: cell, left: df.frame.x, top: df.frame.y });
    // Carry over non-standard per-frame metadata the packers emit (contentTop, …) — the client reads
    // these straight off the merged JSON.
    for (const key of Object.keys(sf)) {
      if (key === 'frame' || key === 'spriteSourceSize' || key === 'sourceSize') continue;
      df[key] = sf[key];
    }
    patched.push(name);
  }

  if (patched.length === 0) {
    console.error(`No frames of ${path.basename(src.jsonPath)} found in ${path.basename(dst.jsonPath)}.`);
    process.exit(1);
  }

  // `composite` BLENDS over what's already there, so the old art would show through wherever the new
  // frame is transparent (this repack shrinks the art, so most cells now have more transparent margin).
  // Zero the target rectangles in the raw page first, then draw the new cells onto the cleared page.
  const { data, info } = await sharp(dst.pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const name of patched) {
    const f = dst.json.frames[name].frame;
    for (let y = f.y; y < f.y + f.h; y++) {
      for (let x = f.x; x < f.x + f.w; x++) {
        const p = (y * info.width + x) * 4;
        data[p] = 0; data[p + 1] = 0; data[p + 2] = 0; data[p + 3] = 0;
      }
    }
  }
  const cleared = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  const out = await sharp(cleared)
    .composite(composites)
    .png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 })
    .toBuffer();

  fs.writeFileSync(dst.pngPath, out);
  fs.writeFileSync(dst.jsonPath, JSON.stringify(dst.json, null, 2));
  console.log(`✓ patched ${patched.length} frame(s) into ${path.relative(process.cwd(), dst.pngPath)}: ${patched.join(', ')}`);
  if (missing.length) console.warn(`  (not present in the merged page, skipped: ${missing.join(', ')})`);
  console.log(`  ${(out.length / 1024).toFixed(1)} KB`);
}

main().catch(err => { console.error(err); process.exit(1); });
