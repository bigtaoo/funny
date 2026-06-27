/**
 * pack_decos_c.cjs — C 组「大厅/功能区手绘图标」源图处理 + 打包成 PixiJS 图集。
 *
 * 与 A 组 pack_decos.cjs 同一口径（抠白底 / 裁剪 / 等比缩放 / shelf packing /
 * 导出 TexturePacker JSON-Hash），仅两点不同：
 *   - 长边 LONG_EDGE = 128（C 组是功能图标，比 A 组边角小涂鸦更精细，需更高分辨率）；
 *   - 图集宽 ATLAS_W = 512（容下 12 帧 128px）。
 * 同样【保留原墨色不染色】——这些是黑墨线稿，按 §6.2 注直接用，不得 tint 成阵营色。
 *
 * 处理流程（全部在内存里完成，不落中间文件）：
 *   1. 读图 → 白底转透明：alpha = 255 - 亮度（白底→全透明，墨线→不透明，灰边→半透明），保留原线条颜色。
 *   2. 按内容包围盒裁掉四周留白。
 *   3. 等比缩放，使长边 = LONG_EDGE。
 *   4. shelf packing 拼进一张 atlas PNG（带 PAD 间距防出血）。
 *   5. 导出到 client/src/assets/decor/decor_c_atlas.png + decor_c_atlas.json。
 *
 * 帧名不带扩展名（如 `decoc_crown`），便于 textures['decoc_crown']。
 * 源图按 decoc_*.{webp,png} 匹配 —— 未选中的源（如实拍的 pennant）不命中此前缀，自动跳过。
 *
 * 运行：  node pack_decos_c.cjs
 * 依赖：  复用 client/node_modules/sharp（无需另装）。
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp'));

const LONG_EDGE = 128;  // C 组目标长边
const PAD = 2;          // atlas 内每帧间距
const ATLAS_W = 512;    // 图集宽（固定，长边 128 时一行放 ~4 个）
const ALPHA_TRIM = 16;  // 裁剪时认定“有内容”的 alpha 阈值

const OUT_DIR = path.resolve(__dirname, '../../../client/src/assets/decor');

const nextPow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

async function loadSprite(file) {
  const name = path.basename(file).replace(/\.(webp|png)$/i, '');
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: ch } = info;

  // 白底转透明 + 求内容包围盒
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * ch;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      let a = Math.round(255 - lum);
      if (a < 0) a = 0; else if (a > 255) a = 255;
      // 若源本身已有 alpha，取较小值（保留原透明）
      if (ch === 4) a = Math.min(a, data[i + 3]);
      data[i + 3] = a;
      if (a > ALPHA_TRIM) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error(`${name}: 空图（无内容）`);

  const cropW = maxX - minX + 1, cropH = maxY - minY + 1;
  const cropBuf = Buffer.alloc(cropW * cropH * 4);
  for (let y = 0; y < cropH; y++) {
    for (let x = 0; x < cropW; x++) {
      const si = ((y + minY) * W + (x + minX)) * ch;
      const di = (y * cropW + x) * 4;
      cropBuf[di] = data[si]; cropBuf[di + 1] = data[si + 1];
      cropBuf[di + 2] = data[si + 2]; cropBuf[di + 3] = data[si + 3];
    }
  }

  // 等比缩放：长边 = LONG_EDGE
  const scale = LONG_EDGE / Math.max(cropW, cropH);
  const newW = Math.max(1, Math.round(cropW * scale));
  const newH = Math.max(1, Math.round(cropH * scale));
  const buf = await sharp(cropBuf, { raw: { width: cropW, height: cropH, channels: 4 } })
    .resize(newW, newH, { fit: 'fill' }).png().toBuffer();

  return { name, buf, w: newW, h: newH };
}

async function main() {
  const files = fs.readdirSync(__dirname)
    .filter((f) => /^decoc_.*\.(webp|png)$/i.test(f))
    .sort();
  if (!files.length) { console.error('没有找到 decoc_*.{webp,png}'); process.exit(1); }

  const sprites = [];
  for (const f of files) sprites.push(await loadSprite(path.join(__dirname, f)));

  // shelf packing：按高度降序，逐行铺
  sprites.sort((a, b) => b.h - a.h);
  let cx = PAD, cy = PAD, rowH = 0, usedH = 0;
  for (const s of sprites) {
    if (cx + s.w + PAD > ATLAS_W) { cx = PAD; cy += rowH + PAD; rowH = 0; }
    s.x = cx; s.y = cy;
    cx += s.w + PAD;
    if (s.h > rowH) rowH = s.h;
    usedH = cy + rowH + PAD;
  }
  const ATLAS_H = nextPow2(usedH);

  // 合成 atlas
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const canvas = sharp({ create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  const composites = sprites.map((s) => ({ input: s.buf, left: s.x, top: s.y }));
  await canvas.composite(composites).png().toFile(path.join(OUT_DIR, 'decor_c_atlas.png'));

  // 导出 JSON（TexturePacker JSON-Hash）—— 帧名不带扩展名，便于 textures['decoc_crown']
  const frames = {};
  for (const s of [...sprites].sort((a, b) => a.name.localeCompare(b.name))) {
    frames[s.name] = {
      frame: { x: s.x, y: s.y, w: s.w, h: s.h },
      rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: s.w, h: s.h },
      sourceSize: { w: s.w, h: s.h },
    };
  }
  const json = {
    frames,
    meta: { app: 'pack_decos_c.cjs', image: 'decor_c_atlas.png', format: 'RGBA8888', size: { w: ATLAS_W, h: ATLAS_H }, scale: '1' },
  };
  fs.writeFileSync(path.join(OUT_DIR, 'decor_c_atlas.json'), JSON.stringify(json, null, 2));

  console.log(`✅ C 组打包完成：${sprites.length} 帧 → ${OUT_DIR}\\decor_c_atlas.png (${ATLAS_W}×${ATLAS_H}) + decor_c_atlas.json`);
  console.table(sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, x: s.x, y: s.y })));
}

main().catch((e) => { console.error(e); process.exit(1); });
