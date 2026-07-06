# SLG 城池图片 Prompt

用途：在大世界地图 tile 上显示玩家主城 + NPC 城池（州府 / 关隘城 / 分级城 / 世界中心）。游戏客户端与地图编辑器共用同一套图（`getCityTextureForLevel`，art-parity）。

## 粒度：每级一张（2026-07-06 用户拍板）

原先 4 档（Tier1=Lv1-2/Tier2=Lv3-5/Tier3=Lv6-8/Tier4=Lv9-10）覆盖 10 级；现改为**每级一张，共 10 张**，城随等级递进变大更宏伟。等级同时决定**占地格数**（`cityFootprint`，见 SLG_DESIGN §3.4）：Lv1-2=3×3，Lv3-5=5×5，Lv6-8=7×7，Lv9-10=9×9。

- **图集帧命名**：`city_l1 … city_l10`（每级一帧）。`getCityTextureForLevel(level)` 先找 `city_l{level}`，找不到再回退到旧的 4 档帧 `city_lv{tier}`——所以 6 张新图**就位后零改代码**，未就位时该级临时用所属档的旧图。
- **已有 4 张**（`city_atlas` 现有 `city_lv1..4`）继续作为各档回退，并对应各档**最低级**：`city_lv1`=Lv1(营地) / `city_lv2`=Lv3(木寨) / `city_lv3`=Lv6(石堡) / `city_lv4`=Lv9(大城)。
- **需新出 6 张**：`city_l2 / city_l4 / city_l5 / city_l7 / city_l8 / city_l10`（下方"新增分级 Prompt"给出）。
- 出图后重新打包成图集（帧名 `city_l{n}`，参照 `art/ui/slg-building/pack_city_atlas.js`），`png+json` 放 `client/src/assets/slg/city_atlas.{png,json}`，并同步拷贝到 `tools/map-editor/src/assets/slg/`（编辑器用同一份）。若也想给 Lv1/3/6/9 出全新图，把它们一并命名 `city_l1/l3/l6/l9` 打进图集即可（否则自动回退到现有 `city_lv1..4`）。

---

## 通用 Style（每条 prompt 末尾附加）

```
hand-drawn doodle illustration on graph paper, fountain pen blue ink lines,
slightly scratchy student sketch strokes, light watercolor marker fill,
gentle isometric perspective (25° tilt), isolated on transparent background,
512x512px, notebook doodle aesthetic, no text, no labels
```

---

## `city_lv1` = Lv 1「小营地」（现有；Tier1 回退）

```
A tiny military camp: 2 small tents made of triangles, a low wooden fence
drawn as zigzag lines around the perimeter, a small flag on a stick in the
center. Humble and sparse, like a student's first doodle. Blue ink outline,
minimal color fill (pale yellow-green tint inside fence).
[+ style]
```

## `city_lv2` = Lv 3「木寨小镇」（现有；Tier2 回退）

```
A small walled town: a rough rectangular wooden palisade wall (vertical plank
lines), 3-4 blocky buildings inside, one taller central watchtower, a wooden
gate with crossbar, tiny smoke wisps from a chimney. Charming and slightly
messy. Blue ink, warm orange-brown fill for wood.
[+ style]
```

## `city_lv3` = Lv 6「石头堡垒」（现有；Tier3 回退）

```
A stone fortress: thick crenellated castle walls forming a square, two round
corner towers with arrow-slit windows, a central keep taller than the walls,
a drawbridge gate with portcullis (grid of lines). Cross-hatching on stone
surfaces for texture. Blue ink outline, cool grey-blue fill for stone.
[+ style]
```

## `city_lv4` = Lv 9「书院大城」（现有；Tier4 回退）

```
An elaborate multi-tower citadel: four tall towers connected by high stone
walls, a grand central spire with a pennant flag, layered battlements, dense
cross-hatching and ruler-straight parallel lines suggesting a grand fortress.
The most complex and imposing structure on the map. Deep blue ink, multiple
layers of detail, slight gold accent on spire tip.
[+ style]
```

---

## 新增分级 Prompt（6 张，需新出）

命名对应帧：Lv2→`city_l2`，Lv4→`city_l4`，Lv5→`city_l5`，Lv7→`city_l7`，Lv8→`city_l8`，Lv10→`city_l10`。每条都要在同一档内、比"档最低级"那张更繁复更大，让相邻等级看得出递进。

### `city_l2` — Lv 2「扩建营寨」（Tier1，比 Lv1 大一档）

```
A slightly larger military camp: 3-4 tents of varying sizes, a wooden watch
platform on stilts in the middle, a taller central banner, the perimeter fence
sturdier with a simple log gate. Still humble and sketchy but clearly a step up
from a two-tent camp. Blue ink outline, pale yellow-green marker fill.
[+ style]
```

### `city_l4` — Lv 4「木寨扩镇」（Tier2 中段）

```
A growing wooden town: rectangular palisade wall with a raised fighting walk,
5-6 blocky houses inside, two watchtowers (one taller), a reinforced double-leaf
wooden gate, more chimney smoke. Busier and denser than a small wooden fort.
Blue ink, warm orange-brown wood fill.
[+ style]
```

### `city_l5` — Lv 5「木寨大镇」（Tier2 顶，向石堡过渡）

```
A large fortified wooden town beginning to add stone: mixed wood-and-stone
perimeter wall, a stone base under the central watchtower, 7-8 buildings, a
market square hinted with tiny stalls, twin gate towers. The most developed
wooden settlement, just short of a true stone castle. Blue ink, warm wood fill
with grey-blue stone accents at the base.
[+ style]
```

### `city_l7` — Lv 7「石堡加固」（Tier3 中段）

```
A reinforced stone fortress: thicker crenellated walls with a second inner wall
ring, three corner towers, a larger central keep with a peaked roof, a stone
gatehouse with double portcullis, banners on the towers. Heavier cross-hatching
for stone texture. Blue ink outline, cool grey-blue stone fill.
[+ style]
```

### `city_l8` — Lv 8「要塞重城」（Tier3 顶，向大城过渡）

```
A massive stone stronghold: high double curtain walls with many towers, a tall
central keep flanked by two smaller spires, a fortified barbican gate, arrow
slits and machicolations, a moat drawn as a wavy blue outline around the base.
Imposing, nearly a citadel. Blue ink, cool grey-blue stone fill, faint blue moat.
[+ style]
```

### `city_l10` — Lv 10「王都巨城」（Tier4 顶，全图最宏伟）

```
The grandest capital citadel on the map: concentric layered walls, six or more
tall towers of varying heights, a soaring central golden spire crowned with a
large pennant, tiered battlements, a monumental gatehouse, dense ruler-straight
parallel lines and cross-hatching everywhere suggesting overwhelming scale and
detail. Clearly the single most magnificent structure. Deep blue ink, multiple
detail layers, prominent gold accents on the tallest spires.
[+ style]
```

---

## 接入说明（已实现）

代码已接入：`getCityTextureForLevel(level)`（`client/src/render/cityAtlasLoader.ts` + `tools/map-editor/src/render/cityAtlasLoader.ts`）按等级取 `city_l{level}`，回退 `city_lv{tier}`。
- **游戏内**：`WorldMapRenderer.refreshCityLayer` 为玩家主城（`base`）**和** NPC 城池节点（`allCityNodes`：州府/关隘城/分级城/世界中心）各放一个精灵，尺寸按 `footprint/BASE_FOOTPRINT × BASE_SPRITE_TILES` 缩放（城越高越大）。
- **编辑器**：`refreshCitySprites`（`tools/map-editor/src/index.ts`）用同一函数、同一缩放规则画城池——所见即游戏内所见。
- 阵营 tint（自己红 `0xcc2222` / 友军绿 `0x2e8b40` / 敌方蓝 `0x224488`）目前只作用于玩家主城的动态层，NPC 城池按原图渲染。
