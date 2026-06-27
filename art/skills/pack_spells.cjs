// 法术卡图标打包脚本（art-direction §六「法术卡图标」）
//
// 输入：本目录下 AI 出的 4 张白底涂鸦（深墨线 + 单道红马克笔重点）。
// 处理：近白像素 → 透明（纸底是米黄 #faf6ee，留白会露白方块；同 decor「抠白底」口径）
//      → 裁掉透明边 → 长边缩到 256 → 透明 PNG-32。
// 输出：client/src/assets/spell_*.png，命名 = spell_${SpellType}，供 HandView.CARD_ART_URLS 消费。
//
// 复用 client 的 sharp。改图后重命名覆盖源文件、重跑 `node pack_spells.cjs` 即可。

const path = require('path');
const sharp = require(path.join(__dirname, '../../client/node_modules/sharp'));

const SRC = __dirname;
const OUT = path.join(__dirname, '../../client/src/assets');
const LONG_EDGE = 256;
const WHITE_THRESHOLD = 240; // r,g,b 三通道均 ≥ 此值 → 判为背景白 → 透明

// UUID 源文件 → 目标命名（SpellType 枚举值）
const MAP = {
  '1807861d-fa54-414f-8d0d-8c7049ad21a0.png': 'spell_meteor.png',          // 陨石打击
  '4a6c4eb7-ebd3-4089-a30d-7e7388a4baa1.png': 'spell_bridge_collapse.png', // 桥梁坍塌
  'cac12438-c655-4b99-843d-eac325e3973b.png': 'spell_rockslide.png',       // 石壁崩塌
  'e50a92fc-87db-4f8f-a687-5e51227c4c17.png': 'spell_haste.png',           // 急速冲锋
};

async function processOne(srcFile, outName) {
  const srcPath = path.join(SRC, srcFile);

  // 1. 取原始 RGBA
  const { data, info } = await sharp(srcPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;

  // 2. 近白 → 透明
  let cleared = 0;
  for (let i = 0; i < data.length; i += channels) {
    if (data[i] >= WHITE_THRESHOLD && data[i + 1] >= WHITE_THRESHOLD && data[i + 2] >= WHITE_THRESHOLD) {
      data[i + 3] = 0;
      cleared++;
    }
  }

  // 3. 重建 → 裁透明边 → 等比缩到长边 256 → PNG
  const outPath = path.join(OUT, outName);
  const meta = await sharp(data, { raw: { width, height, channels } })
    .trim()
    .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: false })
    .png()
    .toFile(outPath);

  const pct = ((cleared / (width * height)) * 100).toFixed(0);
  console.log(`${outName.padEnd(26)} ${width}x${height} → ${meta.width}x${meta.height}  (透明化 ${pct}%)`);
}

(async () => {
  for (const [src, out] of Object.entries(MAP)) {
    await processOne(src, out);
  }
  console.log('完成 → client/src/assets/');
})().catch((e) => { console.error(e); process.exit(1); });
