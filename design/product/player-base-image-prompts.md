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

## 通用 Style（每条 prompt 末尾附加，与 city_atlas 同规格以兼容同一套打包脚本）

```
Hand-drawn doodle illustration, fountain pen blue ink outlines, slightly
scratchy student sketch strokes with cross-hatching, watercolor marker fill in
a single pale yellow-green wash only, strictly two-tone (blue ink + pale
yellow-green, no other colors), gentle isometric perspective (25 degree tilt),
centered composition, isolated on a solid pure-white background, no grid lines,
no ground shadow, 512x512px, notebook doodle aesthetic, no text, no labels.
```

> Lv9/Lv10 把上面 style 里的 `strictly two-tone (...no other colors)` 换成 `otherwise strictly two-tone (blue ink + pale yellow-green) apart from the small gold accents`，以放行金色点缀。

## Prompt（10 张，双色调最终版）

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

## 接入现状（2026-07-17）

> **注意**：代码管线（loader / 渲染分支 / deskLevel 数据线 / 打包脚本）已按下方所述上线，但**美术图正按上面敲定的双色调方向重新生成**——首版打包用的是最初草稿风格的图。Lv1/Lv2/Lv5/Lv10 四张双色调定稿图已过审，其余中间级待补齐后重跑 `pack_playerbase_atlas.js` 覆盖。

10 张图已由用户按 prompt 生成、放入 `art/ui/slg-playerbase/`（`playerbase_l1.png` … `playerbase_l10.png`，混合 png/webp），并跑 `node art/ui/slg-playerbase/pack_playerbase_atlas.js` 打包成 `client/src/assets/slg/playerbase_atlas.{png,json}`，覆盖了此前的空占位图。

**打包脚本一处偏差（相对 `pack_city_atlas.js`）**：这批源图的背景是纯白、无方格纸网格，而建筑主体的浅黄绿色水彩填充与白色背景的色距（约44）小于 `pack_city_atlas.js` 原有的 `TSEED=72` 绝对阈值，会导致区域生长去背算法从边缘一路吃穿建筑内部填充（`playerbase_l7` 曾被吃成碎片）。`pack_playerbase_atlas.js` 因此把 `TSEED` 改成 `0`（只保留 `TSTEP=33` 的渐变跟随去背），10 帧全部干净切割，无需网格桥接。

代码管线（无需再改）：
- `client/src/render/playerBaseAtlasLoader.ts` 提供 `loadPlayerBaseAtlas()`/`getPlayerBaseTextureForLevel(level)`；`WorldMapRenderer/lifecycle.ts` 随其余图集一起加载
- `WorldMapRenderer/city.ts` 按 `tile.mine` 分支选图（自己的基地用这套，其他玩家的基地和 NPC 城池节点继续用 `city_atlas`）
- 服务端 `worldsvc/src/city.ts` 的 `applyDueBuilds` 在 desk 完工时把新等级写入 `TileDoc.deskLevel`（新字段），`coreMap.ts tileDocView` 透出到 `WorldTileView.deskLevel`（`server/contracts/openapi-world.yml` 已加对应 schema 字段，client/worldsvc 的生成类型已同步重新生成）
