# 批次 10：「保护中」的伞（`umbrella`，1 张）— 语义判断 + Prompt 文档

> 创建：2026-09-03 · 状态：**全批完成（同日）**——1 张出图 + 接线 + 26/28px 双衬底 + 真机实拍验收，**一版过**（见 §6）。全库账：**57 张自有美术 + 6 个别名 = 63 个 ink kind**
> 前九批：[批 1–4](tab-icon-art-prompts.md) · [批 5](tab-icon-art-prompts-batch5.md) · [批 6](tab-icon-art-prompts-batch6.md) · [批 7](tab-icon-art-prompts-batch7.md) + [批 7 log](tab-icon-art-prompts-batch7-log.md) · [批 8](tab-icon-art-prompts-batch8.md) · [批 9](tab-icon-art-prompts-batch9.md)
> 配套代码：[`inkIconRaster.ts`](../../client/src/render/icons/inkIconRaster.ts) · [`pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs) · [`WorldMapPanels/hud.ts`](../../client/src/scenes/worldmap/WorldMapPanels/hud.ts)
> 上游：[批 9 §「『保护中』的盾不在本批」](tab-icon-art-prompts-batch9.md) —— 那条把它留成 backlog，理由是「画盾 / 画伞 / 用 `lock` 是一次独立的语义判断，不该顺手塞进一批以地块结构物为主题的出图里」

## 0. 先纠一条事实：这一行不是「没有图标」

上游把它记成「目前无图标」，实测不是。[`hud.ts`](../../client/src/scenes/worldmap/WorldMapPanels/hud.ts) 的保护倒计时 buff 行挂着 **`armorHeavy`**，而 `armorHeavy` 是批 7 v3 的**纹章式四分圆**（一竖一横把圆盘切四份、左上与右下填实黑、中心一枚实心钉）。批 7 的验收结论原文已经把代价写在案上：

> 「**残留**：它更像纹章/饼图而不是「护甲」，语义靠词条文字承担；这是拿「28px 分得开 + 不撞车」换来的，接受」

在装备词条行里「语义靠文字承担」成立（旁边就写着"护甲 12"）。在这一行不成立：这一行的文字是"保护中（剩 0 天 1 时 29 分）"，图标要说的正是**保护**这件事本身。

**同一屏上它还有第二、第三个含义**（2026-09-03 实拍确认，`hud.ts` 一次 `renderHud` 里全部画出来）：

| 位点 | 改前的图 | 说的是 |
|---|---|---|
| buff 行 `world.protected` | `armorHeavy` | 首都保护中 |
| 队伍行 `garrisoned`（[`teamStatus.ts`](../../client/src/scenes/worldmap/logic/teamStatus.ts)） | `armorHeavy` | 野外驻扎 |
| 队伍行 `stationed` | `armor` | 野外停留 |

也就是**一块四分圆在一屏上有三个含义，而两档之间只差一圈粗黑外沿**。后两个已经在 2026-09-03 挪走了（`stationed`→`footsteps`、`garrisoned`→`camp`，批 9 刚出的那两张正好就是玩家点「停留」「驻扎」得到的状态，零新美术，见 [`UI_DESIGN_LOG_2026-08.md` §45](../game/UI_DESIGN_LOG_2026-08.md)）。**剩下的就是这一张。**

## 1. 语义判断：盾 / 伞 / 复用 `lock`，为什么是伞

判断方法照 [[pick-icon-glyphs-by-eye-not-name]]：先用 sharp 把候选的白母版拼成 **26/28px × 深底 + 纸底** 的 contact sheet 看一眼，再谈语义。这一轮拼的是 `armor` / `armorHeavy` / `lock` / `equip` / `defense` / `hourglassMd` / `pvp` / `castle` / `siege` / `stronghold`（前六张是候选，后四张是这一屏或相邻屏的邻居）。

| 方案 | 26px 上读成什么 | 判定 |
|---|---|---|
| **再画一张盾** | `equip_active.png` 就是一张**26px 上极清楚的鸢形盾**——宽肩、尖底、中线，是整套里最好读的剪影之一 | **否决**。`equipIcon` 的既定含义是「装备」，而且不是某个页签的局部约定：[`rewardIcon.ts`](../../client/src/render/rewardIcon.ts) 让**所有装备类奖励**都长这样（邮件、任务、商城、拍卖都会出现）。再画一张盾＝跟全库最广的一条语义撞车，等于把批 7 那次「按名字选图」的学费再交一遍 |
| **复用 `lock`** | 挂锁在 26px 上非常干净，零成本 | **否决**。两条：①`lock` 在本库的既定含义是「未解锁 / 不可用」，是**负向**标记（抽卡、装备、排行榜的锁徽章），挂在一条 buff 上语义反了；②它紧跟一个**倒计时**，「挂锁 + 还剩 1 时 29 分」的第一读法是"还有 1 时 29 分才解锁"——正好是真实含义的反面。一个读成另一件事的图标比没有图标更糟（批 9 §6.4） |
| **画伞** | 全库唯一无冲突的低频剪影：没有第二个"穹顶 + 竖杆 + 弯钩"。最近的邻居是 `defense` 的头盔（穹顶带护面、无杆）和 `hourglass`（对称双三角），并排不混 | **采用**。三语都通：中文「保护伞」是成语级搭配，德语 `Schutzschirm` 字面就是"保护之伞"，英语 "under an umbrella of protection"。正向、与倒计时同向（"这把伞还能撑 1 时 29 分"） |

**没有走的第四条路**：把商店的两档保护道具（[`shop.ts`](../../client/src/scenes/worldmap/WorldMapPanels/shop.ts) 的 `PROTECTION_ICON_TIERS = ['armor', 'armorHeavy']`）一起挪到伞上。它得再画一张"加固档的伞"，范围翻倍，而**档位阶梯在商店里本来就成立**（`iconArtAspect.test.ts` 那条 1.15 墨量下限守着"加固档必须更重"）。所以这一批只动 HUD，`hud.ts` 里那句"复用商城同一套图形语言"的注释要一并改掉——它从此不再成立，而**过时注释会活两个月**（[`UI_DESIGN_LOG_2026-08.md`](../game/UI_DESIGN_LOG_2026-08.md) §39/§40 那条）。哪天商店的保护档也要换，再按同一判据出 `umbrella` 的加固档，不要反过来先画。

**kind 名叫 `umbrella` 而不是 `protect`**：这是 [[pick-icon-glyphs-by-eye-not-name]] 那条教训的正面写法——`armor` 之所以坑人，就是因为名字描述**用途**、屏幕上是另一回事。名字描述**画的是什么**，下一个接图标的人 grep 到它就知道会看到什么；"这张伞代表保护中"由调用点和本文档承担。

## 2. 硬约束（骨架之外，这一张特别容易踩的三条）

骨架沿用前九批（见批 9 §2），不重复贴。这张要写进 prompt 的：

1. **穹顶必须是一块实心黑**。批 7 的总结第一条就是「28px 上活下来的是实心块，死掉的是细节」——伞骨、伞面分格线、布纹全属于 28px 上会平均成一片灰的高频线条。所以身份由**填充**承担：穹顶实心黑 + 杆和钩留白线稿，这也顺带把它和 `defense` 的**空心**头盔穹顶分开。
2. **整体塞进正方形，不许画成细高个**。伞天然是"一个宽穹顶 + 一根长杆"，很容易出到 2:1 以上；`pack_tab_icons.cjs` 裁边后长边归一到 128、运行时 contain-fit 进方框，细长图只占得满格子的一小半，在同一行里比邻居轻一档（`camp` v1 的 2.00:1 就是这么被打回重出的，批 9 §7）。目标 ≤1.5:1，硬拦线是 `iconArtAspect.test.ts` 的 2.2。
3. **伞沿的扇贝齿要留出跟线宽同量级的白纸缝**（几何写法，别用形容词，见 [[ai-art-density-cannot-be-prompted-2026-08-19]]）。齿数按 3–4 个写死：齿太多会在 26px 上糊成一条直边，那时它就只是一个"黑半圆 + 一根棍"，离蘑菇只差一步。

## 3. Prompt（`tabicon_umbrella`，1 张）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: one open umbrella standing upright, seen straight on from the side. Its canopy is a wide low dome filled in as ONE SOLID BLACK area, and the bottom edge of that dome is cut into exactly three deep rounded scallops, with a clear white gap the width of the pen line between each scallop and the next. One short straight spike pokes up from the top of the dome. A single straight vertical shaft runs down from the centre of the dome and ends in a J-shaped hook handle curling to one side; the shaft and the hook are left as bare white line art, not filled. The canopy is as wide as the whole drawing is tall, so the umbrella sits inside a square frame. Nothing else is drawn — no ribs, no seams, no panel lines across the canopy, no raindrops. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no gradient shading — the canopy is one flat solid black area and everything else is bare line art. Must stay clearly recognizable when scaled down to 26x26 pixels, where the solid dome with its scalloped hem and the hooked shaft below are what read. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, radial rib lines or seams drawn on the canopy, an unfilled outline-only canopy, a smooth unbroken bottom edge with no scallops, more than four scallops, a tall narrow silhouette more than one and a half times as tall as it is wide, a closed or folded umbrella, a tilted umbrella, a parasol with a frilly lace edge, a mushroom with a thick tapered stem, a helmet, a bell, a dome tent, a round shield, a kite-shaped shield, a padlock, rain, clouds, drops, a hand holding it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

## 4. 出图后的接线清单

**① 源图归位** — `art/ui/tabicons/tabicon_umbrella.webp`（base 名逐字等于 kind 名）。被打回的版本移进 `art/ui/tabicons/_rejected/`，命名 `tabicon_umbrella_v<n>_<为什么废>.webp`（`inkIconArt.test.ts` 会检查「每个 kind 恰好一个源图」）。

**② `pack_tab_icons.cjs`** — `JOBS` 末尾加一行带注释的，`inks: ['active']`（**只烤白色母版，运行时 tint**；烤三档墨色会静默改道走 `tabIconVariant` 并抹平所有 tint）：

```js
// Batch 10 (design/product/tab-icon-art-prompts-batch10.md): the capital-protection buff chip's own
// glyph — it was borrowing `armorHeavy`, the heraldic quartered disc, which reads as neither.
{ src: 'tabicon_umbrella.webp', name: 'umbrella', inks: ['active'] },
```

**③ 跑打包** — `node art/ui/tabicons/pack_tab_icons.cjs` → `client/src/assets/tabicons/umbrella_active.png`。**没有 merged-atlas 重打包这一步**。跑完确认「只有新增那一张变化，其余 196 张零字节改动」（`client/src/assets/tabicons/` 现在是 196 个文件；批 9 验到过这条管线是确定性的）。

**④ `inkIconRaster.ts`** — 三处：`import umbrellaInkUrl from '../../assets/tabicons/umbrella_active.png';`（挂在批 10 的注释段下）、`InkIconKind` 加 `'umbrella'`、`INK_ICON_ART` 加一行。

**⑤ 调用点，一处**：`WorldMapPanels/hud.ts` 的保护 buff 行 `icon: 'armorHeavy'` → `'umbrella'`，并把它上方那段注释里"reusing the same glyphs the shop panel already uses for these items（SPEEDUP_ICON_TIERS/PROTECTION_ICON_TIERS）"改成实话：加速档仍与商店共用沙漏，保护改成自己的伞，理由见本文档 §1 末段。

**刻意不动**：`shop.ts` 的 `PROTECTION_ICON_TIERS`（§1 末段）、`armor`/`armorHeavy` 在装备词条与 `ResultScene`/`CityScene` 的用法（那里它就是"护甲"这个数值）。

**⑥ 测试**：`client/test/render/inkIconArt.test.ts` 的 `expect(OWN_ART.length).toBe(56)` → `57`，并把它上面那段算式注释补上批 10 的 1 张。`iconArtAspect.test.ts` **不要改**——超 2.2:1 是"这张该重出"的信号，不是"该加豁免"。`worldMapShopPanel.ui.ts` 那两条 `armor`/`armorHeavy` 断言不受影响（本批不动商店）。

**⑦ 验证**：`npm run typecheck`、`npm run lint`、`npm run build:web`（**类型过了不等于构建过了**：这张是 `import` 进来的资源，文件名错一个字母只有 webpack 会报）、`npm run check:filelength`、`vitest run` + `test:ui` 全量。

## 5. 验收口径

1. **26px 和 28px × 深底 + 纸底两张 contact sheet。96px 预览不算数。** 深底 `#2c2c2a`（`C.dark`，按钮填充），纸底 `#f5f0e8`（`C.paper`，buff 行画在纸上）。脚本临时写在 scratchpad，用完删（别留在 `client/` 里，会被 lint 和 `check:filelength` 扫到）。
2. **成组并排看**，这一张必须过的四组：
   - `umbrella` vs `armor` vs `armorHeavy`（它要取代的那两张，别只是"换了个圆"）；
   - `umbrella` vs `defense`（头盔穹顶）vs `hourglassMd`（同屏邻居，都有对称的宽顶）；
   - `umbrella` vs `lock`（被否决的方案，用来确认伞真的更像"保护"而不是"锁住"）；
   - `umbrella` vs `camp`（批 9 的 A 字帐篷）——两张都是"顶 + 底下有东西"，而它们**同屏**（buff 行和队伍行都在世界地图 HUD 右列）。
3. **真机实拍**走 [[worldmap-standalone-debug-render]]：`start:e2e` + `__nwE2E.views.showWorldMap`（cb **必须带 `worldId`**）+ reject-fast `worldApi` Proxy，然后直接 poke `ctx.me.baseProtectedUntil = Date.now() + 5400e3`、`ctx.teams`/`ctx.stationed`、`ctx.teamsLoaded = true`、`ctx.teamPanelExpanded = true`，调 `ctx.panels.renderHud()`。要摆出来的一屏：**保护中 buff 行 + 野外停留/野外驻扎/驻军在家三条队伍行同屏**——这一屏就是「四分圆有三个含义」的原始案发现场，也是判断伞是否真的把它解开的唯一现场。
4. **判定标准是"读成什么"，不是"好不好看"**。任何一张在 26px 上读成蘑菇、钟、头盔或帐篷，就按批 7 log 的格式记下"v1 为什么塌"再重出，**只改导致返工的那一处措辞**。

## 6. 出图记录（2026-09-03 同日出图 + 接线 + 验收，一版过）

**打包结果：`umbrella_active.png` 裁边后 128×128 = 1.00:1**——全批次里最方的一张（批 9 那七张是 1.02–1.52，`camp` v2 是 1.44）。`iconArtAspect.test.ts` 一字未动、自己过关；重跑打包脚本时其余 196 张**零字节变化**（这条管线的确定性又验了一次）。

**26/28px × 深底 + 纸底，四组并排全部无撞车**（§5 那四组）：

- vs `armor` / `armorHeavy`：形态完全不同一档——实心穹顶 + 细杆弯钩 vs 黑白相间的四分圆。这一张的**实心穹顶**正是批 7 总结第一条（「28px 上活下来的是实心块」）的正面用法，26px 上伞沿的扇贝波纹和 J 形钩都还在。
- vs `defense`（头盔）：头盔是**空心**穹顶 + 一条竖直护面、没有杆；伞是**实心**穹顶 + 杆 + 钩。§2 第 1 条要求"填充承担身份"就是为了这一组。
- vs `lock`：一眼分开，也顺手确认了 §1 的判断——挂锁读"锁住"，伞读"罩着"。
- vs `camp`（A 字帐篷）：帐篷是折线、空心、三角；伞是曲线、实心、圆顶。两者**确实同屏**（buff 行与队伍行都在 HUD 右列），实拍那一屏两张同时在，不混。

**真机实拍（Playwright 落文件，1600×900 @2x）**：保护中 buff 行现在是伞，正下方是训练加速的沙漏，两条 chip 读成两件事；同屏的三条队伍行分别是脚印（野外停留）/ 帐篷（野外驻扎）/ 房子（驻军在家）。**整屏再也没有四分圆**——§0 那张「一块图三个含义」的表就此清空。

**没有做的两件事**（都在 §1 末段有据）：商店的 `PROTECTION_ICON_TIERS` 仍是 `armor`/`armorHeavy`（档位阶梯在那儿成立，换伞要再画一张加固档）；`hud.ts` 里那句"复用商城同一套图形语言"的注释已按 §4⑤ 改成实话（加速档仍共用沙漏，保护档不再共用）。
