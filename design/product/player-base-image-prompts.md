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
