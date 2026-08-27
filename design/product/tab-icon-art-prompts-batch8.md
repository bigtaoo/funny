# 批次 8：数值词条图标补齐（射程 / 攻城值 / 暴击率 / 暴击伤害）— Prompt 文档

> 创建：2026-08-27 · 数值词条四张：**全部完成（同日）** · **追加 8b（卡片元信息：类型/费用/未解锁）**：`未解锁` 已复用 `lock` 落地，`费用`→`ink`、`建筑`→`castle` 判为复用，**8b 也全部完成**（`法术`=卷轴一版过，`士兵` v1 读成毛线帽、v2 改侧面科林斯盔一版过；`建筑`/`费用`/`未解锁` 复用 `castle`/`ink`/`lock`）。全库 **49 张自有美术 + 6 个别名 = 55 个 ink kind**：v1 四张里 `crit`/`siege` 过、`range`（4.24:1 缩成发丝）与 `critmult`（读成船舵）打回；v2 三张一版过，四张一起接线上线。最终账：43 + 4 = 47 张自有美术 + 6 个别名 = 53 个 ink kind
> 前七批：[`tab-icon-art-prompts.md`](tab-icon-art-prompts.md)（批 1–4，19 张）· [`tab-icon-art-prompts-batch5.md`](tab-icon-art-prompts-batch5.md)（页面标题，24 张）· [`tab-icon-art-prompts-batch6.md`](tab-icon-art-prompts-batch6.md)（大厅首页，3 张）· [`tab-icon-art-prompts-batch7.md`](tab-icon-art-prompts-batch7.md)（矢量清零，44 张）
> 配套代码：[`client/src/render/icons/inkIconRaster.ts`](../../client/src/render/icons/inkIconRaster.ts)（本批落地处，同批次 7）· [`art/ui/tabicons/pack_tab_icons.cjs`](../../art/ui/tabicons/pack_tab_icons.cjs) · 调用点见文末「出图后的接线清单」
> 相关代码改动（**已落地，不等图**）：收集册属性行每个词条都写全名，见 [`LOBBY_IA_REDESIGN_LOG.md §28`](../game/LOBBY_IA_REDESIGN_LOG.md)
> 美术总纲：[`art-direction.md`](art-direction.md) §0 / §7.6

## 背景：批次 7 把「有图标的地方」清零了，没盘过「该有图标的地方」

批次 7 的范围是**已经在画的 49 个矢量 kind**——把它们逐个换成 AI 线稿，`DRAW` 表清零。它没有回答另一个问题：**有没有哪个词条压根就没进过那张表**。

这次用户圈的正是这种：收集册卡片上 `♡ 60　⚔ 12　射程 1`，前两个词条只有图标、第三个只有文字。`range` 从来没有过矢量画法，所以批次 7 那份 49 个的清单里当然也没有它。

排版层面的毛病（图标被当成标签用）已经单独修掉了——现在每个词条都写全名，图标退化成名字之上的冗余提示，没有美术的词条自然长成 `射程 1`，跟别的 chip 同构。**本文档只解决剩下的那一半：把缺的图标补上。**

## 全库词条盘点：13 个词条，5 个有图标、4 个要出图、4 个不出

判据是「玩家真能在界面上看到这个词条」——引擎里定义了但没接进任何一条产出路径的，不出图。

| 词条 | i18n key | 出现位置 | 现状 | 结论 |
|---|---|---|---|---|
| 生命 | `collection.stat.hp` / `affix.*_hp` / `roster.hp` | 收集册、装备词条行、花名册 | ✅ `hp`（心形） | — |
| 攻击 | `collection.stat.atk` / `affix.*_atk` / `roster.atk` | 同上 | ✅ `atk`（匕首，v6） | — |
| 护甲 | `affix.s_armor` | 装备词条行 | ✅ `armor` / `armorHeavy` | — |
| 移速 | `affix.m_spd` / `affix.s_spd` | 装备词条行 | ✅ `spd`（双人字箭头） | — |
| 攻速 | `affix.s_atkspd` | 装备词条行 | ✅ `atkspd`（闪电） | — |
| **射程** | `collection.stat.range` | 收集册（士兵 + 箭塔） | ❌ 从来没有过 | **出图 P0** |
| **攻城值** | `affix.m_siege` / `affix.s_siege` / `roster.siege` | 装备词条行、花名册卡详情 | ❌ | **出图 P1** |
| **暴击率** | `affix.m_crit` | 装备词条行（饰品主词条，`MAIN_AFFIX_BY_SLOT` 里是活的） | ❌ | **出图 P1** |
| **暴击伤害** | `affix.s_critmult` | 装备词条行（副词条池里是活的） | ❌ | **出图 P1** |
| 费用 | `collection.stat.cost` | 收集册副标题、战斗手牌角标 | ❌ | **不出新图**：战斗里费用付的就是墨水，概念等于批次 7 已有的 `ink`（墨水瓶）。要不要给这两处上图标是排版决定，不是美术缺口 |
| 战力 | `roster.power` | 花名册格子 / 卡详情 | ❌ | **本批不出**，见下「P2」 |
| 带兵上限 | `roster.troopCap` | 同上 | ❌ | **本批不出**，见下「P2」 |
| 吸血 / 生命回复 / 材料掉落 / 体力 | 无 i18n key | `AFFIX_FIELD_MAP` 里有 `s_lifesteal`/`s_regen`/`s_matdrop`/`s_stamina`，但 `SUB_AFFIX_POOL` 里没有 → 永远 roll 不出来，也没有翻译 | ❌ | **不出图**：功能没上线，画了也没人看得到。等它们真进池子时连同 i18n 一起补 |

**P2（战力 / 带兵上限）为什么单拎出来**：花名册那几行现在**整行都是纯文字**（`CardScene/rosterCell.ts` 的 `statRow`、`CardScene/detail.ts` 的 `stxt`），一个图标都没有——那不是「缺了两张图」，是那一屏还没决定要不要图标化，属于另一件事。而且这两个概念都有撞车风险：战力 ↔ `pvpTabIcon`（交叉双剑）、带兵上限 ↔ `rosterIcon`（卡框里挥剑的小人）/ `familyTabIcon`。**要做就得先按前几批的去重判据过一遍**，本批不预支这个决定。

## Prompt 骨架（沿用前七批，不重复贴共用部分）

> 一律用以下骨架：`Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: …. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, …, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.` 下面每条已经组装成完整 prompt，直接复制即可。

## 造型判断表（4 张）

| # | kind | 造型 | 为什么是这个形 | 必须避让 |
|---|---|---|---|---|
| 1 | `range` | 水平量距线：左右各一道短竖端线，中间一条横线两头带箭头（`|←—→|`） | 「射程」要读成**距离**本身。弓/箭矢那条路走不通——弓箭兵、`atk` 的匕首、`crit` 的箭已经占满了「武器」这套语言，再加一件武器就要靠细节区分，28px 上必糊 | 不是 `spd` 的双人字箭头（那两个箭头**同向**，这个是**背向**）；不要画弓、箭矢、准星、靶子（靶子是 `crit`）；不要标尺刻度（缩小后成锯齿） |
| 2 | `siege` | 一段砖墙：三排砖，中间一道粗锯齿裂缝贯穿，顶沿缺两块砖 | 「攻城值」= 打基地/城墙的能力。攻城槌、投石机在 28px 上都是一堆细杆件；「被打坏的墙」是同一个语义里最简的剪影 | 不是 `castle`（完整城堡剪影：城垛 + 小旗 + 拱门）——本图**不许**出现旗帜、塔楼、城门；不要画攻城槌/投石机/云梯 |
| 3 | `crit` | 靶心：三层同心圆，正中扎着一支箭（只画箭头 + 一小截箭杆，斜插） | 「暴击率」= 打中要害的概率。同心圆 + 命中是这个概念最通用、最省线条的写法 | 不是 `zoom` 的放大镜（圆 + 斜柄）——箭杆不能长到像柄；圆环不要画成十字准星（批次 3 的 `socialTabIcon` 就栽在「经纬线画成直线读成准星」）；不是 `star` |
| 4 | `critmult` | 同 3 的靶心 + 同一支箭，外圈再加一圈短而粗的放射迸溅线 | 「暴击伤害」是「暴击率」的**同族加强档**，走 `armor`/`armorHeavy` 那条已经验证过的做法：同一件东西 + 一层「更狠」 | 必须跟 `crit` 是同一只靶子、同一支箭，只多放射线；放射线要**少而粗**（6–8 根），不能变成 confetti 点阵（沙漏三档就栽在点阵上）；**建议和 3 在同一次请求里一起出**，否则两张靶子的画法会对不上 |

---

### 1 射程（`tabicon_range`）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a horizontal distance-measuring line — one short vertical end bar on the left, one short vertical end bar on the right, and a single straight horizontal line between them with a solid arrowhead at each end pointing outward toward the two bars. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, two arrows pointing the same direction, chevrons, a bow, an arrow in flight, a target or bullseye, crosshairs, ruler tick marks or graduations, a dotted or dashed line, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 2 攻城值（`tabicon_siege`）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a short section of a brick wall — three courses of large simple bricks — broken by one bold jagged crack running from top to bottom through the middle, with two bricks missing from the top edge so the top of the wall is chipped and uneven. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading, no texture hatching inside the bricks. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a whole castle silhouette, crenellations or battlements, towers, a flag or banner, a gate or archway, a battering ram, a catapult or trebuchet, a ladder, falling rubble pieces, many small bricks, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 3 暴击率（`tabicon_crit`）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a round archery target seen face-on — three plain concentric circles with a small solid dot at the very center — with one arrow struck dead in the middle: only the arrowhead and a short stub of shaft are visible, angled diagonally into the center dot. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a long arrow shaft or fletching, a magnifying glass with a handle, crosshair lines crossing the rings, a star, a bow, a dagger, radiating burst lines, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 4 暴击伤害（`tabicon_critmult`）

> **和 3 一起出**：两张必须是同一只靶子、同一支箭，唯一的差别是这张外圈多一圈迸溅线。

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a round archery target seen face-on — three plain concentric circles with a small solid dot at the very center — with one arrow struck dead in the middle (only the arrowhead and a short stub of shaft visible, angled diagonally into the center dot), and about seven short thick impact lines bursting radially outward from behind the outer ring, suggesting an amplified hit. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, many thin radiating lines, a dotted or dashed burst, a starburst or explosion cloud, a long arrow shaft or fletching, a magnifying glass with a handle, crosshair lines crossing the rings, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

## 出图后的接线清单

跟批次 7 完全同构（内容态词条图标 → 运行时染色那条路），四张都是**一张白色母版**：

1. `art/ui/tabicons/`：源图按 `tabicon_range.*` / `tabicon_siege.*` / `tabicon_crit.*` / `tabicon_critmult.*` 命名归位（base name 就是 kind name，大小写保留）。
2. `pack_tab_icons.cjs` 的 `JOBS` 加 4 行，**全部 `inks: ['active']`**（不是页签三墨——这四个是内容态词条，调用点传的是字面墨色）。跑脚本产出 `<kind>_active.png`。
3. `client/src/render/icons/inkIconRaster.ts`：4 条 `import` + `INK_ICON_ART` 加 4 行。**不要**加进 `INK_ICON_ALIASES`（它们有自己的美术）。
4. 调用点：
   - `client/src/scenes/CardCodexScene/tile.ts` 的 `cardStats()`：两处 `icon: null` 改成 `icon: 'range'`（士兵一处、建筑一处）。
   - `client/src/scenes/EquipmentScene/detail.ts` 的 `affixIconKind()`：`siege`/`crit`/`critmult` 三个 stat 名加进白名单（该函数已经在剥 `m_`/`s_` 前缀，`s_critmult` 剥完是 `critmult`）。
5. 测试：`client/test/render/inkIconArt.test.ts` 的两半对账（磁盘 ↔ 表）加图即自动覆盖，但它有一处**硬编码计数** `expect(OWN_ART.length).toBe(43)`——那行就是「加图必须同时改文档」的闸门，43 → 47，并在注释里指回本文档。`iconArtAspect.test.ts` 会盯长宽比：`range` 是这四张里唯一明显偏宽的，很可能需要在豁免表里**带上限**地加一行（照批次 7 给 `atk` 的做法，不要写成无条件豁免）。

## 验收口径

沿用批次 7：**28px contact sheet**（纸底 + 深底两种衬底）逐张看，外加两处实拍——
- 收集册（`views.showCardCodex`，横屏 + 竖屏各一张）：`range` 要能跟同一行的 `hp`/`atk` 并排看着像一套。
- 装备详情弹窗（`views.showEquipment`）：`crit`/`critmult` 必须在一屏里同时出现且**一眼分得开**，`siege` 要跟 `castle`（大厅首页/CityScene 会同屏）不打架。

**这四张的特殊验收点**：`crit` / `critmult` 是本批唯一的家族对，按沙漏三档那次的教训——**并排看，不要单张看**；单张各自都过、并排分不开，是这类家族图最常见的失败方式。

## v1 出图结果（2026-08-27）：2 张过、2 张打回

四张一次出齐。验收方式不是看原图——原图 1920×1920 全都好看——而是**把 pack 管线跑一遍再看 28px**：`alpha = 255 - luminance` → 按内容裁边 → 长边归一到 128（`thicken=1`，一次 dilate）→ 运行时 contain-fit 进 28×28 方格，纸底 `C.mid` / 深底白墨两种衬底，并排放已上线的 `hp`/`atk`/`spd`/`castle` 做参照。

| kind | 内容长宽比 | 28px 实际占格 | 结论 |
|---|---|---|---|
| `crit` | 0.99:1 | 28×28 | **过**（见下保留意见） |
| `siege` | 1.16:1 | 28×24 | **过，但偏弱**（第二弱，记录在案不重出） |
| `range` | **4.24:1** | **28×7** | **打回**——构图问题，不是造型问题 |
| `critmult` | 0.99:1 | 28×28 | **打回**——读成船舵 |

### `range`：又踩了一次 `brush` 的 4.74:1

量距线画得很漂亮，但两端只有两道**短**竖线，于是整张图的内容外框是 1735×409。长边归一 → 母版 128×32 → contain-fit 进 28px 方格只剩 **28×7**：旁边 `hp` 是 28×26 的心，这条线在同一行里就是一根发丝。

这正是批次 7 `brush` 那条教训的第二次现场（当时 4.74:1，这次 4.24:1），而且**prompt 里没写这条约束**——batch 7 的结论「新图外轮廓长宽比尽量别超过 2:1」当时只落在 art-direction-map-ui.md 的叙述里，没进本文档的 prompt 骨架。v2 prompt 补上，并且不靠模型自觉：直接把构图写死（两端改成**贯穿全高**的竖杆）。

### `critmult`：8 根等长等距、且贴着外环的迸溅线 = 船舵

单看 1920px 原图是「靶心 + 迸溅」，缩到 28px 之后放射线和外环连成一体，读出来是**船舵/方向盘**（同一类失败已经在批次 3 的 `socialTabIcon` 上发生过一次：经纬线画直了就读成准星）。要修的是三件事：根数减到 5–6、跟外环之间留出**明显空隙**、长度和角度**不要均匀**。

顺带两条保留意见：

- **两张靶子不是同一只**。`crit` 是三道细环 + 大留白，`critmult` 的环更粗、间距更挤——现在还能靠迸溅线分开，所以没到打回 `crit` 的程度，但**重出 `critmult` 时必须把 `crit` 一起重出**（同一次请求），否则家族感只会更差。本文档造型表里那句「建议和 3 在同一次请求里一起出」这次没有执行。
- **两张里的箭都在 28px 上消失了**，只剩中心一个灰点。当前 `crit` 因此实际读成「靶心」而不是「命中靶心」——语义上仍然成立（暴击率 = 打中要害的概率），所以不为它单独打回；但既然要重出这一对，v2 就把箭头改成**一个大的实心三角**、去掉细箭杆（批次 7 的老结论：28px 上活下来的是实心块，死掉的是细节）。

### `siege`：可用，弱在顶部那个缺口

28px 上读得出「一块被劈开的墙」，也没跟 `castle` 撞（那张有城垛+小旗+拱门）。弱点是顶部两块缺砖画成了一个又大又对称的 V 形凹槽，第一眼有点像「豁口的盒子」；砖缝三道横线在 28px 上也接近糊成一条。**记录在案不重出**——真要重出的话，改法是：缺口做成一大一小、位置不对称，砖缝减到两道。

### 资产落位

- `art/ui/tabicons/tabicon_crit.webp`、`tabicon_siege.webp`（原始生成文件名已按 kind 名归位）
- `_rejected/tabicon_range_v1_sliver28x7.webp`、`_rejected/tabicon_critmult_v1_shipswheel.webp`

**这一批还没有接线**：`range` 是收集册那一行的正主（用户最初圈的就是它），`critmult` 又必须和 `crit` 成对上线，所以两张打回的重出回来之前，四张一起等——避免出现「装备详情里有暴击率图标、暴击伤害没有」这种半套状态。

## 重出 prompt（v2，2026-08-27）

### 1 射程（`tabicon_range`）— 重构图，造型不变

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a distance-measuring dimension line drawn between two tall vertical posts — the left and right posts are bold vertical strokes running the FULL height of the image, and the horizontal gap between them is about the same as their height, so the whole drawing fills a roughly SQUARE frame; midway up, one straight horizontal line spans the gap with a large solid arrowhead at each end pointing outward at the posts. The overall outline must be roughly square — never a wide thin strip. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a wide flat composition, short end ticks, two arrows pointing the same direction, chevrons, a bow, an arrow in flight, a target or bullseye, crosshairs, ruler tick marks or graduations, a dotted or dashed line, a goal or gate with a crossbar on top, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 2 暴击率 + 暴击伤害（`tabicon_crit` / `tabicon_critmult`）— **必须同一次请求出两张**

> 两张的靶子和箭要逐笔相同，唯一差别是第二张多一圈迸溅线。先出第一张，第二张在它之上加线。

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a round archery target seen face-on — exactly three plain concentric circles, evenly spaced, with a wide open center — and one large solid black triangular arrowhead planted dead in the middle, big enough to fill the innermost circle, with no shaft and no fletching. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a thin arrow shaft, fletching, a small or hollow arrowhead, a magnifying glass with a handle, crosshair lines crossing the rings, a spiral, a star, a bow, a dagger, any lines outside the outer ring, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: the SAME round archery target as the previous image — exactly three plain concentric circles with a large solid black triangular arrowhead planted dead in the middle, no shaft — and, outside the outer ring, five or six short thick impact strokes bursting outward. Each impact stroke starts a clear gap away from the outer ring and never touches it; they differ in length and are unevenly spaced around the ring, clustered rather than symmetric. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a ship's wheel or steering wheel, spokes touching or crossing the rings, evenly spaced rays, eight or more rays, a sun with rays, a gear or cog, thin hairline rays, a starburst or explosion cloud, a thin arrow shaft or fletching, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### v2 的验收口径（不要只看原图）

跑一遍 pack 管线再看 28px——这四张里有两张是**只有在 28px 才暴露**的问题（一张是归一化后只剩 7px 高，一张是缩小后放射线和环连成一体）。具体要过的三关：①内容外框长宽比 ≤ 2:1（`range` 上一版 4.24:1）；②28px 纸底 + 深底两种衬底；③`crit`/`critmult` **并排**看，不并排看等于没验收。

## v2 出图结果（2026-08-27）：三张全过，四张一起接线完成

| kind | 版本 | 内容长宽比 | 28px 实际占格 | 结论 |
|---|---|---|---|---|
| `range` | v2 | 0.96:1（v1 是 4.24:1） | **27×28**（v1 是 28×7） | **过** |
| `crit` | v2 | 0.99:1 | 28×28 | **过** |
| `critmult` | v2 | 0.94:1 | 26×28 | **过** |
| `siege` | v1 | 1.16:1 | 28×24 | 沿用（v1 就过了，偏弱那条保留意见不变） |

- **`range`**：两端换成贯穿全高的竖杆之后，内容外框从 1735×409 变成近正方，28px 上占满整格，跟同一行的 `hp`（28×26）体量一致。构图约束写进 prompt 就解决了，造型一个字没改。
- **`crit` / `critmult`**：一次请求出的两张，靶子和实心三角箭头逐笔相同，`critmult` 只多外圈那 5–6 道迸溅线——且**不再读成船舵**：线短、跟外环之间有空隙、长短不齐。并排看能一眼分开，单看也各自成立。墨量 95.2 / 78.9，在已上线那批的中上位（`armor` 123.9、`atk` 88.9、`spd` 54.3）。
- v1 的 `crit` 一并作废（箭头是细杆+小箭头，28px 上只剩中心一个灰点），归档为 `_rejected/tabicon_crit_v1_arrowsmudge.webp`。

**`iconArtAspect.test.ts` 的门禁这次是有效的**：`range` v1 的 4.24:1 会被它拦下（上限 2.2），也就是说即使人眼没看出来，`node pack_tab_icons.cjs` 之后的第一次 `npm test` 也会红。四张 v2/v1 全部 ≤1.16，无需进 `ELONGATED_ON_PURPOSE`。

### 接线（已完成，四张一起）

1. `art/ui/tabicons/tabicon_{range,siege,crit,critmult}.webp` + `pack_tab_icons.cjs` 的 `JOBS` 四行（`inks: ['active']`），跑脚本产出四张 `<kind>_active.png`。**只新增这四个文件，其余 182 张字节不变**（脚本是确定性的）。
2. `client/src/render/icons/inkIconRaster.ts`：四条 import + `InkIconKind` 四个成员 + `INK_ICON_ART` 四行。
3. 调用点：`CardCodexScene/tile.ts` 的 `cardStats()` 两处 `icon: null` → `icon: 'range'`；`EquipmentScene/detail.ts` 的 `affixIconKind()` 加一行白名单（`siege`/`crit`/`critmult`，`s_critmult` 剥前缀后正好是 `critmult`）。
4. `inkIconArt.test.ts` 的硬编码计数 43 → 47。
5. 新增 `client/test/ui/equipmentAffixIcons.ui.ts`：装备详情弹窗里这三条词条行必须跟已有图标的词条**缩进相同**。**为什么不断言「有没有图标节点」**——无头 PIXI 里 ink 图标的贴图永远不解码，`buildIcon` 返回空容器，「有没有图标」在树里根本不可观测；可观测的是它对布局的影响（有图标时文字右移 19px），而那一位正是跟着 `affixIconKind` 走的。红绿对照做过。

**验证**：`tsc --noEmit` 绿；`test/render` 全绿（含长宽比门禁、磁盘↔表对账、三墨色契约）；`test/ui` 的 equipment + cardCodex 18 文件 70 例绿；收集册中文横竖屏实拍确认 `射程` 前面的图标就位、整行三个词条同构。

## 追加（8b）：卡片元信息那两行（类型 / 费用 / 未解锁）

2026-08-27，同一轮反馈的下半段：属性行修完之后，收集册卡片上还剩两行**纯文字**——副标题 `士兵 · 费用 4` 和锁定态的 `未解锁`。判据跟上面那条通用判据一致：一张卡片里既然已经有一行是「图标 + 名字」，同一块信息面板里其它行就不能只有名字。

| 词 | i18n key | 现状 | 结论 |
|---|---|---|---|
| 未解锁 | `collection.locked` | ❌ | **复用 `lock`**（批次 7 已有）——**已落地** |
| 费用 | `collection.stat.cost` | ❌ | **复用 `ink`**（墨水瓶）：战斗里费用付的就是墨水，`HUDView` 的战斗内货币用的就是这张图。本文档开头的盘点表早就判过这条复用，这次执行 |
| 建筑 | `collection.cardType.building` | ❌ | **复用 `castle`**（批次 7 已有，带城垛和小旗的城堡）——建筑卡就是兵营/箭塔 |
| 士兵 | `collection.cardType.unit` | ❌ | **出新图 `unit`**（头盔），见下 |
| 法术 | `collection.cardType.spell` | ❌ | **出新图 `spell`**（卷轴），见下 |

**为什么 `士兵` 不复用现成图**：三个候选都撞了——`rosterIcon`（卡框里的小人）跟本页页头的 `collectionTabIcon` 是同一路造型，画在卡片里会跟页头重影；`swords`（交叉双剑）的既有语义是「对战/PVP」（结算页重开按钮、战绩胜负），再兼一个「这张卡是士兵」等于一图三义；`atk` 是同一块面板下一行的匕首，并排两把刀。头盔是这套语言里还空着的位置。

**这两行的排版**：副标题会从 `士兵 · 费用 4` 变成 `[头盔] 士兵　[墨水瓶] 费用 4`——**中间那个 `·` 去掉**，两个图标已经把两段分开了，跟属性行（本来就没有分隔符）对齐。整行沿用 `drawIconTextRow` 的「装不下就整体等比缩小」，因为副标题此前**根本没有宽度守卫**（卡名有，副标题没有），加图标之后竖屏会更贴边。

**`未解锁` 那行已经落地**（不等图，`lock` 是现成的）：锁定卡的插画上本来就压着一个大锁，但那是左边另一块面板；信息面板这一行得有自己的图标。

## 新图 prompt（8b，2 张）

| # | kind | 造型 | 必须避让 |
|---|---|---|---|
| 1 | `unit` | 正面的简易头盔：圆顶 + 一条横向眉带 + 中间一道竖直护鼻，盔口下沿平直 | 不是 `armorslotTabIcon` 的胸甲；不要画脸/眼睛（里面是空的）；不要维京双角、不要高羽毛盔缨（28px 上只会变成一团）；不是整个骑士头像 |
| 2 | `spell` | 摊开的卷轴：上下两端各一个**卷紧的圆柱卷**，中间是平整的一段纸面，卷比纸面明显更宽更圆 | 不是 `book`（摊开的线圈本，有中缝和两页）；不是 `cards`（叠起来的方卡）；纸面上**不要**画任何符号/线条（会被判成文字）；不要星星、魔杖、闪电（`star`/`atkspd` 已占） |

### 1 士兵（`tabicon_unit`）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a simple soldier's helmet seen straight from the front — a rounded dome, one horizontal brow band across it, and one short vertical nose guard hanging down from the band, with a plain straight bottom rim; the space under the dome is empty. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a face or eyes inside the helmet, a head or neck, horns, a tall plume or crest, a full knight bust, a breastplate or torso armor, a shield or sword beside it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

### 2 法术（`tabicon_spell`）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: an unrolled paper scroll seen face-on — one tightly rolled cylinder across the top and another across the bottom, each clearly rounder and wider than the flat blank sheet stretched between them. The sheet is completely blank. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, an open book with a center spine and two pages, a spiral notebook, a stack of cards, any writing, runes, symbols or squiggles on the sheet, a wax seal, a ribbon, sparkles or stars, a magic wand, a lightning bolt, a hand, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

> 备选（`spell` 若第一版读成书/卡）：改画**陨石**——一颗实心圆石 + 三道向后的拖尾线（游戏里的法术本来就是陨石/落石/加速）。实心块在 28px 上比空心纸面更抗缩小，代价是「陨石 = 法术」不如卷轴通用。

### 接线（图回来之后）

1. `tabicon_unit.*` / `tabicon_spell.*` 归位，`pack_tab_icons.cjs` 加两行 `inks: ['active']`，跑脚本。
2. `inkIconRaster.ts`：两条 import + `InkIconKind` 两个成员 + `INK_ICON_ART` 两行；`inkIconArt.test.ts` 的计数 47 → 49。
3. `CardCodexScene/tile.ts`：副标题改走 `drawIconTextRow`，卡类型 → 图标的映射是 `unit → 'unit'` / `building → 'castle'` / `spell → 'spell'`，费用那段带 `ink`，去掉中间的 `·`。
4. 验收照旧：28px contact sheet（`unit` 要跟 `atk`/`armor` 并排看，`spell` 要跟 `book`/`cards` 并排看）+ 收集册中文横竖屏实拍（一屏里同时有士兵/建筑/法术三种卡）。

### 8b v1 出图结果（2026-08-27）：`spell` 过，`unit` 打回

| kind | 内容长宽比 | 28px 实际占格 | 墨量 | 结论 |
|---|---|---|---|---|
| `spell` | 0.84:1 | 23×28 | 49.7 | **过** |
| `unit` | 1.27:1 | 28×22 | 60.7 | **打回**——读成毛线帽 |

**`spell`（卷轴）过**：上下两个卷筒（端头带小螺旋）+ 中间空白纸面，28px 上卷筒仍然读得出来。跟两个最容易撞的邻居并排比过——`book` 是有中缝的两页摊开本、`cards` 是带折角的叠卡——三者在 28px 上互不混淆。墨量 49.7，跟 `castle`(47.5)/`ink`(48.2) 同档。

**`unit`（头盔）打回**：造型出成了「圆顶 + 一条横向箍带 + 一个 T 形小凸起 + **一条封死的平直底边**」。那条底边加上箍带，整体读成**一顶毛线帽**（箍带 = 翻边罗口），完全没有头盔感；缩到 28px 更明显——圆顶下面是一个被竖线一分为二的方框，像个带两格窗棂的拱窗。

三条根因，v2 逐条堵：

1. **底边不能封死**。头盔是空心的、颈口是开的；一条横贯的直线立刻把它变成帽子/盒子。
2. **不要横向箍带**。prompt 里那句「one horizontal brow band across it」被理解成一条贯穿全宽的带子，正是罗口的来源。
3. **护鼻不能画成分隔线**。它在 v1 里从箍带一直连到底边，把下半部切成两格；护鼻应该是**悬在轮廓里**的一根短竖条。

v2 换成**侧面的科林斯式头盔**：正面视角失败的关键是它的辨识全靠细缝，而细缝在 28px 上必然消失；侧面轮廓的眼窝是一个**大缺口**（不是缝），护鼻和护颊是轮廓本身的一部分，缩小后仍然成立——这正是批次 7 那条「28px 上活下来的是实心块、死掉的是细节」的另一面用法。

### `unit` 重出 prompt（v2）

```
Hand-drawn doodle icon in a worn school notebook, single dark-ink pen line art, slightly wobbly imperfect strokes, quick loose sketch — not polished. One bold, simple, highly readable silhouette. Subject: a Corinthian Greek helmet seen from the SIDE, drawn as one continuous outline — a rounded dome, a straight vertical nose bar running down the front, one LARGE angular eye opening cut out just behind the nose bar (a big empty notch, not a thin slit), and a cheek plate sweeping down behind it; the neck opening at the bottom is open, with no line closing it. Single object, centered, filling the frame, on a plain pure-white background, no grid lines, no other elements. Flat 2D, no shading. Must stay clearly recognizable when scaled down to 28x28 pixels. Style of West of Loathing / doodle art. Avoid: color, painterly rendering, gradients, glow, 3d render, photorealistic look, thick clean cartoon outline, vector-art look, a knitted beanie or winter hat, a horizontal band or cuff across the helmet, a straight line closing the bottom, a dome sitting on top of a rectangle, thin slits, a face, eyes or skin inside the opening, a head or neck, a tall plume or crest, horns, a breastplate, a shield or sword beside it, text, letters, numbers, multiple objects, scattered pieces, confetti dots, watermark, gray background, notebook grid lines, drop shadow.
```

> 备选（v2 若读成鱼/一团）：回到正面视角，但**只画**一个下沿外扩的空心圆顶 + 一根从前沿垂下的短护鼻，不画箍带、不封底边、不画眼缝——即「钟形 + 一个小垂片」，代价是可能被读成铃铛。

**资产落位**：`art/ui/tabicons/tabicon_spell.webp`；`_rejected/tabicon_unit_v1_readsasbeanie.webp`。副标题那一行仍然不接线——三种卡类型的图标必须同时到位，否则一屏里「建筑」有图标、「士兵」没有，就是这轮反馈的原样复现。

### 8b v2 出图结果（2026-08-27）：`unit` 一版过，8b 收工

| kind | 版本 | 内容长宽比 | 28px 实际占格 | 墨量 | 结论 |
|---|---|---|---|---|---|
| `unit` | v2 | 0.86:1（v1 1.27:1） | 24×28 | 39.6 | **过** |
| `spell` | v1 | 0.84:1 | 23×28 | 49.7 | **过** |

侧面科林斯盔一版过：一条连续外轮廓（圆顶 → 护鼻 → 大眼窝缺口 → 护颊下摆），底部颈口不封线。v1 那三个毛病（封死的底边 / 横箍带 / 把下半部切成两格的护鼻）全部不存在，28px 上仍然读得出是头盔。墨量 39.6 偏轻，跟 `cards`(41.1)/`book`(33.2) 同档——这类"空心大轮廓"的图本来就在这一档，可接受。

**8b 最终账**：新出 2 张（`unit`/`spell`），复用 3 处（`建筑`→`castle`、`费用`→`ink`、`未解锁`→`lock`），全库 ink kind 从 47 + 6 别名变成 **49 张自有美术 + 6 个别名 = 55 个**。

### 接线（已完成）

1. `tabicon_unit.webp` / `tabicon_spell.webp` + `pack_tab_icons.cjs` 两行 `inks: ['active']`，跑脚本产出 2 张 PNG（其余 186 张字节不变）。
2. `inkIconRaster.ts` 两条 import + `InkIconKind` + `INK_ICON_ART`；`inkIconArt.test.ts` 计数 47 → 49。
3. `CardCodexScene/tile.ts`：副标题从一条 `${typeLabel} · ${cost} ${n}` 字符串改成 `drawIconTextRow` 的两段 chip，卡类型→图标映射 `unit → 'unit'` / `building → 'castle'` / `spell → 'spell'`，费用那段带 `ink`，**中间的 `·` 去掉**（两个图标已经分隔了两段，跟属性行一致）。y 从 `0.34h` 微调到 `0.33h`：行高从「一行文字」变成「图标高度」，减掉半个差值才能保持原来的视觉中心。
4. 测试：`cardCodexScene.ui.ts` 加 1 例——三种类型标签和费用标签都必须有缩进（同上，无头环境断言几何而非图标节点），并且**没有任何标签还带 ` · `**（分隔符必须真的消失，不是只在某一种卡上消失）。红绿对照做过。

**像素证据**：中文横屏（士兵蓝）+ 拖动到底部的横屏（建筑金 / 法术红，一屏同时有三种类型）+ 竖屏（副标题带图标后仍在面板内、靠 `drawIconTextRow` 的整体缩放）。三种类型的图标都跟着卡类型的强调色走（蓝/金/红），费用的墨水瓶同色。

**收尾补的两条正向门禁**（2026-08-27，手法与踩坑见 [`claudedocs/client-testing.md`](../../claudedocs/client-testing.md) 末两节）：①`equipmentAffixIcons.ui.ts` 从 i18n 表推出「玩家能看见的词条」全集，逐条断言有图标缩进，基线用一个永远不可能有图标的合成 id 锚定；②`codexStatChips.ui.ts` 遍历 `CARD_DEFINITIONS` 断言 `cardStats()` 没有 `icon === null`，外加折行的高度预算不变量。**这两条盯的是下一次的缺口**——批次 7 结构上不可能发现「从来没画过」的 `range`，所以它漏了五个批次；现在新增一个词条或一种卡类型而没出图会直接红。
