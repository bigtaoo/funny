#!/usr/bin/env node
/**
 * Crafting-material icon atlas builder
 *
 * Source:  art/ui/material/  (this directory)
 * Output:  client/src/assets/material/material.png   (384×128 atlas, 3 × 128²)
 *          client/src/assets/material/material.json  (PixiJS frame manifest)
 *
 * Usage:   node build-atlas.js
 * Deps:    sharp  (reused from client/ or project root; auto-installed if missing)
 *
 * Frame names match the EquipmentScene short material ids (scrap / lead / binding),
 * which is also what GachaScene.MATERIAL_ICON maps mat_* itemIds onto.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { execSync } = require('child_process');

// Source filename → frame id, left-to-right atlas order
const ENTRIES = [
  ['scrap.png',   'scrap'],
  ['lead.webp',   'lead'],
  ['binding.webp', 'binding'],
];

// Atlas layout: N cols × 1 row, each cell 128×128
const CELL    = 128;
const COLS    = ENTRIES.length;
const ROWS    = 1;
const ATLAS_W = COLS * CELL;
const ATLAS_H = ROWS * CELL;

const SRC_DIR    = __dirname;
const ROOT_DIR   = path.resolve(__dirname, '../../..');
const OUT_DIR    = path.join(ROOT_DIR, 'client', 'src', 'assets', 'material');
const ATLAS_PNG  = path.join(OUT_DIR, 'material.png');
const ATLAS_JSON = path.join(OUT_DIR, 'material.json');

function requireSharp() {
  const candidates = [
    path.join(ROOT_DIR, 'client', 'node_modules', 'sharp', 'dist', 'index.cjs'),
    path.join(ROOT_DIR, 'node_modules', 'sharp', 'dist', 'index.cjs'),
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
    const [filename, id] = ENTRIES[i];
    const srcPath = path.join(SRC_DIR, filename);

    if (!fs.existsSync(srcPath)) {
      console.warn(`  [MISSING] ${id}  ← ${filename}`);
      missing++;
      continue;
    }

    const col = i % COLS;
    const row = Math.floor(i / COLS);

    // trim() removes surrounding transparent margin so every icon fills its cell
    // consistently regardless of how much whitespace the source render left.
    const buf = await sharp(srcPath)
      .trim()
      .resize(CELL, CELL, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    composites.push({ input: buf, left: col * CELL, top: row * CELL });
    console.log(`  [${i + 1}/${ENTRIES.length}] ${id.padEnd(10)} ← ${filename.slice(0, 40)}`);
  }

  if (missing > 0) {
    console.error(`\n${missing} source file(s) missing — aborting.`);
    process.exit(1);
  }

  await sharp({
    create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(ATLAS_PNG);

  const frames = {};
  for (let i = 0; i < ENTRIES.length; i++) {
    const [, id] = ENTRIES[i];
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    frames[id] = {
      frame: { x: col * CELL, y: row * CELL, w: CELL, h: CELL },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: CELL, h: CELL },
      sourceSize: { w: CELL, h: CELL },
    };
  }

  fs.writeFileSync(ATLAS_JSON, JSON.stringify({
    frames,
    meta: { image: 'material.png', format: 'RGBA8888', size: { w: ATLAS_W, h: ATLAS_H }, scale: '1' },
  }, null, 2));

  const kb = (fs.statSync(ATLAS_PNG).size / 1024).toFixed(1);
  console.log(`\nDone.`);
  console.log(`  Atlas  ${ATLAS_W}×${ATLAS_H}  ${kb} KB  →  ${ATLAS_PNG}`);
  console.log(`  JSON                          →  ${ATLAS_JSON}`);
}

main().catch(err => { console.error(err); process.exit(1); });
