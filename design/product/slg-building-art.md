# SLG 地图覆盖建筑 — icon_watchtower 改版 / icon_blocker 新增 prompt

状态：**已出图、已接入（2026-08-09）**——两张新源图已落地 `art/ui/slg-map/`（`icon_watchtower.png` 覆盖旧版，`icon_blocker.png` 新增），`pack_buildings.cjs` 重新打包 `building_atlas` 后，用一次性脚本 [`appendAtlasFrames.js`](../../art/scripts/appendAtlasFrames.js)（§3 有写为什么不能直接跑 `mergeAssetAtlases.js`/`patchMergedAtlas.js`）把这两帧并入了 `world_atlas.{png,json}`（其余 85 个既有帧逐帧比对未变）。§2 的 prompt 仍保留作为出图依据/未来再改版的参照，§4 补了验收记录。旧版 `icon_watchtower.png`（正视立面版）移到了 `art/leftover/icon_watchtower_v1_frontal_2026-08-09.png`。
关联：现有三张覆盖建筑规格见 [`design/game/WORLD_MAP_ART_SPEC.md`](../game/WORLD_MAP_ART_SPEC.md) §三/§四；出图/改色铁律见 [`art-direction.md`](art-direction.md) §〇；地形层出图先例见 [`slg-terrain-art.md`](slg-terrain-art.md)；资源母题出图先例见 [`slg-resource-art.md`](slg-resource-art.md)；渲染实现见 [`tileGraphics.ts`](../../client/src/scenes/worldmap/tileGraphics.ts) `placeBuildingSprite`。

---

## 0. 起因

反馈（2026-08-09，用户截图标注）：地图上瞭望塔（`tile.watchtower`）和路障（`tile.structure`，非 `arrowTower` 的一种）的展示图标不对，看着不像"立在格子上的建筑"，读起来偏怪——需要重新出图，且新图要「刚好铺满一格」。

排查根因：
- **`icon_watchtower`**（`art/ui/slg-map/icon_watchtower.png`）是一张**正视/立面图**（像建筑立面图纸那样从正前方画的塔），长宽比 ~2:3（竖条状）。而同一批的 `building_keep`/`building_stronghold` 都是**3/4 俯视透视**、长宽比接近 1:1～1.2:1 的横向构图（见二者源图，塔身/寨墙左右撑开，画面撑满）。`placeBuildingSprite()`（[`tileGraphics.ts:259`](../../client/src/scenes/worldmap/tileGraphics.ts:259)）按高度等比缩放（`scale = targetH / tex.height`），一张竖条图缩到跟 keep/stronghold 同等目标高度后，宽度只有它们的一半左右——立在菱形格中央显得又细又空，跟"铺满一格"的诉求正好相反。
- **路障（`tile.structure.kind !== 'arrowTower'`）**：v1 起就没有专属美术，纯 `PIXI.Graphics` 画一个米白矩形 + X 形撑木（[`tileGraphics.ts:236-247`](../../client/src/scenes/worldmap/tileGraphics.ts) 改动前），按 TILE 归属描边变色，是几何占位不是图，观感和其余已出图的建筑不统一（用户截图里那个"信封"形状就是这个几何占位在小尺寸下的样子）。

处理方式：
1. **`icon_watchtower`**：不是换个姿势重画同一构图，是**改视角**——从正视立面改成跟 `building_keep`/`building_stronghold` 同一套 3/4 俯视透视、宽幅构图，让缩放后的宽度也能撑满菱形格，见 §2。**已出图**：新源图是一座宽脚架、四面撑开的高台望楼（带两侧的布幡装饰），裁边后 256×198（~1.29:1），比旧版 86×256（~1:3）宽了近 4 倍。
2. **`icon_blocker`**：新增一张，同一视觉语言，横向宽幅的路障/栅栏结构，见 §2。渲染层已接好回退路径（[`tileGraphics.ts`](../../client/src/scenes/worldmap/tileGraphics.ts) 的 `structure.kind !== 'arrowTower'` 分支先试 `placeBuildingSprite(g, 'icon_blocker', …)`，图集未就位时回退原几何占位），`pack_buildings.cjs` 的文件匹配正则已加入 `icon_blocker`。**已出图**：新源图是一排交叉削尖的木桩（画成铅笔形状，呼应"文具战争"主题）用绳索绑扎，横向铺满，裁边后 256×88（~2.9:1），比 v1 的几何 X 撑木占位更宽更有细节。

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

## 3. 出图后的管线（已执行，2026-08-09）

沿用 `building_keep`/`building_stronghold` 现有管线（`pack_buildings.cjs`），实际跑法：

1. 源图（白底 png）落到 `art/ui/slg-map/`，语义名 `icon_watchtower.png`（覆盖旧图，旧图移至 `art/leftover/icon_watchtower_v1_frontal_2026-08-09.png`）/ `icon_blocker.png`（新文件）。
2. `node art/ui/slg-map/pack_buildings.cjs`（复用 `client/node_modules/sharp`）——近白→透明 + 内容裁边 + 长边缩放到 256，重新生成 `client/src/assets/slg/building_atlas.{png,json}`（6 帧：4 张未变 + 这次的 2 张）。脚本文件匹配正则已包含 `icon_blocker`。
3. **合并进 `world_atlas` 这一步没法直接用现成脚本**——客户端实际加载的是合并图集 `client/src/assets/slg/world_atlas.{png,json}`（2026-07-27 起 `building_atlas`/`terrain_atlas`/`res_atlas` 等已被 `art/scripts/mergeAssetAtlases.js` 合并进这一张共享页，且合并前的分源图集**已从仓库删除**，见 [`patchMergedAtlas.js`](../../art/scripts/patchMergedAtlas.js) 头部说明）：
   - `icon_blocker` 是全新帧——`patchMergedAtlas.js` 遇到目标缺帧只会跳过（`missing.push(name)`），不会新增。
   - `icon_watchtower` 换了构图比例，裁边+长边缩放后的新帧尺寸（256×198）跟 `world_atlas.json` 里原来的尺寸（86×256）不一致——`patchMergedAtlas.js` 遇到尺寸变化直接 `process.exit(1)`，且是在写盘之前就退出，不会留下半吊子状态。
   - 完整重新合并（`mergeAssetAtlases.js`）又需要另外 5 个分源图集（terrain/city/playerbase/res/city_bld）的 png+json，这些已经从仓库删除、盘上也没有——要重新生成它们全部（重跑它们各自的 packer）风险面/工作量都远超"就改两张建筑图标"该有的范围。
   - 实际做法：新写了一个更小范围的一次性脚本 [`art/scripts/appendAtlasFrames.js`](../../art/scripts/appendAtlasFrames.js)——只处理明确点名的帧：尺寸不变的就照 `patchMergedAtlas.js` 的办法原位覆盖像素；尺寸变了/全新的就在页面底部铅笔式追加一条新行（画布长高，其余已有内容原样保留，不移动、不重新排版）。跑法：`NODE_PATH="$(pwd)/client/node_modules" node art/scripts/appendAtlasFrames.js client/src/assets/slg/building_atlas.json client/src/assets/slg/world_atlas.json icon_watchtower icon_blocker`。跑完后**删掉了**临时生成的 `building_atlas.{png,json}`（这两个文件本来就不进仓库，见上面"已从仓库删除"）。
   - 验证：跑完后逐帧比对了 `world_atlas.json`（86 帧不变 + `icon_watchtower` 尺寸更新 + `icon_blocker` 新增，无其它字段变化）和抽样帧的原始像素（`building_keep`/`building_stronghold`/`terrain_grass`/`res_ink_l5`/`city_lv1` 等，坐标未变的帧内容一致；受益于 PNG 重新走 `palette` 压缩，个别通道有 ≤4/255 的量化噪声，肉眼不可见，跟 `patchMergedAtlas.js` 本来就有的同款副作用一致，不是本次改动引入的新问题）。
4. 渲染层挂点已就位：`tileGraphics.ts` 的 `icon_blocker` 走 `placeBuildingSprite(g, 'icon_blocker', tp, hh, tp * 0.5, false)`，图集未就位/帧缺失时自动回退原几何 X 撑木占位。
5. **渲染常量**（2026-08-09 的估算已被 2026-08-15 推翻，见 §5）：
   - ~~`icon_watchtower` 目标高度 `tp * 0.95`~~ → **`0.40`**（`tileGraphics.ts` 的 `WATCHTOWER_H`）。
   - ~~`icon_blocker` 目标高度 `tp * 0.5`~~ → **`0.22`**（同文件 `BLOCKER_H`）。
   - 当时那两个数字是纸面估算、没有真机截图核对过（原话："如果之后有人在真机上看着不对，再回来微调"）——用户 8/15 反馈"乱糟糟"，截图核对后确认要调，理由见 §5。

---

## 4. 出图验收记录

- **`icon_watchtower` v2（2026-08-09，通过）**：改成宽脚架高台望楼，3/4 俯视透视，四足向外撑开撑满画面，两侧各挂一副布幡装饰；裁边后 256×198（~1.29:1），跟 `building_keep`/`building_stronghold` 的构图语言统一，解决了 v1 正视立面「又细又空」的问题。旧图归档 `art/leftover/icon_watchtower_v1_frontal_2026-08-09.png`。
- **`icon_blocker` v1（2026-08-09，通过）**：一排交叉削尖的木桩（画成铅笔形状，呼应游戏"文具战争"母题）用绳索绑扎，横向贯穿画面；裁边后 256×88（~2.9:1），是这批里最宽幅/最扁的一张，符合"路障=挡路的横向障碍"的语义，比 v1 起一直用的几何 X 撑木占位更有细节、也更宽。用铅笔当木桩这个处理没有写进 §2 的 prompt 里（当时只写了泛用的"wooden stakes"），但完全贴合项目的文具母题，判定通过，不要求重出。

---

## 5. 尺寸修正：`tp * 0.95` / `tp * 0.5` 太大（2026-08-15）

反馈（用户截图标注）：地图上一排瞭望塔 + 拒马"表现太奇怪了，看起来乱糟糟的"。两张图本身没问题，**问题在 §3.5 那两个目标高度**，以及叠放顺序。

**尺寸**。§3.5 当时拿 `building_keep`（targetH `tp*1.3`）当参照，但那是**每片区域只有一个**的地标地形；瞭望塔/拒马是玩家能沿边界**连着一格一格造**的。等距 2:1 投影下，相邻两格锚点的**屏幕横向间距只有 `tp/2`**，不是菱形格的全宽 `tp`——所以"占菱形格全宽的 73%"这个验收标准从一开始就用错了参照系：

| | 帧尺寸 | 旧 targetH | 旧屏宽 | 新 targetH | 新屏宽 |
|---|---|---|---|---|---|
| `icon_watchtower` | 256×198 (1.29:1) | `tp*0.95` | `1.23 tp`（≈2.5× 邻格间距） | **`tp*0.40`** | `0.52 tp` |
| `icon_blocker` | 256×88 (2.91:1) | `tp*0.5` | `1.45 tp`（≈2.9× 邻格间距） | **`tp*0.22`** | `0.64 tp` |

旧值下每座塔要盖住左右各 ~2 格的邻居，5×5 一片瞭望塔在屏幕上糊成一坨看不出个数的排线团；同样一片拒马糊成一张黑毯。新值下每座塔/每道拒马各自站在自己格子里，能一眼数清——与旁边纯几何绘制的 `arrowTower`（`tp*0.42` 高、`tp*0.16` 宽，一直没人抱怨过）读感一致。

**叠放顺序**。`WorldMapRenderer/pool.ts` 的瓦片池是**取模环绕**的，槽位在 `poolContainer.children` 里的次序跟屏幕深度无关，而且随平移变化——后排的塔可能画在前排之上，平移时还会翻转。格子内的画法都不出菱形时无所谓，但建筑精灵会往上长。已改为 `slot.g.zIndex = tx + ty`（等距下屏幕 y ∝ `tx+ty`）+ `poolContainer.sortableChildren = true`，前排最后画。zIndex 只在平移换格时变，L1 约 600 个槽位，不是每帧排序。

**回归护栏**：`client/test/ui/worldMapStructureIcons.ui.ts` 新增一组 mock 掉 `buildingAtlasLoader`（伪装图集就绪）的用例，断言两个精灵的屏幕宽度 ≤ `tp*0.7`（邻格间距 `tp/2` + 30% 溢出容差），防止系数再被调大。

**核对方式**：`npm run start:e2e` + Playwright 驱动 `window.__nwE2E.views.showWorldMap()`（reject-fast 的 `worldApi` stub，无后端），种一块 7×7 己方领地、内 5×5 全建同类结构，逐个系数截图对比——详见会话记忆 `worldmap-standalone-debug-render`。
