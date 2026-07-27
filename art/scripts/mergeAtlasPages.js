#!/usr/bin/env node
// mergeAtlasPages.js — combine several already-packed PixiJS spritesheet atlases
// (or loose standalone PNGs) into fewer atlas *pages*, without re-cropping or
// touching any individual sprite. Each input source is blitted as one whole
// rectangular block into a new shared canvas; every frame's `frame.x/y` is
// translated by that block's placement offset, everything else (w/h,
// spriteSourceSize, sourceSize, rotated/trimmed) is left untouched — safe
// because every source atlas here has rotated:false / trimmed:false / an
// (0,0) spriteSourceSize origin (verified before writing this script).
//
// Motivation: client/src/assets/bootManifest.ts's L0 gate and
// WorldMapRenderer's scene-entry Promise.all both load several small atlases
// at the same moment (ASSET_PACKAGING.md §2) — merging the ones that always
// load together turns N HTTP fetches + N PIXI.Spritesheet decodes into 1,
// without changing *when* anything loads.
//
// Run: NODE_PATH="$(pwd)/client/node_modules" node art/scripts/mergeAtlasPages.js
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

/**
 * Shelf/row bin-packer: sort blocks tallest-first, fill left-to-right up to
 * maxWidth, wrap to a new row (y += row height) when a block doesn't fit.
 * Deterministic and easy to eyeball in the logged layout — not space-optimal,
 * but these atlases are small and boot-latency, not VRAM, is the target.
 */
function shelfPack(blocks, maxWidth) {
  const order = blocks.map((b, i) => i).sort((a, b) => blocks[b].h - blocks[a].h);
  const placed = new Array(blocks.length);
  let x = 0, y = 0, rowH = 0, usedW = 0;
  for (const i of order) {
    const b = blocks[i];
    if (x > 0 && x + b.w > maxWidth) { y += rowH; x = 0; rowH = 0; }
    placed[i] = { x, y };
    x += b.w;
    rowH = Math.max(rowH, b.h);
    usedW = Math.max(usedW, x);
  }
  const canvasW = Math.min(maxWidth, usedW);
  const canvasH = y + rowH;
  return { placements: placed, canvasW, canvasH };
}

/** One group: merges `sources` into `outDir/outBase.png` + `.json`. */
async function mergeGroup({ name, outDir, outBase, maxWidth, sources }) {
  const loaded = await Promise.all(sources.map(async (src) => {
    const png = await sharp(src.png).metadata();
    if (src.json) {
      const data = JSON.parse(fs.readFileSync(src.json, 'utf8'));
      return { ...src, w: png.width, h: png.height, frames: data.frames };
    }
    // Loose standalone PNG: synthesize a single full-image frame.
    return {
      ...src,
      w: png.width,
      h: png.height,
      frames: {
        [src.frameName]: {
          frame: { x: 0, y: 0, w: png.width, h: png.height },
          rotated: false,
          trimmed: false,
          spriteSourceSize: { x: 0, y: 0, w: png.width, h: png.height },
          sourceSize: { w: png.width, h: png.height },
        },
      },
    };
  }));

  const { placements, canvasW, canvasH } = shelfPack(loaded, maxWidth);

  const mergedFrames = {};
  const composites = [];
  let usedArea = 0;
  loaded.forEach((src, i) => {
    const { x, y } = placements[i];
    composites.push({ input: src.png, left: x, top: y });
    usedArea += src.w * src.h;
    for (const [frameName, f] of Object.entries(src.frames)) {
      if (mergedFrames[frameName]) throw new Error(`${name}: duplicate frame name "${frameName}" (from ${src.png})`);
      mergedFrames[frameName] = {
        ...f,
        frame: { ...f.frame, x: f.frame.x + x, y: f.frame.y + y },
      };
    }
    console.log(`  ${path.basename(src.png)} (${src.w}x${src.h}) -> (${x},${y})`);
  });

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPng = path.join(outDir, `${outBase}.png`);
  const outJson = path.join(outDir, `${outBase}.json`);

  await sharp({ create: { width: canvasW, height: canvasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(outPng);

  const atlasJson = {
    frames: mergedFrames,
    meta: { app: 'mergeAtlasPages.js', image: `${outBase}.png`, format: 'RGBA8888', size: { w: canvasW, h: canvasH }, scale: '1' },
  };
  fs.writeFileSync(outJson, JSON.stringify(atlasJson, null, 2));

  const util = ((usedArea / (canvasW * canvasH)) * 100).toFixed(1);
  console.log(`✓ ${name}: ${canvasW}x${canvasH} (${util}% used, ${Object.keys(mergedFrames).length} frames) -> ${outPng}`);
}

module.exports = { mergeGroup, shelfPack };
