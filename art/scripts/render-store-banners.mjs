// Render the store banner assets (Play feature graphic, WeChat share image) in a real browser.
//
// Why a browser and not a sharp composite: these are the only store assets that carry *type*, and
// the game's own UI is plain `monospace` on the paper tint with the ruled-line/red-margin motif
// (client/src/render/sketchUi.ts). Laying that out in HTML/CSS and screenshotting it means the
// banner is the same medium as the game; a hand-composited PNG with some other font would read as
// marketing material bolted onto a different product.
//
// Deliberately NOT a gameplay screenshot: Play's own guidance is logo + minimal type for the
// feature graphic (it gets cropped and overlaid with UI at various sizes), and the screenshots
// carry the gameplay job already (art/store/en/).
//
// Run: node art/scripts/render-store-banners.mjs
// Out: art/store/icons/{play_feature_1024x500,wechat_share_500x400}.png

import pw from '../../client/node_modules/@playwright/test/index.js';
import sharp from '../../client/node_modules/sharp/lib/index.js';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = pw;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'art/store/icons');
mkdirSync(OUT, { recursive: true });

// Crest with its transparent margin trimmed, inlined as a data URI (the page is set via setContent,
// so it has no origin to load a file from).
const crest = (await sharp(path.join(ROOT, 'art/logo/logo-simple.png'))
  .trim().resize(600, 600, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png().toBuffer()).toString('base64');

// Game palette: paper #faf6ee, ink #2c2c2a, accent blue #4477cc, gold #cc9900, margin red #cc3333.
const html = (w, h, o) => `
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: ${w}px; height: ${h}px; overflow: hidden; font-family: monospace; }
  .sheet {
    position: relative; width: ${w}px; height: ${h}px; background: #faf6ee;
    background-image: repeating-linear-gradient(to bottom, transparent 0 ${o.rule - 1}px, #c8d8e8 ${o.rule - 1}px ${o.rule}px);
    display: flex; align-items: center; gap: ${o.gap}px; padding: 0 ${o.padX}px;
  }
  .margin { position: absolute; left: ${o.marginX}px; top: 0; bottom: 0; width: 2px; background: #cc3333; opacity: .55; }
  .crest { width: ${o.crest}px; height: ${o.crest}px; flex: 0 0 auto; }
  .copy { display: flex; flex-direction: column; gap: ${o.copyGap}px; }
  .title { font-size: ${o.title}px; font-weight: 700; color: #2c2c2a; letter-spacing: -1px; line-height: 1; white-space: nowrap; }
  .sub { font-size: ${o.sub}px; font-weight: 700; color: #4477cc; letter-spacing: ${o.subTrack}px; line-height: 1; white-space: nowrap; }
  .rule { height: ${o.ulH}px; background: #cc9900; border-radius: ${o.ulH}px; width: ${o.ulW}px; }
  .tag { font-size: ${o.tag}px; color: #55524c; line-height: 1.35; white-space: nowrap; }
  .modes { display: flex; gap: ${o.badgeGap}px; margin-top: ${o.copyGap}px; }
  .badge { font-size: ${o.badge}px; color: #2c2c2a; border: 2px solid #4477cc; border-radius: 6px; padding: ${o.badgePadY}px ${o.badgePadX}px; background: #ffffff88; }
</style>
<div class="sheet">
  <div class="margin"></div>
  <img class="crest" src="data:image/png;base64,${crest}">
  <div class="copy">
    <div class="title">Nivara</div>
    <div class="sub">NOTEBOOK WARS</div>
    <div class="rule"></div>
    <div class="tag">${o.tagText}</div>
    <div class="modes">${o.badges.map((b) => `<span class="badge">${b}</span>`).join('')}</div>
  </div>
</div>`;

const browser = await chromium.launch();
async function shoot(file, w, h, o) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.setContent(html(w, h, o));
  await page.waitForTimeout(400); // let the data-URI crest decode before the shot
  await page.screenshot({ path: path.join(OUT, file) });
  console.log(`${file}  ${w}x${h}`);
  await ctx.close();
}

// Play feature graphic. Type stays well inside the frame: Play crops this asset and overlays its own
// UI near the edges.
await shoot('play_feature_1024x500.png', 1024, 500, {
  rule: 42, marginX: 92, padX: 118, gap: 44, crest: 300, copyGap: 14,
  title: 86, sub: 25, subTrack: 5, ulH: 8, ulW: 300, tag: 19,
  badge: 15, badgeGap: 10, badgePadY: 5, badgePadX: 9,
  tagText: 'Turn-based strategy in a hand-drawn notebook',
  badges: ['Campaign', 'Real-time PvP', 'Open-world SLG'],
});

// WeChat share image (5:4). Chinese copy, mirroring §0.1's zh strings.
await shoot('wechat_share_500x400.png', 500, 400, {
  rule: 34, marginX: 40, padX: 34, gap: 20, crest: 168, copyGap: 9,
  title: 50, sub: 14, subTrack: 2.5, ulH: 5, ulW: 170, tag: 12,
  badge: 10, badgeGap: 6, badgePadY: 3, badgePadX: 6,
  tagText: '笔记本里的回合制策略战争',
  badges: ['战役', '联机对战', '大世界'],
});

await browser.close();
