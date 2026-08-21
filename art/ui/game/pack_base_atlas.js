#!/usr/bin/env node
// pack_base_atlas.js — process the 2 battle-base upgrade-tier images into a PixiJS
// spritesheet atlas. Base tier 0 (no upgrade) keeps using the existing
// `client/src/assets/game_base.png` import — unchanged, still L0-preloaded.
// This atlas only covers the 2 upgrade tiers (lv1 "castle-town", lv2 "palace"),
// lazy-loaded like `art/slg/slg-building/pack_city_atlas.js`'s city atlas.
// Run: NODE_PATH="$(pwd)/client/node_modules" node art/ui/game/pack_base_atlas.js
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC_DIR = __dirname;
// assets/buildings/, NOT assets/ — the battle-building art moved into that subdirectory and
// baseUpgradeAtlasLoader.ts imports it from there, but this path was left behind. Running the
// script with the old OUT_DIR wrote two files nobody loads (found 2026-08-19 while renaming the
// sources below; the regenerated PNG is byte-identical to the committed one, so this was purely
// a stale-path bug, not a content drift).
const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets/buildings');

const CELL = 256;
const ATLAS_W = 512;
const ATLAS_H = 256;

// Faint alpha noise/grain left over from AI generation (reads as a "paper texture"
// background instead of true transparency) — zeroed out before cropping.
const NOISE_ALPHA_THRESHOLD = 40;

// Downsampling a 1024-1920px AI source down to the CELL (256px) atlas cell blends every
// edge over several output pixels, and the AI source's own edges are already soft
// (feathered/glow-like, not the crisp near-binary alpha of the hand-inked game_base.png
// tier-0 art) — together this leaves a wide gradient band instead of a thin AA fringe,
// which reads in-game as "this castle looks translucent/washed out" (2026-07-25 user report,
// levels 2/3 only — tier 0 doesn't go through this resize path). Harden the alpha channel
// post-resize: snap outside [LOW,HIGH] to 0/255 and linearly remap the narrow band between,
// so the silhouette is crisp with only a couple pixels of true edge AA, matching tier 0.
const ALPHA_HARD_LOW = 90;
const ALPHA_HARD_HIGH = 170;

function hardenAlpha(raw) {
  for (let i = 3; i < raw.length; i += 4) {
    const a = raw[i];
    if (a <= ALPHA_HARD_LOW) raw[i] = 0;
    else if (a >= ALPHA_HARD_HIGH) raw[i] = 255;
    else raw[i] = Math.round(((a - ALPHA_HARD_LOW) / (ALPHA_HARD_HIGH - ALPHA_HARD_LOW)) * 255);
  }
}

// lv1 = castle-town (walled settlement), lv2 = palace (grandest tier)
const FILES = [
  { file: 'base_lv1_castle_town_src.webp', name: 'base_lv1' },
  { file: 'base_lv2_palace_src.webp', name: 'base_lv2' },
];

/** Zero out faint alpha noise, then crop to the bounding box of remaining content. */
async function cleanAndCropBbox(srcPath) {
  const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const channels = 4;

  for (let i = 3; i < data.length; i += channels) {
    if (data[i] < NOISE_ALPHA_THRESHOLD) data[i] = 0;
  }

  let minX = width, maxX = 0, minY = height, maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * channels + 3];
      if (a > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const cleaned = sharp(data, { raw: { width, height, channels: 4 } });
  if (minX >= maxX || minY >= maxY) {
    return { image: cleaned, bbox: { left: 0, top: 0, width, height } };
  }
  const pad = Math.round(Math.max(width, height) * 0.02);
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(width, maxX + pad + 1);
  const bottom = Math.min(height, maxY + pad + 1);
  return { image: cleaned, bbox: { left, top, width: right - left, height: bottom - top } };
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const composites = [];
  const frames = {};

  for (let i = 0; i < FILES.length; i++) {
    const { file, name } = FILES[i];
    const dx = i * CELL;
    const dy = 0;

    const srcPath = path.join(SRC_DIR, file);
    const { image, bbox } = await cleanAndCropBbox(srcPath);
    console.log(`${name} (${file.slice(0, 8)}…): crop ${JSON.stringify(bbox)} → (${dx},${dy})`);

    const resizedRaw = await image
      .extract(bbox)
      .resize(CELL, CELL, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
      .raw()
      .toBuffer();
    hardenAlpha(resizedRaw);
    const cellBuf = await sharp(resizedRaw, { raw: { width: CELL, height: CELL, channels: 4 } })
      .png()
      .toBuffer();

    composites.push({ input: cellBuf, left: dx, top: dy });

    frames[name] = {
      frame: { x: dx, y: dy, w: CELL, h: CELL },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: CELL, h: CELL },
      sourceSize: { w: CELL, h: CELL },
    };
  }

  const outPng = path.join(OUT_DIR, 'base_upgrade_atlas.png');
  await sharp({
    create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    // Quantized palette PNG (client/src/assets publish-bytes convention — see
    // art/scripts/exportUnitCardArt.mjs and claudedocs/file-formats.md).
    .png({ palette: true, quality: 90, compressionLevel: 9, effort: 10 })
    .toFile(outPng);
  console.log(`✓ atlas PNG → ${outPng}`);

  const atlasJson = {
    frames,
    meta: {
      image: 'base_upgrade_atlas.png',
      format: 'RGBA8888',
      size: { w: ATLAS_W, h: ATLAS_H },
      scale: '1',
    },
  };
  const outJson = path.join(OUT_DIR, 'base_upgrade_atlas.json');
  fs.writeFileSync(outJson, JSON.stringify(atlasJson, null, 2));
  console.log(`✓ atlas JSON → ${outJson}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
