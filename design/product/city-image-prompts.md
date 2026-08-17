# SLG 城池图片 Prompt

用途：在大世界地图 tile 上显示玩家主城 + NPC 城池（州府 / 关隘城 / 分级城 / 世界中心）。游戏客户端与地图编辑器共用同一套图（`getCityTextureForLevel`，art-parity）。

## 粒度：每级一张（2026-07-06 用户拍板）

原先 4 档（Tier1=Lv1-2/Tier2=Lv3-5/Tier3=Lv6-8/Tier4=Lv9-10）覆盖 10 级；现改为**每级一张，共 10 张**，城随等级递进变大更宏伟。等级同时决定**占地格数**（`cityFootprint`，见 SLG_DESIGN §3.4）：Lv1-2=3×3，Lv3-5=5×5，Lv6-8=7×7，Lv9-10=9×9。

- **图集帧命名**：`city_l1 … city_l10`（每级一帧）。`getCityTextureForLevel(level)` 先找 `city_l{level}`，找不到再回退到旧的 4 档帧 `city_lv{tier}`——所以 6 张新图**就位后零改代码**，未就位时该级临时用所属档的旧图。
- **已有 4 张**（`city_atlas` 现有 `city_lv1..4`）继续作为各档回退，并对应各档**最低级**：`city_lv1`=Lv1(营地) / `city_lv2`=Lv3(木寨) / `city_lv3`=Lv6(石堡) / `city_lv4`=Lv9(大城)。
- **需新出 6 张**：`city_l2 / city_l4 / city_l5 / city_l7 / city_l8 / city_l10`（下方"新增分级 Prompt"给出）。
- 出图后重新打包成图集（帧名 `city_l{n}`，参照 `art/slg/slg-building/pack_city_atlas.js`），`png+json` 放 `client/src/assets/slg/city_atlas.{png,json}`，并同步拷贝到 `tools/map-editor/src/assets/slg/`（编辑器用同一份）。若也想给 Lv1/3/6/9 出全新图，把它们一并命名 `city_l1/l3/l6/l9` 打进图集即可（否则自动回退到现有 `city_lv1..4`）。

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

6 张新图已就位并打包进图集，帧齐全：`city_atlas` 现含 `city_lv1..4`（档回退）+ `city_l2/l4/l5/l7/l8/l10`（每级图），共 10 帧，1024×768，调色板量化 ~287 KB。`png+json` 已写入 `client/src/assets/slg/` 与 `tools/map-editor/src/assets/slg/`（两份字节一致）。打包脚本 `art/slg/slg-building/pack_city_atlas.js` 已重写：区域生长 flood-fill 去背（兼容浅色方格纸 / 深色晕影 / 纯色 / 已抠图 4 类背景），10 帧网格，sharp 调色板压缩。源图已按帧名重命名（`city_l{n}.png` / `city_lv{n}.png` / `city_l10.webp`）。

- **仍待补**：Lv1/3/6/9 无专属图，运行时回退到所属档的 `city_lv{tier}`（去背干净，可正常用）。
- **`city_lv4` 已修**（2026-07-06）：原 0fe2fbb5 源图自带的不透明方格纸底板已用 flood-fill（从透明边缘向内、按底板色扩散、遇城堡深墨轮廓停）抠除，再删除小的离散残块（陷阱像素/网格碎片），仅保留城堡本体+其贴地投影。已覆盖回 `city_lv4.png` 源并重新打包，全 10 帧现均无背景。

## 接入说明（已实现）

代码已接入：`getCityTextureForLevel(level)`（`client/src/render/atlas/cityAtlasLoader.ts` + `tools/map-editor/src/render/atlas/cityAtlasLoader.ts`）按等级直取 `city_l{level}`（2026-08-14 起 10 级均有专属帧，无档位回退，见下方"命名统一"）。
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

**顺带清理**：`art/slg/slg-building/` 目录里另有 2 个 UUID 命名的 `.webp`（悬崖栈道 / 石拱桥，黑白铅笔素描），既不在 `pack_city_atlas.js` 的 `FILES` 列表里、画风也跟 `city_atlas` 蓝墨线等轴测涂鸦完全不符——不是这次审计的产物，大概率是"桥/栈道"（`building_bridge`/`building_plankway`，真正管线在 `art/slg/slg-map/pack_buildings.cjs`）早期探索时误放在这个目录、画风不对被搁置的草稿。已按约定移入 `art/leftover/`（保留原文件名，未删）。

## 递进审计（2026-08-14）——Lv6 比 Lv5 简化，违反"越级越宏伟"，需重出图

铺格审计之外，用户追问"10 张图是否真的一级一张"，顺带核实了一遍**覆盖完整性**（哈希比对 10 帧原始像素，全部互不相同，一一对应 10 级，无重复无缺失——`city_lv1/2/3/4` 虽然沿用旧的"档位回退"命名，但内容本来就是各自档位**最低那一级**的专属图，不是临时顶替）和**跨档边界的视觉递进**（每档"顶配"vs 下一档"入门"是否读得出"更宏伟"）：

| 边界 | 前一级 | 后一级 | 结论 |
|---|---|---|---|
| Lv2→Lv3 | `city_l2`（帐篷营地） | `city_lv2`（木寨小镇，真房子+烟囱） | 正常，明显更发达 |
| **Lv5→Lv6** | `city_l5`（大型木寨，多建筑+市集+瞭望塔，画面很满） | `city_lv3`（单个主堡+两座角楼，构图简单） | **反常——Lv6 比 Lv5 简单** |
| Lv8→Lv9 | `city_l8`（大型石堡+护城河） | `city_lv4`（多塔蓝色城堡） | 大致相当，过渡自然 |

**根因**：`city_lv3.png` 是 2026-07-06"每级一张"改版前的老图，当初的定位只是"石头堡垒档"里画得最朴素的入门代表，从没跟同档已经很饱满的 Lv5 放在一起比较过。Lv6 的地块从 5×5 跳到 7×7（渲染时精灵线性放大，画面在屏幕上确实变大），但画面内容本身（建筑数量、细节密度）明显比 Lv5 少，玩家会读出"升级了城反而变简单"的错觉。

**结论**：9 张图（含另外 3 张旧档回退图 `city_lv1/2/4`）在各自位置过渡正常，唯独 `city_lv3.png`（Lv6）建议重新出图，衔接住 Lv5 的饱满度，向 Lv7（双层同心环+三塔）过渡。

### `city_lv3` 重出 prompt — Lv6「石头堡垒」（衔接 Lv5→Lv7，替换现有 `city_lv3.png`）

```
A proper stone fortress town, not a single lonely keep: thick crenellated
outer walls enclosing a busy courtyard with AT LEAST 5 distinct structures —
a central keep taller than the walls with a peaked roof and pennant, two
round corner towers with arrow-slit windows flanking a stone gatehouse with
a drawbridge and portcullis (grid of lines), plus a barracks building, a
storehouse, and a small well or market stall tucked inside the walls. Heavy
cross-hatching on all stone surfaces for texture. The finished silhouette
must read AT LEAST as full and detailed as a large developed wooden town —
match the building-count and density of city_l5.png, do not make it simpler
or emptier than that reference — this is the first STONE tier and must never
look plainer or smaller than the wood tier's peak that came right before it,
while still clearly reading more fortified and stony. Sits on its own wide
isometric ground plate, same camera framing as city_l5.png/city_l7.png (top-
down rotated diamond, not a front elevation). Blue ink outline, cool grey-blue
fill for stone, warm brown accent only on the wooden gate/drawbridge beams.
[+ style]
```

要点沿用 playerbase 那次摸出来的"数字自检 > 形容词"经验：明确写"至少 5 个独立建筑"这种可数的硬指标，并直接点名"参照 `city_l5.png` 的密度，不能比它更空"，比抽象描述"宏伟"更容易在生图时命中。

**待办**：用户出图后按同样方法核对（跟 `city_l5`/`city_l7` 放一起肉眼比对饱满度，另外过一遍铺格审计的 bbox 宽高比 ≥0.9375 判据），落地后 `node art/slg/slg-building/pack_city_atlas.js` 重新打包 + `patchMergedAtlas.js` 补丁进 `world_atlas`，旧 `city_lv3.png` 移入 `art/leftover/`。

**第一版候选（2026-08-14）——画风不对，不采用**：用户按上面的 prompt 出了一版，内容/密度达标（多建筑、井、市集摊位、锻造炉，明显比旧图丰富），但**整体画风是精细写实上色插画**（石材渐变光影、仿真质感、专业原画级别层次），跟 `city_atlas` 全系列"钢笔蓝墨线速写 + 单色/双色水彩淡填充、无光影渐变"的扁平涂鸦风格完全不是一种媒介，放进图集会非常突兀。

根因分析：跟 playerbase 那次"机位指令埋在结尾没吃到"是同一类坑——风格约束（"hand-drawn doodle illustration...fountain pen blue ink lines...watercolor marker fill"）只放在末尾通用 `[+ style]` 段落里，正文描述内容本身没有任何风格限定词，生成工具显然只认了内容、没认风格。

### `city_lv3` v2 prompt（风格约束前置 + 具体负面排除）

```
A loose hand-drawn ink DOODLE sketch on graph paper — NOT a detailed painted
illustration, NOT realistic shading, NOT rendered stone texture with light/
dark gradients. Flat, scratchy fountain-pen blue ink outlines with occasional
cross-hatching for texture ONLY (no smooth shading, no gradients, no
photorealism), filled with simple FLAT single-tone watercolor washes (cool
grey-blue for stone, warm orange-brown for wood roofs/beams) — like a
student's notebook margin doodle, matching the exact rendering style of
city_l5.png and city_l7.png (same medium, same flatness, same line
weight — NOT a game-art render, NOT a book illustration).

Subject: a proper stone fortress town, not a single lonely keep — thick
crenellated outer walls enclosing a busy courtyard with AT LEAST 5 distinct
structures: a central keep taller than the walls with a peaked roof and
pennant, two round corner towers with arrow-slit windows flanking a stone
gatehouse with a drawbridge and portcullis (grid of lines), plus a barracks
building, a storehouse, and a small well or market stall tucked inside the
walls. The finished silhouette must read AT LEAST as full and detailed as a
large developed wooden town — match the building-count and density of
city_l5.png, do not make it simpler or emptier than that reference — this is
the first STONE tier and must never look plainer or smaller than the wood
tier's peak that came right before it. Sits on its own wide isometric ground
plate, same top-down rotated-diamond camera as city_l5.png/city_l7.png (NOT
a front elevation).
[+ style]
```

v2 把风格约束（"是涂鸦速写不是精细插画"）挪到全文最前面并用具体负面词排除（"NOT realistic shading/rendered texture/game-art render/book illustration"），内容段落原样保留（已验证密度达标）。

**v2 候选（2026-08-14，采用）**：用户按 v2 prompt 重出一版，画风这次对上了（蓝墨线+交叉排线+扁平色块，跟 `city_l5.png` 同一媒介），方格纸背景（`pack_city_atlas.js` 的去背算法专为此设计，不是问题）。用真实打包管线核对（不是肉眼）：

| 项 | 数值 | 判定 |
|---|---|---|
| 去背（真实跑 `cutBackground` 区域生长算法） | 干净，方格纸完全清除，无残留、无吃穿建筑 | PASS |
| 内容外接框宽高比 | 2557×1423 → 1.797 | PASS（远超 ≥0.9375 阈值） |
| 宽度填充 `fittedW/CELL` | 1.0（宽度触底，自动贴满整格） | PASS |

内容密度也核对过（跟 `city_l5.png`/`city_l7.png` 放同一显示尺度对比）：新图建筑数量/细节明显超过 Lv5（多了锻造炉小屋、水井、更多市集摊位），原先"Lv6 比 Lv5 简单"的问题解决。**唯一花絮**：新图外接框偏"扁"（宽高比 1.797，比 Lv5 的 1.0/Lv7 的 0.988 都更矮胖）——Lv6/Lv7 同属 7×7 地块档、精灵尺寸相同，所以实机会看到 Lv6 明显比 Lv7 更低矮；不违反任何硬性指标（宽度照样贴满），也符合 city 建筑"矮宽、地台=地块"的定位，记录在案，暂不处理。

**已采用并落地**：
- 源图（webp 格式，未转 png，避免有损转码）改名为 `city_lv3.webp`，`pack_city_atlas.js` 的 `FILES` 列表同步把 `city_lv3.png` 改成 `city_lv3.webp`（沿用 `city_l10.webp` 已验证过的 webp 支持路径）
- 旧 `city_lv3.png`（2026-07-06 之前的老图，简单单堡+两角楼版本）移入 `art/leftover/city_lv3_pre-2026-08-14-lv6-fix.png`，未删
- 重跑 `pack_city_atlas.js` + `patchMergedAtlas.js`，补丁进 `client/src/assets/slg/world_atlas.{png,json}`；`tools/map-editor/src/assets/slg/city_atlas.{png,json}` 由打包脚本自动同步写入
- 从合并后的 `world_atlas.png` 按 frame 坐标重新 extract 实际像素核对（不是只信打包脚本打印的数字）：`city_lv3` 帧宽高比 1.771（打包时因取整 -1px 级误差，跟源图直测的 1.797 一致），`contentTop=0.4453`，肉眼确认跟前面候选阶段的预览一致，去背干净

## 命名统一（2026-08-14）——源图 + 帧名 + 运行时全部改成 `city_l1..city_l10`，档位回退彻底退休

前面的排查过程中，用户发现 `art/slg/slg-building/` 目录下的 10 个源文件一直分两套命名——`city_lv1/2/3/4`（4 张 2026-07-06 之前的老"档位回退"图，对应 Lv1/3/6/9）+ `city_l2/4/5/7/8/10`（6 张 2026-07-06 起的专属图）——这正是最早"2 级和 4 级有两张、6 级却没有"那次困惑的根源。既然 10 级现在都有各自专属的正确美术（含刚修完的 Lv6），双命名体系已经没有存在理由，借这次机会彻底拉平。

**改动范围（源文件 → 帧名 → 运行时，三层一起改，不是只挪文件名）**：

1. **源文件重命名**：`city_lv1.png→city_l1.png`、`city_lv2.png→city_l3.png`、`city_lv3.webp→city_l6.webp`、`city_lv4.png→city_l9.png`（其余 6 个本来就叫 `city_l{level}`，不动）。`pack_city_atlas.js` 的 `FILES` 列表同步更新（`file`+`name` 两个字段），并按 l1→l10 顺序重排，头部注释也删掉"tier fallback"的描述。
2. **图集帧名同步改名**：重跑 `pack_city_atlas.js` 生成新帧名的中间产物；`world_atlas.json`（client 用的合并图集）里旧的 4 个 `city_lv*` 帧名不能直接"改名"（`patchMergedAtlas.js` 按名字匹配、找不到同名旧帧会跳过），改用 `art/scripts/appendAtlasFrames.js` 把 4 个新名字（`city_l1/l3/l6/l9`）追加进页面（shelf-pack，页面从 2048×3782 长高到 2048×4038），再手动删掉 JSON 里的 4 个旧 `city_lv*` key（对应的旧像素留在 PNG 里不管，未被任何帧引用，无害，只是白占了点空间）。`tools/map-editor/src/assets/slg/city_atlas.{png,json}` 由打包脚本整体重新生成，直接就是新帧名，不需要这套 append/delete 手术。
   - 验证：重新用审计脚本核对了新帧名对应的实际像素（宽高比/`contentTop`），10 项数值跟改名前逐一比对完全一致，确认只是换了 key，没有动到任何像素。
3. **运行时代码简化**：`getCityTextureForLevel(level)` 现在直接 `atlas.getTexture('city_l'+level)`，去掉了 `?? atlas.getTexture('city_lv'+cityTier(level))` 这条永远不会再命中的回退分支（`client/src/render/atlas/cityAtlasLoader.ts` + `tools/map-editor/src/render/cityAtlasLoader.ts` 两份都改）。连带清理：
   - `getCityTexture(tier)`（`cityAtlasLoader.ts` 里另一个按档位取图的导出函数）——检查后发现只有 `WorldMapInput.ts` 引用过它，且从未被实际调用过（纯 dead import），一并删除，`WorldMapInput.ts` 的 import 同步瘦身。
   - `cityTier(level)`（`server/shared/src/slg/core.ts`）——排查全仓库，唯一的调用方就是上面两个 loader 和它们的测试，改完之后彻底无人引用，按项目"不留死代码"的约定直接删掉这个导出函数。
4. **测试同步**：`client/test/ui/cityAtlasContentTop.ui.ts` 里"专属帧"和"档位回退"两条分开的断言合并成一条"10 级都有专属帧"；`cityAtlasContentTopFallback.ui.ts` 的 mock 帧集合从 `city_lv1..lv4` 换成 `city_l1`/`city_l10`（该文件测的是"帧存在但缺 `contentTop` 字段"这个边界情况，跟档位回退无关，只是 mock 数据顺手一起改名保持一致）。

**验证**：`tsc -b shared`（server）+ `tsc --noEmit`（client、map-editor）三处全绿；client UI 测试套件 177 个文件 1594 例全绿（含改过的 2 个文件）；map-editor 测试套件 7 个文件 125 例全绿。

**不属于这次改动范围、刻意没动的东西**：`design/game/SLG_DESIGN_LOG.md`、`design/DECISIONS.md`、`design/tools/map-editor/DESIGN.md` 里提到 `city_lv1..4`/`cityTier` 的历史记录条目——那些是带日期的过程记录，写的是"当时发生了什么"，不是"现在架构是什么"，不应该被事后改写；只更新了 `WORLD_MAP_ART_SPEC.md` 里那条**当前状态**参考表（改成 `city_l1..l10`）和本文档的"接入说明"。
