# 玩家基地（desk）图片 Prompt

用途：世界地图上玩家自己的基地（`tile.mine`，desk 建筑等级 1-10）专用美术，与"可攻占城池"的 `city_atlas`（`design/product/city-image-prompts.md`）完全分开的独立图集，二者互不复用、互不回退。

## 为什么要分开

`city_atlas` 的 4 档/10 级贴图服务于世界地图上所有 `type==='base'` 的 tile（不分你我）以及可攻占的 NPC 城池节点，其等级来自地形生成的 `TileDoc.level`（出生/搬迁时写入一次），与玩家 desk 建筑等级完全无关联——desk 升满10级，原先的城池贴图不会跟着变。用户要求玩家自己的基地换一套独立美术，且主题要能和"城堡"类的城池贴图明显区分开。

**主题选择**：desk 建筑本身（连同 cabinet/drillYard/wall/satchel）走的是"文具"主题（见 `SLG_CITY_DESIGN.md` §"建筑图标出图"），玩家基地整体外观延续这条主线，做成"文具搭建的桌面堡垒"——铅笔盒、书本、尺子、订书机等逐级堆叠越来越宏伟，天然区别于 `city_atlas` 的石堡/木寨/城堡主题。

## 粒度：每级一张，共 10 张，无档位回退

帧命名：`playerbase_l1` … `playerbase_l10`。`getPlayerBaseTextureForLevel(level)` 直接取 `playerbase_l{level}`，取不到时代码回落 `getCityTextureForLevel`（临时用城池贴图顶替，避免裸露空白，见 `WorldMapRenderer/city.ts`）——不是像 `city_atlas` 那样的档位设计，10张图都得出全。

## 通用 Style（每条 prompt 末尾附加，与 city_atlas 完全一致，保证像素规格/去背方式兼容同一套打包脚本）

```
hand-drawn doodle illustration on graph paper, fountain pen blue ink lines,
slightly scratchy student sketch strokes, light watercolor marker fill,
gentle isometric perspective (25° tilt), isolated on transparent background,
512x512px, notebook doodle aesthetic, no text, no labels
```

## Prompt（10 张）

### `playerbase_l1` — Lv1「铅笔盒营地」

```
A tiny fort made from a single open pencil case lying on its side as a wall,
two pencils stuck upright as flagpoles with a tiny paper flag, an eraser as a
lookout block. Humble and sparse, like a student's first doodle.
Blue ink outline, pale yellow-green marker fill.
[+ style]
```

### `playerbase_l2` — Lv2「文具围栏」

```
A slightly bigger camp: pencil-case wall extended with a row of standing
pencils as a palisade fence, a ruler laid as a bridge/gate, an ink bottle as a
small watchtower. Blue ink outline, warm wood-pencil brown fill.
[+ style]
```

### `playerbase_l3` — Lv3「书本壁垒」

```
A small stronghold built from stacked notebooks as walls (book spines forming
crenellations), a stapler as a gate mechanism, two pencils crossed as a corner
tower. Cross-hatching on book covers. Cool grey-blue fill.
[+ style]
```

### `playerbase_l4` — Lv4「文具重镇」

```
A growing settlement: notebook-wall perimeter thickened with binder clips as
reinforcements, a tape dispenser as a round tower, a protractor forming an
arched gate. Busier and denser than the book stronghold. Warm fill with
grey-blue accents.
[+ style]
```

### `playerbase_l5` — Lv5「桌面要塞」

```
A large fortified desk-fort: stacked textbooks forming a tall keep, rulers
laid as ramparts along the top, closed scissors as crossed corner spikes, a
compass (drafting tool) planted as a spire. Blue ink, mixed warm/cool fill,
transitioning toward stone-like shading.
[+ style]
```

### `playerbase_l6` — Lv6「文具石堡」

```
A stone-like fortress built entirely from thick hardcover books and a heavy
binder as the central keep, correction-tape rolls as round corner towers, a
ruler-and-compass drawbridge. Heavier cross-hatching for texture.
Cool grey-blue fill.
[+ style]
```

### `playerbase_l7` — Lv7「加固书城」

```
A reinforced book-fortress: double ring of stacked books as inner/outer
walls, three tape-roll towers, a large hardcover book standing open as the
central keep with a pennant bookmark flag. Blue ink, dense cross-hatching.
[+ style]
```

### `playerbase_l8` — Lv8「巨型文具堡」

```
A massive stronghold built from a tower of encyclopedias and binders,
flanked by two large glue-stick spires, a stapler-and-hole-puncher gatehouse,
a moat drawn as a wavy blue ink-puddle outline around the base.
Imposing scale.
[+ style]
```

### `playerbase_l9` — Lv9「书院巨城」

```
An elaborate multi-tower citadel made of towering book stacks connected by
ruler-walls, four pencil-spires of varying heights, a grand central
binder-keep with a large paper pennant, dense parallel ruler-lines suggesting
grandeur. Slight gold accent on the tallest pencil tip.
[+ style]
```

### `playerbase_l10` — Lv10「文具帝都」

```
The grandest capital citadel, built entirely from an overwhelming tower of
books, binders, rulers and pencils: concentric book-wall rings, six or more
pencil/pen spires of varying heights, a soaring golden-nib fountain-pen spire
at the center crowned with a large paper pennant, monumental
stapler-gatehouse, dense ruler-line cross-hatching everywhere. Clearly the
single most magnificent structure, prominent gold accents on the pen nib and
spire tips.
[+ style]
```

## 接入说明（已实现代码管线，等美术图）

1. 把 10 张出好的图放进 `art/ui/slg-playerbase/`，命名 `playerbase_l1.png` … `playerbase_l10.png`
2. 跑 `node art/ui/slg-playerbase/pack_playerbase_atlas.js`（打包逻辑照抄 `pack_city_atlas.js` 的区域生长去背算法），输出 `client/src/assets/slg/playerbase_atlas.{png,json}`，覆盖当前的空占位图
3. 代码已接入：`client/src/render/playerBaseAtlasLoader.ts` 提供 `loadPlayerBaseAtlas()`/`getPlayerBaseTextureForLevel(level)`；`WorldMapRenderer/lifecycle.ts` 随其余图集一起加载；`WorldMapRenderer/city.ts` 按 `tile.mine` 分支选图（自己的基地用这套，其他玩家的基地和 NPC 城池节点继续用 `city_atlas`）
4. 服务端：`worldsvc/src/city.ts` 的 `applyDueBuilds` 在 desk 完工时把新等级写入 `TileDoc.deskLevel`，`coreMap.ts tileDocView` 透出到 `WorldTileView.deskLevel`——图片就位后无需再改这部分代码
