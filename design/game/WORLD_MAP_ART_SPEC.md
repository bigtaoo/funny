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
| `overlay_mine.png` | 我方领地叠层（半透明蓝墨纹理，ADR-003 铁律：我方=蓝） | `#90a8e6` α=0.85 |
| `overlay_mine_base.png` | 我方主城叠层（浓蓝墨） | `#4477cc` α=0.85 |
| `overlay_enemy.png` | 敌方领地叠层（红墨） | `#e69090` α=0.85 |
| `overlay_enemy_base.png` | 敌方主城叠层（浓红墨） | `#cc3333` α=0.85 |
| `overlay_ally.png` | 家族盟友领地叠层（绿墨） | `#9cd6a4` α=0.85 |
| `overlay_ally_base.png` | 家族盟友主城叠层（浓绿墨） | `#46a85a` α=0.85 |
| `overlay_sectmate.png` | 宗门成员（非同家族）领地叠层（紫墨，2026-08-08 新增，不共享视野） | `#c9a8e0` α=0.85 |
| `overlay_sectmate_base.png` | 宗门成员主城叠层（浓紫墨） | `#8e44ad` α=0.85 |
| `overlay_allysect.png` | 盟友宗门领地叠层（琥珀墨，2026-08-08 新增，叠加既有黄描边，不共享视野） | `#f0c987` α=0.85 |
| `overlay_allysect_base.png` | 盟友宗门主城叠层（浓琥珀墨） | `#d68910` α=0.85 |
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
| ~~`icon_watchtower.png`~~ | 瞭望塔（己方领地建造，扩视野） | — | ✅ **改版完成**（2026-08-09）：旧图是正视立面构图，缩放后偏细高、撑不满格子；换成 3/4 俯视宽脚架构图后已接入 `building_atlas`，见 [`slg-building-art.md`](../product/slg-building-art.md)；atlas 未就绪时回落几何塔身 |
| `icon_blocker.png` | 路障（己方/家族领地建造，`tile.structure` 非 arrowTower 的一种） | — | ✅ **出图完成**（2026-08-09）：v1 起一直是几何 X 撑木占位，现已出图（交叉铅笔状木桩绑扎栅栏）并接入 `building_atlas`，见 [`slg-building-art.md`](../product/slg-building-art.md)；atlas 未就绪时回落几何占位 |
| `icon_level_dot.png` | 等级指示圆点（格子升级后右上角） | 12×12 | 实心圆，颜色按归属（保持程序绘制，可动态取归属色，不出图） |
| `icon_allysect_border.png` | 联盟宗门黄色内描边（重复九宫格拼接） | 96×96 | 程序描边（保持程序绘制，不出图） |

---

## 四、覆盖层建筑（Overlay Buildings）

| 资产名 | 描述 | 状态 |
|---|---|---|
| `city_l1..l10` | 我/敌/盟主城 + NPC 可攻占城池（每级一张，10 级，归属靠程序上色） | ✅ 已接入 `city_atlas`（3×3 base 锚点，深度排序图层；2026-08-14 起统一命名，无档位回退） |
| `building_keep` | 战略要点/咽喉点建筑（城楼门楼） | ✅ 已接入 `building_atlas`（2026-07-03） |
| `building_stronghold` | 险地 NPC 据点（暗色石垒） | ✅ 已接入 `building_atlas`（2026-07-03） |
| `icon_watchtower` | 己方瞭望塔（扩视野） | ✅ 改版完成——3/4 俯视宽脚架构图，详见 [`slg-building-art.md`](../product/slg-building-art.md) |
| `icon_blocker` | 己方/家族路障（`tile.structure`，非 arrowTower） | ✅ 已接入 `building_atlas`（2026-08-09），详见 [`slg-building-art.md`](../product/slg-building-art.md) |
| `icon_arrowTower` | 箭塔（`tile.structure.kind === 'arrowTower'`） | ✅ **已出图、已接入**（2026-08-17）：v1 起一直是纯 `PIXI.Graphics` 几何画法（米白塔身 + 三角屋顶，屋顶按格子归属染色）——地图上那个"尖尖的绿色树状"图标就是它（绿色 = 盟友领地染色）；现已出图并接入 `building_atlas`，详见 [`slg-building-art.md` §6](../product/slg-building-art.md)；atlas 未就绪/帧缺失时仍回落原几何塔身（屋顶保留 ownership tint，真图不 tint） |

> **资源母题 vs 建筑压制（2026-08-17）**：一块被占领的资源格，`resType` 会一直留在 tile 文档上（见下方 `motifResType` 说明），哪怕后来在上面造了瞭望塔/箭塔/路障——旧逻辑不管这些，资源图标和建筑精灵会叠在同一格里，读起来乱（用户截图反馈）。`drawTileL1` 现在在画资源母题前先判是否已有 `featBuilding`（keep/stronghold/bridge/plankway）或 `tile.watchtower` / `tile.structure`，命中则跳过该格的资源图标——建筑本身仍照常画。地形建筑（keep/stronghold/…）在地图生成阶段本就不携带 `resType`，这条判断主要生效在玩家建造的动态层。map-editor 的 `drawEditorTile` 不涉及玩家建筑（只编辑静态模板），资源母题本就按 `tile.type === 'resource'` 互斥门控，无需同步改动。
>
> **接入落地（2026-07-03，2026-08-09 追加 icon_blocker + icon_watchtower 改版，2026-08-17 追加 icon_arrowTower）**：
> `building_keep` / `building_stronghold` / `icon_watchtower` / `icon_blocker` / `icon_arrowTower` 五张手绘钢笔线稿
> 经 `art/slg/slg-map/pack_buildings.cjs`（近白→透明+裁边+长边 256，同 `res` 管线）打包为
> `client/src/assets/slg/building_atlas.{png,json}`，`buildingAtlasLoader.ts` 懒加载 + 并入进场
> loading 门控。渲染在 `WorldMapScene.drawTileL1` → `placeBuildingSprite()`：
> - keep/stronghold 属**地形层**（type 由 `proceduralTile` 决定、全图可见），随格底纹一起画、fog 下压淡；
> - watchtower/blocker/arrowTower 属**动态层**（`tile.watchtower` / `tile.structure`），fog 下隐藏，atlas 未就绪回落原几何占位；
> - 五张均为中性墨线**不 tint**，归属由格下水洗表达；bottom-center 锚在菱形下部使建筑「立」在格上（arrowTower 的几何回退例外——那条路径没有格下水洗替代，仍保留 ownership-tinted 屋顶）。
>
> **目标高度的定尺规则（2026-08-15 修正，2026-08-17 补 arrowTower）**：玩家能在**相邻格连片建造**的东西
> （`icon_watchtower` / `icon_blocker` / `icon_arrowTower`），精灵屏幕宽度（`targetH × 帧宽高比`）要贴着
> **邻格锚点间距 `tp/2`** 来定，而不是菱形格全宽 `tp`——等距 2:1 下这两个数差一倍。地标地形
> （`building_keep`/`building_stronghold`，`tp*1.3`）每片区域只有一个，可以放宽。原先按地标的
> 尺度给了 `tp*0.95` / `tp*0.5`（屏宽 1.23 tp / 1.45 tp），一排瞭望塔/拒马糊成一团排线，现为
> `WATCHTOWER_H = 0.40` / `BLOCKER_H = 0.22` / **`ARROWTOWER_H = 0.50`**（`tileGraphics/tiles.ts`）——箭塔刻意
> 比前两者窄（屏宽约 `0.25 tp`），呼应它"单格细尖桩"而非"沿边界连片铺开"的定位。推导与截图见
> [`slg-building-art.md` §5](../product/slg-building-art.md)（§6 是 arrowTower 单独一批）。
> 同批修正：瓦片池是取模环绕的，槽位次序 ≠ 屏幕深度，已按 `zIndex = tx + ty` 排序，前排最后画。
>
> 旧规划里 `building_base_mine/enemy/ally.png` 三张**作废**——主城改由 `city_atlas`（4 级 × 程序上色）承担，
> 不再按阵营出三份。原 64×64 尺寸列亦作废（打包按长边 256、渲染期按 tile 尺寸缩放）。

> **主城名字/等级标签 — 改版（2026-08-01，不出图，程序绘制）**：原先悬浮在建筑下方的实心/空心
> 「档位内等级」圆点阵（`● ○` 数点数换算等级）被反馈「表现形式让人迷惑」——一颗小圆点同时编码了
> 归属色（红/绿/蓝/灰）和档位进度两件事，缩放到小尺寸后更难分辨。改为悬浮在建筑**正上方**的纯文字
> 标签，统一一条规则（自己的据点也不例外）：`{ownerName} Lv.{n}`——自己的据点用
> `WorldMapCallbacks.playerName`，别人的据点用 `WorldTileView.ownerName`（服务端 `ownerName` 只对非本人
> 地块下发，见 `worldsvc/src/worldTypes.ts`）；`ownerName` 缺失（meta 未就绪）时退化为只显示 `Lv.{n}`。
> 归属不再靠标签重复表达——地块本身的水洗颜色（`ownerTint`）已经说明白了，标签着色只是同一套配色的
> 弱回声，不是新的信息编码。实现见 `WorldMapRenderer/city.ts::refreshCityLayer`；回归测试
> `client/test/ui/worldMapCityLabel.ui.ts`。

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
- 敌方行军统一 `#cc3333`（红，ADR-003 铁律：敌方=红），线宽 2.5px（己方 1.5px）

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
> **帮会徽章角标 — ✅ 已接入（2026-08-14，见下方"按队伍真实领队兵种显示"决策，两者不冲突）**：
> 帮会图标体系的 24 套图腾出图并打包接入后（[`family-emblem-art-prompts.md`](../product/family-emblem-art-prompts.md)），
> **没有替换 `MARCH_TOKEN_ASSET`/`buildDotToken`**——那会倒退下面 2026-07-26 才刚落地的"按真实领队兵种
> 显示"决策，`tokens.ts` 头部注释已挑明"帮会/旗帜有意排除在外，这只替换 6 种已授权骨骼中的哪一种代表
> 令牌"。改成叠加一个不影响令牌本身的**角标**：`WorldMapRenderer/tokens.ts::syncEmblemBadge()` 在令牌
> 右下角画一个独立的顶层 `buildEmblemIcon` 精灵（不挂在会跟随行进方向左右镜像的 stickman 容器下，避免
> 徽章图案跟着镜像翻转），三套令牌（march/occupy/stationed）各自的数据来自 `worldsvc` 新增的
> `combatShared.ts::resolveOwnerEmblems()`——按 `PlayerWorldDoc.familyId` 只读镖像批量解析
> ownerId→family→emblemKey/Color，贴回各自 View。
>
> **按队伍真实领队兵种显示 — ✅ 已接入（2026-07-26，零新增美术，复用已有 6 种骨骼资产）**：
> 上面"兵种素材暂时二选一"的写死映射已废弃。`worldsvc` 在 `startMarch` 派发时（`combatMarch.ts`）用
> `leaderUnit.ts::resolveLeaderUnitType()`（镜像客户端 `teamTroops.ts::teamLeaderCard()` 的选取规则：
> 显式 `team.leaderCardId` 优先，否则按 `cardPower` 取全队最强卡）算出队伍领队卡的兵种，一次性冻结进
> `MarchDoc.leaderUnitType`（不随后续改队伍/换卡变化，敌我双方看到的都是派发那一刻的领队），随
> `OccupationDoc`/`StationedDoc` 沿途传递（占领保持、驻扎沿用同一份快照）。**对敌方行军同样生效**——
> 由服务端算好、只下发最终兵种枚举（不暴露队伍/卡牌明细），不像 `teamId` 那样对敌方置空。
> 客户端 `fog.ts::resolveMarchUnitType()` 优先读 `march.leaderUnitType`（若不在已知 6 种骨骼资产内则
> 兜底），否则退回原 kind 二选一逻辑（无队伍的散兵行军）。三套令牌（march/occupy/stationed）全部改用
> 同一套解析。回归测试：`client/test/ui/marchTokenAnimation.ui.ts`（新增 leaderUnitType 分支用例）+
> `server/worldsvc/test/leader-unit.test.ts`（纯函数单测）。
>
> **大量同屏令牌的性能分级（LOD）— ✅ 已接入（2026-07-26）**：千支队伍同屏攻城场景下，"每条行军一个
> 全骨骼 `StickmanRuntime`"（6-12 个 sprite + 每帧骨骼更新）成本会线性爆炸。`fog.ts` 新增跨
> march/occupy/stationed 三套令牌共享的 `STICKMAN_TOKEN_BUDGET`（=80）：`renderOverlay(dt)` 每帧起一个
> 共享预算对象依次传给三个 `syncXxxTokens`，marches 优先占用、其次 occupations、最后 stationed；预算
> 耗尽后新建的令牌退化成 `buildAvatar()` 画的静态头像圆点（1 个 sprite，无骨骼开销），复用领队兵种
> 对应的 `hero:<unit>` 头像。已存在的令牌不会中途升降级（避免闪烁），只有新建令牌受预算门控，因此
> 预算约束的是"新令牌的建造速率"而非"存活总数的硬上限"——但每个存活的骨骼令牌仍会持续占位。
> 视口裁剪（只渲染屏幕可见范围内的令牌）评估后**未采用**：现有 UI 回归测试大量依赖"无论镜头在哪都能
> 稳定拿到令牌池"这一行为，屏幕位置裁剪会让离屏但仍在数据里的令牌拿不到骨骼实例，需要大改测试装置来
> 配摄像机位置，收益（避免离屏渲染）在预算机制已经兜底总数上限后不再是关键——数量预算已经把最坏情况
> 锁死在 O(budget) 而不是 O(实际行军数)。回归测试：`client/test/ui/marchTokenLod.ui.ts`。
>
> **占领/攻城到达 — ✅ 已修复（2026-07-16）**：此前令牌抵达目的地时 `syncMarchTokens()` 直接
> `destroy()`，攻击方令牌瞬间消失、从未播放 `attack` 动画。现在 `SiegeDoc`/`siege_result` 推送
> 携带 `marchId`（`combatSiege/helpers.ts::recordSiege` + `core/push.ts::pushSiege` + `transport.proto`），
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
>
> **令牌整体缩小一半 — ✅ 已接入（2026-08-01）**：march/occupy/stationed 三套令牌此前按
> `targetHeight = tp * 1.1` 渲染，反馈地图上人物偏大、显得拥挤。`fog.ts` 新增共享常量
> `MAP_TOKEN_SCALE = 0.55`（=旧值的一半），三处 `new StickmanRuntime(...)` 的 `targetHeight` 与
> 预算耗尽后的静态头像圆点直径（`buildDotToken`）统一改用 `tp * MAP_TOKEN_SCALE`。只影响世界地图
> 令牌，不影响战斗场景内的单位尺寸（战斗走 `render/unitSize.ts` 独立的 `TARGET_SCREEN_PX`，未改动）。
> 回归测试：`client/test/ui/marchTokenScale.ui.ts`。
>
> **地图视觉降噪：归属描边去重 + 叠加层笔触分层 — ✅ 已接入（2026-08-01）**：反馈"地图看起来有些
> 混乱"（边境攻城场景截图：连续领地描边、占领前线、驻扎光环、行军线全部叠加同一片地块）。根因是
> `drawTileL1`/`drawTileL2` 里每个 owned 地块都独立画一次归属描边，连续同归属领地因此重复画出边框，
> 拼接后读成一片网格线——不是设计意图，是结构性重绘问题。修复：
> - **归属描边只在边界画**：`WorldMapRenderer/pool.ts::ownerHasBoundary()`（复用 `isBaseAnchor` 同款
>   4-邻居 `tileCache` 查表写法）判定一个 owned 地块的 4 个直连邻居是否存在不同 `ownerTint` 值（含
>   邻居缺失/未缓存，保守当作"有边界"，宁可多画不漏画）；只有存在边界才画描边，4 邻居全同只留水洗。
>   `drawTileL1`/`drawTileL2` 新增 `ownerBorder` 参数（默认 `true`，兼容旧调用）网住原有描边绘制。
> - **三层叠加换笔触区分**（新增 `tileGraphics.ts::drawDashedPolygon`/`drawFadedLine` 两个纯绘制原语，
>   与 `drawStar` 同类）：占领前线（`renderOccupyFrontier`）改长虚线引导（填充 0.14→0.10）；驻扎防区
>   光环（`renderGarrisonZones`）3×3 footprint 的中心格跳过描边（否则读成十字网格）、环格改短虚线警示
>   （描边 0.55→0.38）；行军线（`renderOverlay`）从等宽实线换成起点淡/终点浓的渐变线（
>   `drawFadedLine`，固定分段数不随路线长度增长），箭簇不变。最终：**领地边界=实线、占领前线=长虚线、
>   驻扎光环=短虚线、行军线=渐变实线**，不再只靠颜色区分。
> - 二期可选（未纳入本次）：驻扎光环 3×3 内部共享边仍会被两侧各画一次，彻底去重需要整体画一个 3 倍大
>   菱形并用 `isoGrid.ts::clipConvexToRect` 裁到地图边界（`overlayGfx` 画在云雾遮罩之上，未裁剪的大
>   菱形会在地图边缘穿出遮罩）——收益/工作量比不划算，留作后续。
> 验证：`tsc --noEmit` + 生产构建通过；`client/test/ui/` 全量 21 个文件 143 个测试通过（含真实驱动
> `invalidatePool()` 全路径的 `worldMapCityLabel.ui.ts` 等）；vitest UI 层是 startup smoke，非像素级
> 视觉回归（见 `vitest.ui.config.ts` 顶部注释），像素级效果未做浏览器截图核对（本会话 Browser 预览面板
> 无法合成帧）。

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
