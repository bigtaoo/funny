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
// Two modes, chosen automatically by comparing frame sizes:
//
//   IN-PLACE (every incoming frame is the same pixel size as the one already in the page) — each
//   cell is composited back over its existing rectangle. Frame coordinates in the merged JSON never
//   change; only pixels and non-standard per-frame metadata (`contentTop`, `nw`, …) are refreshed.
//   Minimal JSON diff, so this stays the path for same-size repacks.
//
//   REFLOW (any frame changed size) — the whole page is repacked at FRAME granularity: every frame
//   is re-extracted (from the source atlas if the source has it, otherwise from the merged page
//   itself) and shelf-packed into a fresh canvas. This needs nothing but the merged page and the one
//   source atlas, which is why it exists: mergeAssetAtlases.js can no longer re-merge (its other
//   inputs were deleted in 072131d8), and a size change is exactly what in-place cannot absorb.
//   Reflow rewrites every frame.x/y in the JSON — a large diff by nature, not a mistake. It also
//   packs tighter than the original block merge, which blitted each source atlas in whole with all
//   its internal slack (world_atlas was 32.9% used at 2048x4550, over the 4096 texture limit some
//   GPUs enforce).
//
// Run: node art/scripts/patchMergedAtlas.js <source-atlas.json> <merged-atlas.json>
// e.g. node art/scripts/patchMergedAtlas.js client/src/assets/slg/res_atlas.json client/src/assets/slg/world_atlas.json
const fs = require('fs');
const path = require('path');
const { shelfPack } = require('./mergeAtlasPages');
let sharp;
try { sharp = require('sharp'); }
catch { sharp = require(path.resolve(__dirname, '../../client/node_modules/sharp')); }

const PAD = 2;          // transparent gutter between frames when reflowing (matches pack_resources.cjs)
const MAX_WIDTH = 2048; // reflow canvas width cap (matches the `world` group in mergeAssetAtlases.js)

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

  const resized = Object.entries(src.json.frames)
    .filter(([name, sf]) => dst.json.frames[name]
      && (sf.frame.w !== dst.json.frames[name].frame.w || sf.frame.h !== dst.json.frames[name].frame.h));
  if (resized.length) {
    console.log(`${resized.length} frame(s) changed size (e.g. ${resized[0][0]}: `
      + `${dst.json.frames[resized[0][0]].frame.w}×${dst.json.frames[resized[0][0]].frame.h} → `
      + `${resized[0][1].frame.w}×${resized[0][1].frame.h}) → reflowing the whole page.`);
    return reflow(src, dst);
  }

  const patched = [];
  const missing = [];
  for (const [name, sf] of Object.entries(src.json.frames)) {
    const df = dst.json.frames[name];
    if (!df) { missing.push(name); continue; }
    // Carry over non-standard per-frame metadata the packers emit (nw, contentTop, …) — the client
    // reads these straight off the merged JSON.
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

  // Raw row copies, NOT sharp's `composite` — same reason reflow() below does it by hand. `composite`
  // blends, so it premultiplies alpha and rounds back, drifting every anti-aliased edge pixel by 1-2;
  // it would also let the old art show through wherever the new cell is transparent. A frame lands in
  // a rectangle of its own, nothing overlaps, so blending has nothing to contribute. Copying bytes
  // instead keeps each patched frame bit-identical to its source and leaves every OTHER frame on the
  // page untouched, which is what makes "did this patch disturb art it had no business touching?" a
  // question with a checkable answer.
  const { data, info } = await sharp(dst.pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const srcRaw = await sharp(src.pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (const name of patched) {
    const sf = src.json.frames[name].frame;
    const df = dst.json.frames[name].frame;
    for (let row = 0; row < df.h; row++) {
      const from = ((sf.y + row) * srcRaw.info.width + sf.x) * 4;
      const to = ((df.y + row) * info.width + df.x) * 4;
      srcRaw.data.copy(data, to, from, from + df.w * 4);
    }
  }
  // `compressionLevel` ONLY — see the note in reflow(): in sharp 0.32 any of
  // `palette`/`quality`/`colours`/`dither`/`effort` silently quantises the page to an 8-bit palette,
  // which cannot hold this merge's 392 distinct RGBA values and drifts alpha by up to 12-38. This path
  // carried exactly that bug until 2026-08-20 while reflow() was already lossless, so which encoding
  // the page got depended on whether any frame had changed size — a coin flip nobody would notice.
  const out = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();

  fs.writeFileSync(dst.pngPath, out);
  fs.writeFileSync(dst.jsonPath, JSON.stringify(dst.json, null, 2));
  console.log(`✓ patched ${patched.length} frame(s) into ${path.relative(process.cwd(), dst.pngPath)}: ${patched.join(', ')}`);
  if (missing.length) console.warn(`  (not present in the merged page, skipped: ${missing.join(', ')})`);
  console.log(`  ${(out.length / 1024).toFixed(1)} KB`);
}

/**
 * Repack the whole merged page at frame granularity: frames the source atlas carries come from the
 * source PNG (new pixels, new size, refreshed metadata), the rest are re-extracted from the merged
 * page unchanged, and everything is shelf-packed into a fresh canvas.
 *
 * Extraction is safe frame-by-frame because every frame in these pages is `rotated:false` /
 * `trimmed:false` with a (0,0) spriteSourceSize origin — the same precondition mergeAtlasPages.js
 * verified before blitting whole source atlases (which is the only reason IT could work in blocks).
 */
async function reflow(src, dst) {
  const added = [];
  const entries = [];
  for (const [name, df] of Object.entries(dst.json.frames)) {
    const sf = src.json.frames[name];
    entries.push(sf
      ? { name, png: src.pngPath, rect: sf.frame, meta: sf }
      : { name, png: dst.pngPath, rect: df.frame, meta: df });
  }
  // A frame the source grew but the merged page never had: without this it would silently stay
  // missing from the page the client actually loads, and only surface as a blank tile in game.
  for (const [name, sf] of Object.entries(src.json.frames)) {
    if (dst.json.frames[name]) continue;
    entries.push({ name, png: src.pngPath, rect: sf.frame, meta: sf });
    added.push(name);
  }

  // Pad each block on its right/bottom edge so no two frames touch; bilinear sampling at fractional
  // atlas scales otherwise bleeds a neighbour's ink into a sprite's border.
  const { placements, canvasW, canvasH } = shelfPack(
    entries.map(e => ({ w: e.rect.w + PAD, h: e.rect.h + PAD })), MAX_WIDTH);

  // Raw row blits, not sharp's `composite`: `composite` premultiplies to blend, and rounding back out
  // shifts every anti-aliased (semi-transparent) edge pixel by a unit or two. Nothing here needs
  // blending — the cells land on disjoint rectangles of an empty canvas — so a straight memcpy keeps
  // carried-over frames bit-identical to the page they came from, which is what makes "did this
  // repack touch art it had no business touching?" a checkable question.
  const pages = new Map();
  for (const pngPath of new Set(entries.map(e => e.png))) {
    const { data, info } = await sharp(pngPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    pages.set(pngPath, { data, w: info.width });
  }
  const canvas = Buffer.alloc(canvasW * canvasH * 4);
  const frames = {};
  let usedArea = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const { x, y } = placements[i];
    const page = pages.get(e.png);
    for (let row = 0; row < e.rect.h; row++) {
      const from = ((e.rect.y + row) * page.w + e.rect.x) * 4;
      page.data.copy(canvas, ((y + row) * canvasW + x) * 4, from, from + e.rect.w * 4);
    }
    usedArea += e.rect.w * e.rect.h;
    frames[e.name] = { ...e.meta, frame: { ...e.rect, x, y } };
  }

  // `compressionLevel` ONLY — no `palette`/`quality`/`colours`/`dither`/`effort`. In sharp 0.32 ANY
  // of those silently switches pngsave into 8-bit quantisation (that is how this page came to be
  // palette-8), and 256 entries do not cover a merge of six sub-atlases: the page holds 392 distinct
  // RGBA values, so quantising moves 28-54% of the visible pixels, up to 43/255 on a channel and
  // 12-38 on ALPHA — visible as crunch on the anti-aliased pen edges, on frames this repack has no
  // business touching. Lossless costs 1747 KB vs 1092 KB, paid once per client to a CDN-hosted,
  // locally-cached, lazily-loaded scene atlas (ASSET_PACKAGING.md §4: assets never enter the WeChat
  // main package). Bit-exactness is what makes "did the repack disturb anything?" answerable at all.
  const out = await sharp(canvas, { raw: { width: canvasW, height: canvasH, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  fs.writeFileSync(dst.pngPath, out);
  fs.writeFileSync(dst.jsonPath, JSON.stringify({
    ...dst.json,
    frames,
    meta: { ...dst.json.meta, size: { w: canvasW, h: canvasH } },
  }, null, 2));

  const util = ((usedArea / (canvasW * canvasH)) * 100).toFixed(1);
  console.log(`✓ reflowed ${entries.length} frame(s) into ${path.relative(process.cwd(), dst.pngPath)}: `
    + `${canvasW}×${canvasH} (${util}% used, ${(out.length / 1024).toFixed(1)} KB)`);
  const fromSrc = entries.filter(e => e.png === src.pngPath).length;
  console.log(`  ${fromSrc} from ${path.basename(src.jsonPath)}, `
    + `${entries.length - fromSrc} carried over from the old page`);
  if (added.length) console.log(`  new frame(s) added to the page: ${added.join(', ')}`);
}

main().catch(err => { console.error(err); process.exit(1); });
