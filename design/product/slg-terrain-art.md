# SLG 地图地形底格 — AI 出图 prompt 表

状态：已实现（2026-07-02）——7 张地形贴图归档 + 打包脚本 + `WorldMapScene.drawTileL1` 接入全部完成
关联：等距菱形网格改动见 [`design/DECISIONS.md`](../DECISIONS.md) ADR-029（本文档即其 "Out of scope" 里记录的地形贴图跟进项）；地形类型语义见 [`design/game/SLG_DESIGN.md`](../game/SLG_DESIGN.md) §3.1/§14.10/S8-6.6；美术铁律 / 出图管线见 [`art-direction.md`](art-direction.md) §〇 / §6.2；资源母题先例见 [`slg-resource-art.md`](slg-resource-art.md)

---

## 0. 这份文档是什么 / 只要出 7 张

目前地图地形底格（`drawTileL1` 里 `beginFill(fill,0.7)` 那层，见 [`WorldMapScene.ts:719-722`](../../client/src/scenes/WorldMapScene.ts:719)）是纯色 `PIXI.Graphics` 填充，无手绘贴图。资源格已经有母题贴图叠加（`res_atlas`），不需要单独出地面图；真正缺的是地形本身的地面纹理。

**只需要生成这 7 张地面贴图**：

| 资产名 | 对应 `TERRAIN_COLORS` / TileType | 语义（SLG_DESIGN §3.1/S8-6.6） |
|---|---|---|
| `terrain_grass` | `neutral` / `territory` / `base` 及资源格默认地面 | 空地，默认中性地面 |
| `terrain_mountain` | `obstacle`（变体 A） | 山脉，完全不可通行 |
| `terrain_river` | `obstacle`（变体 B） | 河流，完全不可通行 |
| `terrain_gate` | `gate` | 关隘/桥，嵌于阻挡带间的唯一通道 |
| `terrain_keep` | `familyKeep` | 战略要地/咽喉点 |
| `terrain_center` | `center` | 世界中心，赛季终局争夺目标 |
| `terrain_stronghold` | `stronghold` | 险地，NPC 超强防守的高价值格 |

`obstacle` 拆成 mountain/river 两张，是因为程序化生成的连续地形带如果只用一张贴图会很单调；渲染层按 tile 坐标做确定性 hash（如 `(tx*31+ty*17)%2`）在两者间选，不改数据模型（`obstacle` 逻辑上仍是单一 TileType）。

> **neutral 底图口径（本表为权威，2026-07-03 拍板）**：`neutral`（空地/未占领）铺 `terrain_grass` 满铺草地贴图，**不走纯纸白**。此前 `WORLD_MAP_ART_SPEC §一` 的 `tile_neutral #f5f0e8 纸底米白` 与本表口径不一，现已收敛为本表口径（§一米白降级为贴图未加载时的兜底色块，见该文档 §一脚注）。

---

## 1. 出图硬约束（每张都要满足）

1. **满铺地面，不是居中图标**：和资源母题「单个物体居中」不同，这是要铺满整张菱形格的地面纹理，不能留大片纯白边框，四边要能和相邻同类型格子拼接不违和。
2. **纯单色深墨线 + 轻排线，不上色不渐变**：延续资源母题口径——黑/深灰单色线稿，无阴影渐变、无高光。颜色（阵营水洗/等级色）由程序在贴图上叠加，母题本体不 tint。
3. **接缝容忍即可，不必像素级无缝**：手绘涂鸦的不规则排线本身比照片纹理更能藏接缝；重点是避免出现明显方向性的粗线条（比如统一朝向的整齐排线）暴露拼接边界。
4. **顶视角，不画立体建筑/物体**：这是地面纹理，不要在上面画城池、树木等独立物体（那些是叠加层或已有贴图的职责）。
5. **不画**：文字、数字、网格线、横格线、投影、渐变、聚焦主体、留白边框。

---

## 2. Prompt

### 共用前缀（贴在每条主体前）

```
Hand-drawn doodle texture for a strategy-game map ground tile, drawn in a worn
school notebook with a single dark-ink pen. Top-down flat view, slightly
wobbly imperfect strokes and light pencil cross-hatching for texture, like a
teenager quickly sketching terrain in the margins. Fills the entire frame
edge-to-edge with no empty border, no vignette, no centered focal object —
reads as a continuous ground patch that could tile seamlessly with itself.
Flat 2D, no shading gradients, no glossy highlights, no thick cartoon
outline, no isometric buildings or objects on top of the ground. Style of
West of Loathing / doodle art.
```

### 共用负向

```
color, colored ink, painterly, soft gradient, glow, 3d render,
photorealistic, thick bold cartoon outline, clean vector, centered object,
isolated icon, single object, watermark, text, letters, numbers, drop
shadow, vignette, hard border, empty margin, notebook grid lines, ruled
lines
```

### 7 条主体（接在共用前缀之后）

| 资产名 | 主体 prompt | 备注 |
|---|---|---|
| `terrain_grass` | `an open grassy field viewed from above, only a handful of small grass-tuft strokes scattered with irregular, random, asymmetric spacing — some patches left completely bare with no marks at all, a couple of tiny pebble dots placed off-center, quiet mostly-empty ground showing through, sparse and loose like a rushed 5-second sketch, avoid any even or grid-like arrangement` | 默认地面，密度最低，避免抢戏；v2 改稿：初版偏密且草丛间距过于均匀规整（见 §5 验收记录），改为强调不规则/留白/避免网格感 |
| `terrain_mountain` | `a rocky mountainous terrain viewed strictly from directly above (top-down aerial view, NOT a side view of peaks, no triangular mountain silhouettes pointing up), loose jagged angular rock-cluster outlines with a few short scribbly hatching strokes suggesting rough elevation, quick careless 5-second doodle sketch, very loose and wobbly, no fine engraving detail, no clean cross-hatch shading, single dark-ink or dark-grey pen only, no blue, no colored ink, leave a few small bare paper gaps between rock clusters` | 山脉，棱角排线密度高；v3 定稿：v1 蓝墨水撞阵营色、v2 侧视山峰剪影+过度精修撞风格（见 §5），改为顶视角岩石团块+纯黑墨+松散涂鸦感 |
| `terrain_river` | `a wide river viewed strictly from directly above (top-down aerial view), the water fills most of the frame diagonally corner to corner, only thin strips of bare rocky shoreline visible at the two opposite corners, loose hand-drawn wavy lines suggesting flow with irregular spacing and varying curve amplitude — not evenly spaced, not a uniform corrugated pattern, some lines longer and some short broken ripple marks, quick careless 5-second doodle sketch, very loose and wobbly like the rest of the terrain set, single dark-ink or dark-grey pen only, no blue, no colored ink, no grass tufts, no dense cross-hatch ground clutter on the shoreline` | 河流，波浪线走向随机避免统一方向感；v3 定稿：v1 河岸复用 grass 元素+水域占比太小易被误读成普通地面、v2 波纹线过于均匀机械（见 §5），改为水域占满对角+疏密不均的松散波纹 |
| `terrain_gate` | `a single narrow mountain pass viewed strictly from directly above (top-down aerial view), one continuous open corridor path running diagonally straight across the entire frame from corner to corner, the path surface has a few loose worn dirt-track or wooden-plank marks running along its length. On each side of the corridor, ONE solid mass of jagged rocky cliff (same rough rock style as the mountain terrain, dense hatching, no grass tufts, no scattered pebbles) pinches in right up to the corridor edge — only one opening, not multiple gaps. Quick careless 5-second doodle sketch, very loose and wobbly, single dark-ink or dark-grey pen only, no blue, no colored ink` | 关隘/桥，视觉上要读出"通道"感；v2 定稿：v1 出现两处缺口读成两条通道+混入 grass 元素撞风格（见 §5），改为单一对角通道+两侧悬崖复用 mountain 岩石风格 |
| `terrain_keep` | `a single small fortified checkpoint marking viewed strictly from directly above (top-down aerial flat view, NOT isometric, NOT 3d, no shading, no depth, no visible post thickness or side faces), just ONE loose ring or short row of a few simple wooden stake outlines sketched as thin flat lines poking up from the ground, sitting alone in the center of an otherwise open patch of ground, a little sparse hatching scattered around it and nothing elsewhere in the frame, quick careless 5-second doodle sketch, very loose and wobbly, single dark-ink or dark-grey pen only, no blue, no colored ink, no repeated copies of the fence` | 咽喉点，比 grass 密一档但不到城池级别；v2 定稿：v1 画成等距立体透视栅栏、且重复十几组像一片牧场（见 §5），改为单一居中木桩圈+纯顶视平面 |
| `terrain_center` | `an ornate ceremonial ground marking viewed strictly from directly above (top-down aerial flat view), a large compass-rose or star pattern etched into the ground with radiating lines and a couple of loose concentric rings, drawn by hand fast and carelessly — the star points should be noticeably uneven in length and angle, the rings should wobble and not close up perfectly, tick marks and hatching should look dashed off quickly, NOT a technical/engineering drafting look, no ruler-straight lines, no perfect mirror symmetry, no antique parchment texture, no creases or stains, plain clean paper background like the rest of the terrain set, single dark-ink or dark-grey pen only, no blue, no colored ink` | 世界中心，视觉上要比其余地形都更"重要"；v3 定稿：v1 太像古董藏宝图纸质、v2 纸质对了但线条仍过于精确对称像仪器绘图（见 §5），进一步强调不对称/不闭合/手抖感，明确排除工程制图感 |
| `terrain_stronghold` | `a foreboding fortified rocky outpost ground viewed strictly from directly above (top-down aerial flat view, NOT isometric, NOT 3d, no visible post or rock side faces, no shading depth), dense jagged rock-cluster outlines with heavier darker cross-hatching than a normal mountain terrain, a few crude flat X-shaped barricade or spike marks scattered among the rocks — drawn as simple flat line crosses, not standing 3d stakes, no skulls, no bones, no other iconography, still leave a few small bare paper gaps so individual rock clusters stay distinguishable, quick careless 5-second doodle sketch, very loose and wobbly, single dark-ink or dark-grey pen only, no blue, no colored ink` | 险地，密度/压迫感高于 mountain；v3 定稿：v1 尖桩铁丝网立体透视+骷髅骨头图标撞风格、过密难读（见 §5），改为纯顶视岩石团块+扁平X形路障，密度更高更暗以区分 mountain |

> 每条建议抽 3–5 张挑 1。抽的时候重点看「拼接感」：把两张同类型摆一起目视有没有明显断层/方向冲突，不行就多抽几张换个排线方向。

---

## 3. 画幅与接入方式

- **画幅**：正方形画布（如 512×512），对应菱形（2:1 等距）的外接矩形，渲染时程序侧裁成菱形（`diamondPath`），不需要美术手工裁边。
- **叠加关系**：这层贴图只替换 `drawTileL1` 里的纯色地形填充（[`WorldMapScene.ts:719-722`](../../client/src/scenes/WorldMapScene.ts:719)）；归属水洗/描边、迷雾、等级点、HP 血条、资源母题、城池贴图等继续是程序绘制/已有贴图叠在上面，不受影响。
- **接入实现（已完成）**：仿照 `resAtlasLoader.ts` / `cityAtlasLoader.ts` 的模式新增 `terrainAtlasLoader.ts` + 打包脚本 `pack_terrain.cjs`，产物放 `client/src/assets/slg/terrain_atlas.{png,json}`；贴图未就绪时保留纯色 `beginFill` 兜底，和 city/res 的 fallback 逻辑一致。渲染实现用的是 `Graphics.beginTextureFill()` 直接把贴图当纹理铺进 `drawPolygon(diamondPath(...))`（不是额外叠 `PIXI.Sprite` + mask），矩阵把方形贴图坐标映射进菱形外接矩形，边角自然被 `drawPolygon` 裁掉，不需要单独的遮罩层。
- **首帧加载门控（已完成）**：`WorldMapScene` 进场即盖一层不透明纸面 loading 遮罩（旋转墨环 + `world.loading` 文案，`buildLoadingOverlay`/`hideLoading`），三张地图图集（terrain/city/res）`Promise.allSettled` 全部落定后一次性 `renderMap` 再揭遮罩——避免"先闪纯色色块再换贴图"。任一图集解码失败按各自 fallback 走、不阻塞；另设 8s 兜底超时，图集卡死也不会把玩家困在遮罩上。上面「贴图未就绪保留纯色兜底」的 fallback 仍在（遮罩之下不可见，仅超时/失败后生效）。

---

## 4. 出图后的管线（沿用 decor / resource 口径，已执行）

1. 源图（白底 webp）已归档 `art/ui/slg-map/`，语义名 `terrain_grass.webp` / `terrain_mountain.webp` / `terrain_river.webp` / `terrain_gate.webp` / `terrain_keep.webp` / `terrain_center.webp` / `terrain_stronghold.webp`。
2. 打包脚本 `art/ui/slg-map/pack_terrain.cjs`：不同于 `pack_resources.cjs`（母题图标需要裁透明边），地形是满铺方形地面纹理，**不裁边、不抠透明**，只做等比缩放到 256×256 + 定长网格打包，保留原始不透明纸面背景（渲染期整方形贴图会被 `drawPolygon` 裁进菱形，裁掉的边角本来就该丢弃）。
3. 产物输出到 `client/src/assets/slg/terrain_atlas.png`（1024×1024）+ `terrain_atlas.json`（TexturePacker JSON-Hash，帧名同资产名，如 `terrain_grass`）。
4. 线条为原墨色、不 tint；归属色/等级色仍由渲染期叠加（同 res 母题口径）。
5. 接入渲染：新增 `terrainAtlasLoader.ts`（懒加载，色块兜底，接口对齐 `resAtlasLoader.ts`）；`WorldMapScene.drawTileL1` 改用 `g.beginTextureFill({texture, matrix})` 铺底替代原 `beginFill(fill, 0.7)`，`obstacle` 按 `(tx*31+ty*17)%2` 坐标 hash 选 `terrain_mountain`/`terrain_river`；`resource` 类型底纹复用 `terrain_grass`（母题贴图仍叠加在上层，逻辑不变）。

---

## 5. 出图验收记录

- **`terrain_grass` v1（2026-07-02，未通过）**：草丛密度偏高、间距过于均匀规整，接近网格化排列，人眼对规律排列比随机噪点更敏感，裁成菱形小块后拼接容易露出周期性重复感。已改 v2 prompt（见 §2 表格），核心调整：降密度、强调不规则/非对称留白、显式要求避免网格感。
- **`terrain_grass` v2（2026-07-02，通过）**：密度明显降低，留白面积大，草丛/石子/排线均呈有机随机分布，无网格化规律，石子以非对称小聚簇形式零星出现。定稿为 `terrain_grass` 候选。
- **`terrain_mountain` v1（2026-07-02，未通过）**：用了蓝色墨水笔，撞上 `art-direction.md` §3.2 阵营色铁律（蓝=我方水洗色），叠加归属水洗会撞色/混色。
- **`terrain_mountain` v2（2026-07-02，未通过）**：墨色改对了（黑/深灰），但视角错了——画成侧视/仰视的三角山峰插画（有远近层次的山脉风景图构图），不是俯视地面纹理；且线条过度精修，接近版画/蚀刻质感，跟游戏"5秒潦草涂鸦"基调不搭。
- **`terrain_mountain` v3（2026-07-02，定稿）**：改为严格顶视角的岩石团块轮廓（云朵状块面+局部斜排线），黑色单色墨线，线条有松散手抖的重描感，团块间留有纸面空隙。已定稿为 `terrain_mountain`。
- **`terrain_river` v1（2026-07-02，未通过）**：河岸大面积复用了 `terrain_grass` 的草丛/石子/排线元素，水域本身只占画面中间一条窄带，整格看起来大半是"草地"，容易被误读成普通可通行地面，跟 `river` 是完整不可通行 obstacle 格的语义不符。
- **`terrain_river` v2（2026-07-02，未通过）**：水域占比改对了（对角占满，只在两角落石滩），但波纹线间距/方向过于均匀规整，接近机械纹理，跟已定稿两张的松散涂鸦感不统一。
- **`terrain_river` v3（2026-07-02，定稿）**：波纹改为长短线混搭、疏密不均、弯曲幅度不一，松弛感与 grass/mountain 统一，水域覆盖与石滩留白保持 v2 的比例。已定稿为 `terrain_river`。
- **`terrain_gate` v1（2026-07-02，未通过）**：画面出现两处独立缺口，容易读成"两条通道"而非一条唯一通路；同时混入了 grass 的草丛小尖刺，跟 mountain/grass 元素撞在一起，剪影不好区分"这是关隘"。
- **`terrain_gate` v2（2026-07-02，定稿）**：改为单一对角通道贯穿全图，路面带车辙状短划线，两侧各一整块岩石悬崖（复用 mountain 的棱角+密排线风格，不含草丛/石子），通道中间收窄两端略宽，正好呼应"唯一通道"的玩法语义。已定稿为 `terrain_gate`。
- **`terrain_keep` v1（2026-07-02，未通过）**：画成等距/立体透视的木栅栏图标，且在整格里重复了十几组，读起来像"一片牧场"而非"一个据点标记"，跟已定稿四张的纯平面顶视风格严重不统一。
- **`terrain_keep` v2（2026-07-02，定稿）**：改为单一居中的木桩圈标记，纯顶视平面无立体阴影，四周背景密度接近 grass 略高一档。已定稿为 `terrain_keep`。
- **`terrain_center` v1（2026-07-02，未通过）**：星芒/同心圆刻度画得极度精确对称，接近专业地图学罗盘雕版画；背景纸张还带了做旧的皱褶/裂纹/污渍效果，跟其余定稿贴图干净平整的纸面质感不统一。
- **`terrain_center` v2（2026-07-02，未通过）**：纸张质感改对了（干净平整，跟其余贴图一致），但星芒/刻度依然笔直精确、严格镜像对称，仍偏"精密仪器绘图"而非手绘涂鸦，与其余六张的松散感不统一。已改 v3 prompt（见 §2 表格），进一步强调星芒长短角度不均、圆环不闭合、刻度手抖，明确排除工程制图感。
- **`terrain_center` v3（2026-07-02，定稿）**：星芒长短角度明显不均，双圈线有交叠未完全闭合，刻度/排线歪扭随意，彻底脱开工程制图感，背景纸质干净且带 grass 同款草丛/石子元素。已定稿为 `terrain_center`。
- **`terrain_stronghold` v1（2026-07-02，未通过）**：尖桩铁丝网画成立体/侧视透视（同 `terrain_keep` v1 的问题），另外混入骷髅骨头具象图标，跟其余六张纯抽象地形纹理的视觉语言不一致，且整体密度过满、糊成一片难以分辨个体岩石。
- **`terrain_stronghold` v2（2026-07-02，定稿）**：改为纯顶视的岩石团块（同 `terrain_mountain` 画法但密度更高更暗，几乎不留纸面空隙），穿插扁平 X 形路障标记，去掉立体桩子和骷髅骨头。已定稿为 `terrain_stronghold`。

**7 张地形贴图全部定稿完成（2026-07-02）**：grass / mountain / river / gate / keep / center / stronghold。下一步进入 §4 出图后的管线（源图归档 `art/ui/slg-map/` → 打包图集 → 接入 `terrainAtlasLoader.ts`），尚未执行。
