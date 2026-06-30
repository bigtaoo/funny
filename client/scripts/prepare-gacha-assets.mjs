/**
 * Gacha art asset normalization script
 *
 * Usage: node client/scripts/prepare-gacha-assets.mjs
 *
 * What it does:
 *   - Resizes and converts raw images (PNG/WebP) under art/ui/gacha/ to the target specs, outputting PNG
 *   - Writes output to client/src/assets/gacha/
 *
 * Dependency: sharp (already present) under client/node_modules
 */

import sharp from '../node_modules/sharp/lib/index.js';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SRC  = resolve(ROOT, 'art/ui/gacha');
const DEST = resolve(ROOT, 'client/src/assets/gacha');

mkdirSync(DEST, { recursive: true });

/**
 * Task map: source filename → { out, w, h, fit }
 *
 * fit:
 *   'cover'   — proportional scale to fill the target box; excess is center-cropped (used for card backgrounds)
 *   'contain' — proportional scale to fit inside the target box; surplus area filled white (used for frames, ensures corner decorations are not clipped)
 *   'fill'    — forced stretch (not used)
 */
const TASKS = [
  // ── Result card backgrounds (5:7 portrait, 400×560) ──────────────────────────────
  {
    src: 'gacha_card_common.png',
    out: 'gacha_card_common.png',
    w: 400, h: 560, fit: 'cover',
    note: 'Common · pencil ruled paper',
  },
  {
    src: 'gacha_card_rare.png',
    out: 'gacha_card_rare.png',
    w: 400, h: 560, fit: 'cover',
    note: 'Rare · blue ink splash',
  },
  {
    src: 'gacha_card_epic.png',
    out: 'gacha_card_epic.png',
    w: 400, h: 560, fit: 'cover',
    note: 'Epic · purple marker full bleed',
  },
  {
    src: 'gacha_card_legendary.png',
    out: 'gacha_card_legendary.png',
    w: 400, h: 560, fit: 'cover',
    note: 'Legendary · gold foil embossed paper',
  },

  // ── Rarity frames (square, 480×480, contain preserves corner decorations) ──────
  {
    src: 'frame_common.png',
    out: 'frame_common.png',
    w: 480, h: 480, fit: 'contain', bg: { r:255,g:255,b:255,alpha:0 },
    note: 'Common frame · crooked pencil border',
  },
  {
    src: 'frame_rare.webp',
    out: 'frame_rare.png',
    w: 480, h: 480, fit: 'contain', bg: { r:255,g:255,b:255,alpha:0 },
    note: 'Rare frame · blue pen scrollwork (slightly formal, needs regen)',
  },
  {
    src: 'frame_epic.webp',
    out: 'frame_epic.png',
    w: 480, h: 480, fit: 'contain', bg: { r:255,g:255,b:255,alpha:0 },
    note: 'Epic frame · purple marker thick border',
  },
  {
    src: 'frame_legendary.webp',
    out: 'frame_legendary.png',
    w: 480, h: 480, fit: 'contain', bg: { r:255,g:255,b:255,alpha:0 },
    note: 'Legendary frame · gold calligraphy scrollwork',
  },

  // ── Banners (900×340 landscape) ───────────────────────────────────────────────
  {
    src: 'banner_limited_01.webp',
    out: 'banner_limited_01.png',
    w: 900, h: 340, fit: 'cover',
    note: 'Limited pool banner · young commander + LIMITED stamp',
  },

  // ── Standard pool banner (900×340 landscape) ──────────────────────────────────
  {
    src: 'banner_standard.webp',
    out: 'banner_standard.png',
    w: 900, h: 340, fit: 'cover',
    note: 'Standard pool banner · open notebook + stationery flat lay',
  },

  // ── Monthly card (560×240 landscape) ─────────────────────────────────────────
  {
    src: 'monthly_card.webp',
    out: 'monthly_card.png',
    w: 560, h: 240, fit: 'cover',
    note: 'Monthly card · sticky note design (stamp is a gamepad, needs regen)',
  },
];

// ── Skip (duplicates / alternates) ───────────────────────────────────────────
const SKIP = [
  'gacha_card_rare_alt.png', // rare alternate, duplicate of gacha_card_rare.png
];

async function processOne(task) {
  const srcPath = resolve(SRC, task.src);
  const destPath = resolve(DEST, task.out);

  if (!existsSync(srcPath)) {
    console.error(`  ✗ Source file missing: ${task.src}`);
    return;
  }

  let pipeline = sharp(srcPath).resize(task.w, task.h, {
    fit: task.fit,
    position: 'centre',
    background: task.bg ?? { r: 255, g: 255, b: 255, alpha: 1 },
  });

  // frames use contain with transparent background
  if (task.fit === 'contain' && task.bg?.alpha === 0) {
    pipeline = pipeline.png({ compressionLevel: 9 });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9 });
  }

  await pipeline.toFile(destPath);

  const meta = await sharp(destPath).metadata();
  console.log(`  ✓ ${task.out.padEnd(30)} ${meta.width}×${meta.height}  [${task.note}]`);
}

console.log(`\nGacha asset normalization\n  Source: ${SRC}\n  Output: ${DEST}\n`);

for (const t of TASKS) {
  await processOne(t);
}

if (SKIP.length) {
  console.log(`\nSkipped (alternates/duplicates):`);
  for (const s of SKIP) console.log(`  - ${s}`);
}

console.log(`\n⚠️  Suggested for regeneration:`);
console.log(`  - frame_rare.png       Blue pen border is slightly Victorian in style, slightly off from the hand-drawn student notebook aesthetic`);
console.log(`  - monthly_card.png     Right stamp is a gamepad icon, should be changed to a moon/calendar stamp`);
console.log('\nDone.\n');
