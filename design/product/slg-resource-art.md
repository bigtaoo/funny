# SLG 地图资源 — AI 出图 prompt 表

状态：母题 5 张 ✅ 已出图（2026-07-01）；**四种基础资源(粮/木/石/铁) l1–l10 全部专属手绘、打包上线 ✅；铜钱/铜矿(sticker) l6–l10 五张专属上线 ✅（无 l1–5，只在 6 级地及以上，§5.7-sticker）**——所有 `res_{type}_l{n}` 都是白底手绘真图直接进 atlas，**构建期不再合成任何帧**（`bakeCountFrames`/`bakeHeapFrames`/`resbg_*` 托盘背景已于 2026-07-17 全部删除，见下方决策变更 II）。当前 atlas = **50 帧 / 512×2048 / ~395 KB**，client + map-editor 两份字节一致。
**⚠️ 分级读数契约已于 2026-08-19 重构，出图前必读 §6（含 20 张重画清单 + prompt）。**
关联：资源命名定版见 [`design/game/SLG_DESIGN.md`](../game/SLG_DESIGN.md) §3.4；美术铁律 / decor 出图管线见 [`art-direction.md`](art-direction.md) §〇 / §6.2；分级出图规范见下方 **§5**

> **⚠️ 决策变更 III（2026-08-19，用户拍板）**：分级读数整套重构，见 **§6**（权威，覆盖 §5.3 #2 与 §5.4 的形态跃迁条款）。起因是「按宽归一」这条旧契约会**惩罚横向生长**——高等级的丰度是横着铺开画的，归一化反而把它压小，实测四类资源全部在 l5→l6 墨量回落，ink l4 成了全十级里视觉最重的一帧。
> - **剪影铁律（§5.3 #3）优先，§5.4「l6–10 形态逐级跃迁」作废**：同一 resType 的 l1–l10 必须是同一主体，等级只靠个数/堆量增长；容器、载具、器皿、卷状物一律不许（现有 20 张违规帧清单见 §6.4）。
> - **归一化按等效面积 `√(w·h)`，尺寸交给显式 `LEVEL_SCALE 0.80→1.30`**，alpha 改感知墨量补偿，抖动只留 rot/offset。画稿从此不必为了"更高"扭曲构图。
> - **构建期门禁**：`pack_resources.cjs` 计算 `density × LEVEL_SCALE²` 并强制单调，不达标 pack 直接失败（§6.3）。原因：alpha 补偿只能压淡画满的，救不了画空的。
> - **精确等级通道补回**（决策变更 II 曾放弃）：仅 l6+ 且近 zoom 画文字 `Lv.{n}`，沿用主城标签先例，不用符号编码（§6.2 #7）。

> **⚠️ 决策变更 II（2026-07-17，用户拍板）**：推翻 l1–l5「母题 token + 骰子槽计数拼接」。理由：地图上绝大多数格子是低级地（`tileGraphics.ts` 注释 "most tiles sit at low levels"），而拼接图恰是玩家 90% 时间盯着看的主视觉，读作机械印章、表现比 l6–10 专属图差一大截；省的图（4×5 专属 − 4×2 托盘背景 ≈ 12 张）本就是 AI 出图、成本很低。→ **l1–l5 也改每级一张专属手绘**，与 l6–l10 口径统一。
> - **放弃「数个数读精确等级」**（原 §5.4 的核心诉求）：高档本就已脱离计数，低档统一改为靠**体量/繁简/高度递进**一眼分辨即可。
> - **色带（BAND）豁免推广到全等级**：paper/ink/graphite/metal 的 l1–l10 全部保留原黑墨（靠剪影读级、l1–l10 观感统一）；**只有 sticker 仍上色带**（其 l6→l10 tan→gold = 铜→金，货币主题加分）。见 `pack_resources.cjs` `tintLevelFrame` 豁免正则。
> - **删除的东西**：`pack_resources.cjs` 里 `bakeCountFrames`/`bakeHeapFrames`/`fillInteriorWhite`/`BAKE`/`DICE`/`HEAP_TYPES` 及高度台阶常量；8 张 `resbg_*` 托盘背景移入 `art/leftover/`。**运行时代码零改**（`getResLevelTexture` 命中 `res_{type}_l1..10` 即画）。
> - **l1–l5 出图规范 + 20 条 prompt 见 §5.4-lo。**

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

1. 源图（白底 png/webp）放 `art/slg/slg-map/`，语义名 `res_ink.png` / `res_paper.png` / `res_graphite.png` / `res_metal.png` / `res_sticker.webp`。
2. 打包脚本 `art/slg/slg-map/pack_resources.cjs`（复用 client 的 sharp）：近白→透明（`alpha=255-luma`，保留原墨色）+ 裁透明边 + 等比缩放长边 **128** + shelf-pack → 图集宽 512。
3. 产物**直接输出**到 `client/src/assets/slg/res_atlas.png`（palette+压缩，~40 KB）+ `res_atlas.json`（TexturePacker JSON-Hash，帧名不带扩展名，如 `res_ink`）。改图后重跑 `node pack_resources.cjs` 即覆盖。
4. 线条为原墨色、**不 tint**；作淡显时由渲染期 alpha 压淡（同 A/C 组）。
5. 加载可复刻 `client/src/render/atlas/decorCAtlas.ts`（`PIXI.Spritesheet`，改 import 路径到 `slg/res_atlas.{png,json}`）。

> **✅ 出图验收（2026-07-01）**：5 张全部合格。墨水/纸/金属/贴纸 4 张原版合格；石墨 `res_graphite` 已更新为手绘棱块墨线版（带切面的矿石块状，右侧少量斜排线表示切面，白底单色线条，无灰色填充无投影），符合 §1.2 规范，剪影可与金属夹子一眼区分。`art/slg/slg-map/res_graphite.png` + atlas 已同步。
>
> **✅ 地图格渲染接入已落地（2026-06-30，commit `b8b726c0`）**：`client/src/render/atlas/resAtlasLoader.ts`（懒加载，色块兜底）+ `WorldMapScene.drawResMotif`（仅 L1）实现母题加载 + 丰度轴（lv1→4 个精灵成簇）+ 守备轴（lv4+ 栅栏 / lv7+ 桩刻度 / lv8–10 红角）+ 10 级合成；母题墨线不 tint。5 种资源母题全部就位，渲染管线无遗留。

---

## 5. 分级出图（每级一张，2026-07-06 改版 · 权威）

> **2026-07-07 · 粮草(ink) 已跟进 paper 全流程**：`res_ink_l6..l10`（一对瓶→三瓶簇→木架囤→大墨罐→墨仓）+ 空容器 `resbg_ink_a/b`（墨水台）已出图；`pack_resources.cjs` 的 `BAKE` 加 ink 一条、`HEAP_TYPES` 删 ink、`tintLevelFrame` 色带豁免推广到 `res_(paper|ink)_`；重跑产 55 帧 / 512×4096 / ~257 KB，client + map-editor 两份字节一致。ink 的 l1–5 计数托盘走同一 `bakeCountFrames`（母题 `res_ink` 填实 + 骰子槽），l6–10 专属真图保原墨色。
>
> **2026-07-07 修订（地图缩放可辨性 · 覆盖下方部分口径）**：编辑器实测——整片资源格缩到 34% 格宽后，等级几乎读不出（l1/l2/l3 仅差 1/2/3 张白纸，缩放下全糊成白点；且当时只有 paper 有分级帧，其余 4 资源任何级都画同一张母题）。为在**不改渲染程序**的前提下让等级缩放可辨，`pack_resources.cjs` 新增两条**烘焙进 atlas** 的层级编码（§5.9）：
> 1. **高度台阶**：每级帧固定 128 宽、目标高随等级单调递增（`ratioFor`/`targetH`），渲染按宽归一 → 高级 = 屏上更高更密。
> 2. **色带**：按等级叠一层去饱和 multiply 色阶（l1–2 冷青 → l3–4 sage → l5–6 tan → l7–8 琥珀 → l9 rust → l10 金）。**这一条推翻了 §5.3 #1「分级图不上色 / 颜色只由程序 tint 加」的原口径**——色现在直接烘焙进 atlas 帧。paper 的 l6–10 专属手绘**豁免**（保留原墨色，靠剪影区分）；paper l1–5 托盘与其余 4 资源全部上色带。
>
> 同时 ink/graphite/metal/sticker 在专属手绘就位前，改由脚本从各自母题**合成 l1–10 堆叠帧**（`bakeHeapFrames`，母题 `fillInteriorWhite` 填实后按等级叠堆），作为过渡；将来出了专属手绘再替换。改动只动打包脚本，client + map-editor 两份 atlas 仍逐字节一致（见 `feedback_slg_map_editor_client_parity`）。

### 5.1 资源 ↔ 三战对应 + 出图数

| 三战说法 | code enum | 文具名 | 母题（单体，l1–5 计数 token） | l6–10 专属 |
|---|---|---|---|---|
| 粮草 | `ink` | 墨水 | 一个小墨水瓶 | 5 张 ✅ 已上线（§5.7-ink） |
| 木材 | `paper` | 纸张 | 一张卷角的纸 | 5 张 ✅ 已上线 |
| 石料 | `graphite` | 石墨 | 一块带切面的石墨矿块 | 5 张 ✅ 已上线（§5.7-graphite） |
| 铁矿 | `metal` | 金属 | 一个长尾夹 | 5 张 ✅ 已出图上线（§5.7-metal）|
| 铜钱/铜矿 | `sticker` | 贴纸 | 一张翘角的星形贴纸 | **5 = l6–10**（上地图，只在 6 级地及以上）✅ 已出图上线（§5.7-sticker）|

> 分级用 **低档计数 + 高档专属**（§5.4）：l1–5 复用母题 ×N 叠到托盘背景（每资源 2 张专属背景），l6–10 每资源每级专属手绘。合计新增手绘 **4×5 = 20 张专属图 + 4×2 = 8 张背景 = 28 张**，加铜矿 5 张专属（无托盘）= **33 张**。
>
> **铜矿(sticker) 例外 = 只有 l6–10（2026-07-07 拍板）**：回到三战「铜矿是 6 级地及以上特例」（[SGZ_LAND_REFERENCE §49](../game/SGZ_LAND_REFERENCE.md)），铜矿**上地图**但只在等级 ≥6 的格子生成，产出铜钱（用于野外征兵等软操作）。推翻旧口径「贴纸=非地块/家城自产」（原 SLG_DESIGN §3.4 / SGZ_LAND_REFERENCE §52 已改）。因此铜矿**没有 l1–5**：无计数托盘、无 `resbg_sticker_*` 背景，只出 5 张专属手绘 `res_sticker_l6..l10`。prompt 见 §5.7-sticker。

### 5.2 关键反转：分级图要「画满丰度」（和母题相反）

母题层硬约束 #1 是「**只画 1 个、绝不画一堆**」（丰度靠程序复制）。**分级图正相反**：`res_{type}_l{level}` 是**一张图当单个精灵原样画、程序不再复制**，所以每张要**在一图内把该级的丰度画满**——低级稀疏、高级一大簇。渲染时按长边 ≈ 34% 格宽整体缩放贴在格中心。

### 5.3 硬约束（每张都要满足）

1. **单色墨线 + 纯白底**（和 5 母题、色块兜底同款）。**不上色、不阴影渐变**。原因：(a) 未出图的邻格仍用母题(单色墨线)模拟，分级图上色会让相邻格画风裂；(b) 打包脚本抠图是 `alpha = 255 − luma`（白底单色线前提），彩色图会被抠坏。→ **想要城池那种彩色水彩需另换打包管线，本轮不做。**
2. **贴丰度台阶**（§5.4），让 l1→l10 明显递进；相邻级差得出、又是同一物体在长大。
3. **剪影不靠颜色区分**：纸的分级图不管堆多高，轮廓要一眼读成「一摞纸」（层叠的扁平矩形），别糊成方块或和石墨棱堆撞。
4. **别画**：守备栅栏/箭塔/城垛（程序 lv4+/lv7+ 加）、等级数字角标（`PIXI.Text` 加）、阵营/中立框色（程序 tint）、文字、网格/横格线、投影、地面线。

### 5.4 分级方案（2026-07-06 定 · 低档计数 + 高档专属）

> **⚠️ 本节 l1–5「计数拼接」部分已于 2026-07-17 废止**（见顶部决策变更 II）。l1–5 现为每级专属手绘，规范见 **§5.4-lo**。下文保留作历史。l6–10「每资源专属手绘」部分仍有效（§5.7 各资源表格）。

> **为什么必须格面上就能读出精确等级**：守军强度随等级递增，玩家若一眼分不出级会**误伤**（去打打不过的守军）。所以精确等级要在地图格上直接可读，不能只塞进点击面板。又因纯数量在 34% 格宽下到高档糊成一坨（用户实测 l9 vs l10 几乎一样），拆成两段：

- **l1–5（全 5 资源通用）**：复用已验收的**母题图当计数 token**，摆 **N 个 = 等级**（1 个=lv1 … 5 个=lv5），骰子点式固定槽位，叠在背景上。精确等级靠数 token，≤5 是人眼一眼可辨的上限。**新增美术仅背景**（母题复用，5 资源一次全解决）。
- **l6–10（每资源各自出图）**：每种资源、每一级**专属手绘**，形态逐级跃迁，追求最佳表现。5 资源 × 5 级 = **25 张**。5→6 画风从「计数图」跳到「专属大图」，正好标记「进入强守军区」，强化误伤规避。

> 硬约束（§5.3 单色墨线 + 白底）对背景和专属图同样适用。木材的 1–5 计数底 + 6–10 专属阶梯见 §5.7；ink/graphite/metal 套同骨架（1–5 复用各自母题、6–10 各画形态阶梯），待写。铜钱(sticker)另议。

### 5.4-lo 低档分级（2026-07-17 定 · 权威 · l1–l5 每级专属手绘）

原则：**单母题逐级"长大"**，靠体量/繁简/高度递进一眼分辨，不再数个数。l5 = 最丰的"单堆"，正好顶到 l6 专属图下沿；5→6 跳到"容器/多体大簇"标记进入强守军区。渲染按宽归一 → 画得越高越满 = 屏上等级越高。守 §5.3 硬约束（单色黑墨 + 纯白底、不上色不阴影），**色带不再施加于这四类**（§顶部决策变更 II）。每条接 §5.5 共用前缀 + §5.6 共用负向。

**已出图上线（2026-07-17，gpt-image）**。各级主体（帧名 `res_{type}_l{n}`）：

| 级 | paper 木材 | ink 粮草 | graphite 石料 | metal 铁矿 |
|---|---|---|---|---|
| l1 | 单页（卷角） | 小空瓶 | 单块矿石 | 单只长尾夹 |
| l2 | 两页叠 | 带塞瓶 | 单块+1 碎屑 | 夹+1 小件 |
| l3 | 小叠~4 张 | 开塞+洒墨 | 块+几粒碎屑 | 夹+几件散落 |
| l4 | 大叠 | 满瓶（brimming） | 高石块 | 夹+更多散件 |
| l5 | 叠+卷一张 | 大墨罐溢出 | 大石+散屑 | 夹+一大堆散件（最满单夹） |

> **主体 prompt 全文**（接 §5.5 前缀）：
> - paper：`A single blank sheet of paper lying almost flat, one corner lightly curled up` / `Two blank sheets loosely overlapping, the top one slightly askew with a curled corner` / `A small loose stack of three or four blank sheets, edges uneven and fanned, top corner curled` / `A taller loose stack of blank sheets, one sheet sliding off the top, edges fanned out` / `A full loose stack of many blank sheets, one sheet loosely rolled resting on top, a stray sheet leaning at the base`
> - ink：`A single small squat glass inkwell bottle, one tiny ink drop near the rim, low and humble` / `A single slightly taller glass inkwell bottle with its cork stopper on top, a tiny ink drop at its base` / `A single glass inkwell bottle, cork off and lying beside it, a small ink puddle spreading at the base` / `A single taller fuller glass inkwell bottle brimming with ink, a couple of ink drops and a small blot around its base` / `One large round-bellied glass inkwell bottle brimming over, cork lying beside it, ink drops and a blot pooled around its base`
> - graphite：`A single small angular chunk of graphite ore, faceted like a rough crystal, a couple of short hatching strokes on one facet` / `A single small modest chunk of graphite ore, a low rough angular block, one tiny broken ore shard lying beside it` / `A single larger faceted graphite ore chunk with a few small ore shards scattered at its base` / `A single bigger boulder-like faceted graphite ore chunk standing taller, a couple of shards at its base` / `One large faceted graphite ore chunk with a small loose scatter of ore shards heaped around its base`
> - metal：`A single metal binder clip (foldback clip), a chunky triangular body with two thin looped wire handles sticking up` / `A single metal binder clip with one small loose paper fastener or metal bit lying beside it` / `A single metal binder clip with a couple of small metal bits scattered at its base` / `A single larger foldback clip standing taller, two looped wire handles up, a small metal bit or two at its base` / `One metal binder clip standing amid a big loose heap of assorted small metal hardware piled and spilling all around its base`
>
> 剪影铁律（同 §5.7）：paper=层叠扁矩形 / ink=圆肚瓶罐 / graphite=尖锐棱块 / metal=三角夹身+两根线圈，四者一眼互不撞。**替换单张成本极低**（丢 `res_{type}_l{n}.{png,webp}` 进 `art/slg/slg-map/` 重跑脚本即可，零改代码）。

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

### 5.7-ink 粮草 = `ink`（1–5 计数 + 6–10 专属）· 2026-07-07 出图

> 套木材(§5.7)同一骨架：l1–5 复用已验收母题 `res_ink`（矮胖墨水瓶）当计数 token，脚本按骰子槽叠 N 个=等级到背景；l6–10 每级专属手绘，形态逐级跃迁。剪影主题=**玻璃墨水瓶 / 圆肚墨罐**（圆润容器），与纸(层叠扁矩形)、石墨(棱块)、金属(线圈夹)一眼区分。所有图守 §5.3 硬约束（单色墨线 + 纯白底，不上色不阴影）。

**l1–5：母题计数 + 托盘背景**。token = 母题 `res_ink`（单个矮胖墨水瓶），骰子槽叠 **N 个 = 等级**。背景 = 收墨建筑 `inkPot` 的容器（墨水台/瓶架，与内政建筑呼应），**专属 2 张**，按 `l1–3 / l4–5` 分，画**空**容器（瓶由脚本叠上）：

| 背景 | 覆盖级 | 主体 prompt（接 §5.5 前缀，画**空**容器） |
|---|---|---|
| `resbg_ink_a` | l1–3 | `an empty desk ink stand for inkwells: a simple low open rectangular holder with a couple of round empty wells / recesses on top, drawn at a gentle isometric angle, blank and empty, no bottles in it` |
| `resbg_ink_b` | l4–5 | `an empty sturdier two-tier wooden ink stand / small open crate for ink bottles, slightly worn frame with round empty slots, drawn at a gentle isometric angle, blank and empty, no bottles in it` |

**l6–10：每级专属手绘**（接 §5.5 共用前缀），形态逐级跃迁，剪影各异（一对瓶 → 三瓶簇 → 木架囤 → 大墨罐 → 墨仓）：

| 级 | 帧名 | 形态 | 主体 prompt |
|---|---|---|---|
| l6 | `res_ink_l6` | 一对瓶 | `a pair of small glass inkwell bottles standing side by side, one slightly taller than the other, a couple of tiny ink drops near their rims` |
| l7 | `res_ink_l7` | 三瓶簇 | `a small cluster of three glass inkwell bottles of slightly different sizes grouped closely together, one with its cork/lid off` |
| l8 | `res_ink_l8` | 木架囤 | `a small wooden rack or open crate holding several glass inkwell bottles standing in a row, a couple more bottles resting beside its base` |
| l9 | `res_ink_l9` | 大墨罐 | `one large bulbous round-bellied ink jug / demijohn standing tall with a short neck, with two or three small inkwell bottles clustered at its base` |
| l10 | `res_ink_l10` | 墨仓 | `an overflowing store of ink: one big round-bellied ink vat / barrel with a little spout, many glass inkwell bottles crowded around it, a few ink drops spilling at the base — the richest, most imposing ink stockpile` |

> 6–10 每条抽 3–5 张挑 1，都要读得出是「墨水/墨罐」（圆肚玻璃瓶 / 圆罐），别糊成方盒或和石墨棱堆撞。墨水台背景抽图时确保**空**（瓶由脚本叠），且台面轮廓别和 token 的瓶身糊在一起。剪影最容易撞的是 `ink` 圆瓶堆 vs `metal` 长尾夹——盯一下确保「圆肚容器」感 vs「三角夹+线圈」能一眼分开。

### 5.7-graphite 石料 = `graphite`（1–5 计数 + 6–10 专属）· ✅ 已出图上线 2026-07-07

> 套木材(§5.7)/粮草(§5.7-ink)同一骨架：l1–5 复用已验收母题 `res_graphite`（带切面矿块）当计数 token，脚本按骰子槽叠 N 个=等级到背景；l6–10 每级专属手绘，形态逐级跃迁。剪影主题=**带切面的棱角矿块 / 晶体块**（尖锐硬边 + 切面斜排线），与纸(层叠扁矩形)、墨水(圆肚瓶)、金属(线圈夹)一眼区分。所有图守 §5.3 硬约束（单色墨线 + 纯白底，不上色不阴影）。

**l1–5：母题计数 + 托盘背景**。token = 母题 `res_graphite`（单块矿石），骰子槽叠 **N 块 = 等级**。背景 = 采矿容器（矿斗/矿车，与 `graphiteMill` 呼应），**专属 2 张**，按 `l1–3 / l4–5` 分，画**空**容器（矿石由脚本叠上）：

| 背景 | 覆盖级 | 主体 prompt（接 §5.5 前缀，画**空**容器） |
|---|---|---|
| `resbg_graphite_a` | l1–3 | `an empty low open ore bin for mined stone: a simple open rectangular bin with low slightly slanted plank walls, drawn at a gentle isometric angle, blank and empty, nothing inside` |
| `resbg_graphite_b` | l4–5 | `an empty sturdier wooden ore cart with two small wheels and low plank sides, slightly worn frame, drawn at a gentle isometric angle, blank and empty, nothing inside` |

**l6–10：每级专属手绘**（接 §5.5 共用前缀），形态逐级跃迁，剪影各异（双块 → 小堆 → 矿车囤 → 巨石 → 矿仓）：

| 级 | 帧名 | 形态 | 主体 prompt |
|---|---|---|---|
| l6 | `res_graphite_l6` | 双矿块 | `a pair of chunky angular graphite ore chunks resting side by side, sharp faceted crystal-like blocks, a few short hatching strokes on one facet of each` |
| l7 | `res_graphite_l7` | 小矿堆 | `a small loose pile of three or four faceted graphite ore chunks of different sizes heaped together, short hatching strokes on the top facets` |
| l8 | `res_graphite_l8` | 矿车囤 | `a small wooden ore cart heaped with faceted graphite ore chunks piled above its rim, a couple more chunks resting on the ground beside a wheel` |
| l9 | `res_graphite_l9` | 巨矿石 | `one large boulder-sized faceted block of graphite ore standing tall, sharp angular facets with hatching, two or three smaller chunks clustered at its base` |
| l10 | `res_graphite_l10` | 矿仓 | `an overflowing stockpile of mined graphite ore: one big faceted boulder, many angular ore chunks crowded and piled around it, a few small chunks spilling at the base — the richest, most imposing stone stockpile` |

> 6–10 都要读成「带棱角的石块堆」（尖锐晶体切面 + 切面斜排线），别糊成平滑砖块或和纸堆撞。矿斗/矿车背景抽图时确保**空**（矿石由脚本叠）。

### 5.7-metal 铁矿 = `metal`（1–5 计数 + 6–10 专属）· ✅ 已出图上线 2026-07-08

> 套木材(§5.7)/粮草(§5.7-ink)/石料(§5.7-graphite)同一骨架：l1–5 复用已验收母题 `res_metal`（单个长尾夹）当计数 token，脚本按骰子槽叠 N 个=等级到背景；l6–10 每级专属手绘，形态逐级跃迁。剪影主题=**三角夹身 + 两根细线圈的长尾夹（foldback clip）**，与纸(层叠扁矩形)、墨水(圆肚瓶)、石墨(棱块)一眼区分。所有图守 §5.3 硬约束（单色墨线 + 纯白底，不上色不阴影）。铁矿=军工/锻造位。
>
> **出图落地记录（2026-07-08）**：7 张源图（`resbg_metal_a`=浅托盘/l1–3、`resbg_metal_b`=带提手双格木工具盒/l4–5、`res_metal_l6`=双夹、`l7`=四夹簇、`l8`=开盖铁盒装满、`l9`=一巨夹+底部小夹群、`l10`=一大堆）已按 §5.9 落地清单入 atlas：`BAKE` 加 metal 条、`HEAP_TYPES` 删 metal（现空）、`tintLevelFrame` 免色带正则加 metal。重跑产 **50 帧 / 512×2048 / ~334 KB**，client + map-editor 两份逐字节一致，零改运行时代码。

**l1–5：母题计数 + 托盘背景**。token = 母题 `res_metal`（单个长尾夹），骰子槽叠 **N 个 = 等级**。背景 = 收铁建筑 `metalForge` 的容器（金属零件盘/工具盒，与内政建筑呼应），**专属 2 张**，按 `l1–3 / l4–5` 分，画**空**容器（夹子由脚本叠上）：

| 背景 | 覆盖级 | 主体 prompt（接 §5.5 前缀，画**空**容器） |
|---|---|---|
| `resbg_metal_a` | l1–3 | `an empty small open metal parts tray / shallow tin bin for holding binder clips, a simple open rectangular metal tray with low slightly dented walls, drawn at a gentle isometric angle, blank and empty, nothing inside` |
| `resbg_metal_b` | l4–5 | `an empty sturdier two-compartment metal toolbox tray with a low carry handle, slightly worn dented frame, drawn at a gentle isometric angle, blank and empty, nothing inside` |

**l6–10：每级专属手绘**（接 §5.5 共用前缀），形态逐级跃迁，剪影各异（双夹 → 夹簇 → 工具盒囤 → 巨夹 → 铁料仓）：

| 级 | 帧名 | 形态 | 主体 prompt |
|---|---|---|---|
| l6 | `res_metal_l6` | 双夹 | `a pair of metal binder clips (foldback clips) resting side by side, each a chunky solid triangular body with two thin looped wire handles sticking up, one clip slightly larger than the other` |
| l7 | `res_metal_l7` | 夹簇 | `a small cluster of three or four metal binder clips of different sizes grouped closely together, chunky triangular bodies with thin looped wire handles sticking up at slightly different angles` |
| l8 | `res_metal_l8` | 工具盒囤 | `a small open metal tin / box heaped with many metal binder clips piled above its rim, their thin wire handles poking up in a jumble, a couple more clips resting on the ground beside it` |
| l9 | `res_metal_l9` | 巨夹 | `one large oversized metal binder clip standing tall, a chunky triangular body with two big looped wire handles sticking up, with three or four smaller binder clips clustered at its base` |
| l10 | `res_metal_l10` | 铁料仓 | `an overflowing store of metal binder clips: one big oversized foldback clip, many chunky triangular clips crowded and piled around it with wire handles sticking up everywhere, a few loose clips spilling at the base — the richest, most imposing pile of metal hardware` |

> 6–10 每条抽 3–5 张挑 1，每级都要读得出「三角夹身 + 两根细线圈」这个金属剪影，别糊成实心块（撞 graphite 棱块）或方盒。剪影最易撞的是 `metal` 夹堆 vs `graphite` 矿块堆 vs `ink` 圆瓶堆——出图时并排比一下确保「线圈夹子」感能一眼分开。托盘背景抽图确保**空**（夹子由脚本叠），托盘轮廓别和 token 的夹身糊在一起。

**落地清单（待出图后执行，2026-07-07）**：照 §5.9「专属出图后落地清单」——源图 `res_metal_l6..l10` + 空容器 `resbg_metal_a/b`（白底 png/webp）放 `art/slg/slg-map/` → `pack_resources.cjs` 里 (a) `BAKE` 加 `{ type:'metal', token:'res_metal', bgA:'resbg_metal_a', bgB:'resbg_metal_b' }`，(b) 从 `HEAP_TYPES` 删 `metal`（专属帧接管），(c) `tintLevelFrame` 的 l6–10 免色带正则加 `metal`（专属手绘保原墨色）→ 重跑 `node art/slg/slg-map/pack_resources.cjs`，client + map-editor 两份 atlas 逐字节一致。**零改运行时代码**（`getResLevelTexture('metal',1..10)` 命中即画）。

### 5.7-sticker 铜钱/铜矿 = `sticker`（**仅 l6–10** · ✅ 已出图上线 2026-07-07）

> **决策反转（2026-07-07，用户拍板）**：铜矿回到三战规则——**上地图、只在等级 ≥6 的格子生成**（[SGZ_LAND_REFERENCE §49](../game/SGZ_LAND_REFERENCE.md)：铜矿是 6 级地及以上特例）。推翻旧口径「贴纸=非地块、家城自产、主动避开三战铜矿只在高级地」（原 SLG_DESIGN §3.4 / SGZ_LAND_REFERENCE §52，已同步改）。铜矿产**铜钱**，铜钱用于野外征兵等软操作（家城 `stickerShop` 是否仍并存产出=经济侧 TBD，本节只管地图美术）。
>
> 因此铜矿**没有 l1–5**：无「计数托盘」、无 `resbg_sticker_*` 背景，只出 **5 张专属手绘 `res_sticker_l6..l10`**。母题不变=翘角五角星贴纸（铜币位，读成「钱/币」），五角星是 5 资源里唯一星形剪影，天然不撞瓶/纸/棱块/夹子。守 §5.3 硬约束（单色墨线 + 纯白底，不上色不阴影渐变）。

**l6–10：每级专属手绘**（接 §5.5 共用前缀 + §5.6 共用负向），形态逐级跃迁，剪影各异（短叠 → 叠簇 → 贴纸卷 → 卷+堆 → 铜钱仓）：

| 级 | 帧名 | 形态 | 主体 prompt |
|---|---|---|---|
| l6 | `res_sticker_l6` | 初露 | `a small short stack of a few shiny five-pointed star-shaped stickers, the top star peeling up at one corner, one or two loose stars lying beside the stack` |
| l7 | `res_sticker_l7` | 叠簇 | `a taller leaning stack of five-pointed star stickers with several peeled stars stuck on around it at different angles, a couple of loose stars at the base` |
| l8 | `res_sticker_l8` | 贴纸卷 | `a small roll of sticker tape printed with five-pointed stars, partly unspooled so a short strip of star stickers trails out, a few loose peeled stars nearby` |
| l9 | `res_sticker_l9` | 卷+堆 | `one large roll of star-sticker tape standing upright beside a tall stack of five-pointed star stickers, a scatter of loose peeling stars heaped at the base` |
| l10 | `res_sticker_l10` | 铜钱仓 | `an overflowing hoard of five-pointed star stickers: a big upright roll of star-sticker tape, tall leaning stacks of stars, and loose peeling stars spilling out at the base — the richest, most imposing pile of sticker "coins"` |

> 6–10 每条抽 3–5 张挑 1。**剪影注意**：每一级都要让**五角星形 + 翘角**贯穿，别糊成 paper 的「一摞扁矩形」；l8/l9 的「贴纸卷」卷面要**露出星星条带**，别读成 ink 的圆罐或 paper 的大纸卷。
>
> **色带（与 paper/ink/graphite 专属帧不同 → 保留）**：铜钱是货币资源，`tintLevelFrame` 的按级色带（l6 tan → l10 gold）恰好把琥珀→金读成「铜/金钱」，主题加分 → 铜矿 l6–10 **不豁免**，专属帧照上色带（即 `tintLevelFrame` 免色带正则**保持不含** sticker）。

**落地（✅ 已执行，2026-07-07）**：
1. ✅ 源图 5 张按丰度定级重命名进 `art/slg/slg-map/`：l6=`res_sticker_l6.webp`(短叠~4+2散) / l7=`res_sticker_l7`(一叠+8散,无卷) / l8=`res_sticker_l8`(单卷半展+3散) / l9=`res_sticker_l9`(卷+一高叠+~10散) / l10=`res_sticker_l10`(大卷+多高叠+满地散)。主扫描 `loadSprite` 自动收。
2. ✅ `pack_resources.cjs`：从 `HEAP_TYPES` 删掉 `sticker`（专属帧接管）；未加 `BAKE`（无 l1–5 托盘）；`tintLevelFrame` 免色带正则保持 `res_(paper|ink|graphite)_`（**不含** sticker → 专属帧照上色带）。
3. ✅ 重跑脚本 → **50 帧 / 512×2048 / ~290 KB**（sticker 由 10 堆叠帧降为 5 专属，净 −5 帧），client + map-editor 两份 atlas 逐字节一致；`res_sticker_l6..l10` 就位、无 l1–5。**零改运行时代码**（`getResLevelTexture('sticker',6..10)` 命中即画）。
4. ✅ **worldsvc 生成门槛已落地**（2026-07-07）：`mapgen.ts` 新增 `resTypeFor(x,y,seed,level)`——resource 格在 `level ≥ SLG_GEN.copperMinLevel`(=6) 时按 `copperShare`(=0.3) 抽取覆盖为 `sticker`，否则四种生物群系陆地资源。plain resource 格才应用（stronghold/familyKeep/center 保生物群系资源、画建筑不画资源母题）。产出侧 `tileYield` 对任何 resType 通用（铜矿格自然产铜钱）。全图扫描验证：铜矿 =资源格 3.4%（≈≥6 格的 30%），**level<6 的 sticker = 0**；shared 544 + worldsvc 192 全绿。

### 5.8 打包管线（2026-07-17 简化 · 纯手绘帧，无合成）

**所有帧同一条路**（母题 + 各资源 l1–l10 + sticker l6–10 全是白底手绘真图）：
1. 白底 png/webp `res_<type>_l<n>.{png,webp}` 放 `art/slg/slg-map/`（文件名即帧名，去扩展）。
2. 重跑 `node art/slg/slg-map/pack_resources.cjs`：主扫描 `^res_.*\.(webp|png)$` 逐张 `loadSprite`（近白→透明 `alpha=255−luma` 保原墨色 + 裁透明边 + 等比缩长边 128）→ `tintLevelFrame`（**仅 sticker 上色带**，其余保黑墨）→ shelf-pack → 写两份字节一致的 atlas。
3. **零改运行时代码**——`getResLevelTexture('<type>',n)` 命中 `res_<type>_l<n>` 即画。
4. **替换/新增单张成本极低**：丢新图进目录、重跑脚本即可。

**产物**：`client/src/assets/slg/res_atlas.{png,json}` + `tools/map-editor/src/assets/slg/` 两份字节一致（`OUT_DIRS` 一次写两处）。当前 **50 帧**（5 母题 + paper/ink/graphite/metal 各 l1–10 + sticker l6–10），**512×2048，~395 KB**。

> 历史（2026-07-06 → 07-08）：曾用 `bakeCountFrames`（l1–5 母题+骰子槽计数托盘）+ `bakeHeapFrames`（过渡态合成堆叠）+ `resbg_*` 托盘背景。**均于 2026-07-17 删除**（决策变更 II），l1–5 改专属手绘。

### 5.9 待定项 / 收尾

- **构建期合成已彻底移除**（2026-07-17）：`bakeCountFrames`/`bakeHeapFrames`/`fillInteriorWhite`/`BAKE`/`DICE`/`HEAP_TYPES`/高度台阶常量全部删除；8 张 `resbg_*` 托盘背景移入 `art/leftover/`。脚本现只做「扫描→抠图→(sticker)色带→打包」。
- **色带（BAND）现状**：仅 sticker l6–10（tan→gold=铜→金）。paper/ink/graphite/metal 全等级保黑墨（`tintLevelFrame` 豁免正则 `^res_(paper|ink|graphite|metal)_`）。
- **可选后续**：若实测低档在整图缩放下仍难辨（silhouette 不够），再单独给这四类补一档极淡的按级 wash（勿回退计数拼接）。
- ~~**l1–5 落地方式**~~：✅ 已定=**烘焙合成**（§5.8 步骤 3），token 走 `fillInteriorWhite` 填实后叠骰子槽。粮/木/石/铁全部复用同一 `bakeCountFrames`。
- **铜钱/铜矿(sticker)** ✅ 已全链路上线（2026-07-07）：美术 l6–10 五张专属进 atlas + worldsvc 生成门槛（`resTypeFor`：resource 格 lvl≥6 按 `copperShare` 覆盖为 sticker，`SLG_GEN.copperMinLevel/copperShare`）。全图扫描验证 level<6 无 sticker、铜矿占资源格 3.4%。见 §5.7-sticker。**经济侧 TBD**：家城 `stickerShop` 是否与地图铜矿并存产铜钱、copperShare 数值调参。

---

## 6. 分级读数重构（2026-08-19 定 · 权威 · 覆盖 §5.3 #2 / §5.4 的形态跃迁条款）

> 触发：用户截图圈出三块 4 级墨水地，反馈「图片大小和第一眼印象明显不是一种地」。查证后发现问题不在这三格，而在**分级读数的整套契约自我否定**。

### 6.1 病根：按宽归一惩罚横向生长

旧契约（`pack_resources.cjs` 注释 + §5.4-lo 末句）：「渲染按宽归一 → 画得越高越满 = 屏上等级越高」。渲染层 `drawResMotif` 的 `denom = tex.width` 忠实实现了它。

但高等级的丰度在画稿里是**横着铺开**（多瓶并排、一簇、一堆）表达的，内容 bbox 变宽，按宽归一立刻把整幅压小——**画得越多，屏上越小**。任何用横向表达"更多"的画法都满足不了这个契约。

实测（把每帧墨量 Σα 按游戏真实缩放折算成"落在一格上的墨量"，相对 ink l1 = 1.00）：

| | l1 | l2 | l3 | l4 | l5 | l6 | l7 | l8 | l9 | l10 |
|---|---|---|---|---|---|---|---|---|---|---|
| ink | 1.00 | 4.35 | 2.59 | **6.44** | 3.80 | 3.52↓ | 3.50 | 2.14 | 2.11 | 3.72 |
| paper | 0.25 | 0.59 | 0.68 | 1.97 | 2.28 | 0.67↓ | 0.83 | 1.26 | 1.79 | 2.97 |
| graphite | 0.86 | 1.20 | 1.17 | 2.50 | 1.45 | 0.99↓ | 1.41 | 2.43 | 2.17 | 3.23 |
| metal | 1.05 | 1.19 | 1.58 | 1.75 | 1.85 | 1.40↓ | 2.02 | 2.62 | 1.79 | 3.52 |

**四类全部在 l5→l6 回落**——正是画法从「单母题长高」（§5.4-lo）跳到「容器/多体大簇」（§5.4 l6–10）的接缝。且 ink l4（6.44）是全十级里视觉最重的一帧，比 l10 重 1.7 倍——这就是用户圈出 4 级地的直接原因。

同级之间的大小差另有来源：`motifJitter` 的 `scale ∈ [0.85,1.15]`，相邻格实测能到 1.15 vs 0.88 = 1.31×。

### 6.2 裁决

1. **剪影铁律（§5.3 #3）优先，§5.4 的「l6–10 形态逐级跃迁，追求最佳表现」作废。** 同一 resType 的 l1–l10 必须是**同一个主体物件**；等级只通过「个数 + 堆量 + 溢出/碎屑」增长。不得引入容器、载具、器皿、卷状物（现有违规见 §6.5）。
2. **5→6 的画风跳变作废。** l1–l10 是一条连续的量级线，不再分低档段/高档段。
3. **归一化从「按宽」改为「按等效面积」** `√(w·h)`。横排与竖立占同样视觉面积，横向生长不再被惩罚——**画稿从此不必为了"更高"而扭曲构图**。
4. **尺寸改由显式曲线承载**：`LEVEL_SCALE = 0.80 → 1.30`（线性，l10 占地 0.30×1.30 = 0.39 tp，仍在 2026-07-17 判定过大的 0.40 以内，且只有稀有的高级格吃到）。等级→尺寸从"画稿隐式"变成"代码显式"。
5. **alpha 只做小幅修正，不当通道**：`alpha ∈ [0.85, 1.00]`，仅用来削平画稿之间的小落差，替换裸线性 `0.55+0.45*(lv-1)/9`。全图是一支笔画的，某格 0.4、邻格 1.0 读作「换了笔」，不是「资源更少」。
   > **这一条是被实测打回来改的**：第一版门禁允许 alpha 自由补偿总墨量 Σα，结果它给当前这批画稿判了**通过**——它的"解"是把 ink l4 压到 alpha 0.37、l9 留在 1.00，总墨量确实单调了，但浓淡在格间乱跳，正是本契约要防的观感。**Σα 不是正确的感知模型**：一个大而淡的形状和一个小而黑的形状墨量可以相等，眼睛读到的完全不同。→ 等级读数只由「占地曲线 + 画稿自身疏密」承载，于是「某级画得比下一级还空」成为**代码救不了的画稿硬伤**，只能由构建期拒绝。
6. **抖动只保留 rot/offset**，`scale` 收窄到 `[0.96,1.04]`。同级不再有可察觉的大小差。
7. **精确等级恢复为显式通道**（§5.4 的原始诉求「格面上能读出精确等级，否则玩家误伤」在决策变更 II 里被放弃，现在补回，但不用符号编码）：沿用 2026-08-01 主城标签的先例（[`WORLD_MAP_ART_SPEC.md`](../game/WORLD_MAP_ART_SPEC.md) 四节末：符号点阵"让人迷惑"→ 换纯文字 `Lv.{n}`），资源格同样画文字，但**仅 l6+ 且仅近 zoom 显示**——会误伤的是强守军区，低档靠体量读三档足够；`resourceDensity=1.0` 下全等级都标就是满屏噪音。**用位图数字图集或 BitmapText，不要每格 `new PIXI.Text`**（Text 纹理销毁泄漏）。

### 6.3 构建期强制（`pack_resources.cjs`）

画稿层的单调性不再靠画师自觉，改为门禁：

- 每帧计算 `inkMass = Σα`、`density = inkMass/(w·h)`、`equivEdge = √(w·h)`，连同解出的 `sizeMul = LEVEL_SCALE(lv)/equivEdge` 和 `alphaMul` 一起写进**每个 frame 条目的 `nw` 字段**——不是 `meta`：`mergeAtlasPages.js` 只取源 json 的 `data.frames`、`meta` 自己重写，放 `meta` 会被静默丢弃；frame 条目是 `{...f}` 整体展开的，自定义字段能穿过合并落进 `world_atlas.json`，也就是客户端真正加载的那一份。PIXI 的 Spritesheet 只读已知键，忽略 `nw`。
- **等级读数整条在构建期解完**：渲染层因此不含任何 level→尺寸/透明度逻辑，只剩 `scale = tp × MOTIF_SIZE_FRAC × nw.sizeMul × jitter.scale`、`alpha = nw.alphaMul`。图集成为等级读数的唯一权威，client 与 map-editor 两份渲染器不可能再漂移（旧代码靠注释里的「must stay in lockstep」人肉保证）。
- **求解**：`reach(lv) = density × LEVEL_SCALE(lv)²` 是满笔时的落屏墨量。从 l1 起按最低可行值**前向贪心**，每级至少比上一级高 `INK_GROWTH = 1.06`，同时每帧 alpha 必须留在 `[ALPHA_MIN=0.85, 1]`。这给出最低可行曲线——某级的 `reach` 连它都达不到（容差 `GATE_EPS = 1.02`），就是**真的画得比下一级还空**，与调参无关。
- 不达标 pack 直接 `exit 1`，逐帧打印短缺百分比和两条修法（画满这一级，或画淡下一级）。过渡期可 `--report-only` 照常出图（新美术还没到位时不阻塞渲染层开发），CI 不带这个开关。
- **为什么必须是硬门禁**：alpha 只能把画满的**压淡**，`alpha ≤ 1` 意味着**没法把画空的补浓**。

### 6.4 重画清单（17 张 / 46）

两类并集。**B 类**＝§6.3 门禁实测判定（短缺%＝该帧满笔仍差多少才够压过下一级），**A 类**＝剪影铁律违规，门禁看不见，靠 §6.2 #1 裁决。

| 资源 | 帧 | 类 | 原因 |
|---|---|---|---|
| ink | l5 | B | 短缺 7%；圆肚壶偏离 l1–l4 的圆肩直筒瓶族 |
| | l6 | B | 短缺 9%；换成方肩瓶（轻度换族） |
| | l7 | B | 短缺 8% |
| | l8 | **A** | **试管架**＝实验室器材/容器 |
| | l9 | B | **短缺 85%**（全表最严重）：一个大而空的单体瓶，读作"空"而非"高" |
| paper | l6 | B | **短缺 129%**（全表之最）：糊成方块/箱，直接违反 §5.3 #3「轮廓要一眼读成一摞纸」 |
| | l7 | **A** | 换成**卷轴+绑带** |
| | l9 | **A** | **大圆筒/卷纸**，读作卫生纸卷 |
| graphite | l5 | B | 短缺 6% |
| | l6 | B | 短缺 39%；换成瘦长晶柱，偏离尖锐棱块族 |
| | l8 | **A** | **矿车**＝载具 |
| | l9 | B | 短缺 15%；单个大晶体独大 + 偏空 |
| metal | l5 | **A** | 主体夹被碎屑堆**淹没**，剪影读不出（破 §5.3 #3） |
| | l6 | B | 短缺 15% |
| | l8 | **A** | **铁盒/罐**＝容器 |
| | l9 | B | 短缺 41%，量级比 l8 还回退 |
| sticker | l8 | B | 短缺 8%；**贴纸卷**＝卷状条带 |

> **ink l4 / graphite l4 不在清单里**（初稿曾列为"减密度"）。它们 density 确实冲顶，但门禁改成「保持笔触浓度」判据后，正确修法是把**上面那级画满**，而不是把这级画淡——`0.85` 的 alpha 下限只允许微调，画淡不是可用手段。同理 graphite l3、paper l8 落在 `GATE_EPS` 容差内，不必重画。
>
> **系统性规律**：**l8 普遍冒出容器/载具**（试管架、矿车、铁盒、贴纸卷），**l9 普遍是"一个大而空的单体"**（ink 短缺 85%、metal 41%、graphite 15%）。成因就是 §5.4 那句"形态逐级跃迁，追求最佳表现"——它和 §5.3 #3 的剪影铁律在文档内部本就矛盾，本次由 §6.2 #1 裁决。

### 6.5 出图 prompt（接 §5.5 共用前缀 + §5.6 共用负向，另加下面两段增补）

**共用前缀增补**（面积归一后留白直接浪费密度；横向不再被罚）：

```
The subject fills the frame edge to edge with only a thin even margin — no large
empty areas anywhere in the frame. The composition may spread horizontally or
vertically, whichever reads better; wide compositions are not penalised.
```

**共用负向增补**：

```
rack, tray, shelf, crate, box, tin, jar lid, container, cart, wagon, wheels,
scroll, rolled paper, tube, cylinder, laboratory glassware, test tubes, ribbon
```

**主体句**（帧名 → prompt）：

- `res_ink_l5`：`A single round-shouldered glass inkwell bottle brimming with ink, its cork lying beside it, a second empty bottle tipped over behind it, ink drops and a spreading blot pooled around both`
- `res_ink_l6`：`Two round-shouldered glass inkwell bottles standing close together, both filled with ink, a cork and a few ink drops at their base`
- `res_ink_l7`：`Three round-shouldered glass inkwell bottles clustered close together, all filled with ink, one slightly taller, corks and ink drops scattered at their bases`
- `res_ink_l8`：`Five round-shouldered glass inkwell bottles packed tightly together in a loose freestanding cluster, all filled with ink, corks and ink drops crowded around their bases`
- `res_ink_l9`：`Seven round-shouldered glass inkwell bottles crowded together in a dense freestanding heap at slightly varied heights, all filled with ink, several corks and a spreading ink blot pooled underneath`
- `res_paper_l6`：`A tall loose stack of blank sheets with a second shorter stack leaning against it, edges fanned and uneven, a few loose sheets sliding off the top`
- `res_paper_l7`：`Two tall loose stacks of blank sheets standing side by side, edges fanned and uneven, several loose sheets slipping out between them`
- `res_paper_l9`：`Five loose stacks of blank sheets crowded together at differing heights, edges fanned and uneven, loose sheets spilling all around their bases`
- `res_graphite_l5`：`A single large angular faceted graphite ore chunk standing upright with a generous loose scatter of ore shards heaped all around its base, hatching on two facets`
- `res_graphite_l6`：`Two angular faceted graphite ore chunks of different sizes resting against each other, a scatter of small ore shards heaped around their bases`
- `res_graphite_l8`：`A dense freestanding pile of six angular faceted graphite ore chunks heaped up, smaller shards filling the gaps between them`
- `res_graphite_l9`：`A dense freestanding heap of eight angular faceted graphite ore chunks piled together, many small shards filling every gap, no single chunk dominating`
- `res_metal_l5`：`A single metal binder clip standing clearly in front of a loose heap of small metal hardware, the clip's triangular body and two looped wire handles fully readable against the heap`
- `res_metal_l6`：`Two metal binder clips standing side by side, one slightly turned, with a scatter of small metal bits and fasteners heaped around their bases`
- `res_metal_l8`：`Five metal binder clips packed tightly together at different angles in a freestanding cluster, small metal bits filling the gaps between them`
- `res_metal_l9`：`Seven metal binder clips crowded into a dense freestanding heap at varied angles, looped wire handles overlapping, small metal hardware filling every gap`
- `res_sticker_l8`：`A thick stack of star-shaped stickers with more loose stars fanned out around it, several stars overlapping the stack`

> **⚠️ 新美术落地时会撞上一个管线陷阱**：客户端真正加载的是**合并页** `client/src/assets/slg/world_atlas.{png,json}`，而 2026-07-27 的资产整理把 `terrain/city/playerbase/building/city_bld` 这些源图集**从仓库里删掉了**，`mergeAssetAtlases.js` 已不可重跑（缺输入）。本次因为画稿未变、帧尺寸未变，可以用 `node art/scripts/patchMergedAtlas.js client/src/assets/slg/res_atlas.json client/src/assets/slg/world_atlas.json` 就地回贴（它会连带搬运 `nw` 这类自定义 per-frame 字段）。**但新画稿的长宽比一定会变，帧尺寸随之改变，`patchMergedAtlas.js` 会直接拒绝**（它只支持同尺寸回贴）。届时必须：从 git 历史恢复那几个被删的源图集 → 重跑 `mergeAssetAtlases.js` 做整页重排 → 或者给 patch 脚本加"重排整页"能力。**出图之前先把这条路打通**，否则图出完了进不去客户端。
>
> **20 → 17 张的调整**：`res_ink_l4` / `res_graphite_l4` / `res_graphite_l3` / `res_paper_l8` 的 prompt 已撤（理由见 §6.4 末），新增 `res_graphite_l5`。
>
> 出图后丢进 `art/slg/slg-map/` 重跑 `node art/slg/slg-map/pack_resources.cjs`——§6.3 的校验器会直接判定通过/不通过，不达标的帧会打印在违规表里，按表迭代即可。**不需要人肉目测单调性。**
