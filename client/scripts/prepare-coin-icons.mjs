/**
 * Shop recharge-tier coin icon asset pipeline (AI art → game atlas)
 *
 * Usage: node client/scripts/prepare-coin-icons.mjs
 *
 * What it does, per source PNG under art/ui/coins/:
 *   1. Flood-fills the vignette background to transparent (BFS from the border,
 *      tolerant of the smooth gradient but stopped by the icon's ink outlines).
 *   2. Feathers the cut edge with a small blur on the alpha mask (soft edge,
 *      accepted tradeoff for the money-sack icon whose fill is close in color
 *      to its background — see chat 2026-07-05).
 *   3. Trims to the opaque content's bounding box and fits it into a 128×128
 *      cell (contain, small padding, transparent).
 *   4. Packs the 5 cells into one 3×2 grid atlas PNG (manual raw-buffer
 *      compositing — avoids sharp palette/format quirks with translucent
 *      edges) + writes a PixiJS Spritesheet JSON (same format as
 *      assets/equipment/equipment.json).
 *
 * Every intermediate step round-trips through a plain RGBA Buffer instead of
 * chaining sharp pipelines — chaining .extract()/.resize()/.extend() off a
 * pipeline that was built from a raw buffer produced corrupted/blank frames
 * in earlier iterations of this script; isolating each step in its own
 * `sharp(buffer, {raw}).op().raw().toBuffer()` round trip fixed it.
 *
 * Dependency: sharp (already present) under client/node_modules
 */
import sharp from '../node_modules/sharp/lib/index.js';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SRC = resolve(ROOT, 'art/ui/coins');
const DEST = resolve(ROOT, 'client/src/assets/shop');

const CELL = 128;
const PAD = 10; // px of transparent margin inside each 128×128 cell
const COLS = 3;
const ROWS = 2;
const CHANNELS = 4; // RGBA throughout

// Source file → tier frame name (matches IconKind in render/icons.ts).
const TASKS = [
  { src: '71246096-3b07-4a68-9c1d-5d8fab9c3c05.png', frame: 'coin' },
  { src: 'c99f92c7-c4da-4009-87bf-5bc30c24e6a6.png', frame: 'coins' },
  { src: '1887d0fb-0b13-46c6-8fbc-93546ea04129.png', frame: 'coinStack' },
  { src: 'bf28cdb6-6ffd-4088-adc9-3cd91ec90d52.png', frame: 'coinSack' },
  { src: '481464ad-1f65-4e52-abd1-94d8b7afd932.png', frame: 'coinChest' },
];

/**
 * BFS flood-fill from every border pixel, tolerant of small step-to-step color
 * change (handles the smooth vignette gradient) but stopped by the icon's hard
 * ink outlines (large jump). Returns a Uint8Array mask, 1 = background.
 */
function floodFillBackground(data, w, h, stepTolerance = 20) {
  const mask = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qHead = 0, qTail = 0;

  const idx = (x, y) => y * w + x;
  const push = (x, y) => {
    const i = idx(x, y);
    if (visited[i]) return;
    visited[i] = 1;
    queue[qTail++] = i;
  };

  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }

  const colorAt = (i) => {
    const o = i * CHANNELS;
    return [data[o], data[o + 1], data[o + 2]];
  };
  const dist2 = (a, b) => {
    const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
    return dr * dr + dg * dg + db * db;
  };
  const tol2 = stepTolerance * stepTolerance;

  while (qHead < qTail) {
    const i = queue[qHead++];
    mask[i] = 1;
    const x = i % w, y = (i / w) | 0;
    const c0 = colorAt(i);
    const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = idx(nx, ny);
      if (visited[ni]) continue;
      const c1 = colorAt(ni);
      if (dist2(c0, c1) <= tol2) push(nx, ny);
    }
  }
  return mask;
}

/** Bounding box of mask==0 (foreground) pixels, or null if none. */
function bboxOfForeground(mask, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * Simple single-pass box blur (radius px) over a single-channel `w×h` buffer.
 * (sharp's `.blur()` on a raw single-channel buffer silently upconverts the
 * output to 3 channels — see script header note — so this is done by hand.)
 */
function boxBlur1(src, w, h, radius) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          sum += src[ny * w + nx];
          count++;
        }
      }
      out[y * w + x] = Math.round(sum / count);
    }
  }
  return out;
}

/** Copy a `w×h` RGBA raw buffer into a fresh `[0,0,0,0]`-filled canvas at (dx, dy). */
function blit(dstBuf, dstW, srcBuf, srcW, srcH, dx, dy) {
  for (let y = 0; y < srcH; y++) {
    const srcRow = (y * srcW) * CHANNELS;
    const dstRow = ((dy + y) * dstW + dx) * CHANNELS;
    srcBuf.copy(dstBuf, dstRow, srcRow, srcRow + srcW * CHANNELS);
  }
}

/** Matte one source PNG to a transparent-background RGBA buffer + its content bbox. */
async function matte(srcPath) {
  const { data, info } = await sharp(srcPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;

  const bgMask = floodFillBackground(data, w, h);

  const alpha = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = bgMask[i] ? 0 : data[i * CHANNELS + 3];

  // Feather the cut edge: blur just the alpha channel a touch so the boundary
  // isn't pixel-hard (soft edge — accepted tradeoff, see script header).
  const blurredAlpha = boxBlur1(alpha, w, h, 1);
  for (let i = 0; i < w * h; i++) data[i * CHANNELS + 3] = blurredAlpha[i];

  const bbox = bboxOfForeground(bgMask, w, h);
  if (!bbox) throw new Error(`matte produced an empty foreground for ${srcPath}`);

  return { data, w, h, bbox };
}

/** Extract `bbox` from a full-image RGBA buffer as its own tight raw buffer. */
async function extractBbox({ data, w, h, bbox }) {
  const { data: cropped } = await sharp(data, { raw: { width: w, height: h, channels: CHANNELS } })
    .extract(bbox)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return cropped;
}

/** Fit a tight RGBA buffer into a `CELL×CELL` transparent cell (contain + padding). */
async function fitToCell(croppedBuf, cw, ch) {
  const inner = CELL - PAD * 2;
  const { data: resized, info } = await sharp(croppedBuf, { raw: { width: cw, height: ch, channels: CHANNELS } })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const cell = Buffer.alloc(CELL * CELL * CHANNELS, 0);
  const offX = Math.round((CELL - info.width) / 2);
  const offY = Math.round((CELL - info.height) / 2);
  blit(cell, CELL, resized, info.width, info.height, offX, offY);
  return cell;
}

async function buildCell(task) {
  const srcPath = resolve(SRC, task.src);
  if (!existsSync(srcPath)) throw new Error(`Source file missing: ${task.src}`);

  const matted = await matte(srcPath);
  const cropped = await extractBbox(matted);
  return fitToCell(cropped, matted.bbox.width, matted.bbox.height);
}

async function main() {
  mkdirSync(DEST, { recursive: true });
  console.log(`\nCoin icon atlas build\n  Source: ${SRC}\n  Output: ${DEST}\n`);

  const cells = [];
  for (const task of TASKS) {
    console.log(`  processing ${task.src} -> ${task.frame} ...`);
    cells.push({ frame: task.frame, buf: await buildCell(task) });
  }

  const atlasW = COLS * CELL;
  const atlasH = ROWS * CELL;
  const atlasBuf = Buffer.alloc(atlasW * atlasH * CHANNELS, 0);
  cells.forEach((c, i) => {
    const x = (i % COLS) * CELL;
    const y = Math.floor(i / COLS) * CELL;
    blit(atlasBuf, atlasW, c.buf, CELL, CELL, x, y);
  });

  const atlasPath = resolve(DEST, 'coins.png');
  await sharp(atlasBuf, { raw: { width: atlasW, height: atlasH, channels: CHANNELS } })
    .png({ compressionLevel: 9 })
    .toFile(atlasPath);

  const frames = {};
  cells.forEach((c, i) => {
    const x = (i % COLS) * CELL;
    const y = Math.floor(i / COLS) * CELL;
    frames[c.frame] = {
      frame: { x, y, w: CELL, h: CELL },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: CELL, h: CELL },
      sourceSize: { w: CELL, h: CELL },
    };
  });
  const atlasJson = {
    frames,
    meta: { image: 'coins.png', format: 'RGBA8888', size: { w: atlasW, h: atlasH }, scale: '1' },
  };
  writeFileSync(resolve(DEST, 'coins.json'), JSON.stringify(atlasJson, null, 2));

  const meta = await sharp(atlasPath).metadata();
  console.log(`\n  ✓ coins.png  ${meta.width}×${meta.height}  (${cells.length} frames)`);
  console.log(`  ✓ coins.json`);
  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
