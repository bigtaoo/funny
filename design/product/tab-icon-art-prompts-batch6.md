# 批次 6：大厅首页主视觉 — Prompt 文档

> 创建：2026-08-17 · 判断+prompt 定稿：2026-08-17 · 出图+接线完成：2026-08-17
> 前五批：[`tab-icon-art-prompts.md`](tab-icon-art-prompts.md)（试点/批次 2/3/4，19 张）· [`tab-icon-art-prompts-batch5.md`](tab-icon-art-prompts-batch5.md)（页面标题+剩余页签，24 张）
> 配套代码：[`client/src/render/icons.ts`](../../client/src/render/icons.ts) · [`client/src/render/icons/tabIconRaster.ts`](../../client/src/render/icons/tabIconRaster.ts)（本批把 `icons.ts` 顶过 500 行收敛线，光栅那半随即拆到这里；调用点不变，仍由 `icons.ts` 再导出） · [`client/src/scenes/LobbyScene/mainContent.ts`](../../client/src/scenes/LobbyScene/mainContent.ts) · [`client/src/scenes/LobbyScene/header.ts`](../../client/src/scenes/LobbyScene/header.ts) · [`art/ui/tabicons/pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs)
> 美术总纲：[`art-direction.md`](art-direction.md) §0 / §7.6
> 状态：**全部完成**（3 张新图 + 1 处纯复用，46 个光栅图标 / 138 张 PNG，接线+实拍已验收）

## 背景：前五批都绕开了首页

批次 1–4 的范围是"页签条上的图标"，批次 5 补的是"二级页面的标题"。两者都在**二级页面**里——于是全游戏被看得最多的那一屏（大厅首页）反而一张 AI 图都没有：`开始匹配` 按钮的水印、`战役`/`大世界` 两张 pillar 卡片的主视觉、右上角段位 chip，四处全是程序画的 `pencils`/`book`/`castle`/`trophy`。

用户 2026-08-17 圈图指出的正是这四处。问题不只是"线细"：右上角**金币早就是 AI 位图**（`buildCoinIcon`，`assets/shop/coins.png`），紧挨着它的段位奖杯还是细线条程序图，两者并排时程序图的单薄一眼可见。

## 与前五批的两点不同

1. **这批不是 28px 的页签格子，是大尺寸主视觉**：pillar 卡片的 motif = 卡片高的 60%，hero 水印 = 按钮高的 105%，实际渲染上百 px。因此源图允许比前几批多一点线条细节（地图的虚线路线、本子的线圈），28px 可辨仍写进 prompt 但不是硬约束。
2. **墨色只能靠调用点显式声明**：这四处原本都是**运行时染色**（战役金、大世界蓝、hero accent 蓝、段位按 `TIER_COLORS`），而光栅图标的墨色是打包时烤死的三档。结论是**不给 pack 脚本加烤色**，改为：
   - hero 水印 / 段位 chip → `variant: 'active'`（白墨，坐在近黑底上）。这两处的"自然颜色"（accent 蓝 luma≈0.45、段位金 luma≈0.59）经 `tabIconVariant()` 都会被判成"深色"→ 拿到纸面灰，在近黑底上等于消失，所以必须显式指定。
   - 两张 pillar 卡片 → `variant: 'content'`（墨黑，坐在纸面上）；软锁态的大世界卡 → `'inactive'`（压暗灰），跟它变灰的边框一致。
   - **颜色语言没丢**：卡片的左边缘墨条、边框、副标题仍是金/蓝；段位 chip 的边框和 `黄金 · 1425` 文字仍按 `TIER_COLORS` 染色，图标变墨色不丢信息。

## 判断结果总表

| # | 位置 | 原程序图 | 造型 | 避让 |
|---|---|---|---|---|
| 1 | 大厅 `开始匹配` 按钮水印 | `pencils` | 交叉的两支铅笔，交点一小团墨渍 | 不是交叉双剑(`pvpTabIcon`)；不要画成标题栏那枚三笔纹章 |
| 2 | 大厅 `战役` 卡片 | `book` | 摊开的线圈练习本（页面向两侧张开、书脊线圈、页面全空白） | **不是卷起来的藏宝图卷轴**(`pveTabIcon`)，不是合上的书 |
| 3 | 大厅 `大世界` 卡片 | `castle` | 摊开的纸质地图（两条折痕 + 一条虚线路线 + 终点一面小三角旗） | 不是城门楼(`cityTabIcon`)、不是地球(`socialTabIcon`)、不是卷轴(`pveTabIcon`) |

### 判断为复用、不出新图的点

- **段位 chip（原 `trophy`）** → **复用 `leaderboardTabIcon`（领奖台）**。理由：这枚 chip 的点击目标就是排行榜，语义精确；而"奖杯类"造型已经有 `achievementTabIcon`（奖杯）/`honorTabIcon`（桂冠）/`medal`（圆牌）三张，再加一张必然互撞。代价是丢掉段位色——但如上所述边框和文字仍带色，信息不丢。
- `pencils`/`book`/`castle`/`trophy` 四个程序 `IconKind` **不删**：它们在别处仍在用（皮肤页的"无皮肤"格、CityScene 的书院/城墙、ResultScene、世界地图 HUD、成就吐司、头像称号回退）。因此"接线退化回旧图"不会被编译器发现，只能靠下面的测试兜。

## Prompt（3 条，沿用前五批骨架）

### 1 开始匹配水印（`tabicon_duel`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: two ordinary wooden pencils crossed in a big X like duelling swords, both sharpened tips pointing outward and upward, plain straight barrels with a small flat eraser end at each lower tip, and one small ink splat right at the crossing point where they clash. Single object group, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no wood-grain lines. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, swords or blades or hilts, three or more pencils, a shield or crest behind them, hands holding them, written scribbles or lines, motion lines, sparkles, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 2 战役（`tabicon_campaign`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, bold thick confident strokes, slightly wobbly and imperfect, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: an open school exercise book seen at a slight three-quarter angle from above — the two facing pages clearly SPLAY OUTWARD, each page a trapezoid that is narrow at the middle spine and wider at its outer edge, the outer edges of the pages gently curved upward so the book reads as genuinely open and slightly cupped, with a row of small spiral binding rings running down the middle spine. Both pages completely blank. Square composition, the book filling most of the frame. Centered, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable as an open book when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thin faint lines, thick clean cartoon outline, vector-art look, a flat barrel-shaped or bulging outline, two straight parallel lines at the spine, a folder or binder look, a dog-eared corner, ruled lines or writing on the pages, a closed book, hard cover with a clasp, bookmark ribbon, a stack of books, wide flat proportions, text, letters, numbers, multiple objects, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 3 大世界（`tabicon_world`）
```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a flat unfolded paper map laid out face-on — a rectangle with slightly wavy top and bottom edges and exactly two straight vertical fold creases, with one winding dotted trail curving across it and a single small triangular pennant pin planted at the end of that trail. Nothing else drawn on the map. Single object, centered, filling the frame, on a plain pure-white background, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels — err toward too plain rather than too detailed. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a rolled-up scroll with curled ends, a globe or sphere, a castle or gatehouse, a compass rose, coastlines or terrain contours, grid or graticule lines, an X mark, more than one pin, hands holding it, text, letters, numbers, multiple objects, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

## 出图结果

| # | 图 | 结果 |
|---|---|---|
| 1 | `tabicon_duel.webp` (1920²) | 一次过 |
| 2 | `tabicon_campaign.png` (1254²) | **v2 通过**，v1 打回 |
| 3 | `tabicon_world.png` (1331×1181) | 一次过 |

**唯一一张打回（战役 v1）的原因值得记**：v1 画成了两块外凸的桶形面板 + 中缝两条平行竖线夹一排线圈，整体读成"对开的文件夹/板子"而不是翻开的本子——缺的是**书页向两侧张开的透视**。修法是把"张开"写成可执行的几何约束而不是形容词：*each page a trapezoid, narrow at the spine and wider at its outer edge, outer edges curved upward*，并把 v1 的失败形态原样写进 Avoid（`a flat barrel-shaped or bulging outline`、`two straight parallel lines at the spine`、`a folder or binder look`）。v1 另有三个次级问题一并写进 prompt：线偏细（→ `bold thick confident strokes` + Avoid `thin faint lines`）、构图偏扁（→ `Square composition` + Avoid `wide flat proportions`）、右上角折角在 28px 会糊成毛刺（→ Avoid `a dog-eared corner`）。源图尺寸也从 512² 提到 1254²。

## 回归测试

`client/test/ui/lobbyHomeMotifIcons.ui.ts`（4 例，跑在 headless PIXI adapter 上）——盯的是这批**特有**的两条会静默腐烂的线：

1. **墨色变体**：四处调用点各自的"自然颜色"经 `tabIconVariant()` 都会选错变体（hero/段位选到纸面灰、软锁的大世界选到白墨），因此全部显式传 `variant`。漏传 `variant` 编译照过、测试不过。
2. **复用/去重决策**：断言大厅确实画了 `duelTabIcon`/`campaignTabIcon`/`worldTabIcon`/`leaderboardTabIcon`，且**没有**再画 `trophy`/`book`/`castle`/`pencils`。这四个 `IconKind` 因为别处仍在用而不能删，所以"退化回旧图"是编译器看不见的。
