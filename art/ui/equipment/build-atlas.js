#!/usr/bin/env node
/**
 * Equipment icon atlas builder
 *
 * Source:  art/ui/equipment/  (this directory)
 * Output:  client/assets/equipment/equipment.png  (512×384 atlas)
 *          client/assets/equipment/equipment.json  (PixiJS frame manifest)
 *
 * Usage:   node build-atlas.js
 * Deps:    sharp  (auto-installed at project root if missing)
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

// Source filename → defId, top-left to bottom-right atlas order
const ENTRIES = [
  ['1eacb631-45ce-4526-8388-d97128d116bb.png',                                                                'wp_pencil'],
  ['da8de9b1-aff1-4545-bd90-7ad6e367a713.png',                                                                'wp_pen'],
  ['72a9acce-f01a-4834-8228-da184be21351.png',                                                                'wp_marker'],
  ['910e78b4-5564-4789-8d4c-3bb6879b64a7.png',                                                               'wp_highlighter'],
  ['7a9d7524-0eb6-4846-87eb-d82e412d6491.png',                                                               'ar_draft'],
  ['d11fce79-89b6-4a6c-933b-ee2528823cb7.png',                                                               'ar_cardstock'],
  ['bb0b8ff6-c66f-489e-a5e3-20aa00722286.png',                                                               'ar_leather'],
  ['03b5c233-d511-4d4e-816f-83349f774b4e.png',                                                               'ar_foil'],
  ['8707aecd-75e6-4cd6-bd17-6c6c2bedac4f.png',                                                               'tk_clip'],
  ['QpbX7kJHADRHu8D59pU1Nx_1782745628183_na1fn_L2hvbWUvdWJ1bnR1L2Jvb2ttYXJrX2ljb25fMjU2.webp',             'tk_bookmark'],
  ['42CFUkHMUsmzs3Koctxwrd_1782745757571_na1fn_L2hvbWUvdWJ1bnR1L3N0aWNrZXJfc2hlZXRfaWNvbl8yNTY.webp',      'tk_sticker'],
  ['LIEiW9jHcgWXYovU81qLDP_1782745966706_na1fn_L2hvbWUvdWJ1bnR1L3dheF9zZWFsX2ljb25fdjI.webp',              'tk_seal'],
];

// Atlas layout: 4 cols × 3 rows, each cell 128×128 → 512×384
const CELL    = 128;
const COLS    = 4;
const ROWS    = Math.ceil(ENTRIES.length / COLS);
const ATLAS_W = COLS * CELL;
const ATLAS_H = ROWS * CELL;

const SRC_DIR    = __dirname;
const ROOT_DIR   = path.resolve(__dirname, '../../..');
const OUT_DIR    = path.join(ROOT_DIR, 'client', 'assets', 'equipment');
const ATLAS_PNG  = path.join(OUT_DIR, 'equipment.png');
const ATLAS_JSON = path.join(OUT_DIR, 'equipment.json');

function requireSharp() {
  // sharp uses package exports — require its CJS entry directly
  const candidates = [
    path.join(ROOT_DIR, 'node_modules', 'sharp', 'dist', 'index.cjs'),
    path.join(__dirname, 'node_modules', 'sharp', 'dist', 'index.cjs'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  console.log('sharp not found — installing at project root...');
  execSync('npm install --no-save sharp', { cwd: ROOT_DIR, stdio: 'inherit' });
  return require(path.join(ROOT_DIR, 'node_modules', 'sharp', 'dist', 'index.cjs'));
}

async function main() {
  const sharp = requireSharp();

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const composites = [];
  let missing = 0;

  for (let i = 0; i < ENTRIES.length; i++) {
    const [filename, defId] = ENTRIES[i];
    const srcPath = path.join(SRC_DIR, filename);

    if (!fs.existsSync(srcPath)) {
      console.warn(`  [MISSING] ${defId}  ← ${filename}`);
      missing++;
      continue;
    }

    const col = i % COLS;
    const row = Math.floor(i / COLS);

    const buf = await sharp(srcPath)
      .resize(CELL, CELL, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();

    composites.push({ input: buf, left: col * CELL, top: row * CELL });
    console.log(`  [${String(i + 1).padStart(2)}/12] ${defId.padEnd(16)} ← ${filename.slice(0, 40)}`);
  }

  if (missing > 0) {
    console.error(`\n${missing} source file(s) missing — aborting.`);
    process.exit(1);
  }

  // Compose all icons onto a transparent canvas
  await sharp({
    create: {
      width: ATLAS_W,
      height: ATLAS_H,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(ATLAS_PNG);

  // PixiJS / TexturePacker JSON format
  const frames = {};
  for (let i = 0; i < ENTRIES.length; i++) {
    const [, defId] = ENTRIES[i];
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    frames[defId] = {
      frame: { x: col * CELL, y: row * CELL, w: CELL, h: CELL },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: CELL, h: CELL },
      sourceSize: { w: CELL, h: CELL },
    };
  }

  fs.writeFileSync(ATLAS_JSON, JSON.stringify({
    frames,
    meta: {
      image: 'equipment.png',
      format: 'RGBA8888',
      size: { w: ATLAS_W, h: ATLAS_H },
      scale: '1',
    },
  }, null, 2));

  const kb = (fs.statSync(ATLAS_PNG).size / 1024).toFixed(1);
  console.log(`\nDone.`);
  console.log(`  Atlas  ${ATLAS_W}×${ATLAS_H}  ${kb} KB  →  ${ATLAS_PNG}`);
  console.log(`  JSON                          →  ${ATLAS_JSON}`);
}

main().catch(err => { console.error(err); process.exit(1); });
