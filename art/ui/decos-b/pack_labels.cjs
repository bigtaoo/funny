/**
 * pack_labels.cjs — B 组「战场角落手写标注」源图处理 + 改色 + 导出透明 PNG。
 *
 * 与 A 组 pack_decos.cjs 同一抠白底口径，额外做「改色」：
 *   1. 读图 → 白底转透明：alpha = 255 - 亮度（保留抗锯齿灰边为半透明）。
 *   2. 覆盖线条 RGB 为目标墨色（保留上一步算出的 alpha，故边缘平滑）。
 *      —— 原图多为黑/深色线稿，spec 指定了笔色（红马克笔 / 蓝钢笔 / 红圆珠笔），
 *         按「我蓝敌红」铁律：BOSS/here=红（权威/假想敌），START/WIN=蓝（己方）。
 *   3. 按内容包围盒裁掉四周留白。
 *   4. 等比缩放，长边 = LONG_EDGE（高分辨率源，运行期按角落需要缩小用）。
 *   5. 导出 client/src/assets/decor/battle/label_*.png（透明底单色）。
 *
 * 运行：  node pack_labels.cjs
 * 依赖：  复用 client/node_modules/sharp。
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp'));

const LONG_EDGE = 256;   // 高分源，角落标注按需缩小
const ALPHA_TRIM = 16;

// 目标墨色（spec §6.2 B 组 + 我蓝敌红）
const INK_BLUE = { r: 38, g: 58, b: 122 };   // 蓝钢笔（己方）
const INK_RED  = { r: 208, g: 38, b: 44 };   // 红马克笔 / 红圆珠笔（权威/假想敌）

// 源文件 → 资产名 + 目标墨色（源为白底深色线稿，打包时覆盖为 spec 笔色）
const JOBS = [
  { src: 'label_boss.webp',       name: 'label_boss',       ink: INK_RED  },
  { src: 'label_start.webp',      name: 'label_start',      ink: INK_BLUE },
  { src: 'label_win.webp',        name: 'label_win',        ink: INK_BLUE },
  { src: 'label_arrow_here.webp', name: 'label_arrow_here', ink: INK_RED  },
];

const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets/decor/battle');

async function process(job) {
  const file = path.join(__dirname, job.src);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: ch } = info;

  let minX = W, minY = H, maxX = -1, maxY = -1;
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let a = Math.round(255 - lum);
      if (a < 0) a = 0; else if (a > 255) a = 255;
      if (ch === 4) a = Math.min(a, data[i + 3]);
      const di = (y * W + x) * 4;
      out[di] = job.ink.r; out[di + 1] = job.ink.g; out[di + 2] = job.ink.b; out[di + 3] = a;
      if (a > ALPHA_TRIM) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error(`${job.name}: 空图（无内容）`);

  const cropW = maxX - minX + 1, cropH = maxY - minY + 1;
  const cropBuf = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const si = ((y + minY) * W + (x + minX)) * 4;
      const dj = (y * cropW + x) * 4;
      cropBuf[dj] = out[si]; cropBuf[dj + 1] = out[si + 1];
      cropBuf[dj + 2] = out[si + 2]; cropBuf[dj + 3] = out[si + 3];
    }
  }

  const scale = LONG_EDGE / Math.max(cropW, cropH);
  const newW = Math.max(1, Math.round(cropW * scale));
  const newH = Math.max(1, Math.round(cropH * scale));
  await sharp(cropBuf, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize(newW, newH, { fit: 'fill' })
    .png()
    .toFile(path.join(OUT_DIR, `${job.name}.png`));

  return { name: job.name, w: newW, h: newH, ink: `#${[job.ink.r, job.ink.g, job.ink.b].map((v) => v.toString(16).padStart(2, '0')).join('')}` };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const rows = [];
  for (const job of JOBS) rows.push(await process(job));
  console.log(`✅ B 组打包完成 → ${OUT_DIR}`);
  console.table(rows);
}

main().catch((e) => { console.error(e); process.exit(1); });
