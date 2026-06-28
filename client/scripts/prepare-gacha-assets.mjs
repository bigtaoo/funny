/**
 * 盲盒美术资源规范化脚本
 *
 * 用法：node client/scripts/prepare-gacha-assets.mjs
 *
 * 功能：
 *   - 将 art/ui/gacha/ 下的原始图（PNG/WebP）按目标规格 resize + 转 PNG
 *   - 输出到 client/src/assets/gacha/
 *
 * 依赖：client/node_modules 下的 sharp（已有）
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
 * 映射表：source filename → { out, w, h, fit }
 *
 * fit:
 *   'cover'   — 等比缩放填满目标框，超出部分居中裁剪（卡片背景用）
 *   'contain' — 等比缩放放入目标框，多余区域白色填充（边框用，保证不裁角装饰）
 *   'fill'    — 强制拉伸（不用）
 */
const TASKS = [
  // ── 结果卡背景（5:7 竖版，400×560）─────────────────────────────────
  {
    src: '77be3b2a-463b-49c9-afd9-42e3ab154d74.png',
    out: 'gacha_card_common.png',
    w: 400, h: 560, fit: 'cover',
    note: '普通 · 铅笔横线纸',
  },
  {
    src: 'df51c9f3-cd64-4363-8e67-b10848b1268e.png',
    out: 'gacha_card_rare.png',
    w: 400, h: 560, fit: 'cover',
    note: '稀有 · 蓝墨水泼洒',
  },
  {
    src: 'f0e04b6b-2b43-42f9-957c-c19f43a2a78c.png',
    out: 'gacha_card_epic.png',
    w: 400, h: 560, fit: 'cover',
    note: '史诗 · 紫马克笔全幅',
  },
  {
    src: '318c5a97-3209-4348-8b48-a4551161388c.png',
    out: 'gacha_card_legendary.png',
    w: 400, h: 560, fit: 'cover',
    note: '传说 · 烫金压花纸',
  },

  // ── 稀有度边框（正方形，480×480，contain 保留角装饰）───────────────
  {
    src: '897e5525-4f30-4b41-a9d3-3ddabc0c017c.png',
    out: 'frame_common.png',
    w: 480, h: 480, fit: 'contain', bg: { r:255,g:255,b:255,alpha:0 },
    note: '普通边框 · 铅笔歪框',
  },
  {
    src: 'DUWCc4yClGGDwo7gxEM233_1782637112786_na1fn_L2hvbWUvdWJ1bnR1L2ZvdW50YWluX3Blbl9mcmFtZQ.webp',
    out: 'frame_rare.png',
    w: 480, h: 480, fit: 'contain', bg: { r:255,g:255,b:255,alpha:0 },
    note: '稀有边框 · 蓝钢笔卷草（风格偏正式，待重生成）',
  },
  {
    src: 'JkIKdE5ibQIvZGNSpnhmYp_1782637180602_na1fn_L2hvbWUvdWJ1bnR1L3B1cnBsZV9tYXJrZXJfZnJhbWU.webp',
    out: 'frame_epic.png',
    w: 480, h: 480, fit: 'contain', bg: { r:255,g:255,b:255,alpha:0 },
    note: '史诗边框 · 紫马克笔粗框',
  },
  {
    src: 'DNIlmycw0xCdd3X2FIw7dD_1782637302003_na1fn_L2hvbWUvdWJ1bnR1L2dvbGRfY2FsbGlncmFwaHlfZnJhbWU.webp',
    out: 'frame_legendary.png',
    w: 480, h: 480, fit: 'contain', bg: { r:255,g:255,b:255,alpha:0 },
    note: '传说边框 · 金色书法卷草',
  },

  // ── Banner（900×340 横版）──────────────────────────────────────────
  {
    src: 'jyPqSRBEwL26UrLnONC1fY_1782637478736_na1fn_L2hvbWUvdWJ1bnR1L2dhY2hhX2Jhbm5lcl9pbGx1c3RyYXRpb24.webp',
    out: 'banner_limited_01.png',
    w: 900, h: 340, fit: 'cover',
    note: '限定池 Banner · 少年指挥官 + LIMITED 印章',
  },

  // ── 常驻池 Banner（900×340 横版）──────────────────────────────────
  {
    src: 'KT1nb2jF7RizX57ydrqVt4_1782637597867_na1fn_L2hvbWUvdWJ1bnR1L2dhY2hhX2Jhbm5lcl9ub3RlYm9va19kb29kbGU.webp',
    out: 'banner_standard.png',
    w: 900, h: 340, fit: 'cover',
    note: '常驻池 Banner · 摊开笔记本 + 文具 flat lay',
  },

  // ── 月卡（560×240 横版）───────────────────────────────────────────
  {
    src: 'yEgYxZsKRrn1YQPVnCz9WJ_1782637374947_na1fn_L2hvbWUvdWJ1bnR1L2dhbWVfc3Vic2NyaXB0aW9uX3RpY2tldA.webp',
    out: 'monthly_card.png',
    w: 560, h: 240, fit: 'cover',
    note: '月卡 · 便利贴造型（印章是游戏手柄，待重生成替换）',
  },
];

// ── 跳过（重复/备用）──────────────────────────────────────────────────
const SKIP = [
  '76d1b5c9-0a72-430f-8d60-92f8f0bc5aad.png', // rare 备用，与 df51c9f3 重复
];

async function processOne(task) {
  const srcPath = resolve(SRC, task.src);
  const destPath = resolve(DEST, task.out);

  if (!existsSync(srcPath)) {
    console.error(`  ✗ 源文件不存在: ${task.src}`);
    return;
  }

  let pipeline = sharp(srcPath).resize(task.w, task.h, {
    fit: task.fit,
    position: 'centre',
    background: task.bg ?? { r: 255, g: 255, b: 255, alpha: 1 },
  });

  // 边框用 contain，背景透明
  if (task.fit === 'contain' && task.bg?.alpha === 0) {
    pipeline = pipeline.png({ compressionLevel: 9 });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9 });
  }

  await pipeline.toFile(destPath);

  const meta = await sharp(destPath).metadata();
  console.log(`  ✓ ${task.out.padEnd(30)} ${meta.width}×${meta.height}  [${task.note}]`);
}

console.log(`\n盲盒资源规范化\n  源目录：${SRC}\n  输出：  ${DEST}\n`);

for (const t of TASKS) {
  await processOne(t);
}

if (SKIP.length) {
  console.log(`\n跳过（备用/重复）：`);
  for (const s of SKIP) console.log(`  - ${s}`);
}

console.log(`\n⚠️  建议重生成：`);
console.log(`  - frame_rare.png       蓝钢笔边框风格偏维多利亚，与游戏手绘学生本风格略偏`);
console.log(`  - monthly_card.png     右侧印章是游戏手柄图案，宜改为月亮/日历印章`);
console.log('\n完成。\n');
