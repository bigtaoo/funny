/**
 * pack_decos.cjs — 把 decor_*.{webp,png} 处理并打包成 PixiJS 可直接用的图集。
 *
 * 处理流程（全部在内存里完成，不落中间文件）：
 *   1. 读图 → 白底转透明：alpha = 255 - 亮度（白底→全透明，墨线→不透明，抗锯齿灰边→半透明），保留原线条颜色。
 *   2. 按内容包围盒裁掉四周留白。
 *   3. 等比缩放，使长边 = LONG_EDGE（A 组装饰 64px）。
 *   4. shelf packing 拼进一张 atlas PNG（带 PAD 间距防出血）。
 *   5. 导出 decor_atlas.png + decor_atlas.json（TexturePacker JSON-Hash，PIXI.Spritesheet 直接 parse）。
 *
 * 运行：  node pack_decos.cjs
 * 依赖：  复用 client/node_modules/sharp（无需另装）。
 */
const fs = require('fs');
const path = require('path');
const sharp = require(path.resolve(__dirname, '../../../client/node_modules/sharp'));

const LONG_EDGE = 64;   // A 组目标长边
const PAD = 2;          // atlas 内每帧间距
const ATLAS_W = 256;    // 图集宽（固定，长边 64 时一行放 ~4 个）
const ALPHA_TRIM = 16;  // 裁剪时认定“有内容”的 alpha 阈值

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
    .filter((f) => /^decor_.*\.(webp|png)$/i.test(f))
    .sort();
  if (!files.length) { console.error('没有找到 decor_*.{webp,png}'); process.exit(1); }

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
  const canvas = sharp({ create: { width: ATLAS_W, height: ATLAS_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
  const composites = sprites.map((s) => ({ input: s.buf, left: s.x, top: s.y }));
  await canvas.composite(composites).png().toFile(path.join(__dirname, 'decor_atlas.png'));

  // 导出 JSON（TexturePacker JSON-Hash）—— 帧名不带扩展名，便于 textures['decor_sun']
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
    meta: { app: 'pack_decos.cjs', image: 'decor_atlas.png', format: 'RGBA8888', size: { w: ATLAS_W, h: ATLAS_H }, scale: '1' },
  };
  fs.writeFileSync(path.join(__dirname, 'decor_atlas.json'), JSON.stringify(json, null, 2));

  console.log(`✅ 打包完成：${sprites.length} 帧 → decor_atlas.png (${ATLAS_W}×${ATLAS_H}) + decor_atlas.json`);
  console.table(sprites.map((s) => ({ name: s.name, w: s.w, h: s.h, x: s.x, y: s.y })));
}

main().catch((e) => { console.error(e); process.exit(1); });
