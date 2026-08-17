// Measure the head box of every avatar bust portrait and print the table that
// client/src/render/portraitHeadBox.ts holds.
//
// Why a table at all: the 32 bust portraits are drawn to one composition brief but the actual head
// geometry varies a lot (hair top 0.03-0.13 of the image height, chin/neck 0.51-0.69, head width
// 0.58-0.94 of the image width). A single global crop constant therefore has to leave enough
// headroom for the loosest portrait, which makes every other one look small — the "头像偏小" the
// avatar picker showed. buildPortraitIcon normalises each portrait against its own head box
// instead, so all 32 frame identically.
//
// Run (needs the client's sharp):  cd client && node ../art/scripts/measureAvatarHeadBox.mjs
// Re-run and paste the output whenever a portrait is added or repainted.
import sharp from 'sharp';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/src/assets/avatars');
const PRESETS = ['gogetter', 'sunny', 'hype', 'fanboy', 'chuuni', 'observer', 'emo', 'dreamer', 'shy', 'lazy',
  'aloof', 'hothead', 'perfectionist', 'snark', 'sly', 'tsundere', 'peacemaker', 'nerdcrush', 'softie', 'curious'];
const HEROES = ['infantry', 'archer', 'shieldbearer', 'max', 'lena', 'mara'];
const SKINS = ['skin_shop_c1', 'skin_shop_r1', 'skin_shop_e1', 'skin_e1', 'skin_e2', 'skin_l1'];

/** Ink = meaningfully darker or more saturated than the portrait's paper background. */
function isInk(r, g, b, a) {
  if (a < 40) return false;
  return Math.min(r, g, b) < 225 || Math.max(r, g, b) - Math.min(r, g, b) > 24;
}

/** { top, bottom, width } as fractions of the image, where bottom = the neck (narrowest row below the head). */
async function headBox(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;
  const span = [];
  for (let y = 0; y < H; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * C;
      if (isInk(data[i], data[i + 1], data[i + 2], data[i + 3])) { if (lo < 0) lo = x; hi = x; }
    }
    span.push(lo < 0 ? 0 : hi - lo + 1);
  }
  const top = span.findIndex((s) => s > W * 0.04); // hair top
  let widestY = top, widest = 0;
  for (let y = top; y < H * 0.6; y++) if (span[y] > widest) { widest = span[y]; widestY = y; }
  // Neck = the narrowest row between the head's widest row and the shoulders flaring out.
  let neckY = widestY, neckW = Infinity;
  for (let y = widestY; y < H * 0.85; y++) {
    if (span[y] < neckW) { neckW = span[y]; neckY = y; }
    if (span[y] > neckW * 1.6) break;
  }
  return { top: top / H, bottom: neckY / H, width: widest / W };
}

const f = (v) => Number(v.toFixed(4));
const lines = [];
for (const [group, keys, dir, prefix] of [['PRESET', PRESETS, 'preset', 'preset_'], ['HERO', HEROES, 'hero', 'hero_'], ['SKIN', SKINS, 'skin', 'avatar_']]) {
  lines.push(`${group}:`);
  for (const key of keys) {
    const b = await headBox(path.join(ROOT, dir, `${prefix}${key}.png`));
    lines.push(`  ${key}: { top: ${f(b.top)}, bottom: ${f(b.bottom)}, width: ${f(b.width)} },`);
  }
}
console.log(lines.join('\n'));
