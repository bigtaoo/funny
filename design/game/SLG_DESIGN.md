# Notebook Wars — SLG 大世界设计文档（Nivara 版图争霸）

> 创建：2026-06-16。本文件是 SLG 大世界玩法（共享大地图 / 领地 / 兵力行军 / 家族宗门 / 拍卖行经济）的设计基准，随实现推进同步更新。
> 配套阅读：`META_DESIGN.md`（系统/架构总纲，§11 元循环定位）、`world.md`（世界观：宗门-家族版图争霸）、`SOCIAL_DESIGN.md`（家族频道兑现 SOC6-4 + Redis）、`COMMERCIAL_DESIGN.md`（充值/钱包，SLG 变现走它）、`ECONOMY_BALANCE.md`（数值）、`SERVER_API.md`（接口契约）、`META_TASKS.md`（任务进度 S8）。
> 拍板（2026-06-16，用户）：**走最重的率土之滨级共享大地图**；分赛季；交易全走拍卖行（个人交易=指定受拍人）；养成天梯绝对隔离、PvE+SLG 统一一棵树；资源 = 五种文具主题赛季资源 `ink/paper/graphite/metal/sticker`（墨水/纸张/石墨/金属/贴纸，命名定版 2026-06-30，见 §3.4）+ 高阶稀有养成材料。

---

## 0. TL;DR

- **SLG = 游戏的最后一块拼图，也是「赚钱区」**：率土之滨级的**共享大地图领土争霸**——一张地图容纳一整个赛季服的玩家，地图上铺满资源点与领地格子，玩家用有限兵力占领、驻守、行军、互攻；兵力守不住全部领地 → **必须加入家族（联盟）/ 宗门（赛季服）抱团** → 社交从「可选」变「刚需」。
- **承重墙（一句话）**：**SLG 关键围攻 = 双方预布兵的确定性自动战斗，服务器进程内跑确定性引擎算权威结果即时落地**（`seed + 攻守双方布阵` 唯一确定，无手操 / 无复算 / 无录像，见 §16）。复用全部既有战斗基建（确定性引擎 / `AISystem` / `buildXxxBlueprints`），战斗内核**几乎零改动**。
- **三定位互不污染**：天梯 PvP = 公平电竞（**永不卖战力**，硬墙单测守住）；PvE = 免费玩家出路；**SLG = 卖战力的赚钱区**（养成战力＝付费战力）。SLG 与天梯**分开匹配、分开榜**。
- **养成统一、天梯隔离**：PvE 和 SLG **共用一棵养成树 + 统一产出**（PvE 攒的装备/材料直接是 SLG 战力，PvE 成 SLG 的免费 on-ramp）；唯一红线——**天梯 PvP 永远走 `buildPvpBlueprints()`（无养成参）**，养成对天梯零影响。
- **第七进程 `worldsvc`**：有状态世界服，管地图状态机 + 行军调度 + 围攻触发；**状态权威在 Mongo，热态/空间索引/行军定时在 Redis**；资源产出**读时惰性结算**（不每格 active tick）。
- **Redis 入场**：SLG 强制引入 Redis（gateway 横扩 account→实例路由 + 家族/宗门频道 pub/sub + 行军调度），兑现 `META_DESIGN §6.7 / M22` 那条 ADR 与 `SOCIAL_DESIGN SOC7 / S6-4`。
- **交易全走拍卖行**：单一机制；个人交易 = 挂单时指定受拍人；高税 + 限额反 RMT。
- **关键战斗服务器权威结算**：占地/丢地/家族战/打真人驻军 = worldsvc 进程内跑引擎、双方预布兵确定性自动战斗、权威结果即时落地（无手操 / 无复算 / 无录像，见 §16）；扫荡自己领地 / 清中立 NPC / 碾压级目标 = 廉价数值结算。

---

## 1. 锁定的设计决策

| # | 决策 | 理由 |
|---|---|---|
| SLG1 | **走 Heavy 共享大地图**（率土之滨级），不走部落冲突式 Lite 无地图 | 用户拍板；最贴 fiction「版图争霸」；交易/领地/行军/家族连地的核心循环需要共享空间承载 |
| SLG2 | **大区 = 赛季服 = 一张地图实例**（单大区容量 ~500 活跃玩家，超出则开新大区）；**宗门 = 大区内势力组织**（≤30 家族/≤900 人）；**国家 = 占领州府立国的概念疆域**（版图归属已改 ADR-034 角度扇区，见 §2.4，非旧 Voronoi/10 首府）；**大比 = 大区内赛季结算，按宗门占国数排名** | 大区代替原「宗门服」概念；宗门降为大区内势力；国家系统新增为战略目标与加成机制（加成代码现仍按 Voronoi，版图模型待随 ADR-034 重写） |
| SLG3 | **分赛季（2 个月）+ 周期性重置**：单大区 ~500 活跃玩家；超出则并行开新大区；宗门由系统按综合实力（历史排名/规模/繁荣度）平衡分配大区，同宗门成员进同一大区 | 赛季制是变现发动机（重肝重充）；能力分组防止强队碾压生态 |
| SLG4 | **赛季重置粒度**：清「领地 / 兵力 / 地图态 / 赛季资源存量」；保「养成（装备/科技/材料）/ 外观皮肤 / 天梯段位 / 账号档案」 | 战略态归零保新鲜感与公平起跑，养成/付费资产跨季留存保护玩家投入与变现信任 |
| SLG5 | **SLG 围攻战 = 确定性引擎打防守 config（玩家自定义关卡形态）+ 录像** | 复用全部既有战斗基建，战斗内核几乎零改动；防守方离线也能被打 |
| SLG6 | **关键围攻 = 双方预布兵的确定性自动战斗**（服务器跑引擎算权威结果，无手操）（原双形态「真人手操 + 自动扫荡」方案已被 §16 推翻，2026-06-20） | 攻守双方各自开局预布兵，`seed + 双方布阵` 唯一确定结果；防守方离线也能被打，无实时对抗 |
| SLG7 | **养成 PvE+SLG 统一一棵树**，**天梯绝对隔离**（`buildPvpBlueprints` 无养成参，硬墙单测守住） | 用户拍板；PvE 自动成 SLG 免费 on-ramp + 转化钩子；电竞公平命根子不动 |
| SLG8 | **统一产出复用既有 PvE 材料**（scrap/lead/binding 等）当 SLG 高阶养成材料，不另造养成货币 | 「产出统一」最省的兑现；S3 已有材料体系，SLG 直接接 |
| SLG9 | **交易全走拍卖行**（单一机制）；个人交易 = 挂单指定受拍人；高税 + 每日限额 + 部分资源禁挂 反 RMT | 用户拍板；单机制简单、可审计；指定受拍人覆盖「点对点交易」需求；税/限额压住搬砖 |
| SLG10 | **第七进程 `worldsvc`（有状态）**；状态权威 Mongo + 热态/空间/行军调度 Redis；资源**读时惰性结算** | 大地图态有状态、需空间查询与定时行军；惰性结算省海量 tick 算力 |
| SLG11 | **复算只算关键战斗**（占地/丢地/家族战/打真人驻军）；非关键信任客户端 + 廉价结算（抽检） | 用户拍板；高价值战斗必防伪造（复用 `judgeRunner`），低价值省算力 |
| SLG12 | **资源（DRAFT）**：基础三种 粮食/铁/木材 + 高阶稀有养成材料（复用 scrap/lead/binding）；产率按格子类型与等级分布 | 物产差异驱动交易意愿；可后期换文具主题皮 |
| SLG13 | **家族 = 升级 social 基建**：家族成员/频道/公告/互助；家族频道 = Redis pub/sub（兑现 SOC6-4） | 复用好友/邮件/presence 基建，频道阶段正好引 Redis |

---

## 2. 世界结构与分服

### 2.1 组织层级（对齐 fiction）

```
大区（赛季服 = 一张地图实例，~500 活跃玩家）
 └── 宗门（大区内势力组织，≤30 家族；可与最多 2 个其他宗门结盟）
      └── 家族（宗门内联盟，≤30 人；繁荣度达标后族长可立宗门/建国）
           └── 玩家（占领格子 + 有限兵力 + 国籍归属）
宗门间大比 ── 大区内赛季结算，按宗门占领国家（首府）数排名
```

- **大区**：技术上 = 一个赛季服实例 + 一张独立地图。单大区容量 ~500 活跃玩家（地图 500×500，`SLG_WORLD_CAPACITY_MAX=500`）；超出则开新大区；大区间完全隔离（经济/地图/战斗互不影响）。
- **宗门**：大区内由家族组建的势力，最多 30 个家族（≤900 人）。建立宗门需花费 **5000 coin** + 家族繁荣度达中等门槛。宗门可与至多 **2 个**其他宗门结盟（盟友禁止相互攻击夺地；视野不共享；地图上对盟友土地进行颜色标记）。
- **家族**：宗门内自由组建/加入的小团体（≤30 人）。建立家族需花费 **500 coin**。
- **国家**：占领 10 首府之一即可立国，给国家取名。国家是概念疆域（Voronoi 分区），为本国玩家提供战斗/产出加成；国家土地仍需玩家逐格占领。
- **宗门间大比**：大区内赛季结束时，按宗门占领国家（首府）数排名结算奖励。

### 2.2 分服与人口（SLG3）

- 一个赛季开启 = 开一个或多个大区实例（地图）。
- 单大区容量 **~500 活跃玩家**（上限 500，`SLG_WORLD_CAPACITY_MAX=500`）；超出则并行开新大区。
- **分配规则**：系统按宗门综合实力（历史排名 / 规模 / 繁荣度综合评分）平衡分配大区；同宗门所有成员进同一大区；强宗门与弱宗门尽量均衡搭配，避免一边倒。
- 大区间完全隔离（经济/地图/战斗互不影响）。

### 2.3 赛季重置（SLG4）

| 重置（清） | 保留（跨季留存） |
|---|---|
| 领地归属 / 地图状态 / 国家归属 | 养成（装备 / 科技 / 材料库存） |
| 兵力 / 驻军 / 行军 | 外观皮肤 / 收集 |
| 赛季资源存量（粮/铁/木） | 天梯段位 / ELO |
| 繁荣度（赛季内有效）/ 宗门编制 | 账号档案 / 好友关系 |
| 国家/宗门/家族编制（每季重组） | coin（跨季留存） |

> 赛季周期 **2 个月**。重置是变现发动机：战略起跑归零驱动重新肝/充，养成/外观/coin 跨季留存保护投入。
>
> **与天梯赛季的边界/对照** → [`SEASON_OVERVIEW.md`](SEASON_OVERVIEW.md)：SLG 大区赛季（2 月）与天梯赛季（6 周）是两套独立系统，两条时钟互不触发；SLG 重置永不动天梯 ELO/段位（上表「保天梯段位/ELO」），写入域隔离见 OVERVIEW §3。

### 2.4 国家（Nations）系统

> **✅ 已实现（[DECISIONS ADR-034](../DECISIONS.md)，拍板 2026-07-05，同日完成重写）**：此前短暂落地过"10 首府三层同心环 + 距离衰减"模型（[ADR-033](../DECISIONS.md)，含代码实现），当天即被撤销、以 ADR-034 取代并重写完成。**2026-07-22 审计更正**：本节曾长期标注"代码尚未跟进/以下是目标模型"，该标注本身已过期——实际代码早已按本节模型实现：`server/shared/src/slg/province.ts` 的 `provinceIdxAt()`（角度扇区+半径环归属，替代旧 `nearestCapitalIdx()`）+ `provinceCapitalPositions()`（替代旧固定表 `CAPITAL_FRACTIONS`），`server/shared/src/slg/mapgen.ts` 的环形地形带/墨河弦/支脉/城池节点生成。旧符号 `CAPITAL_FRACTIONS`/`GEN_MAX_CAP_DIST`/`nearestCapitalIdx` 已从源码中完全移除。以下描述的就是当前代码状态。

- **环形分层结构**：放弃"首府点 + Voronoi/距离衰减"，改为**角度扇区 + 半径分层**：6 个"出生州"（外圈，各占 60°）+ 3 个"资源州"（中环，各占 120°，与出生州 2:1 对齐，资源州 i 正对出生州 2i/2i+1）+ 1 个"核心州"（中心圆域）。归属由角度扇区决定，不是最近点距离。
- **地形天然隔离**：折痕岭（3 条山脉，= 出生州↔资源州环形边界本身）+ 墨河（2 条河流，横穿全图的独立层）负责大范围隔离；出生州之间另有 6 条支脉/支流（山脉/河流交替）逐个隔开相邻出生州。均完全不可通行。
- **统一通道机制（ADR gate→bridge/plankway 迁移，2026-07-08）**：地图只保留**山地/河流两种阻挡地形**；不再有"免费关隘"。穿越阻挡带的**唯一**方式是一座**可攻占的通行建筑**——跨河为**桥（bridge）**、跨山为**栈道（plankway）**，属建筑城池类，有 NPC 守军，**攻占后（本人及盟友）方可通行，未占领即封**。程序生成时每条阻挡带（折痕岭环 / 墨河 / 支脉）自动开 **1 处 1 格宽穿越**做连通兜底；设计师在地图编辑器里手动增删/挪动桥与栈道为主。
- **立国 = 占领州府**：州府（出生州 6 座 + 资源州 3 座）对应旧模型里的"首府"；占领即立国，本州范围内玩家获战斗/产出加成（具体数值待定）。
- **完整地形/城池骨架**（半径参考值、等级分布表、城池种类数量）见 [`design/tools/map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §2-§4。

---

## 3. 地图与格子

### 3.1 格子类型

| 类型 | 说明 | 进攻形态 | 防守 |
|---|---|---|---|
| **中立资源点** | 产出某种资源，产率/类型随位置与等级分布；占领后归玩家持续产出 | 扫荡（PvE，NPC 防守，按等级默认布防，**不须连地**——扫荡不占地，见 §4.1）/ 占领须连地（ADR-039，见 §4.1） | 系统默认防守 config（按格子等级） |
| **玩家领地** | 玩家占领并驻军的格子 | 围攻（关键战斗，预布兵确定性自动战斗，服务器权威结算）；**须连地（ADR-039，见 §4.1）** | 防守方自定义 config + 驻军 |
| **险地（Stronghold）** | NPC 极强的战略格，非常难攻占；占领后通常提供大幅资源或战略价值 | 围攻（高难 PvE，系统默认超强防守 config）；**须连地（ADR-039，见 §4.1）** | 系统超强默认防守（高等级 NPC） |
| **州府（Capital）** | 占领即立国；实际地图以地图编辑器导出为主，归属按**角度扇区**（ADR-034，6 出生州+3 资源州+1 核心州），本州玩家获加成；赛季终局争夺目标（Voronoi/10 首府点旧模型已废，见 §2.4） | 围攻（关键战斗，预布兵确定性自动战斗，服务器权威结算）；**须连地（ADR-039，见 §4.1）** | 占领方自定义防守 config + 驻军 |
| **桥 / 栈道（Bridge / Plankway）** | 嵌于阻挡带中的唯一通道建筑：跨河=桥、跨山=栈道；有 NPC 守军，须**攻城占领**方可通行，未占领视为阻挡；占领后**保留类型**（不变领地），并写入 `familyId` 使盟友也能通过 | 围攻（PvE 攻占 / 已占则围攻夺取）；**须连地（ADR-039，见 §4.1）** | 系统默认守军 `passageGarrison(level)`（介于普通格与险地之间）；占领方驻军 |
| **阻挡地形（Obstacle）** | 山脉/河流等完全不可通行格子（程序化分布，约占地图 10–15% DRAFT）；行军必须绕行或攻占桥/栈道 | 不可进攻 | — |

> **山/河渲染区分（2026-07-06）**：`obstacle` 仍是**单一不可通行类型**（寻路/占领逻辑不变），但瓦片可带可选 `obstacleKind: 'river'|'mountain'`（`@nw/shared` `core.ts`）纯做美术区分——`proceduralTile` 给折痕岭=山、墨河=河、支脉按奇偶交替；编辑器画笔画的河/山也带此标。渲染端 `terrainTextureName` 有 kind 就用对应贴图，否则回退旧位置哈希。地图编辑器与游戏客户端由此渲染一致，详见 [`design/tools/map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §0（2026-07-06 条）。
| **出生地 / 主城** | 玩家不可被永久夺取的本营（**首次进入=系统自动落城**，被打=掠夺资源 + 自动迁移 + 保护罩，不丢主城资格；只有付费迁城才可自选位置）。**真占 3×3=9 格实体**（锚点=中心格；九格一体不可分割；对非城主行军不可穿过=可封路；攻任一格=围攻整城；九格全计入领地/繁荣）——见 [DECISIONS ADR-025](../DECISIONS.md) | 围攻（掠夺；攻九格任一即结算同一场；**建筑血量+逐队守军波次+攻城值延迟结算见 [ADR-026](../DECISIONS.md)**） | 在城且未受伤的 `teams[]` 逐队上阵（t1→t5）；无守军直接判胜扣血 |

### 3.2 地图尺寸与地形布局

- **地图尺寸 ✅ 已实现（ADR-032，2026-07-04 定案 + 落地，`shared/slg.ts`）**：**500×500（25 万格）**，对应大区容量**上限 500 玩家**（`SLG_WORLD_CAPACITY_MAX=500`，见 §14.10 U4）。
  > **历史记录**（避免与旧数字混淆，仅留一条指针，其余口径已废止）：曾短暂拍板过 1500×1500/对应 1 万玩家（2026-06-18 "U2 ✅"），但从未真正实现——代码里 `SLG_MAP_W/H` 一直是 300，且 2026-06-30 的经济核验（`ECONOMY_VERIFICATION_LOG.md` §13-SLG-NATION）仍是在未升级的 300×300 上跑的。500×500 是重新核实代码现状后的新定案，不是"恢复旧值"也不是"1500×1500 打折"，详见 ADR-032。
- **地块等级 1–10 ✅ 已实现（ADR-032）**：`SLG_MAP_MAX_LEVEL=10`（对齐三国志战略版真实地块等级上限，调研见 [`SGZ_LAND_REFERENCE.md`](SGZ_LAND_REFERENCE.md)）。**不是** 5（旧代码实际值）也不是 9（与装备/武将卡的 `MAX_LEVEL=9` 混淆过一次，二者无关）。
- **无纯空地 ✅ 已实现（ADR-032）**：取消"中立地不产出"的分级（`resourceDensity` 从 0.34 提到 **1.0**）——除阻挡地形/关隘/据点/首府外，所有格子都是某一等级的资源地，呼应"地图上没有真正空地，只是低级地没人要"的设计前提。
- **等级分布曲线 ✅ 已实现（ADR-034，2026-07-22 审计更正原"待重写"标注）**：三层环各自独立的等级权重表（出生州/资源州/核心州分别取值，不是单一连续公式）已实现为 `mapgen.ts` 的 `_levelFromRing()` + `_LEVEL_DIST_OUTER/_RESOURCE/_CORE` 三张累积分布表，旧 ADR-033 的 `GEN_MAX_CAP_DIST`/距离衰减公式已从源码移除。完整权重表见 [`map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §4。
- **稀疏存储**：DB 只落被占领/被改动的格子；阻挡格、险地等静态地形由 `proceduralTile()` 程序化生成，不落库。
- **程序化分布 ✅ 已实现（ADR-034，2026-07-22 审计更正原"待重写"标注）**：§2.4 描述的"折痕岭/墨河/支脉"确定性地形（几何带模型，非噪声阈值）已实现为 `mapgen.ts` 的 `_ringTerrainAt()`/`_riverChordAt()`/`_branchKindAt()`，旧 `SLG_GEN.obstacleThreshold`/`obstacleMinDistRatio` 噪声阈值实现已移除，详见 map-editor DESIGN.md §2.2/§2.3。
- **国家版图布局 ✅ 已实现（2026-07-22 审计更正原"待重写"标注）**：代码已是 ADR-034 的角度扇区模型（`province.ts` 的 `provinceIdxAt()`/`provinceCapitalPositions()`/`NATION_KIND_BY_IDX`），旧 ADR-033 符号 `CAPITAL_FRACTIONS`/`GEN_MAX_CAP_DIST`/`nearestCapitalIdx` 已不存在于源码中。详见 [DECISIONS.md ADR-034](../DECISIONS.md)。
- **城池遮挡带地块等级封顶（占位数值，2026-07-22 补记）**：`server/shared/src/slg/mapgen.ts` 的 `RESOURCE_LEVEL_CAP_NEAR_CITY=5`/`RESOURCE_LEVEL_CAP_DEPTH=5` 把城池高层建筑贴图会遮挡的两条背向格带（`_inCityBackBands`）的资源等级封顶在 5 级，避免生成"看不清、点不到"的高等级地块。代码注释自述这是"用户临时拍板的占位数字，预期后续手工重调"，本文档此前从未记录这条规则——本次审计发现文档缺口，先补记于此，数值本身仍待重新校准，不代表已定案。
- **视觉呈现（ADR-029）**：以上均为逻辑格数据模型（正交整数 `(x,y)`），不涉及渲染方式。客户端 `WorldMapScene.ts` 自 2026-07-02 起改为**等距菱形投影**渲染（纯客户端视觉层，见 `client/src/render/isoGrid.ts`），逻辑网格/寻路/契约仍是正交，不要把"格子"误读成屏幕上必是方形。

### 3.3 格子 = 玩家自定义关卡（SLG5）

- 玩家领地/主城的防守 = 一份**可序列化 config**，形态等同 `LevelDefinition`：建筑摆位（兵营/箭塔在哪格）+ 出兵脚本时间线 + 基地强化 + 驻军兵种/数量。
- 玩家用养成解锁/强化各组件来编自己的「防守关」。
- **中立点/NPC 格按等级有系统默认防守 config**（玩家不编辑，等级越高越难）。
- 复用 level-editor 的概念与 `levelSchema` 校验（防守 config 走同一套运行时校验）。

### 3.4 资源（SLG12，✅ 命名定版 2026-06-30）

> **货币边界**（权威见 `ECONOMY_BALANCE.md` 开头表）：全局**唯一货币**只有 `coins`（金币，可赚可充、跨赛季）。`ink`（墨滴）是单局对战内随时间回的资源、**非货币**。下列 SLG 资源全是**赛季资源**——季末清零、禁挂拍卖行、不可直充（要卖只能走「资源包」commercial），**绝不升格为全局货币**。即便「贴纸」长得像币，也只是赛季资源。

- **基础五种（文具主题，对齐三战 粮/木/石/铁/铜）**：读时惰性产出 + 仓储上限，被攻破时按比例掠夺。

  | code enum | 文具名 | 功能角色 | 三战对位 |
  |---|---|---|---|
  | `ink` | 墨水 | 练兵 / 兵力上限 / 行军续命 | 粮食 |
  | `paper` | 纸张 | 基础建材 | 木材 |
  | `graphite` | 石墨 | 高阶建材 | 石料 |
  | `metal` | 金属 | 军工 / 装备锻造 | 铁矿 |
  | `sticker` | 贴纸 | 通用流通资源（招兵 / 科技 / 小额即时操作的软兜底，避免被单一实体资源死卡） | 铜币 |

  - **「墨即生命」设定（A 案）**：SLG 资源 `ink`（墨水）与对战内 `ink`（墨滴）共享同一世界观符号——Nivara 的画出来的单位靠墨续命。两者**机制完全独立**：对战 `ink` 每局清零（engine `Player.ink`）；SLG `ink` 是赛季续命资源（`playerWorld.resources.ink`），不同结构、不同生命周期，实现时勿混淆。
  - **贴纸（铜币位）护栏**：赛季制（季末清）/ 世界内赚取为主 / 禁挂拍卖行 / 不做独立直充（只能进资源包）。它是 SLG 本地赛季资源，不是 `coins`。
  - **贴纸/铜钱产出 = 家城 stickerShop + 地图铜矿并存（2026-07-07 拍板 · ✅ 已实现）**：回到三战规则——铜矿**上地图**、只在**等级 ≥6 的格子**生成（[`SGZ_LAND_REFERENCE.md`](SGZ_LAND_REFERENCE.md) §49「6 级地及以上特例」），占领后产铜钱，铜钱用于野外征兵等软操作。**推翻**旧口径「贴纸=非地块」。**双 faucet 并存拍板**：`stickerShop`（`STICKER_SELF_BASE`/h/级）是人人都有的**基线**、覆盖建筑升级的 sticker sink；地图铜矿是只在争夺区(≥6)的**稀缺扩张奖励**。`recomputeYield` 两者加性叠加（无重复计数）。
    - 落地：`mapgen.ts` `resTypeFor()` 在 resource 格 `level ≥ SLG_GEN.copperMinLevel`(=6) 时按 `copperShare` 覆盖为 sticker（strongholds/familyKeeps/center 不参与，画建筑不画资源母题）；美术只出 l6–10 五级（[`slg-resource-art.md`](../product/slg-resource-art.md) §5.7-sticker）。
    - **copperShare = 0.25**（DRAFT，2026-07-07 调参）：铜矿 ≈ ≥6 格的 22% ≈ 全资源格的 2.5%（高级格里也是清晰少数，「特殊、要打下来」）。因基线已由 stickerShop 覆盖，铜矿定位为盈余奖励，故取低值。
    - **econ-sim 已建模地图 faucet**（2026-07-07，`tools/econ-sim/src/city.ts`）：`IncomeProfile.copperTiles` = 持有的 ≥6 铜矿格数（≈ ≥6 格 × copperShare），sticker 收入 = stickerShop 自产 + 铜矿格`(100×~6.9×国家加成=759/h/格，无建筑倍率)`。复核结论：铜矿贡献 active≈49% / hardcore≈72% sticker 收入，但 sticker 各档 days-to-max(19.6/5.0/1.9d) 均在 60 天赛季窗口内、且从不是瓶颈(paper 最紧)→ copperShare=0.25 未过量灌水。数值仍 DRAFT，正式登记见 ECONOMY_NUMBERS §13-SLG-CITY。
- **高阶稀有养成材料**：复用既有 PvE 材料 **scrap / lead / binding**（SLG8）——SLG 不另造养成货币，PvE 与 SLG 材料统一流转、可上拍卖行。
- 物产差异（不同格子产不同资源、丰度不同）= 交易意愿的来源。
- **资源格美术（5 母题 × 程序合成 10 级）**：5 种文具母题 AI 涂鸦已出图打包 → `client/src/assets/slg/res_atlas.{png,json}`（帧名 `res_ink/res_paper/res_graphite/res_metal/res_sticker`）；等级（丰度 + 守备强度双轴）、阵营/中立色、等级数字均**运行时程序合成**，不烘进图。出图 prompt / 验收 / 打包管线见 [`design/product/slg-resource-art.md`](../product/slg-resource-art.md)；源图 + 脚本在 `art/ui/slg-map/`。**✅ 地图格渲染接入已落地（2026-06-30，commit `b8b726c0`）**：`client/src/render/resAtlasLoader.ts`（懒加载图集，未解码时色块兜底）+ `WorldMapScene.drawResMotif`（仅 L1 细节层渲染）——丰度轴按等级 1→4 个母题精灵成簇；守备轴 lv4+ 手绘栅栏框 / lv7+ 加栅栏桩刻度 / lv8–10 红马克笔危险角；母题墨线不 tint。L2/L3 仍走色块占用层（按设计）。**✅ 5 种资源母题全部就位（2026-07-01）**：石墨 `res_graphite` 已更新为合规墨线版（带切面矿石棱块，见 slg-resource-art.md §4）。
- **主城（base）美术（4 等级图 × 3×3 占地 + 程序等级点标）✅（2026-06-30）**：4 张 AI 涂鸦手绘风主城图已出图 → `art/ui/slg-building/`；打包脚本 `art/ui/slg-building/pack_city_atlas.js`（Node.js + sharp，白背景自动裁边，256×256/格，2×2 排布）→ `client/src/assets/slg/city_atlas.{png,json}`（帧名 `city_lv1/lv2/lv3/lv4`）。等级↔图档映射：`city_lv1`=营地帐篷（lv 1-2），`city_lv2`=木栅寨子（lv 3-5），`city_lv3`=石砌要塞（lv 6-8），`city_lv4`=大城堡（lv 9-10）。渲染：`client/src/render/cityAtlasLoader.ts`（懒加载，未解码时兜底用现有程序化图标）+ `WorldMapScene.refreshCityLayer()`（在 `cityLayer` 容器中为每个可见 base tile 放 3×3 大小精灵，hovering 于 tile pool 层之上）；同 tier 内等级区分：精灵底部程序绘制填/空圆点（最多 3 个，同阵营 ink 色），lv-in-tier=1→○●●，等。L2/L3 主城精灵同样显示（固定 tp 下可见）。

> **每级出图 + 按等级占地 + NPC 城池也画精灵（2026-07-06 用户拍板）**：城池图从"4 档"细化为**每级一张（10 张）**——`getCityTextureForLevel(level)` 先取 `city_l{level}`、回退旧 `city_lv{tier}`（6 张新图 `city_l2/l4/l5/l7/l8/l10` 待出，prompt 见 [`../product/city-image-prompts.md`](../product/city-image-prompts.md)）。**占地按等级递增**：`cityFootprint(level)`=3/5/7/9（Lv1-2/3-5/6-8/9-10；世界中心仍 9×9=顶档），`allCityNodes` footprint 由它派生。`refreshCityLayer` 现在除玩家主城外，也为 `allCityNodes` 的 NPC 城（州府/关隘城/分级城/世界中心）各放一个按 footprint 缩放的城池精灵（确定性地形，map-wide 可见）。地图编辑器用同一套函数渲染，所见即游戏内所见（[map-editor DESIGN §0](../tools/map-editor/DESIGN.md) 2026-07-06 条）。注：城池的驻军/耐久数值仍是 §5 待定项，本轮只做视觉。

- **大地图观感修缮 ✅（2026-07-03）**：① **地图外云雾遮挡**——`WorldMapScene.renderFog()` 在 tile 层之上、交互 overlay 之下铺一层暖纸灰云 (`CLOUD_COLOR`, α0.97)，把地图 tile 区域（投影后的平行四边形）用 `beginHole/endHole` 挖空，边界叠两道半透明粗描边做雾气渐隐，地图边缘不再是硬钻石切边；随平移/缩放/数据刷新在 `renderOverlay()` 内重绘。**⚠️ 挖洞前必须先把平行四边形裁到视口（2026-07-03 二修）**：地图达 1500×1500，镜头居中时投影后洞多边形顶点在视口外几万像素处（数十个视口宽），直接喂 `beginHole()` 会让 PIXI earcut 洞三角剖分失败——整块云雾退化成实心遮罩把地图糊没（「SLG 地图变空白」回归，进图只见一片米色 + 隐约营地涂鸦）。改为先用 Sutherland–Hodgman 把洞裁进视口矩形再挖：坐标恒有界；镜头居中在大图时裁剪结果=整块视口矩形→洞=填充→云雾自然不显。雾气描边仍描未裁的真实地图边（线段不过 earcut，越界部分由 `mapClip` mask 裁掉）。裁剪函数 `clipConvexToRect()` 落在纯几何模块 [`render/isoGrid.ts`](../../client/src/render/isoGrid.ts)（与 `tileToScreen`/`diamondPath` 同类、零 PIXI 依赖），回归测试 `client/test/isoGrid-fog-clip.test.ts`（7 例：复刻 renderFog 洞多边形，断言大图居中裁剪后①顶点恒在视口内②仍punch穿整块视口=地图不糊白，另覆盖贴边/全屏内/全屏外/跨边裁切）。② **镜头不出图**——`clampPan()` 去掉旧的 `tp*2` 越界缓冲：地图比视口大时贴边停住，比视口小时锁定居中（无处可平移）。③ **去笔记本红竖线**——`buildPaperBackground()` 加 `{ marginLine?: boolean }`（默认 true 不影响其它场景），世界地图正常/加载背景传 `false`，不再画左侧红色页边竖线。④ **城市 sprite 严格 3×3 锚点**——`isBaseAnchor()` 只认完整同主 3×3 中心格；遗留单格主城不再客户端兜底，改由服务端 join 自愈重建（见 [DECISIONS ADR-025](../DECISIONS.md) 强制自愈段）。

> **✅ 主城点击命中区域修复（2026-07-13）**：`WorldMapInput.onTileClick` 的 `isBase` 判定原来只认 `mainBaseTile` 锚点这一格，点在同一座 3×3 主城的其余 8 格会误落进普通「我的地块」菜单（增援/防御/瞭望塔/弃地），没有「进城/训练」按钮——与 ADR-025「九格一体不可分割」矛盾，体验上等价于「点主城常没反应」，进而导致玩家摸不到训练士兵入口，出征几次后 troops 耗尽只能一直报「没有足够的士兵」。改为 `baseFootprintCells(bx, by)` 命中判断（整块 3×3 任一格都算点了主城）；回归测试 `client/test/ui/worldMapBaseClick.ui.ts`（6 例）。

> **✅ code rename 已落地（2026-06-30）**：`ResourceType` = `ink/paper/graphite/metal/sticker`（`shared/slg.ts`），`RESOURCE_TYPES`/`emptyResources`/`WATCHTOWER_COST`/`tileYield`/`biomeAt`/`TROOP_TRAIN_INK_COST` 同步；worldsvc（`service.ts`/`db.ts`/`auctionService.ts`）+ 契约 `openapi-world.yml` resType enum + 客户端（`WorldMapScene` 颜色/展示/训练、`openapi-world.ts`、i18n zh/de/en）全部更新；server typecheck + client tsc + web 构建全绿。
>
> **遗留（balance pass，方案已出 → [`SLG_CITY_DESIGN.md`](SLG_CITY_DESIGN.md)）**：五种赛季资源均已注册进类型/存储/资源包/掠夺/拍卖禁挂/瞭望塔成本等全部泛化管道。**对齐三战「4 地块 + 1 铜币」**：`graphite`（石料）是**第 4 种地块资源**，**已有地图 faucet**——`biomeAt` 产 ink/paper/graphite/metal（ADR-022 已落地，见 [`SLG_CITY_DESIGN.md`](SLG_CITY_DESIGN.md) §10；⚠ `biomeAt` 的空间分布机制 2026-07-15 从"低频噪声四分区"重写为"逐格独立混合 + 省份偏向"，见 [`map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §8，四种资源类型本身不变）；`sticker`（铜币位/通用）由主城 `stickerShop`（民居模型）**自产**（非地块 faucet）；两者 sink = 主城高级建筑升级消耗。随主城建筑系统（SLG_CITY_DESIGN P1）落地，数值经 [`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md) 核验（§16.5 / ECONOMY_NUMBERS §13-SLG）。

---

## 4. 兵力 / 驻军 / 行军（留存发动机）

> 这套数值循环是「为什么必须加家族」的根，要卡死。

- **兵力上限**：玩家可拥有的兵力有上限（训练队列消耗资源 + 时间，是主 sink + 变现加速点）。
- **驻军占用**：每块领地需驻军才守得住；驻军占用兵力池。
- **守不住全部** → 兵力 < 全部领地所需驻军 → **必然需要家族连地互守/增援** → 社交刚需化。
- **行军寻路**：地图含阻挡格（山脉/河流，完全不可通行）和桥/栈道（可占领通道建筑）。服务端用 **A\*** 算法计算行军路径（绕阻挡 + 检查桥/栈道归属）；行军时间 = 路径格数 × `MARCH_SPEED_SEC_PER_TILE`。未被己方或盟友控制的桥/栈道视为阻挡（但始终可作为行军**目标**格抵达以发起攻城）。
- **占领、增援、进攻都需行军**，有距离/时间成本（Redis 调度的定时事件）；家族抱团占**连续领地**才高效（连地加成 + 短行军距离 + 快速增援）。
- **增援 / 代守 / 代打**：家族成员可向彼此领地派驻援军、被攻击时驰援（行军到达触发协防）。
- **保护罩**：被打败后短时保护（防连续碾压），是变现/节奏旋钮。
- **行军疲劳**：远距离讨伐天然处于不利地位，见 §4.4。

### 4.2 卡牌部队 vs 地图兵力池——边界修复 + 占地真实战斗（2026-07-15）

> 用户核验后拍板三处修复，均围绕同一条已有但被违反的设计铁律：`CHARACTER_CARDS_DESIGN.md` §6.1/§9 早已明文「卡牌兵力（`cardState.currentTroops`）是与地图兵力池（`playerWorld.troops`）完全独立的第二套账本，PvE/卡牌结算不计入全局兵力池」。

**问题 1：占地（`kind:'occupy'`）从未接入真实卡牌军队。** `combatMarch.ts` 目前只在 `kind==='attack' && teamId` 时读取真实布阵（`resolveCardArmy`），占地 march 永远用 `synthesizeArmy(troops,'attacker')` 把兵力数字合成成通用步兵去打 `npcGarrison(level)`，与玩家真实卡牌等级/装备/兵种无关——三战式"高级队伍打低级地基本不掉血"这条效果因此从未在占地这个最高频场景上体现，只在打其他玩家/主城时体现。

- **服务端已修复（2026-07-15）**：`startMarch` 允许 `kind==='occupy'` 也带 `teamId`（沿用 `pw.teams` 里已保存的布阵模板，校验逻辑与 `attack` 分支一致）；`occupation.ts` 的 `applyOccupy`/`applyOccupationExpulsion` 比照 `arrival.ts` 的 `hasCardArmy` 判断，卡牌布阵走 `resolveCardArmy` + 真实引擎战斗 + `cardInstances`/`equipmentInv` 注入（复用 §16.5 已有的 CC-3 管线），非卡牌布阵保留 `synthesizeArmy` 兜底。e2e 已验证：12 卡满编队伍打 level≤1 地（`npcGarrison=120`）近乎不掉血。
- **客户端 UI 已接（2026-07-16）**：占地操作不再直接弹 `showDeployDialog(tx,ty,'occupy')`，而是走统一的选队流程。原 `showAttackTeamPicker` 泛化为 `showTeamPicker(tx,ty,kind)`（`kind:'attack'|'occupy'`），`doMarchTeam(tx,ty,teamId,kind)` 相应带上 `kind`，占地时 `startMarch(...,'occupy',1,teamId)`。选队占地下投入的兵力归属卡牌（`cardState.currentTroops`，战后按实际存活写回、可继续出战），不再永久变成地块驻军而从兵力池划走。**兼容早期玩家**：占地选队弹窗内保留一颗「散兵占领（兵力池）」按钮，回退到旧的 `showDeployDialog` flat 派兵路径（无卡牌队伍时仍可占地）。受影响文件：`WorldMapNet.ts`（`showTeamPicker`/`doMarchTeam` 泛化）、`WorldMapInput.ts`（占地操作改调选队）、i18n（`world.team.pickTitleOccupy`/`noTeamsOccupy`/`flatOccupy`）。
  - **为何玩家会误以为"分配一次兵力打一次就没了"**：散兵占地打赢后，幸存兵力按设计留作该地驻军（§4「驻军占用兵力池」的留存/社交机制），从兵力池划走、不回池；`deployAll` 全量派兵时池子直接归零，被读成"一次战斗全损"，实际是占地留守而非真实战损（2000 兵打 L1/L2 的 `npcGarrison=120/240` 必胜、高存活）。选队占地把兵力归属卡牌，正是解决这一体感的路径。
  - **散兵占地路径移除 + 选队器兵力显示修复（2026-07-17，用户拍板）**：用户报告「队伍 1 里有兵力，占地却提示兵力不足」。根因是**同一操作暴露了两套兵力账本**：选队占地用队伍自身携带兵力（卡牌 `cardState.currentTroops`），而弹窗里保留的「散兵占领（兵力池）」按钮走 flat `playerWorld.troops`——玩家把兵力都分给了队伍/卡牌，散兵池为空，点它必然 `NO_TROOPS`「兵力不足」。拍板：**基地兵营的预备兵只用于"分派给队伍"，与占地无关；占地只认队伍自己携带的兵力**。故：① 删除占地弹窗的「散兵占领」按钮（连带 i18n `world.team.flatOccupy`），占地=纯选队；② 选队器每支队伍显示的 committed 兵力改用与 `CityScene.committedTroops`/`TeamsScene` 一致的算法（卡牌项取 `cardState.currentTroops`，flat 项取 `initialHp`），此前只累加 `initialHp` → 卡牌队伍误显示为 0，加剧了"看起来没兵"的误解；③ `errorMsg` 新增 `SATCHEL_CAP_EXCEEDED → world.err.satchelCap` 映射（此前甩英文原文），队伍携带量超无挎包上限（`SATCHEL_CARRY_BASE=TROOP_CAP_BASE=2000`，见 `city.ts`）时给出可行动的中文提示（建/升挎包或减兵）。受影响文件：`WorldMapNet.ts`、i18n（删 `flatOccupy`、加 `world.err.satchelCap`）；`showDeployDialog('occupy')` 已无调用方（仅 reinforce/sweep 仍用）。
  - **选队弹窗只显示可出战队伍 + 编队编辑器迁移到卡牌（2026-07-17，同日追加，用户二次拍板）**：上一条修复几小时后用户仍报告「队伍里有兵，占地却提示兵力不足」——排查发现**真正的根因不在选队弹窗，而在编队编辑器从未接入卡牌系统**。玩家实际使用的编队入口（`TeamsScene` 点击队伍卡 → `DefenseEditorScene` `mode:'attack'`）是 CC-3 卡牌系统上线（2026-07-01）之前的遗留 UI：调色板列的是原始兵种（`CARD_DEFINITIONS` 的 `unitType`），落子时写 `ArmyEntry{unitType, initialHp}`（客户端 25%-100% HP 滑条），**从未产生 `cardInstanceId`**。于是 `combatMarch.ts` 的 `hasCardArmy` 判定对这类队伍恒为 false，退回旧的 `pw.troops < troops`（地图兵力池）闸门——选队弹窗显示的"队伍兵力"是这些 `initialHp` 之和，与真正校验的 `playerWorld.troops` 池子毫无关系，池子不够就必然 `NO_TROOPS`，与队伍本身"看起来有兵"无关。用 e2e 反证过：card army（`cardInstanceId` 全套）即使把 `playerWorld.troops` 清零也能正常占地，说明服务端修复本身没问题，缺口在客户端编辑器一直没跟上。
    - **修复**：① `showTeamPicker` 弹窗改为只列"可出战"队伍——`army` 非空 && 未在行军/占领中 && 携带兵力>0，同时删除弹窗里的「管理队伍」按钮（`WorldMapNet.ts`）；② `DefenseEditorScene` `mode:'attack'` 大改，调色板从原始兵种列表换成玩家的英雄卡牌库（`SaveData.cardInv`，剔除受伤/已在其他队伍的卡，支持翻页），落子写 `ArmyEntry{cardInstanceId, col, row}`（不再写 `unitType`/`initialHp`），一张卡只能上阵一次（重新落子=移动），队伍上限沿用服务端 `CARD_TEAM_MAX_SIZE=12`（原 `MAX_GARRISON=30` 只保留给防守编辑器）；HP 滑条/循环逻辑整体移除，格子下方改显示卡牌 `cardState.currentTroops` 实时兵力。防守模式（`mode:'defense'`，基地/地块驻防）完全不受影响，继续用原始兵种。受影响文件：`DefenseEditorScene.ts`、`WorldMapNet.ts`、`app/nav/world.ts`（新增 `getSave` 回调）、i18n（`world.team.hint`/`noTeamsOccupy` 改写，新增 `world.team.noCards`/`world.team.full`）。回归覆盖：`worldMapOccupyTeamPicker.ui.ts`（补充"仅可战队伍"/"零兵力队伍剔除"用例）+ 新增 `defenseEditorAttackCards.ui.ts`（落子/移动/上限/过滤/存档形状）。
  - **遗留队伍不自动迁移的兜底（2026-07-17，第三次追加，账号 tao 线上复现）**：上一条把**编辑器**迁到卡牌，但**迁移前已存盘的队伍不会被自动改写**——它们的 `army` 仍是旧的 `{unitType, initialHp}` 条目。账号 tao 的 `t1` 正是这种旧队（9 个 `shieldbearer/max/ironclad`，无 `cardInstanceId`，`cardState` 全空），设计总兵力 2160 > `troopCap` 2000 > 地图兵力池，故 `combatMarch.ts:269` 恒抛 `NO_TROOPS`「兵力不足」。三个 UI 误导叠加把玩家推进死胡同：① `TeamsScene`/`CityScene`/选队器都把旧条目的 `initialHp` 计入 committed，旧队看起来"有兵"、能进选队器，选了必失败；② 「Fill All Troops」在没有任何在队卡牌时**仍弹绿色成功提示**（`fillTroopsOk`），玩家以为已分兵实则一张卡没进队（`cardState` 恒空）；③ 没有任何提示告诉玩家旧队已作废。**修复（纯客户端）**：新增共享 `client/src/game/meta/teamTroops.ts`（`isLegacyTeam`/`carriedTroops`），三处 committed 统一改为**只认卡牌 `currentTroops`、旧条目计 0**——旧队因此显示 0、被选队器 `usable` 过滤剔除；`TeamsScene` 队伍卡对旧队显示红框 + 「⚠ 队伍已过期，点击重建」（i18n `world.team.legacyRebuild`）；`doFillTroops` 无在队卡牌时改弹 `world.team.fillNoCards`（红），不再伪造成功。**账号侧**：tao 的 `t1` 已在生产库手工迁移为 9 张自有英雄卡（同格位，`currentTroops` 按各卡上限共 1275，从 `baseTroopStock` 扣，备份见容器内 `/app/tao_t1_backup.json`）以立即解封。受影响文件：`teamTroops.ts`（新）、`TeamsScene.ts`、`CityScene.ts`、`WorldMapNet.ts`、i18n（新增 `world.team.fillNoCards`/`world.team.legacyRebuild`）。回归覆盖：`worldMapOccupyTeamPicker.ui.ts`（旧队剔除用例）+ `teamsScene.ui.ts`（旧队重建提示、Fill 无卡不伪成功）。

### 4.3 SLG 战斗录像浏览器（最近 100 场，2026-07-16）

> 单场围攻录像（`getSiegeReplay`，seed + 双方布阵重建 `LevelDefinition` 客户端 headless 重放）自 G3-2c 已有，但只能从"刚打完"的结算弹窗进入。本节新增按玩家维度列出历史战斗的浏览器，便于事后核实任意一场的胜负/存活（例如排查"是不是真的全灭"）。

- **服务端**：`SiegeDoc` 无 TTL、永久留存，已有 `{worldId,ts:-1}`、`{attackerId}` 索引。新增 `GET /world/sieges?worldId&limit`（`listSieges`，`DefenseService.listSieges`），查 `worldId` 下 `attackerId==me || defenderId==me`、`ts` 倒序、上限 100，返回精简 `SiegeSummaryView`（`siegeId/tile/tileLevel?/outcome/role/ts/hasReplay`）。重的重放输入仍按需通过既有 `getSiegeReplay` 单场拉取。`hasReplay=seed 存在 && attackerArmy 非空`（廉价结算/扫荡 NPC 的记录不可重放）。
- **客户端**：右上角状态卡 + 行军徽标**下方**新增「战斗录像」徽标（`replayBadgeRect`），点开一个可滚动列表模态（`renderReplayPanel`，复用 `beginScrollList`/`panelButtonIn`），每行显示坐标/等级/攻守/胜负(相对本方)/多久前；可重放行点「复盘并验证」复用既有 `onReplaySiege(siegeId)`，不可重放行标「无录像」。受影响文件：`openapi-world.yml`（`SiegeSummaryView` + `/world/sieges`）、`worldTypes.ts`/`combatDefense.ts`/`combat.ts`/`service.ts`/`httpApi.ts`、`WorldApiClient.listSieges`、`WorldMapContext.ts`/`WorldMapPanels.ts`/`WorldMapInput.ts`、i18n（`world.replays*`/`world.replay.*`）。

#### 4.3.1 攻城回放玩家名（2026-07-17）

> 回放观看已支持在基地旁显示玩家名、底部显示当前视角玩家名（`ReplayMeta.players: {bottom?, top?}`，owner 索引，见 `UI_DESIGN.md` §23）。攻城回放此前只能兜底显示占位（`replay.player1/2`）——本次补上真实攻/防名字。

- **服务端**：`DefenseService.getSiegeReplay` 在返回里新增 `attackerName` / `defenderName`。名字来源同行军 `under_attack` 预警——`WorldCore.meta.getProfile(id).displayName`（`resolveDisplayName` 助手，meta 不可用/查失败→空串）。攻方 `siege.attackerId` 恒为玩家；防守方 `siege.defenderId` 在基地/领地攻城时为玩家，PvE 目标（据点/关卡/无主建筑）缺省→空串。
- **契约**：`openapi-world.yml` 的 `SiegeReplayView` 加 `attackerName`/`defenderName`（均 required string，可为空串）；`worldsvc/src/generated/routes.gen.ts` 与 `client/src/net/openapi-world.ts` 按 codegen 重生成。
- **owner→side 映射**：攻方 = owner0 = bottom，防守方 = owner1 = top（见 `buildSiegeBattle` 注释）。`world.ts:goSiegeReplay` 据此设 `replay.meta = { players: { bottom: attackerName, top: defenderName } }`；空串时 `ReplayScene` 回退到既有占位。

**问题 2：卡牌布阵行军会同时扣/退地图兵力池，制造双重记账。** `startMarch` 对**任何**行军（不分卡牌队伍还是散兵）都会在出征时 `$inc:{troops:-troops}`（`troops`=队伍全部卡牌 HP 之和），到达/扑空/驱逐/围攻失败等分支又统一走 `refundTroops(pw, survivors)` 把存活值加回 `playerWorld.troops`；与此同时卡牌胜负结算（`computeCardStateUpdates`）**又单独**把同一批存活值写回 `cardState.{id}.currentTroops`。等于同一次战斗的存活兵力被记了两遍账（一份进地图池，一份留在卡上），且卡牌队伍出征凭空临时"占用"了一段与之无关的地图兵力池容量。

- **修复（拍板规则）**：卡牌布阵（`army` 含 `cardInstanceId` 的行军）**全程不触碰 `playerWorld.troops`**——出征不扣、到达不管输赢/扑空一律不退。卡牌的兵力只活在 `cardState.currentTroops` 这一份账本里：分配（`distributeTroops`，从 `baseTroopStock` 转入）→ 出战消耗/结算存活（`computeCardStateUpdates`）→ 移出队伍销毁 + 退 80% 训练资源（`setTeams`，已有行为不变）。**分配给某张卡的兵力永远不会回到 `playerWorld.troops` 这个地图兵力池，唯一的"释放"路径是把该卡移出队伍**（销毁兵力、退部分训练资源，不是退兵）。
- 非卡牌行军（散兵占地/增援/扫荡/侦查、以及无布阵的裸攻击）行为不变，继续用现有的 `playerWorld.troops` 扣/退模型。
- 受影响文件：`combatMarch.ts`（出征扣减按 `hasCardArmy` 分支跳过）、`combatSiege/arrival.ts` + `combatSiege/occupation.ts`（所有 `refundTroops` 调用按 `hasCardArmy` 分支跳过，含扑空/驱逐早退分支）；`combatShared.ts` 的 `refundTroops` 函数本身不变（继续服务非卡牌路径）。

### 4.4 行军疲劳（远征战力惩罚，2026-07-21）

> 用户拍板：讨伐远距离敌人对自己天然不利，需要一个数值机制体现这一点。
>
> **命名说明（2026-07-22 审计）**：本节中文名从"行军士气"改为"行军疲劳"，避免与 [§6.4 卡牌"士气加成"](CHARACTER_CARDS_DESIGN.md)（`(currentTroops/troopCap)×0.2` 的出战 ATK 加成）撞名——两者是完全不同的机制（一个是距离惩罚，一个是满编加成），代码内部字段/函数名（`morale`/`MARCH_MORALE_MAX`/`moraleCombatMultiplier`）不受影响，仅中文叙述改名。

- **规则**：每支行军（`MarchDoc`）出征时获得满额疲劳值 `MARCH_MORALE_MAX=100`，每移动一格消耗 1 点，抵达时的剩余疲劳值 = `100 - 路径格数`（下限 0）。**绑定行军实例，不绑定队伍**——每次出征都从满额重新开始，不与该队伍上一次出征的结果延续。
- **战力惩罚**：抵达后的战斗力按剩余疲劳值线性缩放，疲劳值 100 → 100% 战力，疲劳值 0 → `MARCH_MORALE_COMBAT_FLOOR=70%` 战力（`moraleCombatMultiplier`，`server/shared/src/slg/march.ts`）；覆盖所有需要战斗的行军类型（`attack`/`occupy`/`sweep`，含驱逐 `applyOccupationExpulsion`），`reinforce`/`return` 不涉及战斗，疲劳值记录但不生效。
- **架构约束（本期不做的部分）**：行军在服务端不是逐格 tick 的实时模拟——出征时一次性算好完整 A\* 路径并只调度一个到达事件（`combatMarch.ts` `startMarch`/`processDueArrivals`），中途没有"停留"状态。因此**「原地不动每 30 秒回复 1 点」这条回复机制在当前架构下没有天然的触发点**（每次出征本就从满额开始），本期不实现；疲劳值消耗按路径长度一次性算好存在 `MarchDoc.morale`，供到达结算读取。
- **实现**：`marchMoraleFromPath(path)` 在出征时算好存入 `MarchDoc.morale`（`server/shared/src/slg/march.ts` + `combatMarch.ts`）；到达结算时 `moraleCombatMultiplier(morale)` 缩放攻方有效兵力/军队 HP（`combatSiege/arrival.ts` 的 `applySiege`/`applyStrongholdSiege`/`applyCrossingSiege`/`applySweep`、`combatSiege/occupation.ts` 的 `applyOccupy`/`applyOccupationExpulsion`），廉价公式（`resolveSiege`）与真实引擎战斗（`runSiegeBattle`）两条结算路径都吃这个缩放，保持一致。未暴露到 `MarchView`/openapi 契约（客户端本期不展示疲劳值）。

### 4.1 连地占领（硬性规则，ADR-039，2026-07-14）

> **用户拍板**：三战「连地」是核心规则之一，不是软性效率加成——**占领/围攻目标格必须与本宗门已占领地相邻**，否则无法发起。

- **判定范围 = 宗门级，不是家族级**：宗门下所有成员家族的领地**并集**共同构成"连地前沿"——只要目标格与宗门内**任一**家族已占领的格子相邻（4 方向），任一成员就可以发起占领/围攻，不要求发起人自己的家族恰好挨着。理由：首府/桥栈道是宗门层面的战争目标，判定钉死到单个家族会让宗门内部协调变得没必要地繁琐；连地范围共享也让"抱团"从口号变成机制（呼应 §4 "为什么必须加家族"）。
  - 未加入家族的玩家：只认自己已占领的格子（主城落地即视为初始领地，不存在"第一块地怎么占"的鸡生蛋问题）。**"主城即初始领地"由 `mainBaseTile` 推出的 3×3 footprint 保证**（连地判定 + 行军寻路都吃这个），不依赖 8 个 ring 格是否带 `ownerId`——否则早期未给 ring 写 ownerId 的历史存档基地会"连自己主城旁的空地都占不了"（详见 DECISIONS ADR-039 核心规则 5）。
  - 已加入家族但宗门未成立：连地范围=家族全体成员领地并集（不强制要求先建宗门才能连地扩张）。
  - **盟友宗门的领地不计入连地判定**——结盟只是互不攻伐 + 桥栈道通行（§8.2），不合并版图；否则会让"结盟"变相等价于"合并宗门"，破坏宗门作为竞争单位的边界。
- **适用目标一视同仁**：普通领地/资源点/险地/州府/桥栈道的占领与围攻均须满足连地判定（§3.1 各行已标注）——首府/桥栈道不豁免，否则"连地才有意义"这条规则本身就会被绕过（凭空跳打州府会让"为什么要一格格打过去"的前线叙事失效）。**扫荡（`sweep`，中立点一次性打劫不占地）不受限**——它不改变领地归属，不涉及"抢地盘"。（侦查 `scout` 本身自 2026-07-21 起服务端整体禁用，见下方"当前状态"说明，此规则暂无实际适用对象。）
- **服务端强制点（`worldsvc`）**：`startMarch` 的 `occupy`/`attack` 分支在发起时校验（`WorldCoreVision.isConnectedToSectTerritory`，4 方向邻接查询，源集合 = 宗门全体成员家族的 `playerWorld.accountId` 并集拥有的 `TileDoc`）；到达时在 `applySiege`/`applyOccupy` 再校验一次（宗门领地可能在行军途中因丢地而断连，断连按"扑空"处理——退还部队 + 推送 `recalled`，与既有的"目标已非敌方所有"重校验同一套模式）。不满足 → `TERRITORY_NOT_CONNECTED`（400）。
- **客户端预过滤（`WorldMapInput`，2026-07-14）**：中立格弹出菜单里的 **占领** 按钮在不连地时**置灰**（`showModal` 的 `disabled` 态；点它弹 `world.err.notConnected` 提示而非直接发起），避免"点了才被服务端 400 拒"——等距投影下一块隔行的空地视觉上就贴着主城，玩家极易误判。**仅对单人玩家（无 `familyId`）启用**：服务端连地算"自己家族 ∪ 同宗门兄弟家族"，但客户端只给自己家族的格子打 `mine`/`ally` 标志，兄弟家族领地无客户端标志，无法可靠判"不连地"——故有家族的玩家一律不预禁用（保留按钮、交服务端校验），杜绝误禁用合法扩张。占领/围攻仍以服务端校验为准，此处纯 UX。**扫荡不置灰**（本就不须连地）。
- **侦查（scout）当前状态（2026-07-21 起，2026-07-22 审计核实仍成立）**：本节及本文档其余处提到的"侦查"均为**目标模型**描述——服务端 `combatMarch.ts` 目前对 `kind==='scout'` 的行军请求直接拒绝（`NOT_IMPLEMENTED`），客户端已同步移除所有侦查入口（菜单按钮不出现，而非出现后报错）。根因（"行军中的队伍被误拉去侦察"的用户反馈）尚未查明，功能暂时整体下线，底层结构保留待恢复。详见 memory `slg-scout-march-disabled-2026-07-21`。
- **前沿高亮（`WorldMapRenderer.renderOccupyFrontier` + `occupyFrontier.ts`，2026-07-14，三战/率土式）**：地图上把与自己/家族领地**共边**、且可占领的中立空格描绿边（`overlayGfx` overlay，L1/L2 才画）。这是"连地=共边"这条规则的**根治性呈现**——之所以会有"看着相邻却占不了"的困惑，是因为格子本质是正方形（只有 4 个共边邻居），但等距投影把它画成菱形后，只共**顶点**的对角格被摆到屏幕正上/下/左/右，看着像紧挨着。三战/率土同样是斜 45°菱形、同样 4 向共边连地，之所以没这个问题，就是因为它把领地画成连续色块 + 明确高亮可扩张前沿，让"共边"一眼可见而非靠肉眼在投影里估。前沿计算是纯函数（`occupyFrontierCells`，含单测），描边仅取自己 `mainBaseTile` footprint + `mine`/`ally` 瓦片（同宗门兄弟家族前沿客户端不可见，故不描——但这是加法式提示，不描≠禁止，按钮仍在、服务端仍校验）。
- **为何是 4 向共边而非 8 向含对角（已拍板，2026-07-14）**：正方形格子只有 4 个共享一条边的"相邻"格，另 4 个对角格只碰一个顶点。连地取共边（几何正确、前线干净、与三战/率土一致）；曾考虑放宽到 8 向"看着挨着就算"，否决——那会让版图斜向渗透、封锁墙可斜绕，且"相邻"定义含糊。正解是保持 4 向 + 前沿高亮把共边关系画清楚（见上条）。
- **权衡（已知取舍，接受）**：先手/占据资源密集区的宗门扩张会更快滚雪球，弱势宗门可能被彻底堵死在外圈——但一个大区真正对抗的宗门通常只有两三个，连地规则逼着弱势方要么被兼并要么结盟，而不是绕开前线偷家，符合"明确前线 + 解释为何要夺关键城池"的设计目的。

---

## 5. 战斗接入（承重墙）

> **⚠️ 攻防模型已升级（[DECISIONS ADR-026](../DECISIONS.md)，2026-07-02）**：主城/关卡/城池/据点统一为**建筑血量 + 逐队守军波次 + 攻城值延迟结算**。要点：①每建筑有血量（主城 `maxHp = level × SLG_BASE_HP_PER_LEVEL`）；②守军 = 在城且未受伤的 `teams[]`（t1→t5 逐队上阵，攻方存活兵力跨波延续），在外行军的队跳过；③攻方清光守军或本无守军 → 胜后挂 5min → 按队伍「攻城值」（队内卡之和）扣建筑血量；④战败守军受伤 10min 不参战；⑤血量归零 → 攻占（主城=passiveRelocate）。下方 §5.1/§16 的「单场确定性围攻」是本模型的**单波实现底座**（每一波仍是一场确定性引擎战），波次编排/血量/延迟结算/受伤为 ADR-026 新增层。
>
> **攻城值 = 逐卡属性（任务 #8 已实现）**：每张卡有 `CardDef.siegeValueBase`（DRAFT，按定位差异化：盾兵/坦克 14 > 步兵 11/Max 12 > 弓手/Mara 8，目录均值 ≈ 10 以保血量节奏），`cardSiegeValue(card)` 逐级 `×(1+0.1(lv-1))`；队伍攻城值 = `teamSiegeValue(army, cardInv)` 逐卡求和（缺卡回退统一值）。**数值 DRAFT，待经济核验**。
>
> **NPC 单场围攻基地血量随等级缩放（2026-07-17，方案 2，见 [DECISIONS ADR-026](../DECISIONS.md) 细化条 + [LOG §29](SLG_DESIGN_LOG.md)）**：上面的分波 + `TileDoc.hp` 是**玩家主城/领地**路径；**NPC 地块**（占地/驱逐/据点/关口/领地单场）走 `runSiegeBattle`（`destroy_base`），其象征基地血量此前恒为 `BASE_HP=100`，与等级无关——一级地驻军仅 120 却要打 100 血基地，最小占地兵力清完守军也推不平基地（超时判守方胜）。现改为 `npcBaseHp(level)=40×level`（L1=40、L10=400），经 `defenderConfig.defenderBaseHp` 显式传入引擎（`Player.maxBaseHp`）。低级更软（L1 最小取胜 660→300 兵）、高级更硬（L10 1560→2940），与玩家城侧 `baseDurabilityMax(墙等级)` 对称。分波路径不受影响。
>
> **血量/受伤下行 + UI（任务 #8 已实现）**：`WorldTileView.hp/maxHp`（base/territory/stronghold）与 `PlayerWorldView.teamState`（+ 补齐 `cardState/baseTroopStock`）经 `getMe/getMap` 下行（主动查询，无实时推送）。客户端：`WorldMapScene` 地图建筑血条（**仅受损时显示**，绿→琥珀→红）+ 攻击弹窗 `world.buildingHp` 数值；`TeamsScene` 队伍受伤倒计时徽标（复用 `roster.injured`）。**`baseTroopStock` 已于 2026-07-22 并入 `playerWorld.troops`，见 §4.3 训练→分兵闭环说明，此处按当时落地原样保留历史记录。**

### 5.1 围攻 = 确定性引擎打防守 config + 录像（SLG5）

```
进攻发起 → 行军 → 到达目标格 → 触发围攻战
  目标 = 中立/NPC 格      → 扫荡（PvE 形态，系统默认防守，廉价结算/信任客户端，可抽检）
  目标 = 真人领地/驻军格  → 围攻（关键战斗）
       ├─ 真人手操：进攻方实时打这份确定性防守关（保留车道战术乐趣）
       └─ 自动扫荡：碾压级目标用 AISystem 当进攻方全自动结算
  产出：胜负 + 一份 Replay（seed + 进攻方输入流 + 防守 config）
```

- 围攻战本体 = 一个 `GameMode`（如 `'siege'`），防守 config 替代 `LevelDefinition`，由 `WaveDirector`/`AISystem` 驱动防守方。
- 复用 `ReplayInputSource` / `RecordingInputSource`：围攻 = `seed + 进攻方输入流 + 防守 config`，完全可序列化、可回放、可复算。

### 5.2 战力注入引擎

- 战斗是技术型（纯数值不自动赢），战力经既有 `buildXxxBlueprints` 缝注入：
  - **蓝图 buff**：HP / 伤害 / 速度（养成科技/装备）→ `buildSiegeBlueprints(slg养成)`。
  - **经济 buff**：起始 ink / ink 上限 / ink 回复（建筑/科技）。
  - **阵容**：更多/更强卡、更高建筑上限。
  - **军队规模**：进攻方携带的兵力 = 这一战的「预算」（携带越多，能出的兵越多）。
- `buildSiegeBlueprints` 与 `buildCampaignBlueprints` 同一注入口；**天梯 `buildPvpBlueprints` 不接养成（SLG7 红线）**。

### 5.3 复算（SLG11）

- **关键战斗（必复算 + 留录像）**：占领/丢失真人领地、家族战、攻打有真人驻军的格子。`worldsvc` 调 `judgeRunner` 复算结果再落地（领地易主、掠夺入账）。
- **非关键（信任客户端 / 廉价数值结算，可抽检）**：扫荡自己领地、清中立 NPC、碾压级目标自动战。
- 阈值（何为「碾压级」可跳过手操/可信任）后期调参。

### 5.4 占领行军 = PvE 战斗 + 占领倒计时（2026-07-13，`feat/occupy-march`）

> `MarchKind='occupy'` **一直存在**（S8-2 起）；本节升级的是它到达时的结算行为——从"直接判定未被占用即瞬间落地"改为"打一场 PvE 战斗，胜后再挂一段占领倒计时"，不是新增行军类型。

- **动机**：ADR-032 把 `resourceDensity` 提到 1.0（§3.2）后，地图上已经没有真正的空地——每个非阻挡/非险地/非州府格都有等级即有 `npcGarrison(level)` 系统驻军（§3.1「中立点/NPC 格按等级有系统默认防守」）。旧的 `combatMarch.ts` 占领到达分支只检查"格子是否已被别人占"，从不打这份系统驻军，等于把 §3.1 表格里"扫荡（PvE，NPC 防守）"的进攻形态跳过了——占领和扫荡应该走同一套系统驻军判定，只是结局不同（扫荡=打完就走+一次性掠夺，占领=打完+长期驻扎）。

- **新流程**：
  ```
  行军出发（复用 findMarchPath/marchDurationFromPath，同 §4）→ 到达目标格
    → 重新校验：世界中心/已被他人占/已是自己领地 → 视为落空，退还部队（原有行为不变）
    → 目标格当前被他人「占领倒计时中」（contestedBy≠自己）→ 5.4.3 驱逐战
    → 否则：查 npcGarrison(proc.level)（与扫荡同一权威来源，§3.1）
        garrison ≤ 0（理论上因 resourceDensity=1.0 不会出现，仅作防御性兜底）→ 直接瞬占，跳 5.4.2
        garrison > 0 → 用 §16 同一套确定性引擎 `runSiegeBattle`（`synthesizeArmy` 生成双方阵型，`seed = siegeSeedFromId(marchId)`，与围攻同源可回放）：
          攻方胜 → 生还部队（`attackerSurvivors`，§16.5「生还折回，阵亡永久损失」同规则）**不立即落地**，转入 5.4.2 占领倒计时
          攻方败 → 生还部队退回兵力池（`refundTroops`，用生还数不是原始行军数，随 §16.5 常规败退处理一致）；格子仍为中立
    → `recordSiege`/`pushSiege` 记一场战报（与扫荡/围攻共用同一战报管线，客户端战报列表/推送无需新增分支即可看到胜负）
  ```

- **5.4.1 数值占位**：`OCCUPY_HOLD_SEC = 5 * 60`（新增于 `shared/src/slg/core.ts`，紧邻 `PROTECTION_SEC`/`GARRISON_PER_TILE`），**DRAFT**，数值待经济核验/实机体验后调整。命名/时长与 ADR-026 的 `SLG_SIEGE_DAMAGE_DELAY_MS`（同为 5 分钟）呼应但语义不同：那是"攻城值到点扣血"，这是"占领到点正式落地"。

- **5.4.2 占领倒计时（沿用 ADR-026 延迟结算范式）**：胜方**不会**立刻写 `TileDoc.ownerId`——参考 ADR-026「攻城值延迟结算」的架构：新增小集合 `occupations`（`OccupationDoc`，`_id`=目标 tileId，一格同时至多一份待结算记录），字段含 `ownerId`（待占领人）/`garrison`（生还驻军，占领落地后成为该格驻军）/`dueAt`（=胜利时刻 + `OCCUPY_HOLD_SEC*1000`）。同时把 `contestedBy`/`contestedUntil`/`contestedGarrison`/`contestedFamilyId` 写进该格 `TileDoc`（格子仍无 `ownerId`，只是"标了个待定占领人"），供 `WorldTileView` 下行渲染"占领中，倒计时 Xs"。调度沿用 `WorldCorePush` 既有 best-effort Redis ZSET + Mongo `dueAt` 索引扫描双保险模式（新增 `scheduleOccupation`/`unscheduleOccupation`，镜像 `scheduleSiegeDamage`/`unscheduleSiegeDamage`），接入 `scheduler.ts` 同一个 2s tick（新增 `processDueOccupations`，与 `processDueArrivals`/`processDueSiegeDamage` 同批 `Promise.allSettled`）。到点结算：原子 `findOneAndDelete` 认领 `OccupationDoc` → 校验该格 `TileDoc.contestedBy` 仍等于这份记录的 `ownerId`（防止与驱逐战的并发写竞态）→ 写 `TileDoc.ownerId`/`garrison`，清 `contested*` 字段，`recomputeYield`。

- **5.4.3 倒计时期间被驱逐**：占领倒计时中的格子可以被**任何一方**（另一支 occupy 行军，或一支 attack 行军——见下）打断：
  - `attack` 行军原本只能打"已被人占领"或险地/桥栈道 PvE 目标；本次放宽：`toTile` 当前处于 `contestedBy` 占领倒计时中（`ownerId` 仍为空但 `contestedUntil>now`）时，也允许发起 `attack`（`defenderId` 记为 `contestedBy`，沿途照常收到 `under_attack` 推送）。
  - 到达时，攻击方打的是**该格已存活的驻军**（`TileDoc.contestedGarrison`），不是重新查一次 `npcGarrison`——因为原占领方已经用真实部队换下了系统 NPC。
  - 打赢（驱逐成功）→ 取消原倒计时（删除旧 `OccupationDoc` + 反调度），驱逐方的生还部队立即开始**自己的新一轮**占领倒计时（复用 5.4.2 同一段逻辑）。
  - 打输 → 原倒计时不受影响（继续跑到 `dueAt`），驱逐方生还部队退回兵力池。
  - v1 不处理"链式无限驱逐"的极端边界（多支部队同时驱逐/再驱逐）——`OccupationDoc._id` 固定为 tileId（一格同时只有一份），`findOneAndDelete`/`findOneAndUpdate` 的原子认领保证并发下不会重复结算或崩溃，但没有对"驱逐链"做专门的公平性设计。

- **旧版 `TerritoryService.occupyTile()`（S8-1 瞬间占领，`territory.ts`）如何处理**：**保留但标注为内部/测试专用，不再对外暴露真实产品流程**。理由：客户端 `WorldMapInput.ts` 的"占领"按钮已改为调用 `startMarch(kind:'occupy')`（见客户端小节）；生产环境下不再有调用方直接命中 `POST /world/tile/occupy`。保留该方法本体是因为①它是 e2e 测试里搭建"玩家已有领地"前置状态的最快方式（大量既有测试用它铺垫场景，删除会连带重写一批与本次改动无关的测试）；②它本身逻辑（无 NPC 驻军、瞬间落地）恰好对应 5.4「`garrison≤0` 防御性兜底」这一支线的语义，两者保持一致不产生行为矛盾。契约 `openapi.yml`/`openapi-world.yml` 对应端点文档补充一行"内部/测试用途，产品客户端请走 march occupy"的说明；不做 404/移除。

- **契约改动**：`WorldTileView` 新增 `contestedUntil`（占领落地时刻，ms）+ `contestedByMe`（占领倒计时中且待定占领人是当前请求者本人，供客户端区分"我在占"还是"别人在占"）。`MarchView`/推送管线不新增字段——战斗胜负复用既有 `siege_result` 推送（`pushSiege`），占领中/占领完成的格子状态复用既有 `tile_update` 推送（`pushTile`）+ 下次 `getMap`/`getTile` 轮询即可看到 `contestedUntil` 倒计时，客户端不需要新的推送类型。

---

## 6. 养成统一与天梯红线（SLG7）

### 6.1 红线（唯一不可破）

> **天梯 PvP 永远走 `buildPvpBlueprints()`（无养成参），养成对天梯零影响。**
> 硬墙单测（满级 SaveData 喂天梯引擎 → 蓝图逐字等于常量）原样保留，守的就是这条。这是「电竞公平 = 获客钩子」的命根子。

### 6.2 统一（红线之外）

- **PvE 与 SLG 共用一棵养成树**（装备 / 锻造 / 科技）+ 统一产出：PvE 掉的材料 = SLG 材料，PvE 攒的装备直接是 SLG 战力。
- 好处：①PvE 自动获得「加成」（用户要求）；②PvE 成 SLG 的免费 on-ramp + 转化钩子，不需单独设计中间态；③只要天梯隔离，硬墙单测存活。
- 代价：PvE 不再是「对 PvP 零影响的纯单机」，变成「对 SLG 有影响、对天梯无影响」。

### 6.3 服务器权威要求

- 养成既然喂 SLG PvP（真钱相邻、有领地/掠夺利益），**养成全链路必须服务器权威**——复用 `PVE_INTEGRITY_PLAN` 已铺好的方案 B（升级权威迁服务器 + 录像抽检复算），扩展到所有影响 SLG 战力的养成。
- 三套蓝图构造器并存且互不串：`buildPvpBlueprints()`（天梯，无参）/ `buildCampaignBlueprints(养成)`（PvE）/ `buildSiegeBlueprints(养成)`（SLG）。新增 SLG 战力单调性单测（养成↑ → SLG 蓝图战力↑）。

---

## 7. 经济与交易

### 7.1 拍卖行（SLG9，单一交易机制）

> **机制权威已抽出 → [`AUCTION_DESIGN.md`](AUCTION_DESIGN.md)**（交易模型/挂单状态机/定向受拍/反 RMT/A–G 缺口决策）。本节保留摘要，结论以该文为准。

- **可交易品**：**材料与装备**（`scrap / lead / binding` 等 PvE/SLG 统一材料 + 锻造装备）；**赛季资源（粮/铁/木）不可上拍卖行**（赛季性资源季末清零，禁止跨账号流通）。
- **交易流程**：挂单（卖方设物品 + 数量 + 起拍价 + 时长）→ 买方竞拍或一口价 → 成交 + **系统抽 10% 手续费（coin）**。
- **个人交易 = 挂单时指定受拍人**：只有指定账号可拍下（覆盖「点对点定向交易」需求，无需独立转移系统）。
- **计价货币**：**充值 coin**（跨季留存）。禁止以赛季资源或其他体系货币计价，防与天梯/付费体系串味。
- **免费玩家参与路径**：零充值玩家可通过游戏内任务/活动/关卡获得 coin（「最低生活保障」原则，coin 总是不够用但够参与基本交易）；可挂单出售自己打造的极品装备或刷出的材料换取 coin。
- **反 RMT**：10% 高税 + 每日挂单/成交限额 + 部分绑定材料禁挂；异常交易模式进 admin 审计（OPS 复用）。

### 7.2 资源 sink / 变现

- **sink**：练兵（粮）、建筑升级（铁/木）、养成（材料）、行军/加速、拍卖税。
- **变现点**（SLG = 赚钱区）：建造/练兵队列加速、资源包、养成科技直购、家族特权、保护罩/迁城道具、赛季战令。全部走 `commercial` 钱包/充值。
- 铁律延续：金币产出/消耗严控防通胀；SLG 资源是赛季性的（季末清），与跨季金币/养成分层管理。
- **购买频次限制（2026-07-15 拍板，修复缺口）**：核验发现 `SLG_SHOP_ITEMS`（`slg_speedup_*`/`slg_res_*`/`slg_shield_*`）此前**没有任何购买次数上限**——只要币够可无限次购买，等价于满氪玩家可把 §4 econ-sim 城建/练兵节奏（B 轨，免费玩家数天到一月不等）无限压缩为"充值瞬间完成"，差距无上界。补**每日购买次数上限**（`SLG_SHOP_ITEMS[i].dailyLimit`，DRAFT 值：`speedup` 类 10/日、`resource_pack` 类 5/日、`protection`/`battle_pass` 不限——保护罩本身受时长挤占抵消无限购买价值、战令一季只需一次），按 `playerWorld` 内按 UTC 天计数的 `shopPurchaseCounts: Record<itemId, {day:number, count:number}>` 追踪，`buySlgShopItem` 超限抛 `SHOP_LIMIT_REACHED`。**科技直购**（设计里提到的变现点）目前尚未实现为具体商品，暂不在此次修复范围内，留待后续商品定义时一并加限购字段。

### 7.3 赛季经济

- 赛季资源（粮/铁/木 + 赛季存量）季末清空，养成材料/金币/外观跨季留存（SLG4）。
- 拍卖行与赛季解耦，无季末冻结/清算（原「settling 拒挂 + clearWorldOnReset」策略已废弃 2026-07-06，拍卖行是全服养成物品市场，不受任何赛季事件影响，见 [`AUCTION_DESIGN.md`](AUCTION_DESIGN.md) §4.F）。

---

## 8. 家族 / 宗门 / 国家社交（兑现 SOC6-4）

### 8.1 家族

> ⚠️ **架构已更新（ADR-021，2026-06-28）**：家族数据已迁出 worldsvc，改由独立 **socialsvc** 管理（`/social/family/*`）。家族是**全局持久实体**（无 worldId，跨赛季长存）。worldsvc 在 `playerWorld.familyId` 保留只读镜像供地图渲染/连地加成用。家族频道 Redis 宿主也已迁入 socialsvc。本节描述家族在 SLG 中的**行为语义**，CRUD 实现见 [`SOCIAL_SVC_DESIGN.md`](SOCIAL_SVC_DESIGN.md)。

- **建立**：花费 **500 coin**；族长管理成员（≤30 人）。
- **繁荣度**：动态综合评分（领地数 + 成员数 + 每日活跃度如新占领数/战斗场次），长期无人上线则衰减；赛季开始时重置；结算时繁荣度决定奖励档位。
- **族长可建宗门**：繁荣度达中等门槛 + 花费 **5000 coin** 方可创立。
- **家族频道 = N 人群聊**（Redis pub/sub 扇出，宿主在 socialsvc + gateway 多实例广播，兑现 SOC6-4）。
- **家族互助**：捐献（走拍卖行指定受拍人或专用捐献接口）/ 增援 / 代守 / 代打。

### 8.2 宗门

- **组成**：最多 **30 个家族**（≤900 人）。
- **宗门内视野共享**：宗门成员共享侦察视野（地图迷雾对盟友透明）。
- **合纵连横（联盟）**：宗门可与至多 **2 个**其他宗门结盟（3 宗门联盟上限）；盟友间禁止进攻/夺地；**盟友不共享视野**；地图上对盟友土地颜色标记区分。
- **门主继承**：门主主城被攻破 → 主城被动迁移到新位置（见 §3.4，所有玩家通用规则）；**额外**令所有宗门成员损失 50% 当前资源（重大惩罚，城主周围宗门成员有强烈互保动机）。门主职位通过**罢免投票**更换：各家族族长发起，超过 **2/3 族长同意 + 同时提名新门主**方可执行。
- **宗门频道**（Redis pub/sub，✅ 已实现）：宗门内全员广播频道。worldsvc 落库后把消息发到 `GW_PUSH_REDIS_CHANNEL`（`nw:gw:push`，一条带收件人列表），各 gateway 实例订阅后只向本机在线成员扇出（≤900 人不做 worldsvc 端 O(n) HTTP 直推；天然支持多 gateway 横扩，SOC9）。无 Redis → 降级为 gateway client 逐个 HTTP push 兜底；离线成员靠 REST 拉历史（TTL 7 天）。

### 8.3 国家

- **立国**：占领首府即可立国并命名（宗门/家族主导占领后，该首府归属该宗门下的玩家）。
- **国民加成**：己方 Voronoi 区内战斗/产出加成（DRAFT 数值）。
- **赛季结算排名**：按宗门占领首府数量排名；中原首府额外加权奖励。
- **奖励内容**：材料、皮肤、称号（如「十冠王」等连续赛季成就称号）；运营活动叠加额外奖励。

### 8.4 技术基建

- **presence 已按「不假设单实例」设计**，横扩有底子（见 `SOCIAL_DESIGN`）。
- 家族/宗门/国家编制每赛季重置，但 coin/养成/好友关系跨季保留。

---

## 9. 服务端架构（SLG10）

### 9.1 第七进程 `worldsvc`（有状态世界服）

- 职责：地图状态机（格子归属/等级/防守 config/资源/驻军）+ 行军调度 + 围攻触发 + 资源惰性结算 + 关键战斗复算编排（调 `judgeRunner`）。
- **状态权威在 Mongo**（专属库或 meta 库新集合，DRAFT）；**热态/空间索引/行军定时在 Redis**：
  - 行军 = Redis sorted-set 按到达时刻调度（到点触发围攻/占领/增援）。
  - 资源产出 = 读时按时间戳 delta + 仓储上限惰性结算（**不每格 active tick**，省海量算力）。
  - 空间查询（某区域格子/邻接/家族连地）走 Redis 缓存 + Mongo 地理/网格索引。
- **围攻战不经 gameserver（D0）**：防守方恒为离线脚本 config，围攻 = 单人打脚本 = 本地 PvE 跑法（`RecordingInputSource` 录制）→ 上传录像 → `worldsvc` 对关键战斗用 `judgeRunner` 复算落地。无锁步、无第二真人，**gameserver 不参与 SLG**。自动扫荡同理（worldsvc headless 跑或信任客户端 + 抽检）。

### 9.2 与现有进程咬合

| 进程 | SLG 中的角色 |
|---|---|
| **meta** | 账号/养成/家族持久数据权威；SLG 玩法 REST 端点（地图查询/行军/挂单/家族操作经 meta 或 worldsvc，分工 DRAFT） |
| **gateway** | 控制面 WS；SLG 实时推送（行军到达/被攻击告警/家族频道）；**横扩 + Redis account→实例路由** |
| **matchsvc** | 不参与 SLG（SLG 不走 1v1 配对） |
| **gameserver** | **不参与 SLG（D0）**——围攻=单人打脚本，本地 PvE 跑法 + 录像上传，无锁步 |
| **commercial** | SLG 全部变现（加速/资源包/科技直购/战令）走其钱包/充值 |
| **admin** | SLG 运维（异常交易审计/补偿/赛季运营/监控），复用 OPS 基建 |
| **worldsvc（新）** | 世界状态机 + 行军 + 围攻触发 + 权威围攻结算编排 |
| **auctionsvc（新）** | 拍卖行独立服务（端口 18086，全服单实例），与 worldId/SLG shard **无关**；`auctions` 集合不含 worldId，机制权威见 [`AUCTION_DESIGN.md`](AUCTION_DESIGN.md) |

### 9.3 Redis 入场（兑现 M22）

- gateway 横扩 account→实例路由（频道找在线成员跨实例推送）。
- 家族/宗门频道 pub/sub 扇出。
- worldsvc 行军调度 + 空间热态缓存。

---

## 10. 与现有系统咬合表

| 现有系统 | 咬合方式 | 改动量 |
|---|---|---|
| 确定性引擎 / `GameMode` | 新增 `'siege'` 模式，防守 config 当关卡 | 小（加模式分支） |
| `ReplayInputSource` / `RecordingInputSource` | 围攻 = seed+输入流+防守 config，原样复用 | 零 |
| `AISystem` | 当防守方 AI / 自动进攻方 | 小（复用 + 调参） |
| `buildXxxBlueprints` | 加第三套 `buildSiegeBlueprints(养成)`；天梯不动 | 小 |
| `judgeRunner` / PVE_INTEGRITY 复算 | 关键战斗复算 + 养成权威 | 中（扩展到 SLG） |
| level-editor / `levelSchema` | 防守 config 复用校验 | 小 |
| social（好友/邮件/presence） | 家族升级版 + 群频道（Redis） | 中（群频道新模型） |
| commercial | SLG 全部变现 | 小（加商品） |
| admin / OPS | SLG 运维/审计/赛季运营 | 中 |
| 天梯 PvP / 硬墙单测 | 完全隔离，零改动（红线） | 零 |

---

## 11. 反作弊与信任边界

- **服务器权威段**（不可信客户端）：地图态/领地归属/资源/兵力/养成/钱包/拍卖成交 —— 全在服务器，客户端只读。
- **关键战斗权威**（SLG11，**已按 §16/ADR-007 改**）：关键围攻 = 双方预布兵的确定性自动战斗，**服务器跑引擎算权威结果即时落地**，伪造战报无效。~~（旧：judgeRunner 复算后才落地——已废）~~
- **拍卖行反 RMT**（SLG9）：高税 + 限额 + 禁挂 + 价格护栏（下单硬闸）+ **异常模式离线检测 + admin 审计队列**（§17.13，事后核查合谋倒货）。
- **天梯隔离**（SLG7）：养成/SLG 战力对天梯零影响，电竞公平不被付费污染。

---

## 12. 分期与任务拆分（S8）

> SLG 是 month 级大工程，按可独立验收的切片推进。详细勾选见 `META_TASKS.md` S8 节。

- **S8-0 契约 + shared + worldsvc 骨架 ✅（2026-06-16）**：地图/格子/行军/家族 schema；`worldsvc` 第七 workspace；Redis 接入（gateway 横扩 + 调度）。**部署接线收尾 ✅**：`dev-up.ps1`(八进程 `world`)/`Dockerfile`(八包 build+runtime)/`docker-compose.{prod,ci}.yml`(worldsvc 服务 + `18084:18084` + healthcheck)/`Caddyfile`(`/world,/family,/auction → worldsvc:18084`)/`.env.example`(`NW_WORLD_MONGO_DB`/`NW_WORLD_REDIS_URL`)/`ecosystem.config.cjs`(`nw-world`)/CI(typecheck 八包 + e2e `up --wait` + `curl /health`)。`npm run dev:all` 起八进程，实跑 curl `/health`·`/world/map`·`POST /world/join`·无 token 401 全通。
- **S8-1 地图与领地 ✅（2026-06-16）**：格子状态机、占领、资源惰性产出、驻军、保护罩。worldsvc `service`/`httpApi` 做实 `joinWorld`(主城 base TileDoc + 新手保护罩 + 满兵 + 起步产率 + 容量守卫，幂等)/`occupyTile`(直占 territory：先结算资源→扣 `GARRISON_PER_TILE`→写 TileDoc→重算 `yieldRate`；校验越界 `OUT_OF_RANGE`/中心/兵力 `NO_TROOPS`/他人主城 `PROTECTED`/他人领地 `TILE_OCCUPIED`，自占幂等)/`abandonTile`(退兵+删格回归程序化+重算)；`shared/slg.ts` 加纯函数 `tileYield()` + `SlgError`；`POST /world/{join,occupy,abandon}`；视图含 `occupied`/`mine`、`getMe` 含 `territoryCount`。e2e 15 例（service 8 + httpApi 7，真 Mongo）。**直占即生效（无行军旅行/围攻）**——夺他人地走 S8-2 march occupy + S8-3 siege；owner publicId 解析待 meta `/internal/profile` 接入。
- **S8-2 兵力与行军 [~]（2026-06-16，行军/调度/到点/推送 ✅；训练队列待）**：worldsvc `startMarch`(occupy/reinforce；**出征即从兵力池扣兵**，`arriveAt=departAt+marchDurationSec`[欧氏距离 ceil × `MARCH_SPEED_SEC_PER_TILE`，双端可算；S8-6.6 改为 A* 路径长度 × `MARCH_SPEED_SEC_PER_TILE`])/`recallMarch`(去程翻**返程腿**，返程耗时=已走时长，到点退兵回池)/`processDueArrivals`(**Mongo `arriveAt` 索引扫描为权威**，跨世界、无 Redis 也正确；`findOneAndDelete({status:marching})` 原子认领+删瞬态文档 → occupy 写 territory TileDoc[garrison=带兵]+重算 yieldRate[到达时已被占/中心→**退兵回池**不夺地]、reinforce `$inc tile.garrison`[兵不回池；目标已非己方→退兵]、return 退兵回池[封顶 troopCap])；`scheduler.ts` `setInterval`(2s)+`unref`+重入守卫；**Redis ZSET `world:{w}:march`(score=arriveAt) 由 `scheduleMarch/unscheduleMarch` best-effort 维护，仅作未来精确唤醒提示，处理逻辑不依赖**（缺 `NW_WORLD_REDIS_URL` 静默降级）；实时推送 `march_update`/`tile_update`（§14.5）经 worldsvc `gatewayClient`(`SlgPushMsg`+`HttpWorldGatewayClient.push` best-effort) → gateway `matchsvcClient.PushMsg`+`Gateway.toServerMsg`+`proto.ts` 编码，owner 定向下发（与 social 共用 `/gw/push`）；`POST /world/march`+`/world/march/{id}/recall` 做实。e2e 22 例（worldsvc，+7 march）+ gateway 10 全绿。**待办**：兵力上限/**训练队列**(`/world/troops/train|speedup` 仍 stub)、attack/sweep 围攻→S8-3、`under_attack` 预警推送、行军列表 GET、client REST codegen + UI。
  - **数值（U6 DRAFT）**：`MARCH_SPEED_SEC_PER_TILE=6`、`OCCUPY_MIN_TROOPS=GARRISON_PER_TILE=500`、`MARCH_MIN_TROOPS=1`。
- **S8-3 围攻战**（⛔ **本条 + S8-3b 描述的「廉价结算 + judge 复算 + 手操复盘」方案已被 §16 / ADR-007 整体作废**；judge siege 路径/录像上传/peer 复算/`siegeLandingFromVerdict` 均已删。现行围攻 = 双方预布兵确定性自动战斗，服务器引擎权威即时落地，见 §16。以下保留作历史）：
  - **引擎 `'siege'` 模式 ✅**（`client/src/game/types.ts`）：机制同 campaign（防守方 = `WaveDirector` 脚本，防守 config = `LevelDefinition`，本地玩家 = 攻方），**仅蓝图源不同** = `buildSiegeBlueprints(pveUpgrades)`（`balance/pveUpgrades.ts`，与 `buildCampaignBlueprints` 同养成树/注入点，独立命名守天梯红线 §6.1）；`GameEngine` 把原 `campaign` 分支广义化为「有 `waveDirector` 即 PvE 形态」覆盖 campaign+siege（蓝图选择/level 设置/出怪/胜负判定），破城 winner=0 → 攻方夺地。
  - **judgeRunner siege 复算 ✅**（`net/judgeRunner.ts`，§5.3）：`JudgeRequest.defense_json`（`transport.proto` +field 8，`npm run proto:gen` 重生）非空 → `runSiegeJudge`：seed + 防守 config(JSON LevelDefinition) + 攻方权威养成快照 + 攻方帧按 siege 跑到终局，winner_side=0=attacker_win（攻方篡改本地状态改不了「这套兵能否在这套防守 config 下破城」）。
  - **worldsvc 围攻编排 ✅（廉价结算）**：`shared/slg.ts` 加 `siegeId`/`resolveSiege`(线性 Lanchester-lite)/`npcGarrison`/`SIEGE_LOOT_RATE`/`SWEEP_LOOT_PER_LEVEL`；`startMarch` 开 `attack`(校验目标他人领地/未保护 + 出征即推 `under_attack` 预警给防守方)/`sweep`(目标无主)；`applyArrival` 到点 `applySiege`（attacker_win+territory→易主+survivors 成驻军+掠夺败方资源+双方产率重算；+base→**不可夺**：守军清零+上保护罩+掠夺+攻方生还回师；defender_win→攻方 committed 全灭+守军减员）/`applySweep`（NPC：胜=缴获+回师退兵，败=兵损耗），写 `sieges` + 推 `siege_result`；`/world/sweep` 别名。
  - **gateway ✅**：`under_attack`/`siege_result` 两 ServerMsg 分支编码（`proto.ts`/`Gateway.ts`/`matchsvcClient.ts`；proto 早有消息 §14.5）。
  - **承重墙取舍**：worldsvc 不引确定性引擎（M12），到点用**廉价线性数值结算**即时落地（§5.3 许可的「非关键/廉价数值结算」路径）；引擎 + judgeRunner 复算（「关键战斗」承重墙）已落地并单测，**S8-3b** 经 worldsvc→gateway `/gw/judge` 接入替代廉价结算 + 录像 `replayRef` + **客户端围攻 UI**（本刀无 PIXI 场景，SLG client UI 无基线）。
  - **S8-3b 客户端落地（C2，2026-06-19，叠加层 B）**：拍板 **B = 廉价结算仍为权威，复盘=反作弊对账层**（非「替代廉价结算」的全权威重构）。新增 `GET /world/siege/{id}/defense`（仅进攻方）返回可玩 `LevelDefinition`；`shared.buildSiegeLevel(config,tileLevel,seed)` 把防守 config 子集（garrison/defenderBuildings/defenderBaseLevel）规整为完整围攻关卡（objective=destroy_base、空波次；无自定义→按格等级派生象征基地防守），`siegeSeedFromId` 为 seed 单一来源——**两端逐字一致**才能确定性复算。客户端攻方在 `siege_result` 弹层点「复盘」→ `GameScene` siege 模式实打 → `resolveSiege` 上传录像。**同时修复** `resolveSiegeWithJudge`：原先把存储的防守子集直接当完整 `LevelDefinition` 传 judge（缺 objective/waves/seed → 复算必崩），现改用 `buildSiegeLevel` 同源构造 `defenseJson` + canonical seed。判负翻转仍未启用（B：仅 log mismatch）。
  - 验证：client tsc + **176 测试**（+7 `test/siege.test.ts`：养成单调性/红线/引擎确定性/judge 复算闭环）+ web 构建；八包 `tsc -b` + **worldsvc 29 e2e**（+6 siege +1 sweep httpApi）+ gateway 10 全绿。
- **S8-4 家族 ✅（2026-06-19）**：家族 CRUD（创建/加入/退出/踢出/角色/解散）、家族频道（落库 + gateway 定向推 `family_msg`）、互助/盟友关隘通行、防守 config。拍板不做家族战（围攻复用 attack/siege）。
- **S8-4b 宗门 ✅（2026-06-20）**：补齐「大区→宗门→家族」三级里此前缺失的宗门层。宗门以**家族**为成员单位，操作须族长代表；`sects`/`sectMessages` 集合 + `families.sectId`。功能：建宗门（5000 coin via commercial，TAG worldId 内唯一）/家族加入退出（≤30 家族）/解散/联盟（双向，各 ≤2 = 3 宗门联盟）/罢免换届（族长投票 ≥⌈家族数×2/3⌉ → 门主转移）/宗门频道（落库，TTL 7 天）。**门主被打惩罚**：门主主城被破 → 全宗门成员资源 -50%（§8.2；主城迁移暂缓）。**大比按宗门**：`settleSeason` 按「宗门→散家族→个人」聚合占国数排名（兑现 §2.1）。`/sect/*` REST + worldsvc 12 e2e。**待办**：~~繁荣度建宗门门槛数值~~（✅ 已拍板 2026-06-22 §14.10 U6 + 已核验 ECONOMY_NUMBERS §13-SLG-E 2026-06-30 CLOSED）；盟友视野标记 + 客户端 UI（S8-9 C6）。
- **S8-4c 宗门频道实时推送横扩 + 主城迁城 ✅（2026-06-20，服务端 + 客户端）**：
  - **宗门频道实时推送（横扩，SOC9 / §8.2 / §8.4）**：worldsvc `gatewayClient.broadcast(recipients, msg)`——Redis 可用 → publish 一条 `{recipients, msg}` 到 `GW_PUSH_REDIS_CHANNEL='nw:gw:push'`（`shared/slg.ts`），各 gateway 实例订阅（`gateway/redis.ts` `connectGatewaySubscriber`）后经 `Gateway.routeBroadcast` **只推本机在线收件人**；无 Redis → 降级逐个 HTTP push 兜底（≤900 人，避免 worldsvc O(n) 直推）。`sectService.sendMessage` 落库后扇出 `sect_msg`（排除发送者，本地回显靠 REST 回包），`sectMemberAccountIds` 跨成员家族汇总收件人去重。proto `SectBroadcast`→`SectMsg`（对齐 FamilyMsg：`sectId/fromPublicId/fromName/text/ts`）；新增 `family_msg`/`sect_msg` 两个 push 分支（gateway `proto.ts`/`matchsvcClient.PushMsg`/`toServerMsg` + worldsvc `SlgPushMsg`）。gateway 读 `NW_GW_REDIS_URL` 订阅（缺省降级，与 worldsvc 共用同一 Redis）。
  - **主城迁城（§3.4 / §8.2，所有玩家通用）**：
    - **主动迁城**：`service.relocateBase(worldId, accountId, x, y)`——花 `RELOCATE_COST=500` coin via commercial，把主城迁到**已被自己完全占领的 3×3 地块中心**（见下方 2026-07-14 规则改动），**保留全部领地**，沿用旧城剩余保护罩（自愿迁城不续）；原地迁城 = no-op 不扣费。`POST /world/relocate`。
    - **被动迁城**：`applySiege` 主城被破分支改为 `passiveRelocate(worldId, defenderId, t)`——`deleteMany({ownerId})` 删玩家全部己方格（旧主城 + **所有领地**，失地强惩罚，不退驻军）→ `pickRandomEmptyTile` 随机选合法空格写新主城（守军 0 + 上保护罩）→ 改 `mainBaseTile` + 重算产率。门主额外仍触发全宗门 -50%（`applySectLeaderPenalty`，叠加）。极端找不到空格 → 仅失地 + 清 `mainBaseTile`。
  - **契约/客户端 ✅**：`openapi-world.yml`（`/world/relocate`）+ `transport.proto`（`SectBroadcast`→`SectMsg`）已改并 codegen（`openapi-world.ts`/`proto/transport.ts`）；`WorldApiClient.relocateBase`；`NetSession.onSectMsg` 路由 `msg.sectMsg`；`WorldMapScene` 中立格菜单加「迁城到此」（确认弹层显花费）+ `doRelocate`；`SectScene.applySectMsg` 实时插入频道（去重）+ `createAppCore.goSectHub` 转发 `onSectMsg`；i18n `world.actRelocate/relocateTitle/relocateConfirm/relocateBtn/relocated` zh/en/de。
  - **部署接线**：gateway 加 `NW_GW_REDIS_URL`（与 worldsvc 同 Redis）+ `ioredis` 依赖；写入 `.env.example`/`dev-up.ps1`/`ecosystem.config.cjs`/`docker-compose.{prod,local}.yml`。
  - 验证：服务端 `tsc -b shared worldsvc gateway` 全绿 + worldsvc **81 e2e**（+主动迁城/迁城校验/宗门频道扇出 3 例，含被动迁城断言改写）；client `tsc --noEmit` 0 错 + **273 测试** + `build:web` 通过。
- **主动迁城规则收紧：只能迁到「已完全占领的 3×3」中心 ✅（2026-07-14，用户拍板）**：
  - **旧规则**（§3.4 初版）：迁到任意合法**空格**（界内/非障碍/未被他人占领），点中立格触发。
  - **新规则**：迁城目标 3×3 九格必须**当前已被自己全部占领**，且**必须点击最中间那块己方地**触发。九格未全占 → 提示「请先占领该地块周围地块」（`world.err.relocateNeedSurround`）。旧主城 9 格按「删除 → 变回中立」处理（用户拍板：不保留、不转普通领地），即迁城会净损失旧主城那 9 格。
  - **服务端**：`coreSpawn.footprintOwnedBy(worldId,ax,ay,mapW,mapH,ownerId)`（`footprintFree` 的反面：要求九格全部属 `ownerId`）；`territory.relocateBase` 去掉「空格/未占领」校验，改为 `footprintOwnedBy` 全占校验，失败抛 `TILE_NOT_OWNED`。旧城 `deleteMany({ownerId,type:'base'})` 删除逻辑不变。
  - **客户端**：`WorldMapInput`——迁城入口从中立格菜单移到**己方地块菜单**（`tile.mine` 且非主城分支）；新增 `footprintAllMine(ax,ay)`（九格 cache 全 `mine`）；不满足则「迁城到此」按钮置灰，点按 toast 提示。`footprintFree` client 辅助 + `proceduralTile` 导入随之移除。
  - **验证**：worldsvc e2e `service.e2e.test.ts` 两条迁城用例改写（成功例改为「直接写入九格己方 TileDoc 后迁城」，因 `TROOP_CAP_BASE/GARRISON_PER_TILE=4` 格 occupy 不够；校验例：空格 / 他人格均 `TILE_NOT_OWNED`）。
- **首次进入系统自动落城 ✅（2026-06-24，用户拍板）**：落城三态归一——**首次进入=系统自动落城**（玩家不再自选坐标）/ 被破=被动随机迁城 / **仅付费迁城可自选位置**。
  - **落点策略（用户拍板：优先靠近家族）**：`service.pickSpawnTile(worldId, accountId)`——① 有家族 → 在同家族成员主城周围逐环（切比雪夫 1..`SPAWN_NEAR_FAMILY_RADIUS=6`）找第一个合法空格（成员顺序 + 同环候选均随机打散，防新人扎堆同一位成员旁，SLG 抱团核心）② 退回外环新手区随机（`pickRandomEmptyTile` 加 `minDr` 参，只取 `dr > SPAWN_OUTER_MIN_DR=0.6` 的外圈，远离中心争夺区）③ 全图随机兜底。新增 `spiralFindEmpty`/`shuffled` 私有辅助；`pickRandomEmptyTile(worldId, minDr=0)` 被动迁城调用不传 minDr → 行为不变。
  - **`joinWorld(worldId, accountId, x?, y?)`**：坐标改为**可选**——公网入口不传 → 走 `pickSpawnTile` 自动选点；仅保留显式坐标供内部/测试手动落点（原校验口径不变）。`joinSeason(season, accountId)` 去掉坐标。
  - **契约/客户端 ✅**：`openapi-world.yml` `/world/join` 去掉必填 `x,y`（重生 `openapi-world.ts`）；`httpApi` `/world/join`、`/world/season/join` 不再收坐标；`WorldApiClient.joinWorld(worldId)`/`joinSeason(season)` 去坐标；`WorldMapScene.loadData` 进图若未落城 → 自动落城 + 居中镜头，`doJoin()` 去坐标（点击空地不再按坐标落城，保留作满员兜底手动重试入口）；i18n `world.joinDesc/confirmJoin/confirmJoinBtn` zh/en/de 改为「系统自动安排落点」。
  - 验证：`tsc -b shared engine worldsvc gateway` 全绿 + client `tsc --noEmit` 0 错 + **366 测试** + `build:web` 通过；`httpApi.e2e.test.ts` 已同步改写（join 不传坐标、捕获服务端落点供后续行军），但本机 Docker 为 Windows 容器模式跑不起 Linux Mongo，worldsvc e2e 未实跑（其余用例传显式坐标走手动路径不受影响）。
  - 备注：全新玩家首次进入通常尚未入家族 → 落「外环新手区随机」；「靠近家族」在玩家已属本区某家族时生效（落点逻辑已就位，为后续家族预分配/重进留接口）。
- **客户端 SLG 社交标签修复 ✅（2026-06-28）**：修复家族/宗门/世界标签「加载中」永不结束 + 生产环境 SLG 标签静默禁用两个 bug。
  - **`WorldApiClient.req` 超时**：原无 `AbortController`——worldsvc 接受 TCP 连接但内部卡住（如 MongoDB 慢查询）时 `fetch()` 永久挂起，`slgLoading=true` 永不清，标签永远转圈。现加 10s `AbortController`；超时后 abort 转 `TypeError`，被 `FriendsScene.loadSLGStatus` catch 捕获，`slgStatus=null`/`slgLoaded=true`，正常显示「暂不可用」。
  - **`worldApi` 空串判断**：`createAppCore.ts` 原写 `worldBaseUrl ? new WorldApiClient() : null`——生产/Docker 环境 `getWorldBaseUrl()` 返回 `''`（同源 nginx 反代，是合法基址但 falsy），导致 `worldApi=null`、`loadSLGStatus` 回调缺失、家族/宗门/世界三标签全部静默显示「无 SLG」。现改为无条件 `new WorldApiClient()`，`''` 基址走同源路由。
- **S8-5 拍卖行**：材料挂单（赛季资源禁挂）/一口价 + 竞拍/指定受拍人/10% 手续费（coin）/每日限额/价格护栏滑窗/绑定禁挂机制（拍卖行与赛季解耦，无季末冻结/清算——原策略已废弃 2026-07-06，见 AUCTION_DESIGN §4.F）+ **装备交易（A）** + **异常交易审计（D，反 RMT，§17.13）** 全 ✅（2026-06-21）。**机制权威见 [`AUCTION_DESIGN.md`](AUCTION_DESIGN.md)**。
- **S8-6 养成统一**：`buildSiegeBlueprints` + PvE/SLG 材料统一 + 服务器权威扩展 + 战力单调性单测。
- **S8-6.5 国家系统**：10 首府固定坐标写入 `shared/slg.ts`、Voronoi 分区计算、立国/灭国状态机、国民加成注入围攻蓝图。
- **S8-6.6 关隘/桥 + A\* 寻路 ✅（2026-06-18）**：
  - **阻挡地形程序化生成**：`TileType` 扩 `'obstacle'`/`'gate'`；`SLG_GEN` 加 `obstacleFreq/obstacleThreshold/obstacleMaxDr/gateFreq/gateThreshold`；`proceduralTile()` 在 `dr ≤ obstacleMaxDr=0.87` 区域用 `valueNoise` 生成 ~12% 障碍 + 极稀疏关隘（`gateThreshold=0.99`）；**角落区（dr > 0.87，玩家落城起始区）永无障碍**。
  - **A\* 寻路**：`shared/slg.ts` 加 `PathCell` 类型 + `findMarchPath()`（4方向 A*，曼哈顿距离启发，`Map`-based g-score 稀疏大地图友好，500k 节点上限）+ `marchDurationFromPath()`（`(path.length-1) × MARCH_SPEED_SEC_PER_TILE`）；`api.ts` 加 `PATH_BLOCKED`(400) 错误码。
  - **关隘通行规则**：`findMarchPath` 中关隘格逻辑——目标格始终可达（用于占领）；中途经过须在 `passableGateKeys` 中（己方已占领的关隘；盟友通行 S8-4 pending）；障碍格永远阻挡（含作为目标格）。
  - **worldsvc 接入**：`service.ts` 去掉 `marchDurationSec`，改用 `computeMarchPath()`（预取所有 `type:'gate'` TileDoc → 组装 `passableGateKeys` → 调 `findMarchPath`，无路 → `PATH_BLOCKED` 400）；`startMarch` 用 `marchDurationFromPath(path)*1000` 计算 `arriveAt`；`joinWorld`/`occupyTile`/`startMarch` 加障碍格/关隘格校验（`BAD_REQUEST`）。
  - **测试**：`worldsvc/test/pathfinding.test.ts`（纯单测：同格/越界/无障碍路径/4方向邻接/角落无障碍/marchDurationFromPath）；`march.e2e.test.ts` 全部 `marchDurationSec` 替换为 `mv.arriveAt` / `findMarchPath` 期望值，兼容 A* 曼哈顿距离。`siege.e2e.test.ts` 无需修改（横向路径 Manhattan=Euclidean）。
  - **⚠️ 已被 gate→bridge/plankway 迁移取代（2026-07-08）**：`'gate'` 地形类型删除，拆为 `'bridge'`（跨河桥）/`'plankway'`（跨山栈道）两个**可攻占通行建筑**类型。要点：① `proceduralTile` 障碍带整条 obstacle，仅每带保留 1 处 1 格宽穿越（`RING_CROSSING_COUNT_PER_RING`/`RIVER_CROSSING_COUNT_PER_CHORD`=1、`CROSSING_WIDTH_TILES`=1）映射为 bridge/plankway；支脉也各开 1 处；旧 `_worldCityNodes` 的 `gateCity` 自动节点删除。② 通行规则不变（`findMarchPath` 未占领视障碍、目标格豁免；`passableGateKeys` 查询改 `type∈{bridge,plankway}`）。③ 新增守军 `passageGarrison(level)`（`siege.ts`）+ `arrival.ts` PvE 攻城分支：攻占**保留** bridge/plankway 类型并写 `ownerId+familyId`（修复旧 gate「占领后 `type:'gate'` 查不到」的隐藏 bug）。④ 手动放置：地图编辑器加 Carve/Bridge/Plankway 画笔（`mapEdit.ts` 支持 neutral/bridge/plankway 覆盖）。⑤ 资源：删 `terrain_gate.webp`，新增 `building_bridge`/`building_plankway`（暂用 keep/stronghold 占位图，待正式美术）。渲染 client/map-editor 双份镜像。测试 `worldsvc/test/passage.e2e.test.ts`。
  - 验证：`shared` + `worldsvc` 两包 `tsc --noEmit` 全绿（无 `marchDurationSec` 遗留引用）。
- **S8-7 赛季**：大区分配（宗门强弱平衡匹配）/赛季开启/赛季重置（清领地/兵力/繁荣度/国家归属）/结算（按宗门占国数排名/奖励材料皮肤称号）。**→ 可编码实现规格见 §17**（赛季四段式现状盘点 + 7 处代码冲突修正 + settle 发奖/排名落库/reset 原子化/admin 鉴权/繁荣度评分/G6 分配算法）。
- **S8-8 变现 + 运营**：加速/资源包/科技直购/战令（commercial）+ admin 赛季运维。
- **B7 国家/世界公频 ✅（2026-06-22，§6.4）**：同 world 内所有玩家均可发言的公开频道（选项对称家族/宗门/公频三级）。
  - **服务端**：`NationMessageDoc`（`nationMessages` 集合，TTL 7 天，`worldId + ts` 复合索引）；`NationChannelService.sendMessage`（校验 `playerWorld` 入驻 → 落库 → `gateway.broadcast(worldMemberAccountIds, nation_msg)`）+ `getChannel`（分页历史）。`worldsvc/httpApi.ts` 加 `POST /nation/message` + `GET /nation/channel`；`worldsvc/index.ts` 实例化 `NationChannelService` 传入 `startHttpApi`。
  - **广播**：复用 `HttpWorldGatewayClient.broadcast`——Redis 可用 → 一条到 `GW_PUSH_REDIS_CHANNEL`，各 gateway 扇出在线成员；无 Redis → O(n) HTTP push 兜底。`SlgPushMsg` 新增 `nation_msg` 分支（`worldId/fromPublicId/fromName/body/ts`）。
  - **proto / gateway**：`transport.proto` 加 `NationMsg`（field 23）；`matchsvcClient.PushMsg` 加 `nation_msg`；`Gateway.toServerMsg` 加 `case 'nation_msg'`。
  - **错误码**：`api.ts` 加 `NOT_IN_WORLD`(403)——玩家未入驻该 world 时拒绝收发。
  - **发言者昵称权威修正（2026-07-05）**：`sendMessage` 原先直接信任客户端传入的 `senderName`（本地缓存，改名后若本地未及时刷新会残留旧值/登录ID），现改为优先用 `meta.getProfile(accountId).displayName`（服务端 `ensureDisplayName` 权威值，随改名实时同步），仅在 meta 不可用时退回客户端值兜底。客户端 `FriendsScene` 世界频道 Tab 头部新增右上角金币余额显示（`getCoins` 回调 + `drawHeaderCurrency`），每条发言扣 50 金币，方便玩家发言前确认余额。同一 patch 顺带修了宗门频道（`worldsvc/sectService.ts`）+ 家族频道（`socialsvc/familyService.ts`）的同款 senderName 信任问题，统一改走各自的 meta client（`getProfile` / `batchProfiles`）解析权威昵称。三处均补了回归测试（`worldsvc/test/nation-channel.e2e.test.ts` + `sect.e2e.test.ts`、`socialsvc/test/family.e2e.test.ts`）：meta 命中时权威昵称覆盖客户端旧值，meta 未命中/未配置时兜底回退。
  - **gateway 掉线重连自动补订阅**：`gateway/redis.ts` 显式设 `autoResubscribe: true`（ioredis 默认已是，显式便于审计）+ 加 `ready` 事件 log；Redis 重连后自动重订 `GW_PUSH_REDIS_CHANNEL`，期间漏的 push 客户端 REST 拉 `/nation/channel` 历史补全。
  - **发言扣费两处修正（2026-07-06）**：反馈「发言不扣金币」，实为两层各自独立的缺陷：①**服务端曾静默放行**——`sendMessage` 把扣费包在 `if (this.deps.commercial.available)` 里，worldsvc 若没配 `NW_COMMERCIAL_INTERNAL_URL` 则发言免费通过；改为**无条件** `commercial.spend`（与 `city.ts` 速建/恢复等所有金币消耗点一致），commercial 未配置时 `spend()` 抛错 → 发言被拒、绝不落库免费消息（先扣费后落库，扣费失败不产生任何状态）。②**客户端发完不刷新钱包**——世界频道金币在 commercial 服务扣，worldsvc 不碰 metaserver 的 save 镜像，而 HUD 金币读的是本地 `saveManager.get().wallet.coins`，即便真扣了 50 屏上数字也不动 → 看着像没扣。`doSendWorldChat` 成功后新增 `refreshWallet` 回调（`nav/social.ts` 里 `client.getSave()` → `saveManager.adoptServer()`；`GET /save` 会重新把 commercial 权威余额镜像进 save），发言后 HUD 立即反映扣款。回归测试：`worldsvc/test/nation-channel.e2e.test.ts` 补 2 例（有 commercial 恰好扣 50；无 commercial 抛错且不落库）+ `client/test/social-world-chat-wallet-refresh.test.ts`（世界 Tab 的 `refreshWallet` 走 getSave→adoptServer）。
  - **历史脏数据说明**：修复前用公开 ID 当昵称落库的旧消息存在 worldsvc `nationMessages` 集合（服务端），`getChannel` 原样回放，客户端不缓存；这些旧消息 TTL 7 天自动过期，新消息已显示权威昵称。
  - **fix（2026-07-04）**：世界频道发言人昵称曾显示成公开 ID——`nav/social.ts` 的 `playerName` 回调误读了 `PLAYER_PUBLIC_ID_KEY` 而非真实昵称，已改用 `ctx.playerName()`。同时给 `NationMessageDoc`/`NationMessageView`/`WorldChatMessage` 加 `senderPublicId`（`meta.getProfile` 落库快照），`worldChat.ts` 消息行现在可点击打开 `ProfilePopup`；`ProfilePopup` 的公开 ID 行加了点击复制到剪贴板。回归测试：`client/test/social-world-chat-playername.test.ts`（`playerName` 回调不再回退成公开 ID）+ `worldsvc/test/nation-channel.e2e.test.ts` 补 3 例（`sendMessage`/`getChannel` 携带 `senderPublicId` + 旧文档缺字段兜底空串）。
  - 验证：`shared` + `worldsvc` + `gateway` `tsc --noEmit` 全绿。

**MVP 切片建议**：S8-0~3（地图+领地+兵力+围攻战，单服、无家族、无拍卖、无赛季重置）先验证「战斗接大地图」这条承重墙跑通，再叠加家族/拍卖/赛季。

---

## 13. 风险与开放问题

- **R1 工程量与风险最大的是 worldsvc + Redis**：第七进程 + 新有状态基建 + 空间/调度，是 month 级且不确定性最高。MVP 切片先验证承重墙。
- **R2 平衡复杂度**：三套蓝图 + 统一养成 + SLG 专属数值，平衡面变大；硬墙单测 + 战力单调性单测兜底。
- **R3 拍卖行 RMT**：自由市场永远是搬砖温床，税/限额/审计需持续对抗。
- **R4 单服容量与分服规则**：健康容量、并行多服、跨服大比形态仍待定（DRAFT）。**分服选人/归属链已拍板（2026-06-21）= 宗门 > 家族 > 单随**：开服分配大区时，①有宗门 → 整宗门进同一大区；②无宗门有家族 → 跟家族走；③都没有 → 单人随机分配到有空位的大区。保证社交单位（宗门/家族）成员同服可协作。**毕业软过渡（ADR-030，2026-07-03）**：外环新手区（G6 已实现，§20）玩家在赛季末/达阈值迁入正式区时，**整个新手区打包迁入同一新开正式区**（一起毕业、起跑线齐），不散插成熟老区——补掉「保护期一过即被老玩家碾压」的断崖。
- **R5 赛季节奏与重置粒度**：周期长短、重置/留存边界影响留存与变现，需上线后调参。
- **R6 真人手操围攻的在线性**：防守方离线由确定性引擎跑，但「进攻方手操 + 防守方实时反应」不成立（防守恒为脚本）——这是设计取舍（防守=自定义关卡，非实时对抗），需在玩法说明里明确。
- **开放问题**：地图/行军/家族 REST 的 meta vs worldsvc 分工；拍卖计价币种；宗门间大比形态；家族容量。~~资源主题（功能命名 vs 文具皮）~~ ✅ 已定（2026-06-30，见 §3.4）：五种文具主题资源 `ink/paper/graphite/metal/sticker`（墨水/纸张/石墨/金属/贴纸），代码 enum 直接重命名，无独立铜币货币（贴纸=赛季资源）。

---

## 14. 契约设计（S8-0）

> 本节是 S8-0 的契约层设计：进程/库归属、坐标与分服、Mongo 集合、Redis key、proto 推送、REST 端点、shared 常量/枚举/ID/错误码。**`⚠️` = 需拍板或有结构性争议的点，集中列在 §14.9。** DRAFT 值仅占位。

### 14.1 进程与库归属

- 新进程 **`worldsvc`**（第七 workspace，CJS，有状态），专属库 **`notebook_wars_world`**（与 meta/commercial/admin 同模式，独立库隔离）。
- **⚠️ P1 — 玩家面 REST 谁来服务**：现有拓扑是「玩家只触达 meta(REST) + gateway(WS) + game(WS)」。SLG 玩家操作（看地图/行军/挂单/家族）放哪：
  - **(A) meta 代理 worldsvc**（保拓扑：客户端只打 meta，meta 经内部 HTTP 转 worldsvc）——一致但 meta 多一跳、地图轮询压 meta。
  - **(B) worldsvc 自暴露公网 REST**（反代加 `/world/*`、`/family/*`、`/auction/*`）——破"只触达三面"，但地图高频读直连、meta 不背锅。
  - **倾向 (B)**：SLG 地图读频率高，硬塞 meta 不划算；worldsvc 成第四个公网面（REST），鉴权复用 meta JWT（worldsvc 验签即可，不需连 accounts）。**待你拍。**
- **M12 边界**：worldsvc 为「关键战斗复算」import 确定性引擎 = 既有「裁判」例外的延伸（允许）。**⚠️ P2** 见 §14.9（防守 config 校验是否也走引擎侧 `levelSchema`）。

### 14.2 坐标与分服

- 世界 = 一个赛季服（宗门）= 一张 2D 网格地图。坐标 `(worldId, x, y)`，`x/y` int32。
- 确定性 id：`worldId`（如 `s{season}-{shard}`）、`tileId = "{worldId}:{x}:{y}"`。
- **稀疏存储 + 程序化默认**：DB **只存被占领/被改动的格子**；未触碰的中立格由 `worldId` 派生的程序化函数即时算出（类型/资源/等级/默认防守），不落库。这是 scale 的关键。
- **P3 — 地图尺寸 + 程序化分布函数 ✅ 已定案且已实现（2026-07-04，ADR-032）**：见 §3.2。

### 14.3 Mongo 集合（worldsvc 库，权威）

> 写型沿用单文档原子 + `rev` 乐观锁（META_DESIGN §6.3）。

| 集合 | `_id` | 关键字段 | 索引 |
|---|---|---|---|
| `worlds` | `worldId` | `season, shard, status(open/active/settling/closed), mapW, mapH, openAt, resetAt, capacity` | `{status:1}` |
| `tiles` | `tileId` | `worldId, x, y, type, level, ownerId?, familyId?, defenseRef?, resType?, garrison?, protectedUntil?, rev` | `{worldId,x,y}`、`{ownerId}`、`{familyId}` |
| `playerWorld` | `worldId:accountId` | `troops, troopCap, resources{ink,paper,graphite,metal,sticker}, yieldRate{...}, lastTickAt, mainBaseTile, defenseRef, materials镜像?, familyId?, rev` | `{worldId,accountId}`、`{familyId}` |
| `marches` | `marchId` | `worldId, ownerId, fromTile, toTile, kind(attack/reinforce/occupy/sweep/return), troops, departAt, arriveAt, status, rev` | `{worldId,ownerId}`、`{arriveAt}` |
| `families` | `familyId` | `worldId, name, tag, leaderId, memberCount, territoryCount, rev` | `{worldId,tag}` 唯一、`{worldId}` |
| `familyMembers` | `worldId:accountId` | `familyId, role(leader/elder/member), joinedAt` | `{familyId}` |
| `auctions`（在独立 `auctionsvc` 库，非 world 库） | `auctionId` | `sellerId, itemType, item, qty, price, currency, designatedBuyerId?, expireAt, status(open/sold/expired/cancelled), buyerId?, rev`（**不含 `worldId`**——拍卖与 SLG shard 无关） | `{itemType,status}`、`{sellerId}`、`{designatedBuyerId}`；过期由扫描器处理（**非 TTL**）。机制权威见 [`AUCTION_DESIGN.md`](AUCTION_DESIGN.md) |
| `sieges` | `siegeId` | `worldId, attackerId, defenderId?, tile, outcome, replayRef?, recomputed, ts` | `{worldId,ts}`、`{attackerId}` |

- **资源惰性结算**：`playerWorld` 存聚合 `yieldRate`（占领/丢地时更新）+ `lastTickAt`；读时 `resources += yieldRate × dt`，封顶 `RESOURCE_CAP`。**不逐格 tick**。
- **P4（已定 §14.9）**：新 `sieges`（world 库）+ 复用 `replayBlobs` 模式，不跨库依赖 meta `matches`。
- **P5（已定 §14.9）**：防守 config **内嵌** `playerWorld.defense`（主城）/ `tiles.defense`（领地），v1 不建独立集合，多套模板留后。

### 14.4 Redis key schema（首次引入）

| 用途 | key | 类型 | 说明 |
|---|---|---|---|
| 行军调度 | `world:{worldId}:march` | ZSET（score=arriveAt ms） | 到点弹出触发围攻/占领/增援；worldsvc 单点消费 |
| gateway 路由 | `gw:acct:{accountId}` | STRING（实例 id） | 横扩后跨实例定向 push |
| 家族频道 | `chan:family:{familyId}` | pub/sub | 群扇出 |
| 宗门/国家频道 | `chan:sect:{worldId}` | pub/sub | 全服广播 |
| 热格缓存 | `world:{worldId}:tile:{x}:{y}` | HASH（可选） | 热点格读缓存，Mongo 为权威 |
| 视区订阅 | `world:{worldId}:sub:{accountId}` | STRING/HASH | 玩家当前订阅的区域，worldsvc 据此定向推 tile/march 事件（P9） |

> **P6（已定 §14.9）**：空间查询 v1 走 Mongo `{worldId,x,y}` 范围查；Redis 网格分桶缓存（`world:{worldId}:bucket:{bx}:{by}`）仅在出现热点后加，列为后置优化。

### 14.5 proto 新增（`transport.proto`，仅 server→client 推送）

> 与 social 同原则（SOC3）：**SLG 玩家动作走 REST**（行军/挂单/家族/设防），**实时事件走 WS push**；真人手操围攻战本体走既有 game 数据面（`game.proto` 不变）。故只加 server→client。

新增 `ServerMsg` 分支（字段 DRAFT）：
- `march_update`（`marchId, kind, fromTile, toTile, arriveAt, status`）— 自己/可见行军状态
- `tile_update`（`tileId, type, level, ownerId, familyId, protectedUntil`）— 可视区格变更
- `under_attack`（`tile, attackerName, attackerPublicId, arriveAt, troopsHint`）— 被攻击预警
- `siege_result`（`siegeId, tile, outcome, lootSummary, replayRef`）— 围攻结算
- `family_msg`（`familyId, fromPublicId, fromName, text, ts`）— 家族频道
- `sect_broadcast`（`worldId, kind, text, ts`）— 宗门/国家广播
- `world_event`（`kind, payload`）— 赛季事件（开服/结算/大比）

> **⚠️ P7 — 家族频道复用 chat 还是独立**：`family_msg` 与 social `chat_message` 形态相似；复用 chat 模型（把 familyId 当 conversation）省事但群语义（成员动态/历史/已读）不同。倾向独立家族频道模型（Redis pub/sub + 可选落库历史），见 SOC6-4。

### 14.6 REST 端点清单（`openapi.yml`，服务方按 §14.1 P1 定）

```
# 地图与领地
GET  /world/me                      自己在当前世界的状态（playerWorld + 已结算资源）
GET  /world/map?cx&cy&r             视区格子（中心+半径，稀疏+程序化默认合并）
GET  /world/tile/{tileId}           单格详情（含防守摘要）
PUT  /world/defense                 设/改主城或领地防守 config
POST /world/march                   发起行军（attack/reinforce/occupy/sweep）
POST /world/march/{id}/recall       撤军
POST /world/sweep                   扫荡（自己领地/中立 NPC，廉价结算）
# 兵力
POST /world/troops/train            训练（入队，消耗粮+时间）
POST /world/troops/speedup          加速（变现，走 commercial）
# 家族
POST /family                        建家族
GET  /family/{id}                   家族详情+成员
POST /family/{id}/join              申请/加入
POST /family/{id}/leave             退出
POST /family/{id}/donate            互助捐献
GET  /family/{id}/channel?before    频道历史（若落库）
# 拍卖行（已迁至独立服务 auctionsvc，端口 18086，与 worldId/shard 无关；反代 /auction→auctionsvc，见 §14.1 P1 / AUCTION_DESIGN）
GET  /auction?itemType&...          浏览挂单
POST /auction                       挂单（可带 designatedBuyerId）
POST /auction/{id}/buy              一口价/竞拍
POST /auction/{id}/cancel           撤单
GET  /auction/me                    我的挂单/成交
# 赛季
GET  /world/season                  当前赛季/重置时间/大比状态
```

### 14.7 shared 常量/枚举/ID/错误码（`shared/slg.ts`）

- **ID**：`worldId(season,shard)`、`tileId(worldId,x,y)`、`marchId`、`familyId`、`auctionId`、`defenseRef`、`familyMemberId(worldId,accountId)`、`playerWorldId(worldId,accountId)`。
- **枚举**：`TileType`(neutral/resource/territory/familyKeep/center/base/obstacle/bridge/plankway/stronghold；`gate` 已于 2026-07-08 拆为 bridge/plankway)、`MarchKind`、`SiegeOutcome`、`FamilyRole`、`WorldStatus`、`AuctionStatus`、`ResourceType`(ink/paper/graphite/metal/sticker，命名定版 2026-06-30，见 §3.4)。
- **常量（DRAFT）**：`TROOP_CAP_BASE`、`MARCH_SPEED_PER_TILE`、`RESOURCE_CAP`、`RESOURCE_YIELD_BASE`、`PROTECTION_SEC`、`FAMILY_CAP`、`AUCTION_TAX_RATE`、`AUCTION_MAX_LISTINGS`、`AUCTION_DURATIONS`、`GARRISON_PER_TILE`、`SEASON_LENGTH_DAYS`。
- **错误码**（接 `api.ts` + HTTP 映射）：`WORLD_FULL`、`WORLD_CLOSED`、`TILE_NOT_OWNED`、`TILE_OCCUPIED`、`OUT_OF_RANGE`、`NO_TROOPS`、`TROOP_CAP_REACHED`、`PROTECTED`、`MARCH_NOT_FOUND`、`FAMILY_FULL`、`NOT_IN_FAMILY`、`ALREADY_IN_FAMILY`、`AUCTION_NOT_FOUND`、`AUCTION_CLOSED`、`NOT_DESIGNATED_BUYER`、`INSUFFICIENT_RESOURCES`、`AUCTION_LIMIT_REACHED`。

### 14.8 与既有 codegen 管线对齐

- proto：改 `transport.proto` → `npm run proto:gen`（客户端 `net/proto/transport.ts` 重生 + 服务端 protobufjs/手写编码同步，见既有 S1-7/S1-M4 流程）。
- REST：改 `openapi.yml` → 客户端 `npm run rest:gen`（`net/openapi.ts` 重生）。
- shared：`slg.ts` 加进 `shared/index.ts`；mongo 集合工厂 + `ensureIndexes` 扩到 world 库（或 worldsvc 自带 db.ts，参考 commercial/admin）。

### 14.9 已定方案（D0~P9）

> 2026-06-16 定。以下作为 S8 实现基准；只有 §14.10 列的项仍需后续拍板/调参。

| # | 决策 | 落地约束 |
|---|---|---|
| **D0** | **围攻不经 gameserver**：单人打离线脚本 = 本地 PvE 跑法 + 录像上传 + worldsvc 复算关键战斗 | gameserver 不背 SLG 依赖；siege 流程 = 战役 PvE + S1-RP 录像 + judge 复算的组合 |
| **P1** | **worldsvc 自暴露公网 REST**（第四公网面：`/world/*` `/family/*`），复用 meta JWT（仅 `verifyToken` 验签，不连 accounts 库）。**拍卖 `/auction/*` 已迁出至独立 `auctionsvc`（端口 18086，全服单实例，与 worldId 无关），2026-07-06** | 反代加各组路由；拓扑原则更新为「客户端触达 meta + worldsvc(REST) + auctionsvc(REST) + gateway + game(WS)」 |
| **P2** | **worldsvc import 确定性引擎 + `levelSchema`**（M12「裁判例外」延伸）：复算 + 防守 config 校验都走引擎侧 | 绑 `engineVersion`；worldsvc 随引擎版本重构建；防守 config 是引擎 `LevelDefinition` 的受限子集 |
| **P4** | **新 `sieges` 集合（world 库）** + 自带录像存储（复用 `replayBlobs` 模式），客户端经 worldsvc 取回回放 | 不跨库依赖 meta `matches`；录像 opaque bytes，engineVersion 自校验 |
| **P5** | **防守 config 内嵌**（`playerWorld.defense` 主城 / `tiles.defense` 领地），v1 不建独立 `defenseConfigs` 集合；多套模板留后 | §14.3 删 `defenseConfigs` 表，`defenseRef` 改内嵌结构 |
| **P6** | **空间查询 v1 走 Mongo `{worldId,x,y}` 范围查**；Redis 网格分桶缓存仅在出现热点后加 | §14.4 P6 行降级为「后置优化」 |
| **P7** | **家族频道独立群模型**（Redis pub/sub + 可选落库历史），不复用 1:1 chat | 兑现 SOC6-4；与 social chat 共存不混用 |
| **P9** | **动作走 REST / 事件走 push**（沿用 SOC3）；地图读 = REST 视区拉取 + `tile_update` push 增量；客户端按当前视区向 worldsvc **订阅区域**（`POST /world/subscribe?cx&cy&r`） | 视区订阅表存 Redis（`world:{worldId}:sub:{accountId}`→区域），worldsvc 据此定向推 tile/march 事件 |

---

### 14.10 剩余不确定（需后续拍板 / 调参 / 实现期处理）

> §14.9 已把契约结构定死；下面是**真正还没定**的，按性质分三类。

**A. 产品/经济拍板（2026-06-18 第三轮，全部已定）**

- **U4 大区容量 ✅（2026-07-04 复核，ADR-032 废止 2026-06-18 版本）**：**上限 500 活跃玩家/单大区**（`SLG_WORLD_CAPACITY_MAX=500`；`MIN/TARGET/MAX` 三档以 500 为封顶，与代码现状一致）。2026-06-18 曾拍板"~1 万玩家替代 300-500"，但从未落地实现（代码常量、e2e 测试、econ-sim 全部仍按 300-500 人假设跑），本次复核后正式废止该版本，改回并确认 300–500 为真实目标——不是"退回旧值"，是承认那次"升级"从未发生过。
- **U2 地图尺寸 ✅ 已实现（2026-07-04 更新 + 落地，ADR-032）**：**500×500（25 万格）**（替代代码现状 300×300，**不是**从未落地的 1500×1500）。500 玩家 × 人均上限 200 块 5 级+地的目标，反推地图面积需求，详见 ADR-032 与 §3.2。稀疏存储只落被占格不影响存储。
- **U6 程序化分布 ✅（原方案 + 扩展）**：在原 `proceduralTile()` 基础上扩展：增加阻挡地形（山脉/河流约 10–15% 格子，连续地形带）；险地（稀疏强 NPC 战略点）；桥/栈道通行建筑嵌于阻挡带（gate→bridge/plankway 迁移后：每带 1 处自动兜底穿越，其余靠地图编辑器手动放置）；10 首府固定坐标（`CAPITAL_POSITIONS`）。
- **U1 拍卖行计价币种 ✅（2026-06-18 定）**：充值 **coin**；**赛季资源（粮/铁/木）禁挂**，仅材料/装备可交易；系统抽 **10% 手续费**；免费玩家通过任务/活动/关卡赚 coin 参与（最低生活保障原则）。
- **U3 赛季周期 + 大比形态 ✅（2026-06-18 定）**：赛季 **2 个月**；大比 = **大区内宗门占领首府数排名**（非跨服）；中原首府额外加权奖励；奖励材料/皮肤/称号（含连续赛季成就称号如「十冠王」）；运营活动叠加。
- **U5 家族/宗门容量 + 权限 ✅（2026-06-18 定）**：家族 ≤30 人（建立 500 coin）；宗门 ≤30 家族（建立 5000 coin + 繁荣度中等门槛）；联盟 ≤3 宗门；门主换届需 2/3 族长投票 + 提名；门主主城被破 → 全宗门成员资源 -50% + 主城自动迁移。
- **U7 碾压级阈值 ✅（2026-06-18 定）**：满装备玩家 ≈ 碾压 100 个零充值玩家（Lanchester 比值约 100:1）；非关键战斗廉价结算阈值据此设置（DRAFT 具体数值待调参）。
- **U8 防守 config 可编辑范围 ✅（2026-06-18 定）**：可编辑内容 = 玩家已收集的单位和已有的建筑/机关（复用现有兵营/箭塔等），未收集的无法使用；不引入新元素，引擎现有组件即可。

**B. 数值 DRAFT（先占位，上线后调参）**
- **U6** §14.7 全部常量（兵力上限 / 行军速度 / 资源上限与产率 / 保护时长 / 驻军数）；国民加成具体数值（防御加成 % / 产出加成 %）；碾压级廉价结算具体比值。（繁荣度建宗门具体阈值已移出本清单——已拍板+核验，见 §14.10 U6 表 / ECONOMY_NUMBERS §13-SLG-E）

**C. 实现期风险 / 细节（实现时处理，先记着）**
- **U9 engineVersion 耦合**：引擎更新 → worldsvc 须重构建；赛季中途引擎升级如何 pin 版本，保录像/复算一致性（D0+P2 的代价）。
- **U10 防守 config 旋钮接引擎 ✅（2026-06-18）**：三组新旋钮已完整落地——①**garrison（驻军单位）**：`LevelDefinition.garrison[]`（unitType/col/row），siege 模式下构造期在 Top 侧指定行列预置兵，首 tick `emitInitialEvents` 发 `unit_spawned`+`unit_move_start` 事件，单位随即按正常移动系统向 Bottom 行进；②**defenderBuildings（防守建筑）**：`LevelDefinition.defenderBuildings[]`（buildingType/col），放在 `TOP_BUILDING_ROW=17`，首 tick 发 `building_placed(owner=1)` 事件，ArrowTower/Barracks 即刻生效（射程攻击/生产单位）；③**defenderBaseLevel（基地强化）**：`LevelDefinition.defenderBaseLevel`（`0..BASE_UPGRADE_COSTS.length`，2026-07-11 天梯改动后为 0–2），直接设 `topPlayer.upgradeLevel`（跳过 ink 消耗），影响 ink 回复加成。`levelSchema` 三字段全部验证（unitType/buildingType/lane 合法性 + baseLevel 范围随 `BASE_UPGRADE_COSTS.length` 联动）；**天梯红线不动**（仅在 siege 路径生效，pvp/netplay 无 level）；31 新单测全绿；265 全量回归全绿。**遗留一致性修复（2026-07-15）**：`shared/src/slg/siege.ts` 的 `clampBaseLevel()` 在 2026-07-11 那次改动（4级砍3级）后仍硬编码 `Math.min(3,…)`，未跟随 `BASE_UPGRADE_COSTS.length`（=2）同步，导致 tileLevel≥4 的高等级据点攻城会派生非法 `defenderBaseLevel=3` 被 `levelSchema` 拒绝；已改为硬编码 `2` 并加注释标注需与 `engine/campaign/levelSchema.ts` 的 `MAX_BASE_LEVEL` 保持同步（两包无跨包依赖，无法直接 import 常量）。
- **U11 视区订阅推送扇出**：300-500 人地图 `tile_update`/`march_update` 风暴，需节流/聚合（P9 订阅模型的规模化）；密集首府区域尤需注意。（原文按 1 万人量级写，已随 U4 复核降级，风险等级相应降低但机制仍需做）
- **U12 worldsvc 单点 march 调度**：ZSET 到点消费是单点；300-500 人规模下压力显著小于原 1 万人估算，前期单进程可接受，暂不需要选主/分片。
- **U13 多步原子性**：占地/丢地改 `yieldRate` 与读时惰性结算的并发（rev 守卫够不够）；拍卖成交（扣卖方挂存 + 给买方 + 抽税）的跨文档幂等与回滚；门主被打全宗门资源 -50% 的大规模写操作原子性。
- **U14 A\* 寻路性能**：500×500 地图 A\* 最坏情况计算量，需评估是否要路径缓存或分块寻路（阻挡带连续则影响不大；规模远小于曾评估的 1500×1500，风险显著降低）。
- **U15 Voronoi 分区计算**：首府坐标固定后，Voronoi 分区可预计算并缓存（或实时算），每格 tileId 的国家归属查询路径确定（worldsvc 内存缓存 + Mongo 按需）。

---

*本文档为 SLG 设计基准，DRAFT 标注处随实现/调参细化；锁定决策（SLG1~13）非经重新拍板不改。*

> §15 起的收尾清单/功能落地/实现记录/bug 修复已拆分至 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md)（章节号延续本文档编号，未重新编号）。
