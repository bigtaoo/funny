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

## 打包现状（2026-07-06）

6 张新图已就位并打包进图集，帧齐全：`city_atlas` 现含 `city_lv1..4`（档回退）+ `city_l2/l4/l5/l7/l8/l10`（每级图），共 10 帧，1024×768，调色板量化 ~287 KB。`png+json` 已写入 `client/src/assets/slg/` 与 `tools/map-editor/src/assets/slg/`（两份字节一致）。打包脚本 `art/ui/slg-building/pack_city_atlas.js` 已重写：区域生长 flood-fill 去背（兼容浅色方格纸 / 深色晕影 / 纯色 / 已抠图 4 类背景），10 帧网格，sharp 调色板压缩。源图已按帧名重命名（`city_l{n}.png` / `city_lv{n}.png` / `city_l10.webp`）。

- **仍待补**：Lv1/3/6/9 无专属图，运行时回退到所属档的 `city_lv{tier}`（去背干净，可正常用）。
- **`city_lv4` 已修**（2026-07-06）：原 0fe2fbb5 源图自带的不透明方格纸底板已用 flood-fill（从透明边缘向内、按底板色扩散、遇城堡深墨轮廓停）抠除，再删除小的离散残块（陷阱像素/网格碎片），仅保留城堡本体+其贴地投影。已覆盖回 `city_lv4.png` 源并重新打包，全 10 帧现均无背景。

## 接入说明（已实现）

代码已接入：`getCityTextureForLevel(level)`（`client/src/render/atlas/cityAtlasLoader.ts` + `tools/map-editor/src/render/atlas/cityAtlasLoader.ts`）按等级取 `city_l{level}`，回退 `city_lv{tier}`。
- **游戏内**：`WorldMapRenderer.refreshCityLayer` 为玩家主城（`base`）**和** NPC 城池节点（`allCityNodes`：州府/关隘城/分级城/世界中心）各放一个精灵，尺寸按 `footprint/BASE_FOOTPRINT × BASE_SPRITE_TILES` 缩放（城越高越大）。
- **编辑器**：`refreshCitySprites`（`tools/map-editor/src/index.ts`）用同一函数、同一缩放规则画城池——所见即游戏内所见。
- 阵营 tint（自己蓝 `0x224488` / 友军绿 `0x2e8b40` / 敌方红 `0xcc2222`，ADR-003 铁律）目前只作用于玩家主城的动态层，NPC 城池按原图渲染。

## 铺格审计（2026-08-13）——结论：10 帧全部健康，未返工

playerbase_atlas 折腾 8 个子回合（[[slg-playerbase-oversized-fix-2026-07-17]]）解决"desk 贴图铺不满 3×3 地块"后，用同一套方法论回头审计 `city_atlas`（NPC 可攻占城池）是否有同类问题。**结论：没有，10 帧全部贴合自己的等轴测地块，无需重出图或改打包脚本**——因为 city_atlas 从一开始就走了另一条设计路线，两个关键差异让它天然不会踩 playerbase 踩过的坑：

1. **`citySpriteTiles(footprint, BASE_SPRITE_TILES)` 是线性缩放**（`(footprint/BASE_FOOTPRINT) × BASE_SPRITE_TILES`），精灵方形边长与自身地块宽度的比值恒为 `BASE_SPRITE_TILES/BASE_FOOTPRINT = 3.2/3 ≈ 1.067`，与 footprint 具体取值（3×3/5×5/7×7/9×9 四档）无关——这 6.7% 就是 `cityPlotMaskPoints` 文档里说的"故意画得比地块宽 7%，靠裁剪菱形收边"。**因此判定阈值只需算一遍，对全部 10 级、四档 footprint 通用**，不像 playerbase 那样要按等级分别验证。
2. **打包脚本 `pack_city_atlas.js` 用单轴 `fit:'inside'` 塞进正方形 CELL**（不像 `pack_playerbase_atlas.js` 有独立的 `CONTENT_W_FRAC`/`CONTENT_H_FRAC`）。由此可推出一个简洁的判据：设内容外接框宽高比为 `aspect = cw/ch`——
   - `aspect ≥ 1`（内容本身不比高更窄）时，宽度必然是 `fit:'inside'` 的触底轴，`fittedW/CELL` 恒为 `1.0`，自动打满整格宽度（略超 7%，交给 mask 裁边，正是设计预期的"贴边"效果）；
   - `aspect < 1` 时，`fittedW/CELL = aspect` 本身。
   
   代入"贴满地块宽度"的目标（`fittedW/CELL ≥ BASE_FOOTPRINT/BASE_SPRITE_TILES = 3/3.2 = 0.9375`），两种情况合并为一条统一判据：**内容外接框宽高比 `cw/ch ≥ 0.9375` 即视为贴满**。

**审计方法**：抛弃式 node+sharp 脚本，直接从当前线上 `client/src/assets/slg/world_atlas.png`（不是中间产物 `city_atlas.png`）按 `world_atlas.json` 里 10 个 `city_*` 帧坐标 `extract`，测每帧 alpha>10 的内容外接框（因为打包时已去背，无需重跑区域生长）：

| 帧 | 外接框 (px) | 宽高比 | 判据 (≥0.9375) | contentTop |
|---|---|---|---|---|
| city_l2 | 251×168 | 1.494 | PASS | 0.32 |
| city_l4 | 246×185 | 1.330 | PASS | 0.26 |
| city_l5 | 256×256 | 1.000 | PASS | 0.00 |
| city_l7 | 247×250 | 0.988 | PASS（贴近阈值） | 0.00 |
| city_l8 | 256×254 | 1.008 | PASS | 0.01 |
| city_l10 | 253×253 | 1.000 | PASS | 0.01 |
| city_lv1 | 246×122 | 2.016 | PASS | 0.50 |
| city_lv2 | 256×249 | 1.028 | PASS | 0.01 |
| city_lv3 | 246×204 | 1.206 | PASS | 0.19 |
| city_lv4 | 244×245 | 0.996 | PASS（贴近阈值） | 0.02 |

10 帧宽高比落在 0.988~2.016，全部 ≥ 0.9375（多数直接是 1.0 附近，即宽度轴触底、自动打满整格）；仅 `city_l7`（0.988）/`city_lv4`（0.996）贴近阈值但仍在安全边内。抽样把 5 帧（l2/l5/l7/lv1/l10）放大到 512px 肉眼复核，确认每帧确实自带一块清晰的等轴测菱形地台，建筑/围栏铺到地台边缘——数字判据与肉眼观察一致，不是背景抠图残留像素撑大了外接框。

**结论**：`city_atlas` 设计初衷（"图自带地台，地台=地块，整体矮宽"）成立，未发现 playerbase 那类"建筑铺不满地块"的缺陷，任务到此收尾，不需要改 `pack_city_atlas.js`、不需要重出图。审计脚本为抛弃式临时文件，未入库。
