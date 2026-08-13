# 玩家基地（desk）图片 Prompt

用途：世界地图上玩家自己的基地（`tile.mine`，desk 建筑等级 1-10）专用美术，与"可攻占城池"的 `city_atlas`（`design/product/city-image-prompts.md`）完全分开的独立图集，二者互不复用、互不回退。

## 为什么要分开

`city_atlas` 的 4 档/10 级贴图服务于世界地图上所有 `type==='base'` 的 tile（不分你我）以及可攻占的 NPC 城池节点，其等级来自地形生成的 `TileDoc.level`（出生/搬迁时写入一次），与玩家 desk 建筑等级完全无关联——desk 升满10级，原先的城池贴图不会跟着变。用户要求玩家自己的基地换一套独立美术，且主题要能和"城堡"类的城池贴图明显区分开。

**主题选择**：desk 建筑本身（连同 cabinet/drillYard/wall/satchel）走的是"文具"主题（见 `SLG_CITY_DESIGN.md` §"建筑图标出图"），玩家基地整体外观延续这条主线，做成"文具搭建的桌面堡垒"——铅笔盒、书本、尺子、订书机等逐级堆叠越来越宏伟，天然区别于 `city_atlas` 的石堡/木寨/城堡主题。

## 粒度：每级一张，共 10 张，无档位回退

帧命名：`playerbase_l1` … `playerbase_l10`。`getPlayerBaseTextureForLevel(level)` 直接取 `playerbase_l{level}`，取不到时代码回落 `getCityTextureForLevel`（临时用城池贴图顶替，避免裸露空白，见 `WorldMapRenderer/city.ts`）——不是像 `city_atlas` 那样的档位设计，10张图都得出全。

## 美术方向（2026-07-17 敲定，取代最初草稿）

第一轮试图（Lv1 双色 / Lv2 全彩木棕 + 方格纸背景）暴露两个问题，据此定下全系列硬规：

1. **严格双色调**：只用**蓝墨线 + 单一淡黄绿水彩填充**，不引入木棕/灰蓝等杂色。最初草稿里逐级不同的 `warm brown`/`cool grey-blue` 填充描述全部废弃——那会让升级看起来像换了画师，10 张放一起没有"一套"的感觉。
2. **纯白背景、无网格线**：`on graph paper` 只是风格意象，**不要把方格真的画进画面**。方格线会让打包脚本的区域生长去背从边缘吃穿建筑（见"接入现状"里 `TSEED=0` 的偏差）。统一 `solid pure-white background, no grid lines`。
3. **用排线密度表现等级递进**：Lv1/2 松（学生涂鸦）→ Lv5 中 → Lv10 密（近铜版蚀刻）。**必须单调递增**，中间级别不得比更高级还密/还简。风格锚点：已定稿的 Lv1、Lv2、Lv5、Lv10 四张。
4. **满级专属视觉信号**：大面积**实心深蓝填充**只留给 Lv10；中间级（3~9）保持淡黄绿为主、蓝仅描线。**金色点缀**仅 Lv9（最高铅笔尖一处）/ Lv10（钢笔金尖 + 最高几处塔尖）作为唯一破例，其余严格双色。

## 构图硬规（2026-08-02，第二轮返工的核心）

第一批图（下面"旧版 prompt"）在地图上**盖住了基地后方一大片格子**。根因不是画风，是构图：

- 世界地图是 2:1 等轴测（`ISO_RATIO = 0.5`），3×3 地块在屏幕上只有 `3 × 0.5 = 1.5` 个 tile **高**，却有 3 个 tile **宽**；
- `city_atlas` 的图自带一块**等轴测地台**（那块菱形就等于地块），建筑坐在地台上、整体矮宽 —— 所以 NPC 城池贴合地块；
- 这批"文具堡垒"**没有地台**，物体铺满正方形画幅，且 prompt 把等级递进写成了"越来越高"（l8 `tall tower`、l9 `towering`、l10 `soaring spire`）。打包脚本等比塞进正方形 cell，渲染时 cell 被画成 `BASE_SPRITE_TILES = 3.2` tile 的**正方形** → 建筑高 ≈ 2.5 tile，比地块高出整整 1 个 tile，往后压掉约 2 排格子。

**因此新一批必须满足（美术侧硬规，与画风同等重要）：**

1. **必须画等轴测地台**：一块 2:1 的菱形地面（书桌台面/垫板/纸面），横向占满画幅宽度，作为"这就是我的 3×3 地块"的视觉锚点。建筑坐在地台上，不得悬空。
2. **宽 > 高**：整幅画面内容的外接框**宽高比约 10:7**（宽是高的约 1.4 倍）。这是打包脚本 `CONTENT_W_FRAC / CONTENT_H_FRAC` 的比值，画到这个比例的图，宽高两个预算同时打满，既填满地块又不超高；画得更高只会被脚本整体缩小，反而显得基地变小。
3. **建筑不许比地台还高**：建筑（含旗杆、塔尖）的垂直高度**约等于地台菱形自身的高度**，绝不超过它的 1.2 倍。要"铺开的院落"，不要"竖起的塔"。
4. **等级递进换维度**：从"越来越高"改成**占地越来越满、圈层越来越多、构件越来越密、排线越来越细**。高度只允许极小幅增长（Lv10 也就比 Lv1 高一点点）。

打包脚本 `pack_playerbase_atlas.js` 的 `HEIGHT_BUDGET_K` 会强制裁到这个预算（超高就整体缩小），`client/test/ui/cityAtlasContentTop.ui.ts` 有对应回归断言 —— 但脚本只能保证"不超高"，**保证不了"够宽"**，够不够宽全靠上面第 2 条画到位。

## 通用 Style（每条 prompt 末尾附加，与 city_atlas 同规格以兼容同一套打包脚本）

```
Hand-drawn doodle illustration, fountain pen blue ink outlines, slightly
scratchy student sketch strokes with cross-hatching, watercolor marker fill in
a single pale yellow-green wash only, strictly two-tone (blue ink + pale
yellow-green, no other colors), gentle isometric perspective (25 degree tilt),
the whole scene sitting on a wide isometric diamond ground plate that spans the
full width of the image, the structure spreading out ACROSS that plate rather
than rising above it, wide low sprawling silhouette clearly wider than it is
tall (bounding box roughly 10 wide to 7 high), nothing rising higher than the
ground plate's own diamond height, centered composition, isolated on a solid
pure-white background, no grid lines, no ground shadow, 512x512px, notebook
doodle aesthetic, no text, no labels.
```

> Lv9/Lv10 把上面 style 里的 `strictly two-tone (...no other colors)` 换成 `otherwise strictly two-tone (blue ink + pale yellow-green) apart from the small gold accents`，以放行金色点缀。

## Prompt（10 张，2026-08-02 矮宽构图版）

每条都以"地台上的什么"开头，等级递进体现在**占地/圈层/密度**。

### `playerbase_l1` — Lv1「铅笔盒营地」

```
A wide flat desk-pad ground plate with a tiny humble camp spread across it: a
single open pencil case lying on its side as a low wall, two short pencils laid
almost flat as a gate, a small eraser block as a lookout, a folded paper flag
on a stubby pole. Mostly empty plate — only a handful of objects, all low to
the ground, nothing standing tall.
[+ style]
```

### `playerbase_l2` — Lv2「文具围栏」

```
A wide desk-pad ground plate with a low camp covering about a third of it: an
open pencil case wall extended by a row of pencils laid down as a short
palisade, a ruler laid flat as a bridge/gate, a squat ink bottle at one corner,
a small flat tent inside. Everything hugs the plate; the tallest object barely
clears the fence line.
[+ style]
```

### `playerbase_l3` — Lv3「书本壁垒」

```
A wide desk-pad ground plate about half covered by a low stronghold of flat
stacked notebooks forming a wide square wall, book spines making crenellations
along the top, a stapler set into the wall as a gate, a single short pencil
stub at one corner. Wide and squat — the wall is only two or three books high.
Denser cross-hatching on the book covers than the earlier levels.
[+ style]
```

### `playerbase_l4` — Lv4「文具重镇」

```
A wide desk-pad ground plate mostly covered by a sprawling settlement: a broad
perimeter of stacked-notebook walls reinforced with binder clips, a lying-down
tape dispenser as a squat round bastion, a protractor as a low arched gate, two
flat tents and a small courtyard inside. Busier and more detailed than Lv3, but
no taller — it grows OUTWARD across the plate.
[+ style]
```

### `playerbase_l5` — Lv5「桌面要塞」

```
A wide desk-pad ground plate fully covered by a broad fortified compound:
textbooks laid flat and stacked only a few high forming a wide central keep
with a large footprint, rulers along the walls as long ramparts, closed
scissors laid crossed at the corners, a drafting compass folded low over the
gate. Imposing through WIDTH and mass, not height.
[+ style]
```

### `playerbase_l6` — Lv6「文具石堡」

```
A wide desk-pad ground plate filled edge to edge by a stone-like fortress of
thick hardcover books laid flat: a broad low binder as the central keep,
correction-tape rolls lying on their sides as squat round corner towers, a
ruler-and-compass drawbridge across the front. Heavy cross-hatching for stony
texture. Wide, heavy, low.
[+ style]
```

### `playerbase_l7` — Lv7「加固书城」

```
A wide desk-pad ground plate filled by a reinforced book-fortress: a double
concentric ring of flat-stacked books as outer and inner walls with a walkway
between them, three squat correction-tape-roll towers spaced around the outer
ring, a large hardcover book lying open as the central keep with a small
bookmark pennant. Dense and detailed, clearly well-defended — depth comes from
the extra ring, not from extra height.
[+ style]
```

### `playerbase_l8` — Lv8「巨型文具堡」

```
A wide desk-pad ground plate completely filled by a massive sprawling
stronghold: a broad platform of encyclopedias and binders stacked only a few
deep, flanked by two glue sticks lying on their sides as squat bastions, a
stapler-and-hole-puncher gatehouse across the whole front edge, and a moat
drawn as a wavy blue ink-outline puddle running around the plate's rim.
Impressive through sheer footprint and density. Still low.
[+ style]
```

### `playerbase_l9` — Lv9「书院巨城」

```
A wide desk-pad ground plate overflowing with an elaborate citadel complex:
several broad book-stack blocks connected by ruler-walls into wings and
courtyards, four short pencil stubs standing at the corners as stumpy spires of
barely varying height, a wide central binder-keep flying a paper pennant, dense
parallel ruler-lines everywhere suggesting grandeur. A single small gold-ink
accent on one pencil tip as the only exception to the two-tone palette.
Grandeur through sprawl and line density — nothing towers.
[+ style with gold-accent exception]
```

### `playerbase_l10` — Lv10「文具帝都」

```
A wide desk-pad ground plate packed edge to edge with the grandest capital
complex: concentric rings of book-walls enclosing dense courtyards of binders
and rulers, six or more short pen and pencil stubs standing around the rings as
stumpy spires of near-equal height, a broad central fountain-pen laid at a
shallow angle with its golden nib pointing forward, a monumental
stapler-gatehouse spanning the front edge, and dense ruler-line cross-hatching
throughout. The most magnificent of the set through density, layering and
footprint — NOT through height; it must be no taller than Lv9. The stubby
spires may be filled solid deep blue as the pinnacle signal. Small gold-ink
accents on the pen nib and a few spire tips are the only exception to the
two-tone palette.
[+ style with gold-accent exception]
```

<details>
<summary>旧版 prompt（2026-07-17，高瘦构图，已被上面取代）</summary>

原版把等级递进写成"越来越高"（`tall central keep` / `soaring central fountain-pen spire` 等），配合无地台的满幅构图，正是 2026-08-02 "基地盖住后面格子" 的根因。原文见 git 历史（本文件 2026-08-02 那次提交的父版本），不再使用。

</details>

### `playerbase_l1` — Lv1「铅笔盒营地」

```
A tiny humble fort made from a single open pencil case lying on its side as a
wall, two pencils stuck upright as flagpoles with a small paper flag, an eraser
block placed on top as a lookout. Sparse and modest, only a handful of objects.
[+ style]
```

### `playerbase_l2` — Lv2「文具围栏」

```
A slightly bigger camp: an open pencil case as a wall extended by a row of
standing pencils forming a short palisade fence, a ruler laid flat as a
bridge/gate, a small ink bottle as a corner watchtower, a tiny tent inside.
A little more built-up than a bare camp.
[+ style]
```

### `playerbase_l3` — Lv3「书本壁垒」

```
A small stronghold built from stacked notebooks as walls, the book spines
forming crenellations along the top, a stapler as a gate mechanism, two pencils
crossed as a simple corner tower. Denser cross-hatching on the book covers to
suggest texture.
[+ style]
```

### `playerbase_l4` — Lv4「文具重镇」

```
A growing settlement: a perimeter of stacked-notebook walls thickened with
binder clips as reinforcements, a tape dispenser as a round tower, a protractor
forming an arched gate, a couple of small tents inside. Busier and more
detailed than the earlier levels.
[+ style]
```

### `playerbase_l5` — Lv5「桌面要塞」

```
A large fortified desk-fort: stacked textbooks forming a tall central keep,
rulers laid along the top as ramparts, closed scissors crossed as corner
spikes, a drafting compass planted as a spire. Clearly more imposing, a real
fortress silhouette.
[+ style]
```

### `playerbase_l6` — Lv6「文具石堡」

```
A stone-like fortress built entirely from thick hardcover books, with a heavy
binder as the central keep, correction-tape rolls as round corner towers, and a
ruler-and-compass drawbridge. Heavy cross-hatching for stony texture.
[+ style]
```

### `playerbase_l7` — Lv7「加固书城」

```
A reinforced book-fortress: a double ring of stacked books as inner and outer
walls, three correction-tape-roll towers, and a large hardcover book standing
open as the central keep with a pennant bookmark as a flag. Dense, detailed,
clearly well-defended.
[+ style]
```

### `playerbase_l8` — Lv8「巨型文具堡」

```
A massive stronghold built from a tall tower of encyclopedias and binders,
flanked by two large glue-stick spires, with a stapler-and-hole-puncher
gatehouse and a moat drawn as a wavy blue ink-outline puddle around the base.
Imposing scale, filling most of the frame.
[+ style]
```

### `playerbase_l9` — Lv9「书院巨城」

```
An elaborate multi-tower citadel made of towering book stacks connected by
ruler-walls, four pencil-spires of varying heights, a grand central binder-keep
flying a large paper pennant, with dense parallel ruler-lines suggesting
grandeur. A single small gold-ink accent on the tallest pencil tip as the only
exception to the two-tone palette.
[+ style with gold-accent exception]
```

### `playerbase_l10` — Lv10「文具帝都」

```
The grandest capital citadel, built from an overwhelming tower of books,
binders, rulers and pencils: concentric book-wall rings, six or more pen and
pencil spires of varying heights, and a soaring central fountain-pen spire with
a golden nib crowned by a large paper pennant, a monumental stapler-gatehouse,
and dense ruler-line cross-hatching everywhere. Clearly the single most
magnificent structure of the whole set. The tall spires may be filled solid
deep blue as the pinnacle signal. Small gold-ink accents on the pen nib and the
tips of the tallest spires are the only exception to the two-tone palette.
[+ style with gold-accent exception]
```

## 接入现状（2026-08-03 更新）

> 代码管线（loader / 渲染分支 / deskLevel 数据线 / 打包脚本）+ **按"矮宽构图版" prompt 重出的 10 张图**都已上线。2026-07-17 那批高瘦无地台的图已全部替换。

### 2026-08-03：新图入库

新图外接框宽高比 1.19~1.89（旧图约 1.0，目标 1.43），10 张里 7 张宽于目标 → 由**宽度**预算触底、高度自动落在预算内；只有 Lv.8/Lv.10 略高于目标，被高度预算轻微缩了一点。`contentTop` 0.44~0.57（低级别更矮，符合预期）。真机 10 级逐个截图核对：全部落在 3×3 地块上，不再压后排格子。

等级 ↔ 源图对应（AI 出图是 UUID 命名，按"能对上哪条 prompt 的特征物"判定，源文件仍留在 `art/ui/slg-playerbase/`）：

| 等级 | 源图前缀 | 判定依据（prompt 特征物） |
|---|---|---|
| Lv.1 | `b6426909` | 笔袋 + 一面纸旗 + 几个小桩，地台大片空着 |
| Lv.2 | `292b43b8` | 笔袋 + 帐篷 + 墨水瓶 + 一排铅笔栅栏 |
| Lv.3 | `6bf8ebd0` | 平摊笔记本围成方墙、书脊做雉堞、订书机门 |
| Lv.4 | `798c5a2a` | 长尾夹加固墙 + 量角器拱门 + 两顶帐篷 + 内院 |
| Lv.5 | `510840c1` | 教科书平摊主堡 + 直尺城墙 + 四角剪刀 + 圆规门 |
| Lv.6 | `01f1a353` | 四个修正带卷做圆形角楼 + 圆规直尺吊桥 |
| Lv.7 | `445aa377` | 双层同心环墙 + 中央摊开的精装书 |
| Lv.8 | `8608ad46` | 网格院落 + 四支铅笔角塔（一支金尖）+ 中央高堡 |
| Lv.9 | `f3e1b623` | 最密的网格城 + 两根横放胶棒堡垒 + 波浪护城河 |
| Lv.10 | `74edac36` | 同心环 + 多支实心蓝尖塔 + 金尖钢笔 + 订书机门楼 |
| （备用） | `fbb0769b` | 与 Lv.8 同构的另一次出图，较稀疏，未采用 |

> 已知小瑕疵，暂不返工：Lv.7（环形+摊开书）视觉冲击强于 Lv.8（网格），密度递进在这一档有个小回落。想平滑的话把 Lv.7/Lv.8 两张对调即可。另外美术地台的透视比地图的 2:1 略陡，地台菱形和地块菱形不完全重合，横向溢出由 `cityPlotMaskPoints` 裁掉，实机看不出来。

### 2026-08-08：宽度预算修正——低级别地台没填满 3×3 菱形

用户反馈：自己基地（真机截图，Lv.1）的地台明显比地图上画出的 3×3 菱形边界窄，两侧留有一截空地，"处理了两次反而更奇怪"。

排查：`CONTENT_W_FRAC = 0.8` 一直是 2026-08-02 那批**无地台**旧图遗留的经验值——特意留了余量，不是"贴图应有宽度"。矮宽新图（8-03 入库）本身没问题，但打包脚本仍按旧预算裁，于是即使新图地台画得再宽，也只能填到 cell 宽度的 80%，而 3×3 地块换算到 `BASE_SPRITE_TILES` 宽的 sprite cell 里应占 `BASE_FOOTPRINT / BASE_SPRITE_TILES = 3/3.2 ≈ 93.75%`（`city_atlas` 走的是"贴满整格，靠 `cityPlotMaskPoints` 裁多出的 ~7%"这条路，`playerbase` 应该一致）。用标准渲染公式（`tileToScreen`/`citySpriteTiles`/`cityPlotMaskPoints`）离线复现了地台+裁剪菱形的几何再叠加真实图集像素核对，10 级里 Lv.1/2/3/9（外接框比目标更宽，宽度预算先触底）确认是"贴图内容本该顶到菱形边，却被 0.8 的老预算收窄了"，其余等级本来就是高度预算先触底、不受 W_FRAC 影响。

修复：`CONTENT_W_FRAC` 改成 `BASE_FOOTPRINT / BASE_SPRITE_TILES`（0.8 → 0.9375），`HEIGHT_BUDGET_K`/`CONTENT_H_FRAC` 不动——2026-08-02 那次修的"压住后排格子"问题因此不会回归（验证过：把两个预算都调宽到能让 Lv.10 满宽，Lv.10 的绘制高度会从 1.8 tile 涨到 2.5+ tile，重新覆盖后排，所以只动宽度）。

结果（重跑 `pack_playerbase_atlas.js` + `patchMergedAtlas.js` 后核对）：
- Lv.1（用户报告的那级）：地台宽度从填满 cell 的 80% 涨到 93.8%（=目标满宽），真机截图确认地台边缘正好顶到地图画出的绿色虚线 3×3 菱形——即用户要的"刚好覆盖玩家自己的 9 格"。
- Lv.2/3/9 同样变宽（宽度预算触底的等级），Lv.4~8/10（高度预算先触底，本次改动够不到它们）维持不变——这批仍是已知的"两侧留一点空地"，跟 2026-08-03 记的瑕疵是同一件事，真出图重画地台更宽、身形不跟着变高才能根治，留给后续美术返工。
- `client/test/ui/cityAtlasContentTop.ui.ts` 的上下界断言（1.8 tile 上限 / 0.75 tile 下限）无需改，10 级全部在界内（重新算过的 `contentTop`：Lv.1=0.49，Lv.2/3/4~10=0.44，其中 2/3/9 相比之前的 0.50/0.45/0.44 分别变化，宽度预算触底的等级 `contentTop` 由 `fittedH` 反算，随宽度预算变化联动）。

**补测（同日）**：上面这批断言全读 `contentTop`（高度轴），今天这个 bug 从头到尾没碰过高度轴——照旧跑不会挂，等于这次的回归完全没测试覆盖。补了 `pack_playerbase_atlas.js` 新字段 `contentWidthFrac`（跟 `contentTop` 同款，量的是宽度轴实际填充比例）+ `playerBaseAtlasLoader.getPlayerBaseContentWidthFracForLevel()`，`cityAtlasContentTop.ui.ts` 新增 3 例：每级 `contentWidthFrac` 落在 `(0,1]`；10 级里**至少有一级**必须顶到 `BASE_FOOTPRINT/BASE_SPRITE_TILES`（不硬编码具体是哪一级——宽度触底的等级会随美术批次的长宽比变化，但"一个都够不到"就是回归本身，`CONTENT_W_FRAC=0.8` 时会全员卡在 0.8，正好触发这条断言）；每级不低于 0.5（防裁切失败）。手动验证过测试真的会抓：把 `CONTENT_W_FRAC` 临时改回 0.8、重跑打包，"至少一级够宽"断言按预期挂掉（0.80078125 < 0.9175），改回来再重跑，12 例全绿。

### 2026-08-02：高度预算（缩小是权宜之计，重出图才是正解）

`pack_playerbase_atlas.js` 原先只有一个正方形 `CONTENT_SCALE = 0.8`，宽高同缩，改不了导致问题的**长宽比**。现拆成两个独立预算：

- `CONTENT_W_FRAC = 0.8` —— 宽度照旧（约 2.5/3 个 tile 宽，从没溢出过）
- `CONTENT_H_FRAC = BASE_FOOTPRINT × ISO_RATIO × HEIGHT_BUDGET_K / BASE_SPRITE_TILES` —— 由地块**真实屏幕高**（1.5 tile）推出，`HEIGHT_BUDGET_K = 1.2` 是留给旗杆塔尖的余量

`fit: 'inside'` 取两者中先触底的那个。对现有这批近正方形的图，触底的永远是高度：绘制高度从 2.5 tile 降到 1.8 tile（`contentTop` 全部变成 0.44），不再压住后排格子。

**代价**（对当时那批高瘦图而言）：等比缩小同时把宽度也压到约 1.75 tile，在 3 tile 宽的地块上略显小、比旁边的 NPC 城池"瘦"。刻意不做非等比拉伸——那会把手绘等轴测透视压变形。2026-08-03 换成矮宽构图的新图后这个代价消失了：新图多数由宽度预算触底，高度自然合规，宽度打满。

`HEIGHT_BUDGET_K` 是唯一的调节旋钮；`client/test/ui/cityAtlasContentTop.ui.ts` 里有上下界断言（既不许超预算，也不许缩没了），改这个常量记得同步。

### 打包链路的坑：`mergeAssetAtlases.js` 已经跑不起来了

2026-07-27 的资源重组（`072131d8`）把各分主题 atlas 合并成 `world_atlas` 后，**把源 atlas 从仓库里删了**——于是 `art/scripts/mergeAssetAtlases.js` 的输入不复存在，重跑必然报 `Input file is missing`。重跑 `pack_playerbase_atlas.js` 只会更新 `assets/slg/playerbase_atlas.{png,json}`，而客户端读的是 `world_atlas`，改了等于没改。

补法：`art/scripts/patchMergedAtlas.js`，把某个子图集的帧**原位重新盖印**进已合并页（帧尺寸不变 → 坐标不变，只换像素和 `contentTop` 之类的自定义字段；尺寸变了会直接报错要求整页重打）。

```bash
node art/ui/slg-playerbase/pack_playerbase_atlas.js
node art/scripts/patchMergedAtlas.js client/src/assets/slg/playerbase_atlas.json client/src/assets/slg/world_atlas.json
```

第一步产出的 `playerbase_atlas.{png,json}` 只是中间产物，不入库（和其余 13 个源 atlas 一样，2026-07-27 起仓库里只留合并页）——盖印完可以删掉，需要时重跑第一步即可。

10 张图已由用户按 prompt 生成、放入 `art/ui/slg-playerbase/`（`playerbase_l1.png` … `playerbase_l10.png`，混合 png/webp），并跑 `node art/ui/slg-playerbase/pack_playerbase_atlas.js` 打包成 `client/src/assets/slg/playerbase_atlas.{png,json}`，覆盖了此前的空占位图。

**打包脚本一处偏差（相对 `pack_city_atlas.js`）**：这批源图的背景是纯白、无方格纸网格，而建筑主体的浅黄绿色水彩填充与白色背景的色距（约44）小于 `pack_city_atlas.js` 原有的 `TSEED=72` 绝对阈值，会导致区域生长去背算法从边缘一路吃穿建筑内部填充（`playerbase_l7` 曾被吃成碎片）。`pack_playerbase_atlas.js` 因此把 `TSEED` 改成 `0`（只保留 `TSTEP=33` 的渐变跟随去背），10 帧全部干净切割，无需网格桥接。

代码管线（无需再改）：
- `client/src/render/atlas/playerBaseAtlasLoader.ts` 提供 `loadPlayerBaseAtlas()`/`getPlayerBaseTextureForLevel(level)`；`WorldMapRenderer/lifecycle.ts` 随其余图集一起加载
- `WorldMapRenderer/city.ts` 按 `tile.mine` 分支选图（自己的基地用这套，其他玩家的基地和 NPC 城池节点继续用 `city_atlas`）
- 服务端 `worldsvc/src/city.ts` 的 `applyDueBuilds` 在 desk 完工时把新等级写入 `TileDoc.deskLevel`（新字段），`core/map.ts tileDocView` 透出到 `WorldTileView.deskLevel`（`server/contracts/openapi-world.yml` 已加对应 schema 字段，client/worldsvc 的生成类型已同步重新生成）

## 2026-08-08（同日第二轮）：重出图，Lv.4/5/6/10 落地，Lv.7/8 仍不够宽

上一节末尾留的坑（Lv.4-8/10 高度预算先触底，宽度填不满）用户直接重出了 7 张新图丢进 `art/ui/slg-playerbase/`。逐张核对（离线复现 `citySpriteTiles`/`cityPlotMaskPoints`/`tileToScreen` 几何 + 叠加真实打包后的图集像素，方法同上一节"验证技术"）：

| 候选 | 目标等级 | contentWidthFrac（满宽=0.9375） | 对比旧图 | 结论 |
|---|---|---|---|---|
| `db469fcb` | Lv.4 | 0.94（满宽） | 旧 0.77 | **采用** |
| `9db3987e` | Lv.5 | 0.91 | 旧 0.77 | **采用** |
| `0a256a95` | Lv.6 | 0.85 | 旧 0.73 | **采用**（仍有一丝缝，明显好转） |
| `5dfc4f19` | Lv.7 | 0.71 | 旧 0.71 | **不采用**——同心环画得太圆，宽度几乎没涨 |
| `acf658c8` | Lv.8 | 0.68 | 旧 0.68 | **不采用**——两侧堡垒没顶到画幅边缘 |
| `53f7ed55` | Lv.10 | 0.84 | 旧 0.66 | **采用** |
| `0b1ef4e0` | Lv.10（备选） | 未测（同构更圆，肉眼明显更窄）| — | **不采用**，比 `53f7ed55` 差 |

采用的 4 张已改名覆盖 `playerbase_l4/5/6/10.png`，重跑 `pack_playerbase_atlas.js` + `patchMergedAtlas.js` 入库。未采用的 3 张 + 被替换下来的旧图（`798c5a2a`/`510840c1`/`01f1a353`/`74edac36`）+ 仓库里一直没清理的 2026-07-17 最早一批高瘦无地台源图（10 个文件）一并移入 `art/leftover/`。

**Lv.7/Lv.8 仍要再出一版**——两张的通病是"同心环/两翼堡垒画在偏中间、没顶到画幅左右边缘"，即使把 prompt 里的宽高比数字写高（如 12:7），AI 出图也不会精确对齐这个数字，得给一个更具体可执行的画面指令（"在两个远端塔尖各插一面旗子作宽度标记，甚至允许旗子/堡垒被画幅边缘裁到一半"）比抽象宽高比更有效——这正是 `db469fcb`（Lv.4，满宽）成功的构图套路，搬到 Lv.7/8 上：

### `playerbase_l7` v2 prompt

```
A wide desk-pad ground plate filled by a reinforced book-fortress: the double
concentric ring of flat-stacked books is drawn as a WIDE FLAT OVAL, not a
circle — squash it left-right so the ring's own left and right edges touch the
very left and right edges of the picture frame (put a small flag at each of
those two tips so the width is unmistakable), with a walkway between the outer
and inner ring, three squat correction-tape-roll towers spaced along that
horizontal oval (one AT the far-left tip, one AT the far-right tip, one at the
back — none of the three near the center), a large hardcover book lying open
as the central keep with a small bookmark pennant. Dense and detailed, clearly
well-defended — depth comes from the extra ring pushed wide, not from extra
height or a circular footprint. The finished silhouette must look noticeably
WIDER than Lv6's fortress, never narrower.
[+ style]
```

### `playerbase_l8` v2 prompt

```
A wide desk-pad ground plate completely filled by a massive sprawling
stronghold: a broad platform of encyclopedias and binders stacked only a few
deep runs the full width of the picture, its left and right ends touching the
very left and right edges of the frame — put a glue stick lying on its side as
a squat bastion AT each of those two tips (half the bastion may even crop off
the edge of the frame, that's fine, it must NOT float with empty plate beside
it), a stapler-and-hole-puncher gatehouse across the whole front edge between
them, and a moat drawn as a wavy blue ink-outline puddle running around the
plate's rim. Impressive through sheer footprint and horizontal spread, low and
flat — the two bastions are the widest points of the entire image.
[+ style]
```

在新图落地前，`playerbase_l7.png`/`playerbase_l8.png` 保持现状（`445aa377`/`8608ad46`），比旧图差不到哪去，先不空着。

### 2026-08-08（同日第三轮）：Lv.7/8 v2 prompt 一次命中，10 张全部达标

用户按上面 v2 prompt 重出了两张（`0e5d40d6`→Lv.7、`4d95d1b3`→Lv.8），离线几何核对：

| 候选 | 目标等级 | contentWidthFrac（满宽=0.9375） | 结论 |
|---|---|---|---|
| `0e5d40d6` | Lv.7 | 0.9375（**满宽**） | 采用 |
| `4d95d1b3` | Lv.8 | 0.91 | 采用 |

"具体锚点"套路（远端插旗子/让物体贴边）比抽象宽高比数字有效，这次一次成功。已改名覆盖 `playerbase_l7/8.png`，重跑 `pack_playerbase_atlas.js` + `patchMergedAtlas.js` 入库；被替换的旧图（`445aa377`/`8608ad46`）连同确认再无用途的 11th 备用图（`fbb0769b`，2026-08-03 就已标注不采用，一直没清理）一并移入 `art/leftover/`。

**至此 10 张玩家基地图全部达到"地台顶到 3×3 菱形边界"的构图要求**（`contentWidthFrac`：Lv.1 0.94 / Lv.2 0.89 / Lv.3 0.82 / Lv.4 0.94 / Lv.5 0.91 / Lv.6 0.85 / Lv.7 0.94 / Lv.8 0.91 / Lv.9 0.83 / Lv.10 0.84，无一低于 0.82），2026-08-08 当天开的这个坑到此收口。

### 2026-08-08（收尾）：真机截图复核，而非只有离线几何模拟

上面三轮的判定都是靠离线复现 `citySpriteTiles`/`cityPlotMaskPoints` 几何叠加真实图集像素，没有实机截图。收尾前补了一次真机验证：临时给 `client/src/entries/web.ts` 加了个 `?worldmapdebug` 分支（构造真实 `WorldMapScene`，reject-fast 的 `WorldApiClient` stub 跳过登录/后端，在地图上摆 10 个"我的基地"测试块，每级一个），Playwright 依次把镜头切到每个基地截图——走的是客户端真正的渲染代码路径（`playerbase_atlas` → `getPlayerBaseTextureForLevel` → `WorldMapRenderer/city.ts` 的 `tile.mine` 分支），不是模拟。10 级截图里"连接己方领地"的绿色虚线框正好是每个基地自己的地块边界，肉眼确认全部贴边，跟离线核算的结论一致。调试脚手架（临时文件 + `web.ts` 分支 + Playwright 脚本）验证完已删除/还原，不留痕迹。

## 2026-08-13：仍有 5 张没顶满，出 v2 prompt

用户反馈"还有几张图没法完全铺到格子上"。核对 8-08 收尾时记的 `contentWidthFrac`（满宽目标 0.9375）：Lv.1 0.94 / Lv.4 0.94 / Lv.7 0.94 已满宽；Lv.5 0.91 / Lv.8 0.91 够接近，之前判定"达标"未再返工；但 **Lv.3 0.82（最窄）/ Lv.9 0.83 / Lv.10 0.84 / Lv.6 0.85 / Lv.2 0.89** 明显偏窄，两侧仍留白。

沿用 8-08 第三轮已验证有效的套路——抽象宽高比数字（如"12:7"）AI 出图对不齐，得换成**具体锚点指令**（远端插旗/物体贴边、允许被画幅边缘裁掉一半）——给这 5 级各写一条 v2 prompt，只改构图锚点部分，画风/特征物延续原 prompt：

### `playerbase_l2` v2「文具围栏」
```
A wide desk-pad ground plate with a low camp covering about a third of it: an
open pencil case wall extended left and right by a row of laid-down pencils as
a short palisade that runs the full width of the frame, its far-left and
far-right pencil tips touching the very edges of the picture (put a tiny paper
flag stuck at each of those two outer tips so the width reads clearly,
cropping half a flag off the edge is fine), a ruler laid flat as a bridge/gate
at the front, a squat ink bottle at one back corner, a small flat tent inside.
Everything hugs the plate and stays low; the fence's two ends are the widest
points of the whole image, not the tent or bottle.
[+ style]
```

### `playerbase_l3` v2「书本壁垒」
```
A wide desk-pad ground plate about half covered by a low stronghold of flat
stacked notebooks forming a wall drawn as a WIDE FLAT RECTANGLE, not a square —
stretch it so the wall's own left and right ends touch the very left and right
edges of the picture frame (put a single upright pencil stub at each of those
two far corners, tip poking just past the frame edge if needed), book spines
making crenellations along the top the whole way across, a stapler set into
the middle of the front wall as a gate. Wide and squat — the wall is only two
or three books high, and its two far corners are the widest points in the
image, wider than Lv2's fence.
[+ style]
```

### `playerbase_l6` v2「文具石堡」
```
A wide desk-pad ground plate filled edge to edge by a stone-like fortress of
thick hardcover books laid flat, drawn as a wide flat rectangle rather than a
block — its outer wall's left and right corners touch the very left and right
edges of the picture frame, with a correction-tape roll lying on its side as a
squat round corner tower AT each of those two far corners (half a tower may
crop off the frame edge, that's fine, it must not float with empty plate
beside it), a broad low binder as the central keep, a ruler-and-compass
drawbridge across the front between the two corner towers. Heavy
cross-hatching for stony texture. Wide, heavy, low — the two corner towers are
the widest points of the whole image, clearly wider than Lv5's fortress.
[+ style]
```

### `playerbase_l9` v2「书院巨城」
```
A wide desk-pad ground plate overflowing with an elaborate citadel complex:
several broad book-stack blocks connected by ruler-walls into wings and
courtyards that run the FULL WIDTH of the picture frame, with one short
pencil stub standing upright AT the far-left edge and another AT the
far-right edge of the frame (their tips may crop off the very edge, that's
fine — they must not float with empty plate beside them), two more pencil
stubs at the back corners as stumpy spires of barely varying height, a wide
central binder-keep flying a paper pennant, dense parallel ruler-lines
everywhere suggesting grandeur. A single small gold-ink accent on the
far-right pencil tip as the only exception to the two-tone palette. The two
outermost pencil stubs are the widest points of the whole image — grandeur
through sprawl and line density, nothing towers.
[+ style with gold-accent exception]
```

### `playerbase_l10` v2「文具帝都」
```
A wide desk-pad ground plate packed edge to edge with the grandest capital
complex: concentric rings of book-walls enclosing dense courtyards of binders
and rulers, stretched into a wide flat oval so the outermost ring's left and
right sides touch the very left and right edges of the picture frame — put
one short pen or pencil stub standing upright AT the far-left tip and another
AT the far-right tip of that ring (half a stub may crop off the frame edge,
that's fine), four more stubby spires of near-equal height spaced around the
rest of the ring, a broad central fountain-pen laid at a shallow angle with
its golden nib pointing forward, a monumental stapler-gatehouse spanning the
front edge between the inner rings, and dense ruler-line cross-hatching
throughout. The most magnificent of the set through density, layering and
footprint — NOT through height; no taller than Lv9. The two outermost spires
(far-left and far-right tips) are the widest points of the whole image,
clearly wider than Lv9. The stubby spires may be filled solid deep blue as
the pinnacle signal. Small gold-ink accents on the pen nib and a few spire
tips are the only exception to the two-tone palette.
[+ style with gold-accent exception]
```

**待办**：用户拿这 5 条 prompt 出图后，按 8-08 第三轮的流程核对（离线复现几何 + `contentWidthFrac`，达到或接近 0.9375 才采用），落地后照旧跑 `pack_playerbase_atlas.js` + `patchMergedAtlas.js`，未采用的候选图和被替换的旧图移入 `art/leftover/`。

### 2026-08-13（同日第二轮）：v2 prompt 出的图机位整体错了，未采用

用户按上面 5 条 v2 prompt 出图放进 `art/ui/slg-playerbase/`（`1790904c`→Lv.2、`fadb8a8c`→Lv.3、`8bca89bc`→Lv.6、`ac069d0a`→Lv.9、`a3e07823`→Lv.10）。目测核对，5 张全部**机位不对，未采用**，问题比"宽度不够"更根本：

- **画布不是正方形**：现有全套（`playerbase_l1` 等）都是 1254×1254；这 5 张是 1672×941 / 1536×1024 / 1704×923 等**横版长方形**。
- **构图不是旋转菱形地台**：现有正确图的地台画的是旋转45°的菱形（四角指向画布上/下/左/右，像扑克牌"♦"），这 5 张画的是"正面/略俯视看一张平铺长方形垫子"——有地平线、往远处延伸的透视，不是俯视机位。拼进等轴测地图后 `cityPlotMaskPoints` 拿菱形去裁一张长方形画面，形状对不上。
- **另外两张有独立的风格违规**：Lv.6（`8bca89bc`）、Lv.9（`ac069d0a`）地台上画出了方格网格线，违反"no grid lines"硬规；Lv.9 那张基本是纯蓝线稿，没有淡黄绿水彩填充，违反"严格双色调"硬规。

好消息：**宽度锚点这部分做对了**——护栏/书墙/塔尖确实顶到了画面边缘甚至裁出画布，v2 prompt 里"远端插旗/贴边裁切"那套指令本身有效，只是被套进了错的画布形状/机位里。因此 v3 不推翻内容，只把"旋转菱形地台 + 正方形画布 + 俯视机位"这条最关键的指令挪到每条 prompt **最前面**（原来只在末尾通用 style 里提一句"isometric diamond ground plate"，这次的生成工具显然没吃到），并在每条里点名参照 `playerbase_l1.png`/`l4.png`/`l7.png` 的机位；锚点内容原样保留。

### `playerbase_l2` v3
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, its four corners pointing to the top, bottom, left and
right edges of the square frame. This is NOT a front-facing tabletop diorama —
there is no horizon, no receding table edge, no vanishing point behind the
objects; the camera looks straight down at a gentle 25-degree tilt, matching
the look of playerbase_l1.png / playerbase_l4.png / playerbase_l7.png.

A low camp covers about a third of the diamond: an open pencil case wall
extended by a row of laid-down pencils as a short palisade running out toward
the diamond's own far-left and far-right corners, with a tiny paper flag stuck
at each of those two corner tips (a flag may crop off the very edge of the
square frame, that's fine), a ruler laid flat as a bridge/gate at the front, a
squat ink bottle at one back corner, a small flat tent inside. Everything hugs
the plate and stays low; the diamond's left and right corners are the widest
points of the whole image.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill only, strictly two-tone (blue
ink + pale yellow-green, no other colors), notebook doodle aesthetic, no text.
```

### `playerbase_l3` v3
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, its four corners pointing to the top, bottom, left and
right edges of the square frame. NOT a front-facing tabletop diorama — no
horizon, no receding table edge; camera looks straight down at a gentle
25-degree tilt, matching playerbase_l1.png / playerbase_l4.png / playerbase_l7.png.

A low stronghold of flat stacked notebooks covers about half the diamond,
forming a wall stretched so its own two ends reach the diamond's far-left and
far-right corners (put a single upright pencil stub at each of those two
corners, tip poking just past the frame edge if needed), book spines making
crenellations along the top, a stapler set into the middle of the wall as a
gate. Wide and squat — the wall is only two or three books high, and the
diamond's left/right corners are the widest points in the image.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill only, strictly two-tone (blue
ink + pale yellow-green, no other colors), notebook doodle aesthetic, no text.
```

### `playerbase_l6` v3
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, its four corners pointing to the top, bottom, left and
right edges of the square frame. NOT a front-facing tabletop diorama — no
horizon, no receding table edge; camera looks straight down at a gentle
25-degree tilt, matching playerbase_l1.png / playerbase_l4.png / playerbase_l7.png.

A stone-like fortress of thick hardcover books fills the diamond edge to edge:
its outer wall reaches the diamond's far-left and far-right corners, with a
correction-tape roll lying on its side as a squat round corner tower AT each
of those two corners (half a tower may crop off the frame edge, that's fine),
a broad low binder as the central keep, a ruler-and-compass drawbridge across
the front between the two corner towers. Heavy cross-hatching for stony
texture. Wide, heavy, low — the diamond's left/right corners are the widest
points of the whole image.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill only, strictly two-tone (blue
ink + pale yellow-green, no other colors), notebook doodle aesthetic, no text.
```

### `playerbase_l9` v3
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, its four corners pointing to the top, bottom, left and
right edges of the square frame. NOT a front-facing tabletop diorama — no
horizon, no receding table edge; camera looks straight down at a gentle
25-degree tilt, matching playerbase_l1.png / playerbase_l4.png / playerbase_l7.png.

An elaborate citadel complex overflows the diamond: several broad book-stack
blocks connected by ruler-walls into wings and courtyards that reach the
diamond's far-left and far-right corners, with one short pencil stub standing
upright AT the far-left corner and another AT the far-right corner (tips may
crop off the very edge, that's fine), two more pencil stubs at the back
corners as stumpy spires of barely varying height, a wide central binder-keep
flying a paper pennant, dense parallel ruler-lines suggesting grandeur. A
single small gold-ink accent on the far-right pencil tip as the only exception
to the two-tone palette. The diamond's left/right corners are the widest
points of the whole image.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill, otherwise strictly two-tone
(blue ink + pale yellow-green) apart from the small gold accent, notebook
doodle aesthetic, no text.
```

### `playerbase_l10` v3
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, its four corners pointing to the top, bottom, left and
right edges of the square frame — NOT a circle or oval, and NOT a front-facing
tabletop diorama with a horizon; camera looks straight down at a gentle
25-degree tilt, matching playerbase_l1.png / playerbase_l4.png / playerbase_l7.png.

The grandest capital complex packs the diamond edge to edge: concentric rings
of book-walls enclosing dense courtyards of binders and rulers, the outermost
ring reaching the diamond's far-left and far-right corners — put one short pen
or pencil stub standing upright AT the far-left corner and another AT the
far-right corner (half a stub may crop off the frame edge, that's fine), four
more stubby spires of near-equal height spaced around the rest of the ring, a
broad central fountain-pen laid at a shallow angle with its golden nib
pointing forward, a monumental stapler-gatehouse spanning the front between
the inner rings, dense ruler-line cross-hatching throughout. NOT taller than
Lv9. The diamond's left/right corners are the widest points of the whole
image. The stubby spires may be filled solid deep blue as the pinnacle signal.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill, otherwise strictly two-tone
(blue ink + pale yellow-green) apart from small gold accents on the pen nib
and spire tips, notebook doodle aesthetic, no text.
```

**建议**：若生图工具支持传参考图，直接把 `playerbase_l1.png`/`l4.png` 当机位参考图传入，比纯文字描述"旋转菱形"更可靠——本轮翻车大概率是文字机位指令没被生成工具吃到，参考图能直接锁镜头角度。5 张未采用的候选图已移入 `art/leftover/`（保留原 UUID 文件名）。

### 2026-08-13（同日第三轮）：机位对了，但地台画得太陡——量出新问题、出 v4、Lv.2/3 命中

用户按 v3 prompt 先出了 Lv.2/Lv.3 两张（`7ffc6c01`→Lv.2、`135d6f06`→Lv.3）探路。机位终于对了（旋转菱形，不再是横版桌面），但离线核对 `contentWidthFrac` 反而比 v2 那批更差：

| 候选 | 目标等级 | 内容外接框宽高比 | contentWidthFrac |
|---|---|---|---|
| `7ffc6c01` | Lv.2 | 1.21 | 0.68（比 v2 的 0.89 还差） |
| `135d6f06` | Lv.3 | 1.17 | 0.66（比 v2 的 0.82 还差） |

排查：打包脚本按高度预算（`CONTENT_H_FRAC=0.5625`）和宽度预算（`CONTENT_W_FRAC=0.9375`）取先触底的一个整体等比缩放（`fit:'inside'`）——两者的比值 `0.9375/0.5625 ≈ 1.667` 就是"内容外接框宽高比"必须达到的门槛，低于它就会被高度先卡住、连带宽度也缩没了。能满宽的参照图（`playerbase_l1`/`l4`，宽高比 1.8~1.84）地台画得"扁"，上尖大致在画布 25% 高、下尖 75% 高；这两张新图的地台画得"陡"，上尖几乎顶到画布顶部（~8%）、下尖几乎顶到底部（~92%），外接框宽高比只有 1.17~1.21——机位对了，但地台自身的高宽比还停留在接近"正方形旋转45°"，没做成 2:1 的扁菱形。

修法：v3 prompt 开头那段"旋转菱形"指令后面追加"squashed FLAT"的具体比例锚点（上尖约在画布 1/4 高、下尖约在 3/4 高，参照 `playerbase_l1.png`/`l4.png` 的扁度），物体描述段落不变。用户按这条 v4 重出 Lv.2/Lv.3（`bf10f349`→Lv.2、`5ab60853`→Lv.3），离线核对：

| 候选 | 目标等级 | 内容外接框宽高比 | contentWidthFrac | 结论 |
|---|---|---|---|---|
| `bf10f349` | Lv.2 | 2.07 | **0.94（满宽）** | 采用 |
| `5ab60853` | Lv.3 | 2.11 | **0.94（满宽）** | 采用 |

两次失败的候选（v2 那批 `7ffc6c01`/`135d6f06`、更早的横版长方形批次）全部移入 `art/leftover/`。已改名覆盖 `playerbase_l2/3.png`，重跑 `pack_playerbase_atlas.js` + `patchMergedAtlas.js` 入库；额外从合并后的 `world_atlas.png` 按 frame 坐标截出这两个 cell 的实际像素核对（不是只信打包脚本报的数字）——菱形贴边到 cell 边界，旗子/笔尖精确在角上裁出画布，跟 `playerbase_l1`/`l4` 一致。

**Lv.6/9/10 待办**：直接沿用这条 v4 的"压扁菱形"开头（"squashed FLAT... top corner ~1/4 down, bottom corner ~3/4 down"）替换各自 v3 prompt 的开头段落，物体描述段落不变，出图后重复同样的核对流程。

### `playerbase_l2` v4（已采用，供 l6/9/10 抄开头段落）
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, but squashed FLAT: its own top-to-bottom corner distance
is only about HALF of its own left-to-right corner distance (a wide 2:1
diamond, not a rotated square). The diamond's left and right corners touch the
very edges of the frame, but its top corner sits only about a quarter of the
way down from the top of the canvas and its bottom corner about three-quarters
of the way down — leaving a generous margin of white space above and below,
matching the flat diamond proportions of playerbase_l1.png / playerbase_l4.png
(NOT the steeper, taller diamond you may have drawn before). This is NOT a
front-facing tabletop diorama — no horizon, no receding table edge; camera
looks straight down at a gentle 25-degree tilt onto that flat diamond.

A low camp covers about a third of the diamond: an open pencil case wall
extended by a row of laid-down pencils as a short palisade running out toward
the diamond's own far-left and far-right corners, with a tiny paper flag stuck
at each of those two corner tips (a flag may crop off the very edge of the
square frame, that's fine), a ruler laid flat as a bridge/gate at the front, a
squat ink bottle at one back corner, a small flat tent inside. Everything hugs
the plate and stays low; the diamond's left and right corners are the widest
points of the whole image.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill only, strictly two-tone (blue
ink + pale yellow-green, no other colors), notebook doodle aesthetic, no text.
```

### `playerbase_l3` v4（已采用）
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, but squashed FLAT: its own top-to-bottom corner distance
is only about HALF of its own left-to-right corner distance (a wide 2:1
diamond, not a rotated square). The diamond's left and right corners touch the
very edges of the frame, but its top corner sits only about a quarter of the
way down from the top of the canvas and its bottom corner about three-quarters
of the way down — leaving a generous margin of white space above and below,
matching the flat diamond proportions of playerbase_l1.png / playerbase_l4.png
(NOT the steeper, taller diamond you may have drawn before). This is NOT a
front-facing tabletop diorama — no horizon, no receding table edge; camera
looks straight down at a gentle 25-degree tilt onto that flat diamond.

A low stronghold of flat stacked notebooks covers about half the diamond,
forming a wall stretched so its own two ends reach the diamond's far-left and
far-right corners (put a single upright pencil stub at each of those two
corners, tip poking just past the frame edge if needed), book spines making
crenellations along the top, a stapler set into the middle of the wall as a
gate. Wide and squat — the wall is only two or three books high, and the
diamond's left/right corners are the widest points in the image.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill only, strictly two-tone (blue
ink + pale yellow-green, no other colors), notebook doodle aesthetic, no text.
```

### 2026-08-13（同日第四轮）：Lv.6/9/10 用 v4 开头仍不够扁——竖起来的构件把外接框顶高了，出 v5

用户按 v4 开头（"squashed FLAT"）+ 各自 v3 物体描述重出了 Lv.6/9/10（`2d100fae`→Lv.6、`2972edb1`→Lv.9、`83228644`→Lv.10）。离线核对，三张**都不如现在线上的图**，未采用：

| 候选 | 目标等级 | 内容外接框宽高比 | contentWidthFrac | 对比现有线上图 |
|---|---|---|---|---|
| `2d100fae` | Lv.6 | 1.37 | 0.77 | 现有 0.85，新图更差 |
| `2972edb1` | Lv.9 | 1.34 | 0.75 | 现有 0.83，新图更差 |
| `83228644` | Lv.10 | 1.34 | 0.75 | 现有 0.84，新图更差 |

跟 Lv.2/3 那次不是同一个病：地台本身压得还行（不再是接近1:1的陡菱形），但 Lv.6/9/10 都比 Lv.2/3 多了**立起来的构件**——Lv.6 的修正带卷角楼、Lv.9/10 的铅笔角塔+旗子/笔尖——这些竖直元素把整体外接框往上抻高，宽高比停在 1.34~1.37，还是够不到命中满宽需要的 ≥1.667 门槛（对比 `playerbase_l1`/`l4`/`l7`——同样带旗子/塔尖但压得更矮，宽高比 1.67~1.84）。

修法：v4 的"压扁地台"开头不变，在物体描述段落后面加一句**具体的整体外接框比例自检**（"画一个包住画面里所有非白色内容——包括地台本身和任何竖起来的塔尖/旗子——的最小外框，宽必须至少是高的1.7倍；不够就把塔尖压得更矮"），逼着生成工具把塔尖/角楼画得更矮，而不是停留在"squat"这种形容词上。三张未采用的候选已移入 `art/leftover/`，图集未改动（现有 Lv.6/9/10 虽未满宽但比这批新候选更好，暂不替换）。

### `playerbase_l6` v5
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, but squashed FLAT: its own top-to-bottom corner distance
is only about HALF of its own left-to-right corner distance (a wide 2:1
diamond, not a rotated square). The diamond's left and right corners touch the
very edges of the frame, but its top corner sits only about a quarter of the
way down from the top of the canvas and its bottom corner about three-quarters
of the way down. This is NOT a front-facing tabletop diorama — no horizon, no
receding table edge; camera looks straight down at a gentle 25-degree tilt.

A stone-like fortress of thick hardcover books fills the diamond edge to edge:
its outer wall reaches the diamond's far-left and far-right corners, with a
correction-tape roll lying on its side as a squat round corner tower AT each
of those two corners (half a tower may crop off the frame edge, that's fine),
a broad low binder as the central keep, a ruler-and-compass drawbridge across
the front between the two corner towers. Heavy cross-hatching for stony
texture.

Self-check before finishing: draw an imaginary tight box around EVERYTHING
non-white in the picture, including the plate itself and every tower sticking
up from it — that box's width must be at least 1.7 times its height. If the
corner towers you drew would make that box taller than that, shrink them:
make them noticeably SQUATTER and shorter, no taller than roughly one-fifth of
the plate's own width, until the whole silhouette reads clearly wider than
tall at that ratio.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill only, strictly two-tone (blue
ink + pale yellow-green, no other colors), notebook doodle aesthetic, no text.
```

### `playerbase_l9` v5
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, but squashed FLAT: its own top-to-bottom corner distance
is only about HALF of its own left-to-right corner distance (a wide 2:1
diamond, not a rotated square). The diamond's left and right corners touch the
very edges of the frame, but its top corner sits only about a quarter of the
way down from the top of the canvas and its bottom corner about three-quarters
of the way down. This is NOT a front-facing tabletop diorama — no horizon, no
receding table edge; camera looks straight down at a gentle 25-degree tilt.

An elaborate citadel complex overflows the diamond: several broad book-stack
blocks connected by ruler-walls into wings and courtyards that reach the
diamond's far-left and far-right corners, with one short pencil stub standing
upright AT the far-left corner and another AT the far-right corner (tips may
crop off the very edge, that's fine), two more pencil stubs at the back
corners as stumpy spires of barely varying height, a wide central binder-keep
flying a paper pennant, dense parallel ruler-lines everywhere suggesting
grandeur. A single small gold-ink accent on the far-right pencil tip as the
only exception to the two-tone palette.

Self-check before finishing: draw an imaginary tight box around EVERYTHING
non-white in the picture, including the plate itself and every pencil stub or
pennant sticking up from it — that box's width must be at least 1.7 times its
height. If the pencil stubs/pennant you drew would make that box taller than
that, shrink them: make them noticeably SQUATTER and shorter, no taller than
roughly one-fifth of the plate's own width, until the whole silhouette reads
clearly wider than tall at that ratio — grandeur through sprawl and line
density, nothing towers.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill, otherwise strictly two-tone
(blue ink + pale yellow-green) apart from the small gold accent, notebook
doodle aesthetic, no text.
```

### `playerbase_l10` v5
```
Top-down isometric view on a SQUARE 1:1 canvas (1024x1024px): the whole scene
sits on ONE ROTATED DIAMOND-SHAPED ground plate — a rhombus like a diamond
playing-card symbol, but squashed FLAT: its own top-to-bottom corner distance
is only about HALF of its own left-to-right corner distance (a wide 2:1
diamond, not a rotated square) — NOT a circle or oval either. The diamond's
left and right corners touch the very edges of the frame, but its top corner
sits only about a quarter of the way down from the top of the canvas and its
bottom corner about three-quarters of the way down. This is NOT a
front-facing tabletop diorama — no horizon, no receding table edge; camera
looks straight down at a gentle 25-degree tilt.

The grandest capital complex packs the diamond edge to edge: concentric rings
of book-walls enclosing dense courtyards of binders and rulers, the outermost
ring reaching the diamond's far-left and far-right corners — put one short pen
or pencil stub standing upright AT the far-left corner and another AT the
far-right corner (half a stub may crop off the frame edge, that's fine), four
more stubby spires of near-equal height spaced around the rest of the ring, a
broad central fountain-pen laid at a shallow angle with its golden nib
pointing forward, a monumental stapler-gatehouse spanning the front between
the inner rings, dense ruler-line cross-hatching throughout.

Self-check before finishing: draw an imaginary tight box around EVERYTHING
non-white in the picture, including the plate itself and every spire or pen
sticking up from it — that box's width must be at least 1.7 times its height.
If the spires you drew would make that box taller than that, shrink them:
make every spire noticeably SQUATTER and shorter, no taller than roughly
one-fifth of the plate's own width, until the whole silhouette reads clearly
wider than tall at that ratio — it must not be taller than Lv9's silhouette.
The stubby spires may be filled solid deep blue as the pinnacle signal.

Solid pure-white background, no grid lines anywhere on the plate, hand-drawn
doodle illustration with fountain pen blue ink outlines and cross-hatching,
single pale yellow-green watercolor wash fill, otherwise strictly two-tone
(blue ink + pale yellow-green) apart from small gold accents on the pen nib
and spire tips, notebook doodle aesthetic, no text.
```

### 2026-08-13（同日第五轮）：换用户出图工具为 GPT Image 2，v5 数字自检明显更好用；Lv.6 命中，Lv.9/10 待定

用户改用 GPT Image 2 出图，按 v5 prompt（含"外接框宽高比≥1.7 自检"那句）重出 Lv.6/9/10：

| 候选 | 目标等级 | 内容外接框宽高比 | contentWidthFrac | 结论 |
|---|---|---|---|---|
| `isometric_book_fortress.png` | Lv.6 | 1.66 | **0.93** | 采用，覆盖 `playerbase_l6.png`，已重跑 `pack_playerbase_atlas.js` + `patchMergedAtlas.js` 入库 |
| `citadel_diamond_doodle.png` | Lv.9 | 1.53 | 0.86 | 比现有 0.83 有改善，但未到满宽，**待用户拍板**是否接受或再出一版 |
| `citadel_diamond_doodle_1024.png` | Lv.10 | 3.08 | 0.94（满宽） | 宽度达标，但外接框比 Lv.9 平了一倍多——画面主体比 Lv.9 矮很多，跟"Lv.10 不该比 Lv.9 矮"的硬规有点冲突，构图内容也换成了链环+台阶（不是原 prompt 的钢笔造型）。**待用户确认**是否满意这个方向 |

数字自检（"整体外接框宽高比≥1.7，不够就把塔尖压更矮"）这次效果明显比上一轮的"squat"形容词好——Lv.6 一次命中。Lv.9/Lv.10 两张候选先留在 `art/ui/slg-playerbase/`（未改名，不是 playerbase_lN 也不是 leftover），等用户决定采用/重出再处理。
