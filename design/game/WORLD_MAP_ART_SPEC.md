# 大世界地图 — 美术资产规格书

> 权威来源：`WorldMapScene.ts`（渲染代码）、`design/game/SLG_DESIGN.md`（功能设计）。
> 本文列出所有需要替换程序占位色块的美术资产，按优先级排列。

---

## 一、格子地形底图（Tile Background）

每格在三档缩放下均会显示底色。L1（76px）最精细，L2（38px）次之，L3（20px）仅色块。
美术资产优先提供 **96×96 px PNG**（L1 用，L2/L3 缩放取样即可）。

| 资产名 | 描述 | 临时程序色 |
|---|---|---|
| ~~`tile_neutral.png`~~ | 空地（未占领）→ **走 `terrain_grass` 贴图**，非纯纸白（拍板 2026-07-03，见 §一脚注） | `#f5f0e8` 仅作贴图未加载时的兜底色块 |
| `tile_food.png` | 食物资源格（麦穗/农田）（旧命名，权威见 `slg.ts` `ResourceType`=ink/paper/graphite/metal/sticker） | `#a8d870` 嫩草绿 |
| `tile_wood.png` | 木材资源格（树林）（旧命名，权威见 `slg.ts` `ResourceType`=ink/paper/graphite/metal/sticker） | `#90b860` 深草绿 |
| `tile_iron.png` | 铁矿资源格（矿石）（旧命名，权威见 `slg.ts` `ResourceType`=ink/paper/graphite/metal/sticker） | `#a0b8c8` 灰蓝 |
| `tile_familyKeep.png` | **家族要点（familyKeep）**——家族争夺的战略格（注意：非 stronghold） | `#ffd060` 琥珀黄 |
| `tile_center.png` | 世界中心（唯一，全图标志性） | `#ffe88a` 浅金 |
| `tile_obstacle.png` | 不可通行地形（山脉/河流） | `#9a9488` 石灰灰 |
| `tile_gate.png` | 关隘/桥（可通行的地形节点） | `#c8a878` 沙棕 |
| `tile_stronghold.png` | **NPC 据点（stronghold）**——攻克前为系统超强守备（注意：与 familyKeep 是两类，别混用「险地」一词） | `#8a4a4a` 暗砖红 |

**要求**：
- 手绘笔记本风，铅笔/钢笔线条感，轻微纹理，无卡通描边
- 格子边缘留 1px 透明，由程序控制间距
- 提供 @1x（96px）即可；若需要 @2x 高清请另行通知

> **§一 脚注（neutral 底图口径，2026-07-03 拍板）**：`neutral`（空地/未占领）**走 `terrain_grass` 满铺草地贴图，不留纯纸白**。
> 权威见 [`slg-terrain-art.md §2`](../product/slg-terrain-art.md)（`terrain_grass` → `neutral`/`territory`/`base`），7 张地形贴图已按「满铺纹理、无留白」基调定稿验收。
> 本表 `#f5f0e8` 等临时程序色仅作贴图未加载时的兜底色块，不再是空地的目标外观。上表其余行同为旧命名，权威地块类型见 `slg.ts` `TileType`。

---

## 二、占领叠加色（Occupation Overlay）

占领状态目前用纯色半透明覆盖。计划用叠加纹理或旗帜图标替换。

| 资产名 | 描述 | 临时程序色 |
|---|---|---|
| `overlay_mine.png` | 我方领地叠层（半透明红墨纹理） | `#e69090` α=0.85 |
| `overlay_mine_base.png` | 我方主城叠层（浓红墨） | `#cc3333` α=0.85 |
| `overlay_enemy.png` | 敌方领地叠层（蓝墨） | `#90a8e6` α=0.85 |
| `overlay_enemy_base.png` | 敌方主城叠层（浓蓝墨） | `#4477cc` α=0.85 |
| `overlay_ally.png` | 家族盟友领地叠层（绿墨） | `#9cd6a4` α=0.85 |
| `overlay_ally_base.png` | 家族盟友主城叠层（浓绿墨） | `#46a85a` α=0.85 |
| `overlay_fog.png` | 视野外迷雾叠层（铅笔灰半透明） | `#6b6458` α=0.4 |

**要求**：
- 96×96 px，RGBA PNG
- 主题：墨水晕染感，非像素/卡通风格
- 叠加方式为 multiply 或 alpha overlay，由程序合成

---

## 三、格内标记图标（In-tile Icons，L1 档展示）

仅在 L1（76px 格）下可见，L2/L3 不显示。图标绘制在格子内部。

| 资产名 | 描述 | 尺寸 | 当前程序占位 |
|---|---|---|---|
| ~~`icon_watchtower.png`~~ | 瞭望塔（己方领地建造，扩视野） | — | ✅ **已接入手绘贴图**（`building_atlas` 帧 `icon_watchtower`，见 §四）；atlas 未就绪时回落几何塔身 |
| `icon_level_dot.png` | 等级指示圆点（格子升级后右上角） | 12×12 | 实心圆，颜色按归属（保持程序绘制，可动态取归属色，不出图） |
| `icon_allysect_border.png` | 联盟宗门黄色内描边（重复九宫格拼接） | 96×96 | 程序描边（保持程序绘制，不出图） |

---

## 四、覆盖层建筑（Overlay Buildings）

| 资产名 | 描述 | 状态 |
|---|---|---|
| `city_lv1..4` | 我/敌/盟主城（4 级建筑，归属靠程序上色） | ✅ 已接入 `city_atlas`（3×3 base 锚点，深度排序图层） |
| `building_keep` | 战略要点/咽喉点建筑（城楼门楼） | ✅ 已接入 `building_atlas`（2026-07-03） |
| `building_stronghold` | 险地 NPC 据点（暗色石垒） | ✅ 已接入 `building_atlas`（2026-07-03） |
| `icon_watchtower` | 己方瞭望塔（扩视野） | ✅ 已接入 `building_atlas`（2026-07-03） |

> **接入落地（2026-07-03）**：`building_keep` / `building_stronghold` / `icon_watchtower` 三张手绘钢笔线稿
> 经 `art/ui/slg-map/pack_buildings.cjs`（近白→透明+裁边+长边 256，同 `res` 管线）打包为
> `client/src/assets/slg/building_atlas.{png,json}`，`buildingAtlasLoader.ts` 懒加载 + 并入进场
> loading 门控。渲染在 `WorldMapScene.drawTileL1` → `placeBuildingSprite()`：
> - keep/stronghold 属**地形层**（type 由 `proceduralTile` 决定、全图可见），随格底纹一起画、fog 下压淡；
> - watchtower 属**动态层**（`tile.watchtower`），fog 下隐藏，atlas 未就绪回落原几何塔身；
> - 三张均为中性墨线**不 tint**，归属由格下水洗表达；bottom-center 锚在菱形下部使建筑「立」在格上。
>
> 旧规划里 `building_base_mine/enemy/ally.png` 三张**作废**——主城改由 `city_atlas`（4 级 × 程序上色）承担，
> 不再按阵营出三份。原 64×64 尺寸列亦作废（打包按长边 256、渲染期按 tile 尺寸缩放）。

---

## 五、覆盖层标记（Overlay Markers，叠加在 overlayGfx 层）

| 资产名 | 描述 | 尺寸 | 当前程序占位 |
|---|---|---|---|
| `marker_capital_owned.png` | 首府星标（已被占领） | 32×32 | 实心五角星金色（保持程序绘制，含手绘抖动，不出图） |
| `marker_capital_free.png` | 首府星标（未占领） | 32×32 | 空心五角星米色（保持程序绘制，含手绘抖动，不出图） |
| `arrow_attack.png` | 行军箭头—攻击 | 32×8 | 程序直线+有向箭簇（保持程序绘制，不出图） |
| `arrow_reinforce.png` | 行军箭头—增援 | 32×8 | 同上 |
| `arrow_scout.png` | 行军箭头—侦察 | 32×8 | 同上 |
| `arrow_return.png` | 行军箭头—回师 | 32×8 | 同上 |
| `arrow_occupy.png` | 行军箭头—占领 | 32×8 | 同上 |

**行军箭头颜色对照**（待替换后保留色值用于 tint）：
- 攻击 `#cc3333`，增援 `#44aacc`，侦察 `#9b59b6`，回师 `#44cc88`，占领 `#cc8844`
- 敌方行军统一 `#4477cc`，线宽 2.5px（己方 1.5px）

> **HUD 行军列表兵种字形 — ✅ 已接入（2026-07-03，`icons.ts` 手绘，无需出图）**：
> `renderHud()` 行军列表原用 emoji `⚔🛡🔭↩→`，已改用 `buildIcon()` 手绘图标：
> attack→`swords`、reinforce→`armor`(盾)、return→`replay`(环箭)、scout→`scope`(望远镜，新增)、
> occupy→`flag`(旗，新增)。`scope`/`flag` 为本次新增的 SketchPen 图标。
> 注：这只替换 HUD **列表内**的兵种字形；地图上的**行军连线 `arrow_*`** 仍为程序矢量（见上表，属可选 PNG 升级）。

> **§五 复核与程序 polish（2026-07-03 拍板：三项全部保持程序绘制，不出图）**：
> `overlay_*` 占领水洗 / `arrow_*` 行军连线 / `marker_capital_*` 首府星标经评估**均维持程序绘制**——
> 动态阵营色（6 变体 tint）、逐格自适应描边、变长线段几何，转静态 PNG 会牺牲灵活性且收益趋零。
> 同时落两处不牺牲灵活性的**程序 polish**（`WorldMapScene.ts`）：
> - **行军箭头**：终点由圆点 → **按线段角度旋转的有向箭簇**（`renderOverlay`），行军方向一眼可读；
> - **首府星标**：`drawStar` 顶点加**索引种子、位置无关的确定性半径抖动**，融入手绘笔记本风，
>   且跨 ~5s 重绘与拖动不闪烁（不用 `Math.random`，用 `sin` 哈希）。
> `overlay_*` 水洗（`drawTileL1` option-3 淡填充+墨色描边）已是最优解，无改动。

> **行军令牌行走动画 — ✅ 已接入（2026-07-15，暂用战斗现有兵种素材，占位）**：
> 原沿路线插值移动的纯 Graphics 菱形令牌（见上文行军箭头颜色对照）替换为真实的行走循环动画——
> `WorldMapRenderer/fog.ts::syncMarchTokens()` 为每条在途行军挂一个 `StickmanRuntime`（战斗单位渲染同款,
> `render/stickman/StickmanRuntime.ts`），播放 `walk` 循环，沿路线插值位置并按行进方向左右镜像朝向。
> 兵种素材暂时二选一（`MARCH_TOKEN_ASSET`）：`kind==='attack'` 用盾兵 `shieldbearer.tao`（代表"攻城兵种"，
> 目前没有专门的攻城兵种，盾兵是最接近"破城"定位的单位）；其余全部行军用普通兵 `infantry.tao`。
> **TODO（美术）**：等专门的行军动画素材（含旗帜/头像等帮会标识）出图后替换 `MARCH_TOKEN_ASSET`；
> 目前旗帜/头像暂不做，涉及帮会图标体系，留待后续。
>
> **占领/攻城到达 — ✅ 已修复（2026-07-16）**：此前令牌抵达目的地时 `syncMarchTokens()` 直接
> `destroy()`，攻击方令牌瞬间消失、从未播放 `attack` 动画。现在 `SiegeDoc`/`siege_result` 推送
> 携带 `marchId`（`combatSiege/helpers.ts::recordSiege` + `corePush.ts::pushSiege` + `transport.proto`），
> 客户端 `WorldMapNet.applySiegeResult()` 据此把该令牌标记进 `ctx.marchAttackUntil`（截止时间 =
> 当前 `attack` clip 时长，素材未加载时兜底 0.6s），`fog.ts::syncMarchTokens()` 的清理循环对标记中的
> 令牌播放 `attacking` 状态而非立即销毁，到期后才真正 `destroy()`。
>
> **占领保持（hold）期间持续攻击动画 — ✅ 已接入（2026-07-21）**：上一条修复的 `marchAttackUntil` 只覆盖
> 令牌抵达那一刻的短暂 attack 播放（≤1s），保持阶段（`contestedUntil` 倒计时，可长达数分钟）此前地图上
> 完全没有视觉表现——只有点击弹出的纯文字倒计时弹窗（`WorldMapInput.ts`）。新增
> `fog.ts::syncOccupyTokens()`：对 `ctx.occupations`（"我方进行中的占领保持"列表，随行军一起 ~5s 轮询）
> 里的每一块地，在其坐标上常驻一个盾兵 `StickmanRuntime`，每帧调用 `syncState('attacking')` ——
> `StickmanRuntime.syncState()` 对非循环 clip 会在播放完后自动重播，因此只要令牌存在就会一直挥砍，
> 直到该地从 `ctx.occupations` 消失（保持结束/被放弃）才 `destroy()`。同时修了 `lifecycle.ts::update()`
> 的每帧重绘门槛——此前只在 `ctx.marches`/`marchTokenRuntimes` 非空时才调 `renderOverlay()`，`occupations`
> 单独存在时永远不会触发，新令牌根本不会被驱动。回归测试见 `client/test/ui/occupyTokenAnimation.ui.ts`。

---

## 六、资源图标（HUD 内显示）— ✅ 已接入（复用 `res_atlas`，无需单独出 24px 图）

> **赛季资源权威 = 5 种**（`server/shared/src/slg.ts` `RESOURCE_TYPES` + `WorldMapScene.renderHud()`）：
> `ink 墨水` / `paper 纸张` / `graphite 石墨` / `metal 金属` / `sticker 贴纸`。
> 旧「食物/木材/铁矿（food/wood/iron）」命名已废弃，勿再使用。
>
> **接入拍板（2026-07-03）**：HUD 资源图标**不再单独出 24px 图**，直接**复用已定稿的地图母题 `res_atlas`**
> （`getResTexture('ink'|...)`），在 `renderHud()` 里建 18px `PIXI.Sprite` 替换原 emoji `🖋️📄✏️🔩⭐`。
> 母题墨线在浅纸底 HUD（`C.paper`）上小尺寸可辨，风格与地图格母题天然统一。图集解码前仍以 emoji 兜底。
> 下表 `res_*.png`（24×24 独立版）**作废，不再需要出图**，保留仅作历史记录。

| 资产名 | 资源 | emoji 兜底 | 描述 | 尺寸 |
|---|---|---|---|---|
| `res_ink.png` | ink 墨水 | 🖋️ | 墨水瓶 + 一滴墨，深蓝墨 | 24×24 |
| `res_paper.png` | paper 纸张 | 📄 | 单张折角纸 + 两条淡横线 | 24×24 |
| `res_graphite.png` | graphite 石墨 | ✏️ | 削尖铅笔 / 六棱石墨条 | 24×24 |
| `res_metal.png` | metal 金属 | 🔩 | 金属锭 + 螺栓（军工锻造） | 24×24 |
| `res_sticker.png` | sticker 贴纸 | ⭐ | 奖励星星贴纸（老师奖励款） | 24×24 |

**要求**：24×24 RGBA PNG；单主体居中，透明背景；深墨线（`#2c2c2a`）+ 单一强调色 + 轻铅笔阴影；
无卡通描边、无投影；在浅色 HUD（`#f5f0e8`）上小尺寸仍清晰可辨。

### AI 生成 prompt

**统一风格前缀**（拼在每个 prompt 之前）：

```
Hand-drawn notebook doodle icon, single stationery object centered on transparent
background, dark ink outline (#2c2c2a) with light pencil shading, one accent color
only, no cartoon outline, no drop shadow, flat top-down, worn-paper aesthetic,
24x24 crisp at small size.
```

| 文件 | 追加 prompt |
|---|---|
| `res_ink.png` | `a small ink bottle with one ink drop, deep blue accent (#3355aa).` |
| `res_paper.png` | `a single sheet of paper with one folded corner and two faint ruled lines, cream fill, blue ink outline (#4477bb).` |
| `res_graphite.png` | `a short sharpened pencil / hexagonal graphite stick, grey body (#778899), wood-tone tip (#ccaa44).` |
| `res_metal.png` | `a small forged metal ingot with a bolt, muted olive-steel accent (#889966), industrial feel.` |
| `res_sticker.png` | `a shiny five-point reward star sticker (teacher's homework style), warm gold accent (#cc9922), thin white sticker border.` |

> ⚠ 上方 **§一 格子地形底图** 的资源行（`tile_food/wood/iron`、麦穗/树林/矿石）同为旧命名，
> 权威地块类型见 `slg.ts` `TileType`/`ResourceType`；资源格通过格内母题（§三 / `drawResMotif`）区分
> ink/paper/graphite/metal 四大 biome，而非独立底图。该节待随地形贴图重做一并订正。

---

## 七、提供格式与命名规约

```
art/world/
  tiles/          tile_*.png
  overlays/       overlay_*.png
  icons/          icon_*.png
  buildings/      building_*.png
  markers/        marker_*.png  arrow_*.png
  hud/            res_*.png
```

- **格式**：PNG-32（RGBA），无压缩或 PNG-OPT 压缩
- **分辨率**：@1x 对应 96px 格（tile/overlay/buildings），图标类 32px 以下
- **风格**：手绘笔记本铅笔/墨水质感，与 `sketch.ts` 程序笔触一致，不要卡通描边
- **命名**：小写下划线，无空格，`.png` 后缀
- **交付**：所有资产放入 `art/world/` 对应子目录后告知，程序侧替换 `Graphics` 占位为 `PIXI.Sprite`

---

## 八、实现计划（程序侧）

当前所有效果由 `WorldMapScene.ts` 的 `drawTileL1()` / `drawTileL2()` / `renderOverlay()` 用 `PIXI.Graphics` 程序绘制。

收到美术资产后改造：
1. 在 `build()` 阶段 `PIXI.Loader.shared.add()` 预加载所有地图资产
2. `drawTileSlot()` 改为 `Sprite`（底图）+ `Sprite`（叠加层）复用，颜色改为 `tint`
3. 标记类图标改为每格固定 `Sprite` 子节点，按 `visible` 切换显示
4. L2/L3 仍可继续用色块（减少 draw call），或改用 `RenderTexture` 批量

### 未缓存格的程序地形（§14.2 computable on either end）

视野外 / 从未拉取的格子不在 `tileCache` 里，但地块类型是 `proceduralTile(worldId,x,y)` 确定性生成的、
两端可算。`drawTileSlot()` 对未缓存格用 `proceduralTile()` 现算 `type/resType`，喂给 **贴图选择**
（`terrainTextureName`）与 **资源母题**（`drawResMotif`），使山脉/河流/关隘/中心/四大 biome 资源
在全图可见（§18 V1 model 2a：地形层全图可见，仅动态层 [归属/城/驻军/等级] 受视野门控）。

> 历史 bug：此前 L1 贴图对未缓存格恒取 `'neutral'→terrain_grass`，把整张图的地形多样性糊成同一张
> grass 涂鸦（颜色层算对了却被 alpha 0.9 的贴图盖住）。已修（2026-07-03）。
> 注：`neutral` 底图走 `terrain_grass`（非纯纸白）已于 2026-07-03 拍板收敛，§一 与 `slg-terrain-art.md`
> 口径已统一（见 §一脚注）；本次 bug 修复只保证「按真实 type 渲染」，neutral 的贴图选择由该拍板确定。

### 行军连线端点校验

`renderOverlay()` 画行军连线前用 `parseTileStrict()` 校验 `fromTile/toTile`：缺失/格式错/越界 → 跳过该 march，
避免端点异常时 `parseTileId` 兜底成 `(0,0)` 而从世界原点拉一条线贯穿全屏（已修 2026-07-03）。
