# SLG 地图资源 — AI 出图 prompt 表

状态：母题 5 张 ✅ 已出图（2026-07-01）；**分级图改为每级一张；木材(paper) l1–l10 全就位并打包上线 ✅（2026-07-06）**——l6–l10 专属真图直接进 atlas，l1–l5 由脚本烘焙（母题 token 白底填实 + 骰子槽叠放）；ink/graphite/metal/铜钱待出图
关联：资源命名定版见 [`design/game/SLG_DESIGN.md`](../game/SLG_DESIGN.md) §3.4；美术铁律 / decor 出图管线见 [`art-direction.md`](art-direction.md) §〇 / §6.2；分级出图规范见下方 **§5**

> **⚠️ 决策变更（2026-07-06，用户拍板）**：推翻 2026-06-30「只出 5 张母题 + 程序合成」。改为**每级单独出一张真图**，照城池 `city_l{n}` 那套（代码钩子 `getResLevelTexture` 已就位：atlas 里出现 `res_{type}_l{level}` 帧即自动取用、跳过丰度模拟，零改代码；未出图的级继续回退母题模拟，不报错）。
> - **规模**：4 种基础资源(粮/木/石/铁) × 10 级 + 铜钱 5 张 = **45 张**。
> - **母题 5 张不废**：仍作(a) 未出图级的运行时回退、(b) 铜钱(sticker) 无地块场景的图标来源。§0–§4 保留为母题规范。
> - **分级出图规范 + 木材 10 条 prompt 见 §5。**

---

## 0. 母题层（5 张，已出图，作分级图的回退底）

SLG 大世界地图上的资源格有 **5 种资源 × 10 级** 个视觉状态。母题层出 **5 张单体涂鸦**，作为分级图未就位时的运行时回退底（丰度靠程序复制母题模拟）。分级真图规范见 §5。

> 历史拍板（2026-06-30）：曾定为「5 母题 + 程序合成、不出 50 张」，理由是一致性铁律 + 收入区稳定。2026-07-06 已推翻为每级一张（见顶部决策变更）；母题层降级为回退底 + 铜钱图标。

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

---

## 5. 分级出图（每级一张，2026-07-06 改版 · 权威）

### 5.1 资源 ↔ 三战对应 + 出图数

| 三战说法 | code enum | 文具名 | 母题（单体，l1–5 计数 token） | l6–10 专属 |
|---|---|---|---|---|
| 粮草 | `ink` | 墨水 | 一个小墨水瓶 | 5 张 |
| 木材 | `paper` | 纸张 | 一张卷角的纸 | 5 张 **← 先出这个** |
| 石料 | `graphite` | 石墨 | 一块带切面的石墨矿块 | 5 张 |
| 铁矿 | `metal` | 金属 | 一个长尾夹 | 5 张 |
| 铜钱 | `sticker` | 贴纸 | 一张翘角的星形贴纸 | 5（**无地块自产**，哪 5 级待定）|

> 分级用 **低档计数 + 高档专属**（§5.4）：l1–5 复用母题 ×N 叠到托盘背景（每资源 2 张专属背景），l6–10 每资源每级专属手绘。合计新增手绘 **4×5 = 20 张专属图 + 4×2 = 8 张背景 = 28 张**，铜钱另议。铜钱(sticker) `无地块`（`stickerShop` 民居模型自产，见 `ECONOMY_NUMBERS §13`），地图上不铺资源格，故只需少量图标状态，等落到它的使用场景再定哪 5 级。

### 5.2 关键反转：分级图要「画满丰度」（和母题相反）

母题层硬约束 #1 是「**只画 1 个、绝不画一堆**」（丰度靠程序复制）。**分级图正相反**：`res_{type}_l{level}` 是**一张图当单个精灵原样画、程序不再复制**，所以每张要**在一图内把该级的丰度画满**——低级稀疏、高级一大簇。渲染时按长边 ≈ 34% 格宽整体缩放贴在格中心。

### 5.3 硬约束（每张都要满足）

1. **单色墨线 + 纯白底**（和 5 母题、色块兜底同款）。**不上色、不阴影渐变**。原因：(a) 未出图的邻格仍用母题(单色墨线)模拟，分级图上色会让相邻格画风裂；(b) 打包脚本抠图是 `alpha = 255 − luma`（白底单色线前提），彩色图会被抠坏。→ **想要城池那种彩色水彩需另换打包管线，本轮不做。**
2. **贴丰度台阶**（§5.4），让 l1→l10 明显递进；相邻级差得出、又是同一物体在长大。
3. **剪影不靠颜色区分**：纸的分级图不管堆多高，轮廓要一眼读成「一摞纸」（层叠的扁平矩形），别糊成方块或和石墨棱堆撞。
4. **别画**：守备栅栏/箭塔/城垛（程序 lv4+/lv7+ 加）、等级数字角标（`PIXI.Text` 加）、阵营/中立框色（程序 tint）、文字、网格/横格线、投影、地面线。

### 5.4 分级方案（2026-07-06 定 · 低档计数 + 高档专属）

> **为什么必须格面上就能读出精确等级**：守军强度随等级递增，玩家若一眼分不出级会**误伤**（去打打不过的守军）。所以精确等级要在地图格上直接可读，不能只塞进点击面板。又因纯数量在 34% 格宽下到高档糊成一坨（用户实测 l9 vs l10 几乎一样），拆成两段：

- **l1–5（全 5 资源通用）**：复用已验收的**母题图当计数 token**，摆 **N 个 = 等级**（1 个=lv1 … 5 个=lv5），骰子点式固定槽位，叠在背景上。精确等级靠数 token，≤5 是人眼一眼可辨的上限。**新增美术仅背景**（母题复用，5 资源一次全解决）。
- **l6–10（每资源各自出图）**：每种资源、每一级**专属手绘**，形态逐级跃迁，追求最佳表现。5 资源 × 5 级 = **25 张**。5→6 画风从「计数图」跳到「专属大图」，正好标记「进入强守军区」，强化误伤规避。

> 硬约束（§5.3 单色墨线 + 白底）对背景和专属图同样适用。木材的 1–5 计数底 + 6–10 专属阶梯见 §5.7；ink/graphite/metal 套同骨架（1–5 复用各自母题、6–10 各画形态阶梯），待写。铜钱(sticker)另议。

### 5.5 共用前缀（分级版，接在每条主体前）

```
Hand-drawn doodle icon for a strategy-game map resource tile, drawn in a worn
school notebook with a single dark-ink pen. Slightly wobbly imperfect strokes
like a teenager sketching in the margins, but clean and clear enough to read at
a small size on a map tile. The subject sits centered, filling most of the
frame, on a plain pure-white background. Flat 2D line art, no shading or only
light pencil hatching, no thick cartoon outline. Style of West of Loathing /
doodle art.
```

### 5.6 共用负向（分级版 — 已删掉母题版的「禁止多个/堆叠」词）

```
color, colored ink, painterly, shading, soft gradient, glow, 3d render,
photorealistic, thick bold cartoon outline, clean vector, text, letters,
numbers, watermark, gray background, notebook grid lines, ruled lines, drop
shadow, ground line, baseline
```

### 5.7 木材 = `paper`（1–5 计数 + 6–10 专属）

**l1–5：母题计数 + 托盘背景**。token = 已验收母题 `res_paper`（卷角单页），脚本按骰子点式固定槽（1 中；2 对角；3 三角；4 四角；5 四角+中）叠 **N 张 = 等级** 到背景上，让 5 张也一眼数清。背景 = 收纸建筑 `paperTray` 的容器（与内政建筑呼应），**每资源专属、2 张**，按 `l1–3 / l4–5` 分，空容器即可（token 由脚本叠上）：

| 背景 | 覆盖级 | 主体 prompt（接 §5.5 前缀，画**空**容器） |
|---|---|---|
| `resbg_paper_a` | l1–3 | `an empty shallow desk in-tray for paper: a simple open rectangular tray with low walls, drawn at a gentle isometric angle, blank and empty, nothing inside` |
| `resbg_paper_b` | l4–5 | `an empty sturdier two-tier stacked desk paper tray, slightly worn wooden or wire frame, drawn at a gentle isometric angle, blank and empty, nothing inside` |

**l6–10：每级专属手绘**（接 §5.5 共用前缀），形态逐级跃迁，剪影各异（捆块 → 卷 → 摞+卷 → 高圆柱 → 满仓）：

| 级 | 帧名 | 形态 | 主体 prompt |
|---|---|---|---|
| l6 | `res_paper_l6` | 捆扎令 | `a neat ream of paper bound with a paper band around the middle, a couple of loose sheets tucked under it` |
| l7 | `res_paper_l7` | 卷轴束 | `a small bundle of two or three rolled paper scrolls tied with string, resting on a couple of flat sheets` |
| l8 | `res_paper_l8` | 多令囤 | `several banded reams of paper stacked together, a rolled scroll leaning against them, a few loose sheets around the base` |
| l9 | `res_paper_l9` | 大纸卷 | `one large upright cylindrical roll of paper standing tall, with two or three banded reams stacked at its base` |
| l10 | `res_paper_l10` | 纸仓 | `an overflowing storehouse of paper: a big upright paper roll, several tall banded reams crowded around it, rolled scrolls and loose sheets spilling at the base — the richest, most imposing paper stockpile` |

> 6–10 每条抽 3–5 张挑 1，都要读得出是「纸」（层叠矩形 / 圆柱纸卷），别糊成砖块石块。托盘背景抽图时确保**空**（sheets 由脚本叠），且托盘轮廓别和 token 的纸片糊在一起。

### 5.8 打包管线（沿用母题口径，加分级帧）

**l6–10（专属图）**：
1. 白底 png `res_paper_l6.png … res_paper_l10.png`（5 张），放 `art/ui/slg-map/`。
2. 重跑 `node art/ui/slg-map/pack_resources.cjs`：近白→透明(`alpha=255−luma` 保原墨色) + 裁透明边 + 等比缩长边 128 + shelf-pack。帧名按文件名(去扩展)，即得 `res_paper_l6..l10`。**零改运行时代码**——`getResLevelTexture('paper',6..10)` 命中即画。

**l1–5（母题计数）**：✅ **已落地为烘焙合成**（`pack_resources.cjs`，非手绘）：
3. `bakeCountFrames()` 吃背景（`resbg_paper_a`=l1–3 / `resbg_paper_b`=l4–5）+ 母题 `res_paper`，按骰子槽（`DICE`：1中／2对角／3三角／4四角／5四角+中）叠 1..5 张 token 出 `res_paper_l1..l5`，一并进 atlas。**零改运行时代码**（`getResLevelTexture('paper',1..5)` 直接命中）。
   - **关键坑（已解）**：token 走近白→透明抠图后「纸面」是透明的，直接叠会互相透光、数不清。烘焙前对 token 跑 `fillInteriorWhite()`（从边界洪水填充定位外部、把被墨线闭合包住的纸面涂成不透明白），叠起来才互相遮挡、读成实心纸张堆。`TOKEN_FRAC=0.40`、槽位见脚本 `C/TL/TR/BL/BR/BC`。
4. ~~退路：运行时程序合成~~——已选烘焙（零改代码、体积可控），此路作废。

**通用收尾**：
5. ✅ 产物写到 **`client/src/assets/slg/res_atlas.{png,json}`** + **`tools/map-editor/src/assets/slg/`** 两份字节一致（脚本 `OUT_DIRS` 一次性写两处）。当前 15 帧（5 母题 + `res_paper_l1..l10`），512×1024，~89 KB。
6. 其余 3 类(ink/graphite/metal)：l1–5 复用各自母题 ×N（同法），l6–10 各画 5 张形态阶梯；铜钱(sticker)待定。

### 5.9 待定项

- **背景已定**（2026-07-06）：每资源专属 2 张，用该资源生产建筑容器（`paperTray`/`inkPot`/`graphiteMill`/`metalForge`），按 `l1–3 / l4–5` 分。木材已出图+烘焙上线（§5.7/§5.8）；ink/graphite/metal 套同思路待出图。
- ~~**l1–5 落地方式**~~：✅ 已定=**烘焙合成**（§5.8 步骤 3），token 走 `fillInteriorWhite` 填实后叠骰子槽。ink/graphite/metal 出图后复用同一 `bakeCountFrames`（往 `BAKE` 加一条即可）。
- **铜钱(sticker)**：无地块，5 张映射哪 5 级、用在什么界面。
