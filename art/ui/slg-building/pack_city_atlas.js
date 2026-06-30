#!/usr/bin/env node
// pack_city_atlas.js — process 4 SLG city images into a PixiJS spritesheet atlas.
// Run: node art/ui/slg-building/pack_city_atlas.js
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const SRC_DIR = __dirname;
const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets/slg');

const CELL = 256;
const ATLAS_W = 512;
const ATLAS_H = 512;

// lv1=camp, lv2=wooden fort, lv3=stone castle, lv4=grand castle
const FILES = [
  { file: 'cff60e26-e8a7-4579-b462-fb975dd08ae3.png', name: 'city_lv1' },
  { file: '694878ba-a838-491c-8745-b2fcea0f36b2.png', name: 'city_lv2' },
  { file: 'b4347658-1cab-4ce1-b3fd-15390bdfe943.png', name: 'city_lv3' },
  { file: '0fe2fbb5-2799-4b4d-a3e0-d5e595764977.png', name: 'city_lv4' },
];

async function getContentBbox(srcPath) {
  const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const channels = 4; // ensureAlpha

  // Sample 4 corners (20x20 px each) to detect background type
  const sampleCornerLuma = (sx, sy) => {
    const sz = Math.min(20, Math.floor(width * 0.02));
    let sum = 0;
    const n = sz * sz;
    for (let y = sy; y < sy + sz; y++) {
      for (let x = sx; x < sx + sz; x++) {
        const i = (y * width + x) * channels;
        sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
    }
    return sum / n;
  };
  const sz20 = Math.min(20, Math.floor(width * 0.02));
  const avgCorner = (
    sampleCornerLuma(0, 0) +
    sampleCornerLuma(width - sz20, 0) +
    sampleCornerLuma(0, height - sz20) +
    sampleCornerLuma(width - sz20, height - sz20)
  ) / 4;

  if (avgCorner > 210) {
    // White background: crop to non-white content
    let minX = width, maxX = 0, minY = height, maxY = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * channels;
        const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        const alpha = data[i + 3];
        if (luma < 228 && alpha > 20) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (minX < maxX && minY < maxY) {
      const pad = Math.round(width * 0.025);
      const left = Math.max(0, minX - pad);
      const top = Math.max(0, minY - pad);
      const right = Math.min(width, maxX + pad + 1);
      const bottom = Math.min(height, maxY + pad + 1);
      return { left, top, width: right - left, height: bottom - top };
    }
  }

  // Dark vignette background (grand castle): use full image
  return { left: 0, top: 0, width, height };
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const composites = [];
  const frames = {};

  for (let i = 0; i < FILES.length; i++) {
    const { file, name } = FILES[i];
    const col = i % 2;
    const row = Math.floor(i / 2);
    const dx = col * CELL;
    const dy = row * CELL;

    const srcPath = path.join(SRC_DIR, file);
    const bbox = await getContentBbox(srcPath);
    console.log(`${name} (${file.slice(0, 8)}…): crop ${JSON.stringify(bbox)} → (${dx},${dy})`);

    const cellBuf = await sharp(srcPath)
      .extract(bbox)
      .resize(CELL, CELL, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha()
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

  const outPng = path.join(OUT_DIR, 'city_atlas.png');
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
      image: 'city_atlas.png',
      format: 'RGBA8888',
      size: { w: ATLAS_W, h: ATLAS_H },
      scale: '1',
    },
  };
  const outJson = path.join(OUT_DIR, 'city_atlas.json');
  fs.writeFileSync(outJson, JSON.stringify(atlasJson, null, 2));
  console.log(`✓ atlas JSON → ${outJson}`);
}

main().catch(err => { console.error(err); process.exit(1); });
