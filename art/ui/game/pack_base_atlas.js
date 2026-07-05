#!/usr/bin/env node
// pack_base_atlas.js — process the 2 battle-base upgrade-tier images into a PixiJS
// spritesheet atlas. Base tier 0 (no upgrade) keeps using the existing
// `client/src/assets/game_base.png` import — unchanged, still L0-preloaded.
// This atlas only covers the 2 upgrade tiers (lv1 "castle-town", lv2 "palace"),
// lazy-loaded like `art/ui/slg-building/pack_city_atlas.js`'s city atlas.
// Run: NODE_PATH="$(pwd)/client/node_modules" node art/ui/game/pack_base_atlas.js
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC_DIR = __dirname;
const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets');

const CELL = 256;
const ATLAS_W = 512;
const ATLAS_H = 256;

// Faint alpha noise/grain left over from AI generation (reads as a "paper texture"
// background instead of true transparency) — zeroed out before cropping.
const NOISE_ALPHA_THRESHOLD = 40;

// lv1 = castle-town (walled settlement), lv2 = palace (grandest tier)
const FILES = [
  { file: 'rOhtChw7aebowR6NpxcLfX_1783267912263_na1fn_L2hvbWUvdWJ1bnR1L2Nhc3RsZV90b3duX2ljb25fZmluYWw.webp', name: 'base_lv1' },
  { file: 'wzBuhTmUHq8oAdhwbf5Pkf_1783268977194_na1fn_L2hvbWUvdWJ1bnR1L21lZGlldmFsX3BhbGFjZV9pY29u.webp', name: 'base_lv2' },
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

    const cellBuf = await image
      .extract(bbox)
      .resize(CELL, CELL, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
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
    .png({ compressionLevel: 9, effort: 10 })
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
