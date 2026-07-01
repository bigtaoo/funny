# SLG 地图资源母题 — AI 出图 prompt 表

状态：待出图（2026-06-30）
关联：资源命名定版见 [`design/game/SLG_DESIGN.md`](../game/SLG_DESIGN.md) §3.4；美术铁律 / decor 出图管线见 [`art-direction.md`](art-direction.md) §〇 / §6.2

---

## 0. 这份文档是什么 / 只要出 5 张

SLG 大世界地图上的资源格有 **5 种资源 × 10 级 = 50 个视觉状态**。**不要出 50 张图。**

> 拍板（2026-06-30，用户）：50 张图违背「同一个孩子一笔笔画出来」的一致性铁律，且收入区（玩家长时间盯看 + 主要变现）最怕调不动。改为 **5 个「单个母题」+ 程序分层合成 10 级**。

**你只需要生成这 5 张母题**（每种资源一个单体涂鸦）：

| code enum | 文具名 | 母题（单个物体） |
|---|---|---|
| `ink` | 墨水 | 一个小墨水瓶 |
| `paper` | 纸张 | 一张卷角的纸 |
| `graphite` | 石墨 | 一块带切面的石墨矿块 |
| `metal` | 金属 | 一个长尾夹（binder clip） |
| `sticker` | 贴纸 | 一张翘角的星形贴纸 |

其余一切（数量、密度、丰度、守军强度、等级、颜色、阵营、等级数字）**都由程序在运行时合成**，见 §3。

---

## 1. 出图硬约束（每张都要满足）

1. **单个物体**：画面里只有一个该物体，居中、占满大部分画幅。**绝对不要画一堆/一摞/一簇**——「丰度=多个」是程序把同一张母题复制堆出来的，你画成一堆程序就没法 1 级显示单个。
2. **纯白底 + 单色深墨线**：单色深墨（黑/深灰）线稿，纯白背景。不要上色、不要阴影渐变。颜色由程序加（阵营框/等级色/压淡），母题本体保持原墨色不 tint（同 decor A/C 组口径）。
3. **小尺寸可读**：这是地图格上的功能图标，玩家一直盯着看 → 比"5 秒涂鸦"干净一点，剪影要清晰。线条仍可手抖，但别糊。
4. **剪影互不撞**：5 个物体的轮廓必须一眼区分（瓶子 / 卷纸 / 棱块 / 夹子 / 星星），因为它们共用同一种墨线风格、且**不能靠颜色区分**（颜色被阵营和等级占用）。
5. **不画**：文字、数字、网格线、横格线、投影、地面线/基线、多个物体。

---

## 2. Prompt

### 共用前缀（贴在每条主体前）

```
Hand-drawn doodle icon for a strategy-game map resource tile, drawn in a worn
school notebook with a single dark-ink pen. Slightly wobbly imperfect strokes
like a teenager sketching in the margins, but clean and clear enough to be read
at a small size on a map tile. ONE single isolated object, centered, filling
most of the frame, on a plain pure-white background. Flat 2D line art, no
shading or only light pencil hatching, no outline cleanup, no thick cartoon
outline. Style of West of Loathing / doodle art.
```

### 共用负向

```
color, colored ink, painterly, shading, soft gradient, glow, 3d render,
photorealistic, thick bold cartoon outline, clean vector, multiple objects,
group, pile, stack of many, cluster, text, letters, numbers, watermark, gray
background, notebook grid lines, ruled lines, drop shadow, ground line, baseline
```

### 5 条主体（接在共用前缀之后）

| 资产名 | 主体 prompt | 剪影 / 为什么 |
|---|---|---|
| `res_ink` | `a single small glass inkwell bottle, squat rounded body with a short neck and an open or cork top, one or two tiny ink drops near the rim` | 矮胖瓶身，墨水=粮食位（练兵/续命）。瓶子剪影独一份 |
| `res_paper` | `a single rectangular sheet of paper, slightly tilted, with one corner curled or folded up; plain blank surface, no lines on it` | 卷角方片，纸=木材位（基础建材）。卷角让多张堆叠时读成"一摞纸" |
| `res_graphite` | `a single chunky angular lump of graphite mineral, faceted like a small rough crystal/stone block, a couple of short hatching strokes on one facet to read as soft dark graphite` | 带切面的棱块，石墨=石料位（高阶建材）。棱角块状区别于瓶/纸/夹 |
| `res_metal` | `a single metal binder clip (foldback clip): a chunky solid triangular body with two thin looped wire handles sticking up` | 三角夹身+两根细线圈，金属=铁矿位（军工/锻造）。夹子剪影最"金属感"且独特 |
| `res_sticker` | `a single shiny five-pointed star-shaped sticker, peeling up at one corner to show it is a stick-on label` | 翘角五角星，贴纸=铜币位（通用流通）。星形+翘角="贴纸/币"质感，剪影独一份 |

> 每条建议抽 3–5 张挑 1。剪影最容易撞的是 `graphite` 棱块 vs `metal` 夹子——出图时盯一下这两个，确保块状感 vs 线圈夹子能一眼分开；不行就给 graphite 多加切面、给 metal 强调两根线圈。

---

## 3. 程序会加什么 → 所以你别画

母题之上，程序在地图格里叠三层（全部 SketchPen / `PIXI.Text`，0 额外资产）：

- **丰度轴（产量越高越多）**：把同一张母题**复制成簇**，数量/密度随等级递增（1 级单个 → 高级一簇）。→ 所以母题必须是**单体**。
- **守备轴（等级越高守军越强、越难打）**：随等级叠手绘防御元素——中级套手绘栅栏框、高级加箭塔/城垛涂鸦（复用 `icons.ts` 的 `castle`）、顶级（lv8–10）压**红马克笔危险点缀**（红=权威/警示，`theme` §3.3 已有功能色）。→ 所以母题里别画框、别画守卫。
- **等级数字 + 阵营/中立色**：手写等级角标（`PIXI.Text`，永不烘焙）+ 地块框颜色（蓝=我/红=敌/中立色）。→ 所以母题里别写数字、别上色。

10 级建议用 **3–4 个生长档**映射（如 lv1-3 单体 / lv4-6 成簇 / lv7-9 加守备框 / lv10 满饰+红点），跳变明显但母题资产恒为 5。

---

## 4. 出图后的管线（✅ 已落地，沿用 decor 口径）

1. 源图（白底 png/webp）放 `art/ui/slg-map/`，语义名 `res_ink.png` / `res_paper.png` / `res_graphite.png` / `res_metal.png` / `res_sticker.webp`。
2. 打包脚本 `art/ui/slg-map/pack_resources.cjs`（复用 client 的 sharp）：近白→透明（`alpha=255-luma`，保留原墨色）+ 裁透明边 + 等比缩放长边 **128** + shelf-pack → 图集宽 512。
3. 产物**直接输出**到 `client/src/assets/slg/res_atlas.png`（palette+压缩，~40 KB）+ `res_atlas.json`（TexturePacker JSON-Hash，帧名不带扩展名，如 `res_ink`）。改图后重跑 `node pack_resources.cjs` 即覆盖。
4. 线条为原墨色、**不 tint**；作淡显时由渲染期 alpha 压淡（同 A/C 组）。
5. 加载可复刻 `client/src/render/decorCAtlas.ts`（`PIXI.Spritesheet`，改 import 路径到 `slg/res_atlas.{png,json}`）。

> **✅ 出图验收（2026-07-01）**：5 张全部合格。墨水/纸/金属/贴纸 4 张原版合格；石墨 `res_graphite` 已更新为手绘棱块墨线版（带切面的矿石块状，右侧少量斜排线表示切面，白底单色线条，无灰色填充无投影），符合 §1.2 规范，剪影可与金属夹子一眼区分。`art/ui/slg-map/res_graphite.png` + atlas 已同步。
>
> **✅ 地图格渲染接入已落地（2026-06-30，commit `b8b726c0`）**：`client/src/render/resAtlasLoader.ts`（懒加载，色块兜底）+ `WorldMapScene.drawResMotif`（仅 L1）实现母题加载 + 丰度轴（lv1→4 个精灵成簇）+ 守备轴（lv4+ 栅栏 / lv7+ 桩刻度 / lv8–10 红角）+ 10 级合成；母题墨线不 tint。5 种资源母题全部就位，渲染管线无遗留。
