# 返回箭头 AI 图 — Prompt + 接线记录

> 创建：2026-08-19 · 出图+接线完成：2026-08-19
> 前六批（页签/标题/首页图标）：[`tab-icon-art-prompts.md`](tab-icon-art-prompts.md) · [`tab-icon-art-prompts-batch5.md`](tab-icon-art-prompts-batch5.md) · [`tab-icon-art-prompts-batch6.md`](tab-icon-art-prompts-batch6.md)
> 配套代码：[`client/src/ui/widgets/SceneHeader.ts`](../../client/src/ui/widgets/SceneHeader.ts) · [`client/src/render/icons/tabIconRaster.ts`](../../client/src/render/icons/tabIconRaster.ts) · [`client/src/scenes/LoginScene.ts`](../../client/src/scenes/LoginScene.ts) · [`art/ui/tabicons/pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs)
> 美术总纲：[`art-direction.md`](art-direction.md) §0 / §7.6 · 返回按钮硬约定：[`../game/UI_DESIGN.md`](../game/UI_DESIGN.md) §3.1
> 状态：**已完成**（1 张新图 / 2 张 PNG）

## 这张不是页签图标

前六批全是"某个格子里的图标"。这张是**返回按钮里的箭头**——全游戏出现次数最多的一枚图形（每个二级场景的标题栏 + 世界地图的悬浮胶囊 + 登录页表单栏）。它此前一直是**文字里的 `←` 字符**：由文字渲染器按平台 CJK 回退字体绘制，笔画细、字形随设备变，是这条栏里唯一没经过 sketch 笔触的图形。2026-08-19 用户提出"返回也需要一个图标"。

先落地过一版**矢量手绘箭头**（`render/icons/ui.ts` 的 `drawBackArrow`），当天换成本文这张 AI 图后删除——不留两套写法。

因此它在管线里的定位与页签图标不同，三处都要单独处理：

| | 页签图标 | 返回箭头 |
|---|---|---|
| 墨色 | `active` 白 / `inactive` 灰 / `content` 墨黑 | **`accent` 蓝**（纸面标题栏）+ `active` 白（登录页深色栏） |
| 代码入口 | `TAB_ICON_RASTER` + `buildIcon(kind,…)` | `BACK_ARROW_ART`，`SceneHeader` 直接画，**不进** `buildIcon` 分发 |
| 契约测试 | `test/render/tabIconContentVariant.test.ts` | `test/render/backArrowArt.test.ts`（前者按 `NON_TAB_BASES` 排除它） |

## 定稿 Prompt（`tabicon_back.png`，一版通过）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished, bold and thick strokes. Subject: ONE simple left-pointing arrow — a single straight horizontal shaft running from the right edge toward the left, ending in an open V-shaped arrowhead (two short strokes meeting at the tip, NOT a filled solid triangle). Just the shaft and the head, nothing else: no tail feathers, no curve, no loop, no second arrow, no circle or box around it, no target. The arrowhead is large and open, roughly a third of the total width, and the strokes are noticeably thicker than a normal pen line, so the arrow still reads as an arrow rather than as a stray line. Single object, centered, filling the frame horizontally, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable as "go back" when scaled down to 24x24 pixels — err on the side of too simple and too thick. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, curved or looping undo arrow, circular refresh arrow, double chevron, two or three stacked chevrons without a shaft, upward or rightward direction, filled solid triangle head, arrow through a target, mouse cursor, hand pointer, multiple objects, confetti dots, text, letters, watermark, gray background, notebook grid lines, drop shadow.
```

出图 1536×1024，墨迹 bbox 1231×598（**2.06:1**），轴笔宽约 48px = 长边的 3.92%。

## 「会不会太细」——量出来的答案

用户出图时问的就是这个，肉眼在 1500px 原图上看不准，量了才知道：打包按**长边**归一到 128，所以决定最终粗细的是**笔画占箭头总长的比例**，不是画布上的绝对像素；而这是个 2.06:1 的扁形状，长边归一后笔画比同等"手感"的方形图标更细。

| | 折算到 24px 盒 |
|---|---|
| 原样（5.0px @128） | 0.94px — 半透明灰线，正是页签图标那个病 |
| +1 道 dilate | 1.32px |
| +2 道 | 1.69px |
| **+3 道（采用）** | **2.07px** |
| （被替换的矢量箭头 `0.09·s`） | 2.16px |

结论是**不重画**：这个形状是一条轴加两笔头、之间全是空白，不存在页签图标那种"细节糊成一块"的风险（铁砧那批卡在 1 道，正是因为盾牌中缝和小人会粘连）。于是 `pack_tab_icons.cjs` 的 `JOBS` 行支持按图覆盖膨胀道数，这张给 3 道。**能吃几道膨胀是形状的属性，不是全局常量。**

## 同批修掉的黑边 bug

接线实拍时箭头在纸面上读成"深蓝近黑"，量下来 PNG 里不透明像素的 RGB 是 `(0,0,0)`——**08-19 上午那次加粗一直带着一个没被发现的缺陷**：`dilateAlpha` 只涨 alpha，被它变成不透明的像素保留原有 RGB，而 sharp 的 resize（premultiply → unpremultiply）会把全透明像素的 RGB 清零，`extend` 传的 background 也留不住。于是每条加粗过的笔画外面都裹着一圈 `thicken` 像素宽的**黑边**。

之所以上午没发现：`active` 白墨只画在近黑的页签格上，黑边混进底色里看不出来。换成蓝墨画在奶白纸上、而且宽达 3 像素，立刻现形。修法是膨胀后统一重刷一遍 RGB；46 张 `*_active.png` 一并重打，边缘干净了（视觉上仍几乎无变化，因为它们仍只画在深色格上——但这是正确性问题）。

**教训**：只在一种底色上验收的资产改动，缺陷会被那种底色藏住。换一种墨色/底色再看一眼，比加测试更快发现问题。

## 接线要点

- **`accent` 墨只给要它的图出**：`INKS` 表加了第四档（`#4477cc` = `C.accent`），但 `JOBS` 行按需 opt-in（`inks: ['accent','active']`）。给全部 46 张页签图都烤第四份 = 约 250KB 谁也不画的包体，微信单包约束下不划算。
- **箭头画在缓存之外**：标题栏 chrome 走 `uiCache` 烘一次复用，而 AI PNG 是异步解码的，`buildRasterTabIcon` 在纹理没好时**画空**。若把箭头烘进 chrome，冷启动时第一个抢输解码的标题栏会把"没有箭头的胶囊"永久缓存在那个 key 上——只在冷加载复现，改代码的人本机永远看不到。所以 `addBackArrow()` 由调用方画在 chrome 之上，节点带 `name = 'backArrow'`（`BACK_ARROW_NODE`）方便定位，且**追加在最后**，让 `[chrome, (标题图标), 标题]` 这个既有前缀保持稳定。
- **宽度用常量比例，不读纹理**：胶囊背景是缓存的，宽度若取决于"PNG 解没解码完"就会烘出一个装不下自己内容的胶囊。`BACK_ARROW_ASPECT = 128/65` 由 `backArrowArt.test.ts` 对着真 PNG 的 IHDR 校验——重画成别的比例时，这条是唯一会喊的。
- **`LoginScene` 自己预热**：它跑在大厅**之前**，而 `preloadTabIconTextures()` 一直是大厅在替所有二级场景暖纹理的。不补这一下，第一个登录表单会画出没有箭头的标签。
- **尺寸**：箭头高 = `0.62 × backSize`（略低于 cap height，读作前导而非第二行文字），宽按上面的比例推。
