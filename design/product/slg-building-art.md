# SLG 地图覆盖建筑 — icon_watchtower 改版 / icon_blocker 新增 prompt

状态：**prompt 草拟，尚未出图**（2026-08-09）——本文档只是给下一步 AI 出图用的 prompt 稿，`art/ui/slg-map/` 下还没有对应的新源图，`building_atlas` / `world_atlas` 也还没重新打包。跟 [`slg-terrain-art.md`](slg-terrain-art.md)「已定稿」的口径不一样，别误当成已验收。
关联：现有三张覆盖建筑规格见 [`design/game/WORLD_MAP_ART_SPEC.md`](../game/WORLD_MAP_ART_SPEC.md) §三/§四；出图/改色铁律见 [`art-direction.md`](art-direction.md) §〇；地形层出图先例见 [`slg-terrain-art.md`](slg-terrain-art.md)；资源母题出图先例见 [`slg-resource-art.md`](slg-resource-art.md)；渲染实现见 [`tileGraphics.ts`](../../client/src/scenes/worldmap/tileGraphics.ts) `placeBuildingSprite`。

---

## 0. 起因

反馈（2026-08-09，用户截图标注）：地图上瞭望塔（`tile.watchtower`）和路障（`tile.structure`，非 `arrowTower` 的一种）的展示图标不对，看着不像"立在格子上的建筑"，读起来偏怪——需要重新出图，且新图要「刚好铺满一格」。

排查根因：
- **`icon_watchtower`**（`art/ui/slg-map/icon_watchtower.png`）是一张**正视/立面图**（像建筑立面图纸那样从正前方画的塔），长宽比 ~2:3（竖条状）。而同一批的 `building_keep`/`building_stronghold` 都是**3/4 俯视透视**、长宽比接近 1:1～1.2:1 的横向构图（见二者源图，塔身/寨墙左右撑开，画面撑满）。`placeBuildingSprite()`（[`tileGraphics.ts:259`](../../client/src/scenes/worldmap/tileGraphics.ts:259)）按高度等比缩放（`scale = targetH / tex.height`），一张竖条图缩到跟 keep/stronghold 同等目标高度后，宽度只有它们的一半左右——立在菱形格中央显得又细又空，跟"铺满一格"的诉求正好相反。
- **路障（`tile.structure.kind !== 'arrowTower'`）**：v1 起就没有专属美术，纯 `PIXI.Graphics` 画一个米白矩形 + X 形撑木（[`tileGraphics.ts:236-247`](../../client/src/scenes/worldmap/tileGraphics.ts) 改动前），按 TILE 归属描边变色，是几何占位不是图，观感和其余已出图的建筑不统一（用户截图里那个"信封"形状就是这个几何占位在小尺寸下的样子）。

处理方式：
1. **`icon_watchtower`**：不是换个姿势重画同一构图，是**改视角**——从正视立面改成跟 `building_keep`/`building_stronghold` 同一套 3/4 俯视透视、宽幅构图，让缩放后的宽度也能撑满菱形格，见 §2。
2. **`icon_blocker`**：新增一张，同一视觉语言，横向宽幅的路障/栅栏结构，见 §2。渲染层已接好回退路径（[`tileGraphics.ts`](../../client/src/scenes/worldmap/tileGraphics.ts) 的 `structure.kind !== 'arrowTower'` 分支先试 `placeBuildingSprite(g, 'icon_blocker', …)`，图集未就位时回退原几何占位），`pack_buildings.cjs` 的文件匹配正则已加入 `icon_blocker`；**只欠源图**。

---

## 1. 出图硬约束

跟 `building_keep`/`building_stronghold` 保持同一视觉语言（不是母题层"单个物体居中留白"的规则，是覆盖建筑层"立在格上、撑满构图"的规则）：

1. **3/4 俯视透视，不是正视立面、也不是纯顶视平面**——参考 `art/ui/slg-map/building_keep.png` / `building_stronghold.png` 的视角：能同时看到建筑顶部和一到两个侧面，像站在稍高处斜看过去。
2. **横向/方形构图，画面边到边撑满，别留大片空白**——建筑本体（含底部支撑/栅栏/尖桩等延展物）要占满画幅宽度，不要画成细高的独立剪影再留一堆白边。`building_stronghold` 底部的尖桩栅栏左右撑开到画面边缘就是这个效果，抄它的构图逻辑。
3. **纯单色深墨线 + 排线阴影**（钢笔素描风，同 `building_keep`/`building_stronghold`），不上色、不用阴影渐变色块，只用排线表达明暗。
4. **纯白背景**，出图管线（`pack_buildings.cjs`）靠亮度算 alpha 抠白底，深色线条留下、白背景变透明——背景不能有灰底/网格/纹理，否则会被误当成内容裁进去。
5. **不画**：文字、数字、人物、旗帜（归属色由程序在贴图下叠加，不要预先画旗子/颜色）、阴影投影（drop shadow，跟排线阴影是两回事）、地面草丛等地形元素（那是 terrain 层的职责，不要在建筑图里带地面纹理）。

---

## 2. Prompt

### 共用前缀（贴在每条主体前）

```
Hand-drawn pen-and-ink sketch of a small wooden structure standing on a
strategy-game map tile, drawn in a worn school notebook with a single dark
ink pen. Three-quarter elevated view (looking down and slightly across, NOT
a flat front elevation, NOT a straight top-down plan) — same camera angle as
a fortified stone gatehouse drawn from just above eye level. Wide,
squarish-to-landscape composition that fills the frame edge-to-edge: the
structure's base/supports/stakes spread out sideways to reach both the left
and right edges of the frame, not a tall narrow isolated silhouette with
empty margins on the sides. Cross-hatched pen shading for depth (no flat
color fills, no gradients). Plain pure-white background, no ground texture,
no grass, no horizon line. Loose, slightly wobbly hand-drawn linework, style
of a quick architectural sketch — clean enough to read at small size, not a
5-second doodle. Style of West of Loathing / doodle art.
```

### 共用负向

```
front elevation, straight-on view, side view, flat top-down plan view,
isometric axonometric CAD drawing, tall narrow silhouette, empty margins,
empty white border, centered small icon with lots of surrounding white space,
color, colored ink, painterly, flat color fill, soft gradient, glow, 3d
render, photorealistic, thick bold cartoon outline, clean vector, watermark,
text, letters, numbers, flags, banners, faction colors, people, characters,
skulls, bones, drop shadow, ground texture, grass, dirt, horizon, sky,
notebook grid lines, ruled lines
```

### 2 条主体（接在共用前缀之后）

| 资产名 | 主体 prompt | 备注 |
|---|---|---|
| `icon_watchtower` | `a squat, compact wooden watchtower — a small raised platform with a peaked shingled roof, standing on four short splayed wooden legs with X-shaped cross-braces, the legs spread wide apart so the structure's footprint is noticeably wider than it is tall, roughly as wide as a small gatehouse, not a tall spindly tower` | 改版：把旧版正视立面的细高塔身改成矮胖宽脚架构图，腿脚左右撑开撑满画面，呼应 `building_keep`/`building_stronghold` 的宽幅构图；语义不变（己方领地建造、扩视野），只改视角与比例 |
| `icon_blocker` | `a low wooden barricade blocking a path — a row of crossed wooden stakes and horizontal fence rails lashed together with rope, spanning the full width of the frame left to right, low and wide rather than tall, a couple of the stakes sharpened and angled outward` | 新增：路障/障碍物，语义是"挡路的栅栏"，横向宽幅、矮而不高，风格延续 `building_stronghold` 底部尖桩栅栏的画法但单独成图 |

> 每条建议抽 3–5 张挑 1，重点核对：①跟 `building_keep.png`/`building_stronghold.png` 摆在一起视角/线条风格是否统一；②横向是否真的撑满画幅（不是又画成一个居中小图标）。

---

## 3. 出图后的管线

沿用 `building_keep`/`building_stronghold` 现有管线（`pack_buildings.cjs`），流程：

1. 源图（白底 png/webp）落到 `art/ui/slg-map/`，语义名 `icon_watchtower.png`（覆盖现有旧图）/ `icon_blocker.png`（新文件）。
2. `node art/ui/slg-map/pack_buildings.cjs`（复用 `client/node_modules/sharp`）——近白→透明 + 内容裁边 + 长边缩放到 256，重新生成 `client/src/assets/slg/building_atlas.{png,json}`。脚本文件匹配正则已包含 `icon_blocker`（本次改动，见 [`pack_buildings.cjs`](../../art/ui/slg-map/pack_buildings.cjs)），不用再改脚本。
3. **⚠️ 关键：这一步不能漏**——客户端实际加载的是合并图集 `client/src/assets/slg/world_atlas.{png,json}`（2026-07-27 起 `building_atlas`/`terrain_atlas`/`res_atlas` 等已被 `art/scripts/mergeAssetAtlases.js` 合并进这一张共享页，且合并前的分源图集**已从仓库删除**，见 [`patchMergedAtlas.js`](../../art/scripts/patchMergedAtlas.js) 头部说明）。这意味着：
   - `icon_blocker` 是全新帧，`world_atlas.json` 里本来就没有它的条目 —— **`patchMergedAtlas.js` 无法插入新帧**（遇到目标缺帧会跳过，不会新增，见该脚本 `missing.push(name)` 分支），必须走「从 git 恢复被删的分源图集 → 重跑 `mergeAssetAtlases.js` 完整重新合并」这条路，不能只跑 patch 脚本。
   - `icon_watchtower` 换了构图比例后，裁边+长边缩放算出来的新帧尺寸大概率跟 `world_atlas.json` 里现有的 `icon_watchtower` 帧尺寸（改动前为 86×256）不一致——`patchMergedAtlas.js` 遇到尺寸变化会直接报错拒绝（"a full re-merge is required"），同样需要走完整重新合并这条路，不能指望 patch 脚本蒙混过去。
   - 简言之：这次的两张图（一张换比例、一张全新）都绕不开完整重新合并，出图后请先确认能拿到 `mergeAssetAtlases.js` 需要的分源图集（从 git 历史恢复或重新导出），别直接跑 `patchMergedAtlas.js` 踩上面两个坑。
4. 渲染层挂点已就位（本次改动）：`tileGraphics.ts` 的 `icon_blocker` 走 `placeBuildingSprite(g, 'icon_blocker', tp, hh, tp * 0.5, false)`，图集未就位/帧缺失时自动回退原几何 X 撑木占位，不会因为没出图而报错或空白。
5. **验收后可能要回调的渲染常量**（新图定下来再看，不用出图前先猜）：
   - `icon_watchtower` 目标高度 `tp * 0.95`（[`tileGraphics.ts:190`](../../client/src/scenes/worldmap/tileGraphics.ts:190)）是照旧版竖条构图定的；改成矮胖宽脚构图后，同样的目标高度会让整体路缘宽度变化——如果新图实际比例跟 §1 约束不完全一致，先跑真图实测缩放后的菱形格内视觉效果，再决定要不要调这个系数。
   - `icon_blocker` 目标高度暂定 `tp * 0.5`（比 `arrowTower` 几何占位的 `tp * 0.42` 略高，因为新图预期是横向宽幅而非高塔，实际数值以出图后目测为准）。

---

## 4. 出图验收记录

（尚未出图，暂无记录——出图后按 [`slg-terrain-art.md` §5](slg-terrain-art.md) 的格式在此追加每版的通过/不通过原因。）
