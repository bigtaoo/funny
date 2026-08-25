# Notebook Wars — SLG 大世界设计文档（Nivara 版图争霸）

> 创建：2026-06-16。本文件是 SLG 大世界玩法（共享大地图 / 领地 / 兵力行军 / 家族宗门 / 拍卖行经济）的设计基准，随实现推进同步更新。
> 配套阅读：`META_DESIGN.md`（系统/架构总纲，§11 元循环定位）、`world.md`（世界观：宗门-家族版图争霸）、`SOCIAL_DESIGN.md`（家族频道兑现 SOC6-4 + Redis）、`COMMERCIAL_DESIGN.md`（充值/钱包，SLG 变现走它）、`ECONOMY_BALANCE.md`（数值）、`SERVER_API.md`（接口契约）、`META_TASKS.md`（任务进度 S8）。
> 拍板（2026-06-16，用户）：**走最重的率土之滨级共享大地图**；分赛季；交易全走拍卖行（个人交易=指定受拍人）；养成天梯绝对隔离、PvE+SLG 统一一棵树；资源 = 五种文具主题赛季资源 `ink/paper/graphite/metal/sticker`（墨水/纸张/石墨/金属/贴纸，命名定版 2026-06-30，见 §3.4）+ 高阶稀有养成材料。

---


## 分册

本文 2026-08-17 按 500 行约定拆分。**小节编号一律未变**，源码/文档里既有的 `SLG_DESIGN.md §N` 引用照旧有效——按下表找所在分册。

| 内容 | 文件 |
|---|---|
| 开头 ~ Notebook Wars — SLG 大世界设计文档（Nivara 版图争霸） | **本文** |
| §10 与现有系统咬合、§11 反作弊、§12 分期任务、§13 风险、§14 契约设计 | [`SLG_DESIGN_CONTRACTS.md`](SLG_DESIGN_CONTRACTS.md) |

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
| SLG11 | **只有关键战斗（占地/丢地/家族战/打真人驻军）走服务器权威结算**（`runSiegeBattle`，**非** `judgeRunner` 复算，§16/ADR-007 已改）；非关键信任客户端 + 廉价结算（抽检） | 用户拍板；高价值战斗必防伪造（服务器进程内直接算，无需事后复算），低价值省算力 |
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

- **大区**：技术上 = 一个赛季服实例 + 一张独立地图。单大区容量 ~500 活跃玩家（地图 1500×1500，ADR-049 起从 500×500 放大；`SLG_WORLD_CAPACITY_MAX=500`）；超出则开新大区；大区间完全隔离（经济/地图/战斗互不影响）。
- **宗门**：大区内由家族组建的势力，最多 30 个家族（≤900 人）。建立宗门需花费 **5000 coin** + 家族繁荣度达中等门槛。宗门可与至多 **2 个**其他宗门结盟（盟友禁止相互攻击夺地；视野不共享；地图上对盟友土地进行颜色标记）。
- **家族**：宗门内自由组建/加入的小团体（≤30 人）。建立家族需花费 **500 coin**。
- **国家**：占领州府（Capital）即可立国，给国家取名。国家疆域按**角度扇区 + 半径分层**划分（ADR-034：6 出生州 + 3 资源州 + 1 核心州，归属由角度扇区决定，**非 Voronoi/最近点距离**，见 §2.4/§3.1），为本国玩家提供战斗/产出加成；国家土地仍需玩家逐格占领。
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
| 国家/宗门编制（每季重组）；家族的 SLG 归属镜像（`sectId`/繁荣度/活跃度） | coin（跨季留存）/ 家族本体（成员/频道，ADR-021 起持久，见 §8.4） |

> 赛季周期 **2 个月**。重置是变现发动机：战略起跑归零驱动重新肝/充，养成/外观/coin 跨季留存保护投入。**家族自 ADR-021（socialsvc 独立管理）起为跨赛季持久实体，与国家/宗门这两个赛季内概念不同——见 §8.4。**
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

> **散布式「关隘」（`familyKeep`）已删除（2026-08-19，用户拍板）**：本表从来没有"关隘"这一行，但 `proceduralTile` 一直在用平滑 value-noise 阈值撒 `familyKeep` 格——实测在 1500×1500 上占了 **3.29%（74,124 格）**、聚成 472 个连通团块（最大 1,745 格），每格各画一座 `building_keep` 门楼，连成一面砖墙（用户截图"这是一堆什么，看起来真丑"）。核对后它也没有任何独立玩法：通行早已由桥/栈道接管（见上条统一通道机制）、占领方式与普通中立地完全一致、无守军/夺取奖励/加成、连交互文案都没有，实质只是"被强拉到 9 级的资源地 + 城门皮肤"。现已删掉该生成分支（`SLG_GEN.keepThreshold`/`keepFreq`/`keepMinDistRatio` 一并移除），这些格子退化为所在环该有的普通资源地。`familyKeep` 类型保留，但语义收窄为**城池地面**（州府/分级城节点锚点格 + 地图编辑器城池占地）。**⚠️ 2026-08-25 补记（ADR-074）：「锚点格」这个措辞本身就是缺陷所在**——程序化生成确实只刷锚点一格，而 `rasterizeMapEdits` 刷整块 footprint，两路径语义不一致；且 `familyKeep` 在服务端没有任何玩法分支（`validateMarchTarget` 四个 `kind` 分支全无拦截），城内格子可被单人 `occupy`。ADR-074 起语义统一为「整块 footprint 的城池地面，只能攻城、不可占领/清野/驻扎」，详见 [`SLG_CITY_SIEGE_DESIGN.md`](SLG_CITY_SIEGE_DESIGN.md) §1.1-§1.3/§4.1。若日后要做真正的咽喉点玩法，须用逐格 Bernoulli 哈希（照 `strongholdThreshold`）而非噪声阈值。详见 [`SLG_LOG_2026-08.md` 2026-08-19 条](SLG_LOG_2026-08.md)。

> **山/河渲染区分（2026-07-06）**：`obstacle` 仍是**单一不可通行类型**（寻路/占领逻辑不变），但瓦片可带可选 `obstacleKind: 'river'|'mountain'`（`@nw/shared` `core.ts`）纯做美术区分——`proceduralTile` 给折痕岭=山、墨河=河、支脉按奇偶交替；编辑器画笔画的河/山也带此标。渲染端 `terrainTextureName` 有 kind 就用对应贴图，否则回退旧位置哈希。地图编辑器与游戏客户端由此渲染一致，详见 [`design/tools/map-editor/DESIGN.md`](../tools/map-editor/DESIGN.md) §0（2026-07-06 条）。
| **出生地 / 主城** | 玩家不可被永久夺取的本营（**首次进入=系统自动落城**，被打=掠夺资源 + 自动迁移 + 保护罩，不丢主城资格；只有付费迁城才可自选位置）。**真占 3×3=9 格实体**（锚点=中心格；九格一体不可分割；对非城主行军不可穿过=可封路；攻任一格=围攻整城；九格全计入领地/繁荣）——见 [DECISIONS ADR-025](../DECISIONS.md) | 围攻（掠夺；攻九格任一即结算同一场；**建筑血量+逐队守军波次+攻城值延迟结算见 [ADR-026](../DECISIONS.md)**） | 在城且未受伤的 `teams[]` 逐队上阵（t1→t5）；无守军直接判胜扣血 |

### 3.2 地图尺寸与地形布局

- **地图尺寸 ✅ 已实现（ADR-032 定 500，**ADR-049（2026-07-22）放大到 1500×1500**，`shared/slg/core.ts`）**：现 **1500×1500（225 万格）**，对齐主流 SLG 量级、给 10 州环形布局 + PvE 关卡留出余地；容量仍**上限 500 玩家**（`SLG_WORLD_CAPACITY_MAX=500`，见 §14.10 U4）。稀疏落库不受尺寸影响；下游几何全比率制、随尺寸等比缩放。
  > **历史记录**（避免与旧数字混淆，仅留一条指针，其余口径已废止）：曾短暂拍板过 1500×1500/对应 1 万玩家（2026-06-18 "U2 ✅"），但从未真正实现——代码里 `SLG_MAP_W/H` 一直是 300，且 2026-06-30 的经济核验（`ECONOMY_VERIFICATION_LOG.md` §13-SLG-NATION）仍是在未升级的 300×300 上跑的。500×500 是重新核实代码现状后的新定案，不是"恢复旧值"也不是"1500×1500 打折"，详见 ADR-032。
- **地块等级 1–10 ✅ 已实现（ADR-032）**：`SLG_MAP_MAX_LEVEL=10`（对齐三国志战略版真实地块等级上限，调研见 [`SGZ_LAND_REFERENCE.md`](SGZ_LAND_REFERENCE.md)）。**不是** 5（旧代码实际值）也不是 9（与装备/武将卡的 `MAX_LEVEL=9` 混淆过一次，二者无关）。
- **无纯空地 ✅ 已实现（ADR-032）**：取消"中立地不产出"的分级（`resourceDensity` 从 0.34 提到 **1.0**）——除阻挡地形/据点/城池占地（州府·分级城·世界中心，即 `familyKeep`/`center` 那批"城池地面"格）外，所有格子都是某一等级的资源地（散布式关隘已于 2026-08-19 删除，见 §3.1 该条注），呼应"地图上没有真正空地，只是低级地没人要"的设计前提。
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
- **资源格美术（5 母题 × 程序合成 10 级）**：5 种文具母题 AI 涂鸦已出图打包 → `client/src/assets/slg/res_atlas.{png,json}`（帧名 `res_ink/res_paper/res_graphite/res_metal/res_sticker`）；等级（丰度 + 守备强度双轴）、阵营/中立色、等级数字均**运行时程序合成**，不烘进图。出图 prompt / 验收 / 打包管线见 [`design/product/slg-resource-art.md`](../product/slg-resource-art.md)；源图 + 脚本在 `art/slg/slg-map/`。**✅ 地图格渲染接入已落地（2026-06-30，commit `b8b726c0`）**：`client/src/render/atlas/resAtlasLoader.ts`（懒加载图集，未解码时色块兜底）+ `WorldMapScene.drawResMotif`（仅 L1 细节层渲染）——丰度轴按等级 1→4 个母题精灵成簇；守备轴 lv4+ 手绘栅栏框 / lv7+ 加栅栏桩刻度 / lv8–10 红马克笔危险角；母题墨线不 tint。L2/L3 仍走色块占用层（按设计）。**✅ 5 种资源母题全部就位（2026-07-01）**：石墨 `res_graphite` 已更新为合规墨线版（带切面矿石棱块，见 slg-resource-art.md §4）。
- **主城（base）美术（4 等级图 × 3×3 占地 + 程序等级点标）✅（2026-06-30）**：4 张 AI 涂鸦手绘风主城图已出图 → `art/slg/slg-building/`；打包脚本 `art/slg/slg-building/pack_city_atlas.js`（Node.js + sharp，白背景自动裁边，256×256/格，2×2 排布）→ `client/src/assets/slg/city_atlas.{png,json}`（帧名 `city_lv1/lv2/lv3/lv4`）。等级↔图档映射：`city_lv1`=营地帐篷（lv 1-2），`city_lv2`=木栅寨子（lv 3-5），`city_lv3`=石砌要塞（lv 6-8），`city_lv4`=大城堡（lv 9-10）。渲染：`client/src/render/atlas/cityAtlasLoader.ts`（懒加载，未解码时兜底用现有程序化图标）+ `WorldMapScene.refreshCityLayer()`（在 `cityLayer` 容器中为每个可见 base tile 放 3×3 大小精灵，hovering 于 tile pool 层之上）；同 tier 内等级区分：精灵底部程序绘制填/空圆点（最多 3 个，同阵营 ink 色），lv-in-tier=1→○●●，等。L2/L3 主城精灵同样显示（固定 tp 下可见）。

> **每级出图 + 按等级占地 + NPC 城池也画精灵（2026-07-06 用户拍板）**：城池图从"4 档"细化为**每级一张（10 张）**——`getCityTextureForLevel(level)` 先取 `city_l{level}`、回退旧 `city_lv{tier}`（6 张新图 `city_l2/l4/l5/l7/l8/l10` 待出，prompt 见 [`../product/city-image-prompts.md`](../product/city-image-prompts.md)）。**占地按等级递增**：`cityFootprint(level)`=3/5/7/9（Lv1-2/3-5/6-8/9-10；世界中心仍 9×9=顶档），`allCityNodes` footprint 由它派生。`refreshCityLayer` 现在除玩家主城外，也为每个 NPC 城节点（州府/分级城/世界中心）各放一个按 footprint 缩放的城池精灵（地形层，map-wide 可见）。**节点表来源已于 2026-08-19 改为服务端下发**（`POST /world/enter` 的 `cities`，克隆自世界的地图模板），`allCityNodes(worldId)` 退为兜底——设计师在地图编辑器里拖过的城必须连精灵一起挪，且模板地形是按 templateId 的种子生成的，本地按 worldId 重算两头都对不上；详见 [`SLG_LOG_2026-08.md` 2026-08-19 城池节点条](SLG_LOG_2026-08.md)。地图编辑器用同一套函数渲染，所见即游戏内所见（[map-editor DESIGN §0](../tools/map-editor/DESIGN.md) 2026-07-06 条）。注：城池的驻军/耐久数值仍是 §5 待定项，本轮只做视觉。**⚠️ 2026-08-25 更新（[ADR-074](../DECISIONS.md)）：这条「只做视觉」的遗留已被立项补完，机制基准移交 [`SLG_CITY_SIEGE_DESIGN.md`](SLG_CITY_SIEGE_DESIGN.md)**——野外城池升级为有耐久/守军波次/宗门归属的攻城实体，攻打需有宗门，难度靠「回复速度 > 单人输出上限」封死单人。同时该文档记录了本节此前未察觉的两个缺陷：①程序化生成只把**锚点一格**标成 `familyKeep`（`capitalIdxAt` 精确匹配），与 `rasterizeMapEdits` 的「整块 footprint」实现漂移，导致同一座城在编辑器发布的世界和纯程序生成的世界里地形语义不同；②`familyKeep` 在 `validateMarchTarget` 里没有任何拦截，城内格子可被单人 `occupy`（用户 2026-08-25 截图实证）。

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
  - **散兵占地路径移除 + 选队器兵力显示修复（2026-07-17，用户拍板）**：用户报告「队伍 1 里有兵力，占地却提示兵力不足」。根因是**同一操作暴露了两套兵力账本**：选队占地用队伍自身携带兵力（卡牌 `cardState.currentTroops`），而弹窗里保留的「散兵占领（兵力池）」按钮走 flat `playerWorld.troops`——玩家把兵力都分给了队伍/卡牌，散兵池为空，点它必然 `NO_TROOPS`「兵力不足」。拍板：**基地兵营的预备兵只用于"分派给队伍"，与占地无关；占地只认队伍自己携带的兵力**。故：① 删除占地弹窗的「散兵占领」按钮（连带 i18n `world.team.flatOccupy`），占地=纯选队；② 选队器每支队伍显示的 committed 兵力改用与 `CityScene.committedTroops`/`TeamsScene` 一致的算法（卡牌项取 `cardState.currentTroops`，flat 项取 `initialHp`），此前只累加 `initialHp` → 卡牌队伍误显示为 0，加剧了"看起来没兵"的误解；③ `errorMsg` 新增 `SATCHEL_CAP_EXCEEDED → world.err.satchelCap` 映射（此前甩英文原文），队伍携带量超无挎包上限（`SATCHEL_CARRY_BASE=TROOP_CAP_BASE`，当时=2000；2026-07-22 兵力池统一后已改 **10000**，见 `city.ts`/`core.ts`）时给出可行动的中文提示（建/升挎包或减兵）。受影响文件：`WorldMapNet.ts`、i18n（删 `flatOccupy`、加 `world.err.satchelCap`）；`showDeployDialog('occupy')` 已无调用方（仅 reinforce/sweep 仍用）。
  - **选队弹窗只显示可出战队伍 + 编队编辑器迁移到卡牌（2026-07-17，同日追加，用户二次拍板）**：上一条修复几小时后用户仍报告「队伍里有兵，占地却提示兵力不足」——排查发现**真正的根因不在选队弹窗，而在编队编辑器从未接入卡牌系统**。玩家实际使用的编队入口（`TeamsScene` 点击队伍卡 → `DefenseEditorScene` `mode:'attack'`）是 CC-3 卡牌系统上线（2026-07-01）之前的遗留 UI：调色板列的是原始兵种（`CARD_DEFINITIONS` 的 `unitType`），落子时写 `ArmyEntry{unitType, initialHp}`（客户端 25%-100% HP 滑条），**从未产生 `cardInstanceId`**。于是 `combatMarch.ts` 的 `hasCardArmy` 判定对这类队伍恒为 false，退回旧的 `pw.troops < troops`（地图兵力池）闸门——选队弹窗显示的"队伍兵力"是这些 `initialHp` 之和，与真正校验的 `playerWorld.troops` 池子毫无关系，池子不够就必然 `NO_TROOPS`，与队伍本身"看起来有兵"无关。用 e2e 反证过：card army（`cardInstanceId` 全套）即使把 `playerWorld.troops` 清零也能正常占地，说明服务端修复本身没问题，缺口在客户端编辑器一直没跟上。
    - **修复**：① `showTeamPicker` 弹窗改为只列"可出战"队伍——`army` 非空 && 未在行军/占领中 && 携带兵力>0，同时删除弹窗里的「管理队伍」按钮（`WorldMapNet.ts`）；② `DefenseEditorScene` `mode:'attack'` 大改，调色板从原始兵种列表换成玩家的英雄卡牌库（`SaveData.cardInv`，剔除受伤/已在其他队伍的卡，支持翻页），落子写 `ArmyEntry{cardInstanceId, col, row}`（不再写 `unitType`/`initialHp`），一张卡只能上阵一次（重新落子=移动），队伍上限沿用服务端 `CARD_TEAM_MAX_SIZE=12`（原 `MAX_GARRISON=30` 只保留给防守编辑器）；HP 滑条/循环逻辑整体移除，格子下方改显示卡牌 `cardState.currentTroops` 实时兵力。防守模式（`mode:'defense'`，基地/地块驻防）完全不受影响，继续用原始兵种。受影响文件：`DefenseEditorScene.ts`、`WorldMapNet.ts`、`app/nav/world.ts`（新增 `getSave` 回调）、i18n（`world.team.hint`/`noTeamsOccupy` 改写，新增 `world.team.noCards`/`world.team.full`）。回归覆盖：`worldMapOccupyTeamPicker.ui.ts`（补充"仅可战队伍"/"零兵力队伍剔除"用例）+ 新增 `defenseEditorAttackCards.ui.ts`（落子/移动/上限/过滤/存档形状）。
  - **遗留队伍不自动迁移的兜底（2026-07-17，第三次追加，账号 tao 线上复现）**：上一条把**编辑器**迁到卡牌，但**迁移前已存盘的队伍不会被自动改写**——它们的 `army` 仍是旧的 `{unitType, initialHp}` 条目。账号 tao 的 `t1` 正是这种旧队（9 个 `shieldbearer/max/ironclad`，无 `cardInstanceId`，`cardState` 全空），设计总兵力 2160 > `troopCap` 2000 > 地图兵力池，故 `combatMarch.ts:269` 恒抛 `NO_TROOPS`「兵力不足」。三个 UI 误导叠加把玩家推进死胡同：① `TeamsScene`/`CityScene`/选队器都把旧条目的 `initialHp` 计入 committed，旧队看起来"有兵"、能进选队器，选了必失败；② 「Fill All Troops」在没有任何在队卡牌时**仍弹绿色成功提示**（`fillTroopsOk`），玩家以为已分兵实则一张卡没进队（`cardState` 恒空）；③ 没有任何提示告诉玩家旧队已作废。**修复（纯客户端）**：新增共享 `client/src/game/meta/teamTroops.ts`（`isLegacyTeam`/`carriedTroops`），三处 committed 统一改为**只认卡牌 `currentTroops`、旧条目计 0**——旧队因此显示 0、被选队器 `usable` 过滤剔除；`TeamsScene` 队伍卡对旧队显示红框 + 「⚠ 队伍已过期，点击重建」（i18n `world.team.legacyRebuild`）；`doFillTroops` 无在队卡牌时改弹 `world.team.fillNoCards`（红），不再伪造成功。**账号侧**：tao 的 `t1` 已在生产库手工迁移为 9 张自有英雄卡（同格位，`currentTroops` 按各卡上限共 1275，从 `baseTroopStock` 扣，备份见容器内 `/app/tao_t1_backup.json`）以立即解封。受影响文件：`teamTroops.ts`（新）、`TeamsScene.ts`、`CityScene.ts`、`WorldMapNet.ts`、i18n（新增 `world.team.fillNoCards`/`world.team.legacyRebuild`）。回归覆盖：`worldMapOccupyTeamPicker.ui.ts`（旧队剔除用例）+ `teamsScene.ui.ts`（旧队重建提示、Fill 无卡不伪成功）。
  - **占领弹窗补充资源类型/等级 + 建议兵力（2026-07-22）**：点击中立地块弹出的占领确认框此前只有「驻军/坐标」两行，玩家看不到这块地是什么资源、等级多高、大概要带多少兵才够，只能凭经验猜。`WorldMapInput.ts` 的 `onTileClick`（中立地块弹窗构建处）新增两行：地块有 `resType` 时显示「资源 · Lv.等级」（新 i18n `world.resLevel`，三语），恒显示「建议兵力 {n}」（新 i18n `world.recommendTroops`，取值即 `npcGarrison(level)`——与占领战斗实际判定同一权威来源，见 §4.2 上方 ADR-032/DECISIONS.md 421 行），不新造第二套强度估算。
  - **兵营训练档位从 +10/+50 上调到 +100/+500（2026-07-22）**：兵力上限已普遍到万级（§4.1 `SATCHEL_CARRY_BASE` 提到 10000 起），旧的 `+10`/`+50` 档位点满一次训练队列要点几十次。`TROOP_TRAIN_BATCH_MAX`（`server/shared/src/slg/core.ts`）同步从 500 提到 5000，`CityScene.ts` 训练弹窗按钮档位随之调整，详见 `SLG_CITY_DESIGN.md` 对应小节。
  - **`WorldMapScene` 常驻不刷新导致的第五次"队伍有兵却提示无队伍"（2026-07-29，账号 tao 线上复现）**：前四次修复分别堵住了兵力池混淆、旧队未迁移、Fill 假成功等根因，这次是 ADR-044/046（Home Desk/子界面改覆盖层、地图全程不销毁重建）留下的一个新缺口。`WorldMapNet.ctx.me`（含 `cardState.currentTroops`）只在地图 `loadData()` 首次进入时整取一次；City（覆盖层）打开→编队编辑器分兵/`一键补满`→逐层 `onBack` 弹出覆盖层回到地图（`returnToMap`），这条路径只 `hideOverlay()+bindMapNet()`，从未重新拉取 `me`。于是刚分完兵的队伍在 `showTeamPicker` 的 `usable` 过滤（`committedOf(tm) > 0`，见 `teamTroops.ts`）里仍读到分兵前的旧值（通常是 0）——UI 显示队伍已满编，选队占地/攻击却报 `noTeamsOccupy`「No teams yet — go edit a formation」。**注意与 ADR-046 的已知取舍区分**：那条讲的是社交/宗门覆盖层期间 `session.handlers` 改绑造成的 march/tile **实时推送**陈旧，明确"不做返回时强制刷新"是因为那会是一次可见的地图重绘；这里是 `ctx.me` 这份后台数据从未随任意覆盖层关闭而重新拉取，两者是完全不同的陈旧维度，`refreshMe()` 本身也只碰 `ctx.me` + `renderHud()`，不碰 tile/march，不构成"可见重绘"。**修复**：`WorldMapView` 新增 `refreshMe()`（`WorldMapContext.ts`/`WorldMapScene.ts`，委托给已有的 `WorldMapNet.refreshMe()`）。**未做成"所有覆盖层返回都刷新"**——用户核验后拍板：`refreshMe()` 是一次真实网络请求，为了稳定性/服务器负载，只在真正可能改 `cardState`/`troops` 的路径上触发，而不是每次覆盖层关闭都无脑刷；`app/nav/world.ts` 因此拆成两个返回函数：`returnToMap`（原样，`hideOverlay()+bindMapNet()`，供世界聊天/拍卖行——账号维度与 worldId 无关、不碰 `me`——/地块防守编辑器——只改建筑驻军蓝图，`setDefense` 返回 `void`、不涉及 `me`——共用）与新增的 `returnFromCityToMap`（额外调 `view.refreshMe()`，仅 City 的 `onBack` 用它，因为分兵/一键补满这条路径**只**挂在"打开 City → 编队编辑器"这条链路上）。回归覆盖：`world-map-return-refreshes-me.test.ts`（4 例：City 刷新 / 聊天不刷新 / 拍卖不刷新 / 防守编辑器不刷新，锁的是 nav 层"何时调 `refreshMe()`"）+ `worldMapOccupyTeamPicker.ui.ts` 新增两例锁 `WorldMapNet` 层机制本身：一是队伍在 `ctx.me` 陈旧时（`currentTroops:0`）确实从选队器消失、`refreshMe()` 重新拉到真实值后确实重新出现（用 sabotage 验证过——把 `refreshMe()` 改成丢弃返回值不赋回 `ctx.me`，此例真的会红）；二是 `refreshMe()` 对已销毁场景是 no-op（同样 sabotage 验证过移除 `ctx.destroyed` 判断会让此例真的会红）。两层测试合起来锁住"nav 何时触发"与"触发后是否真的生效"，避免只测了调用时机、机制本身被悄悄改坏却测不出来。
  - **选队弹窗按"近→兵多→战力高"排序（2026-08-02，用户拍板）**：此前 `usable` 队伍列表沿用 `getTeams` 原始返回顺序（无排序），玩家要在一串按钮里逐个对比才能挑到最合适的队伍。改为：① 距目标地块的距离（越近越靠前，Chebyshev 距离——`max(|dx|,|dy|)`，与行军耗时 `marchDurationFromPath` 按路径步数计费的口径一致，非直线欧氏距离）；② 距离相同按携带兵力（`committedOf`）从高到低；③ 距离与兵力都相同按战力（各卡 `cardPower(card, equipmentInv)` 之和，与 `CityScene`/`DefenseEditorScene` 卡牌强度排序同一公式）从高到低。**空闲过滤本身不变**（沿用既有 `busyTeamIds` 闸门，行军/驻扎/停留占领/在途派遣中的队伍已被剔除，见上文 §4.2 历次修复）。队伍当前位置：`ctx.stationed` 里该队伍的 own+idle（停留）条目取其 `x,y`；没有则视为仍在主城（`ctx.me.mainBaseTile`）。战力计算需要 `SaveData.cardInv`/`equipmentInv`，故 `WorldMapCallbacks` 新增可选 `getSave?(): SaveData`（`app/nav/world.ts` 的 `showWorldMap(...)` 调用处注入 `() => saveManager.get()`，与 City/编队编辑器一致的取值方式）；测试用 mock 若不提供 `getSave`，战力一律按 0 参与排序（只影响战力这一级 tiebreak，不影响距离/兵力两级）。受影响文件：`WorldMapNet.ts`（`showTeamPicker` 排序）、`WorldMapContext.ts`（`getSave` 回调声明）、`app/nav/world.ts`（注入）。回归覆盖：`worldMapOccupyTeamPicker.ui.ts` 新增 7 例（按距离排序、距离相同按兵力排序、距离兵力都相同按战力排序、驻扎中队伍仍被完全剔除不参与排序、敌方同名队伍槎位不劫持我方队伍的位置判定、卡牌从卡库移除后战力按 0 计不抛错、4 队混合距离/兵力/战力的完整排序），关键用例（敌方同槎位劫持防护、战力 tiebreak）均用 sabotage 反证过——临时去掉对应守卫/tiebreak 代码后测试真的会红，排除了"测了调用但没测效果"的假阳性。

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

- **规则**：每支行军（`MarchDoc`）出征时获得满额疲劳值 `MARCH_MORALE_MAX=100`（归一化上限，非格数），每移动一格消耗 `MARCH_MORALE_MAX / MARCH_MORALE_FLOOR_TILES` 点，抵达时的剩余疲劳值 = `100 - 路径格数 × (100/MARCH_MORALE_FLOOR_TILES)`（下限 0）。**绑定行军实例，不绑定队伍**——每次出征都从满额重新开始，不与该队伍上一次出征的结果延续。
- **ADR-053 修订（2026-07-27）：疲劳耗尽预算改为比率制**——`MARCH_MORALE_FLOOR_TILES = MARCH_MORALE_FLOOR_RADIUS_RATIO(0.35) × 地图半对角线`，不再是原 ADR-047 的绝对格数 `100`。起因：`100 格`是针对旧 500×500 地图（半对角线≈354 格）拍的数，ADR-049 把地图放大到 1500×1500（半对角线≈1061 格）后从未联动重算，design-doc-audit-2026-07 用真实 A*+省份几何核验发现同省内最远单腿距离（中位 534 格）已 100% 触底，梯度对绝大多数非"家门口"场景名存实亡（详见 [`ECONOMY_VERIFICATION_LOG.md` §13-SLG-MARCH](ECONOMY_VERIFICATION_LOG.md)）。改为比率制后当前地图（1500×1500）的 floor 约 371 格，且未来 `SLG_MAP_W/H` 再变化时自动跟着地图尺寸重新缩放，不用每次手动重算——判据复核见 [`SLG_ECONOMY_CHECK.md` §5.5](SLG_ECONOMY_CHECK.md)。
- **战力惩罚**：抵达后的战斗力按剩余疲劳值线性缩放，疲劳值 100 → 100% 战力，疲劳值 0 → `MARCH_MORALE_COMBAT_FLOOR=70%` 战力（`moraleCombatMultiplier`，`server/shared/src/slg/march.ts`）；覆盖所有需要战斗的行军类型（`attack`/`occupy`/`sweep`，含驱逐 `applyOccupationExpulsion`），`reinforce`/`return` 不涉及战斗，疲劳值记录但不生效。
- **架构约束（本期不做的部分）**：行军在服务端不是逐格 tick 的实时模拟——出征时一次性算好完整 A\* 路径并只调度一个到达事件（`combatMarch.ts` `startMarch`/`processDueArrivals`），中途没有"停留"状态。因此**「原地不动每 30 秒回复 1 点」这条回复机制在当前架构下没有天然的触发点**（每次出征本就从满额开始），本期不实现；疲劳值消耗按路径长度一次性算好存在 `MarchDoc.morale`，供到达结算读取。
- **实现**：`marchMoraleFromPath(path)` 在出征时算好存入 `MarchDoc.morale`（`server/shared/src/slg/march.ts` + `combatMarch.ts`），内部按 `MARCH_MORALE_FLOOR_TILES`（`MARCH_MORALE_FLOOR_RADIUS_RATIO × 地图半对角线`，与 `province.ts` 的 `PROVINCE_*_RADIUS_RATIO` 同一套比率制约定）折算每格消耗；到达结算时 `moraleCombatMultiplier(morale)` 缩放攻方有效兵力/军队 HP（`combatSiege/arrival.ts` 的 `applySiege`/`applyStrongholdSiege`/`applyCrossingSiege`/`applySweep`、`combatSiege/occupation.ts` 的 `applyOccupy`/`applyOccupationExpulsion`），廉价公式（`resolveSiege`）与真实引擎战斗（`runSiegeBattle`）两条结算路径都吃这个缩放，保持一致。未暴露到 `MarchView`/openapi 契约（客户端本期不展示疲劳值）。

### 4.5 实时野战遭遇系统（停留/驻扎 + 建筑层，ADR-051，2026-07-24）

> 野外驻扎 v1（2026-07-23，见 [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md)）的 **v2 升级**。完整设计见独立文档 **[`SLG_FIELD_BATTLE_DESIGN.md`](SLG_FIELD_BATTLE_DESIGN.md)**。

- **停留 idle vs 驻扎 garrison**：单一 `stationed` 态拆两态——停留（空闲、可就地占领/再移动、仅本格被动应战）与驻扎（忙碌、守本格+周围8格、主动拦截路过敌军）；**发兵时选定意图**。停留放出忙碌门禁，修复「站在地上却不能就地占领」。
- **实时野战引擎**：位置权威进 Redis（占格索引 + 9格反向索引），行军改逐格步进、路径持久化，三种遭遇（撞停留 / 两行军同格 / 驻扎拦截）合并为一次「踏格检查」，全部走 `runSiegeBattle`，胜方带残兵继续原行动。**注意：本节升级会改动 §4.4「架构约束（本期不做）」所述的「一次性算路径、单一到达事件」模型**——行军将变为逐格步进；疲劳仍按路径长度一次性算好、仅影响战力不影响时长（ADR-047 语义不变）。
- **建筑层（玩家建造）**：`TileDoc.structure` 叠加位——箭塔（踏入9格掉血不拦停、可攻毁）、必拆除阻挡（接入寻路）。只能建己方/家族领地格。
- 分阶段 P1–P5 实现（见设计文档 §7）。

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
- **前沿高亮（`WorldMapRenderer.renderOccupyFrontier` + `occupyFrontier.ts`，2026-07-14，三战/率土式）**：地图上把与自己/家族领地**共边**、且可占领的中立空格标绿（`overlayGfx` overlay，L1/L2 才画）。**画法（2026-08-17 改，用户反馈"太显眼了…要能让玩家一眼看到，但不能太抢夺焦点"）**：淡绿面（alpha 0.13）+ 四角短角标（`drawPolygonCornerTicks`，线宽 `max(1, tp*0.022)`、alpha 0.45、`tickFrac` 0.13），由面承担"是哪几格"、由角标勾出带子走向。旧画法是每格描一整圈粗虚线（线宽 `max(2, tp*0.08)`、alpha 0.9），前沿本就连成片，于是满屏一根贯穿视野的绿绳压过了地图墨线/建筑/行军令牌。这是"连地=共边"这条规则的**根治性呈现**——之所以会有"看着相邻却占不了"的困惑，是因为格子本质是正方形（只有 4 个共边邻居），但等距投影把它画成菱形后，只共**顶点**的对角格被摆到屏幕正上/下/左/右，看着像紧挨着。三战/率土同样是斜 45°菱形、同样 4 向共边连地，之所以没这个问题，就是因为它把领地画成连续色块 + 明确高亮可扩张前沿，让"共边"一眼可见而非靠肉眼在投影里估。前沿计算是纯函数（`occupyFrontierCells`，含单测），描边仅取自己 `mainBaseTile` footprint + `mine`/`ally` 瓦片（同宗门兄弟家族前沿客户端不可见，故不描——但这是加法式提示，不描≠禁止，按钮仍在、服务端仍校验）。
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
> **血量/受伤下行 + UI（任务 #8 已实现）**：`WorldTileView.hp/maxHp`（base/territory/stronghold）与 `PlayerWorldView.teamState`（+ 补齐 `cardState/baseTroopStock`）经 `getMe/getMap` 下行（主动查询，无实时推送）。客户端：`WorldMapScene` 地图建筑血条（**仅受损时显示**，绿→琥珀→红）+ 攻击弹窗 `world.buildingHp` 数值；`TeamsScene` 队伍受伤倒计时徽标（复用 `roster.injured`）。**主城（3×3 base）修正（2026-07-22）**：`tileGraphics.drawHpBar` 画在锚点格所在 tile pool 层，会被覆盖锚点格的 3×3 城市精灵完全挡住 → 受损主城看不到血条。故在 `WorldMapRenderer/city.ts refreshCityLayer` 的城市精灵容器内额外重绘一条血条（`hpbar` 子 `Graphics`，悬于建筑轮廓上方，同样仅 `hp<maxHp` 时显示），覆盖自己/敌方/盟友主城。**`baseTroopStock` 已于 2026-07-22 并入 `playerWorld.troops`，见 §4.3 训练→分兵闭环说明，此处按当时落地原样保留历史记录。**

### 5.1 围攻 = 双方预布兵确定性自动战斗（SLG5，**已按 §16/ADR-007 改**）

> 下方流程图为 §16（2026-06-20）现行模型；旧版「真人手操 / 录像上传复算」双形态已被 §16/ADR-007 整体推翻，仅保留在 §12 S8-3 作历史记录。

```
进攻发起 → 行军 → 到达目标格 → 触发围攻战
  目标 = 中立/NPC 格      → 扫荡（PvE 形态，系统默认防守，廉价结算/信任客户端，可抽检）
  目标 = 真人领地/驻军格  → 围攻（关键战斗）
       └─ 服务器进程内跑确定性引擎：`seed + 攻守双方预布阵`喂给 `runSiegeBattle`，无手操、无进攻方输入流，一次算出唯一权威结果即时落地
  产出：胜负 + 双方存活兵力（`seed+双方布阵`可供客户端本地重播观战，回放能力见 §16.8 未尽事项）
```

- 围攻战本体 = 一个 `GameMode`（如 `'siege'`），防守 config 替代 `LevelDefinition`，由 `WaveDirector`/`AISystem` 驱动防守方；进攻方阵型同样预先给定（`synthesizeArmy` 兜底或真实布阵），无实时输入。
- `runSiegeBattle` 内部仍复用 `ReplayInputSource`（喂空帧）驱动引擎跑到终局，但这只是引擎复用手段——对外不存在「进攻方输入流」这个产出，`seed + 双方布阵`本身就唯一确定结果，无需复算。

### 5.2 战力注入引擎

- 战斗是技术型（纯数值不自动赢），战力经既有 `buildXxxBlueprints` 缝注入：
  - **蓝图 buff**：HP / 伤害 / 速度（养成科技/装备）→ `buildSiegeBlueprints(slg养成)`。
  - **经济 buff**：起始 ink / ink 上限 / ink 回复（建筑/科技）。
  - **阵容**：更多/更强卡、更高建筑上限。
  - **军队规模**：进攻方携带的兵力 = 这一战的「预算」（携带越多，能出的兵越多）。
- `buildSiegeBlueprints` 与 `buildCampaignBlueprints` 同一注入口；**天梯 `buildPvpBlueprints` 不接养成（SLG7 红线）**。

### 5.3 权威结算分级（SLG11，**已按 §16/ADR-007 改**）

- **关键战斗（服务器权威、无手操可跳过）**：占领/丢失真人领地、家族战、攻打有真人驻军的格子。`worldsvc` 进程内直接跑 `runSiegeBattle`（seed+双方预布阵）算出结果——这就是唯一一次计算，不存在「客户端先算、服务器再复算校验」的二段式流程，`judgeRunner` 不参与 SLG。**掠夺/一次性夺城奖励仍然即时**（战斗判定那一刻就转移资源），但**易主本身不再即时**：领地、关口（bridge/plankway，PvE 或 PvP 均同）、据点（stronghold）攻打胜利后都走 §5.4.4/§5.4.5 的占领倒计时，与占中立地同一套延迟落地机制（ADR-062，2026-08-09，2026-08-09 同日订正扩大范围）；主城不受影响——ADR-026 的攻城值延迟结算本来就是同一时长（5 分钟）的延迟落地机制。
- **非关键（信任客户端 / 廉价数值结算，可抽检）**：扫荡自己领地、清中立 NPC、碾压级目标自动战。
- 阈值（何为「碾压级」可走廉价结算）后期调参。

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

- **5.4.4 PvP 攻打真人领地复用同一套占领倒计时（ADR-062，2026-08-09，用户反馈）**：用户报告"攻打其他玩家的地"和"占中立地"体验不一致——PvP 攻城胜利后走的是 §16 旧模型的"即时易主"（`combatSiege/arrival.ts` `landSiege`），弹一个独立的"Siege won!"弹窗；占中立地却是 5.4.2 的倒计时+轻量 toast。拍板：**普通领地格（非主城、非 bridge/plankway 关口）的 PvP 攻打胜利，从"即时易主"改成走 5.4.2 同一套占领倒计时**——胜利那一刻：防守方立刻失去这块地（`ownerId` 清空，`yieldRate` 立即重算，掠夺/战报仍然即时结算不变），但攻击方**同样不会**立刻拿到，而是写 `contestedBy`/`contestedUntil`/`contestedGarrison`，upsert 一份 `OccupationDoc`，5 分钟后 `settleOccupation` 才真正落地 `ownerId`/`yieldRate`/`applyNationChange`——`settleOccupation` 本身不区分"这格以前是中立还是玩家领地"，直接复用，零改动。倒计时期间，原防守方（或任何人）可以对这个"无主但 `contestedBy` 有人"的格子发起新的 `attack`，天然落进 5.4.3 已有的驱逐分支（`applySiege` 顶部 `!target?.ownerId && contestedBy` 判断）——即"PvP 占地也有一个 5 分钟的反打窗口"，不需要为此新增代码。
  - **客户端**：`WorldMapNet.applySiegeResult` 原先只要 `marchKind==='attack'` 就弹"Siege won!"+回放校验的 modal；现在攻方胜利时先看目标格刷新后的 `contestedByMe`——为真（本次胜利只是开了个倒计时，含 5.4.3 的驱逐胜利）则改成跟占领中立地一样的轻量 toast（`world.siegeWinHold`），回放仍可从"Battle replays"列表打开；为假（主城/关口/结构磨血未破防/PvE 据点或关口）则维持原 modal——服务器权威信号，不靠客户端猜测。
  - **地块资源类型显示 bug 一并修复**：调研过程中发现地图图标（`tileGraphics.ts` `motifResType`）和点格信息面板（`WorldMapInput.ts`）都把"显示 `resType`"错误地绑定在"`tile.type==='resource'`"或"落进中立分支"上——但服务器（`core/map.ts` `tileDocView`）从来是"只要 `resType` 存在就下发，不管 `type`"，占领/攻占结算也一直保留 `resType` 字段（`settleOccupation`/`landSiege` 都显式带上）。改成"只要有 `resType` 就画/就显示"，不再要求 `type==='resource'` 或落在中立分支——已占领的地块现在也能看到自己的资源类型+等级。

- **5.4.5 修正 & 扩大范围：游戏里没有任何东西能在战斗胜利后瞬间易主（2026-08-09，用户当场订正 5.4.4）**：用户看完 5.4.4 的初版落地后指出范围定错了——"所有的地或者建筑、城池，战斗胜利之后都需要 5 分钟的占领时间，游戏里没有可以立即占领或易主的东西"，5.4.4 排除关口是错的，应该反过来一起接进占领倒计时。逐个盘点后落地：
  1. **玩家已拥有的关口被 PvP 攻打（`landSiege`）**：不再排除，并入下面第 2 点同一套通用写入。
  2. **PvE 攻打无主关口（`applyCrossingSiege`）、PvE 攻打据点（`applyStrongholdSiege`）**：这两处此前也是秒占（`$set ownerId` 直接落地），现在同样改走占领倒计时；据点的一次性资源/材料奖励仍立即结算（掠夺惯例不变），只有 `ownerId`/`yieldRate`/`applyNationChange` 推迟到落地。
  3. **主城（capital）**：核实后**无需改动**——ADR-026 的"攻城值延迟结算"（`SLG_SIEGE_DAMAGE_DELAY_MS=5*60*1000`，`processDueSiegeDamage`）本来就是同一时长的延迟落地机制（打穿主城守军→挂 5 分钟→才真正扣建筑血量→归零才触发 `passiveRelocate`），只是名字不同、走的是另一套既有管线，语义上早就符合"战斗胜利后 5 分钟才生效"，不需要额外接入占领倒计时框架。
  - **生产代码重构**：原来 `occupation.ts` 私有的 `startOccupationHold`（只服务占中立地/驱逐两处调用点）拆成两个方法：`writeContestedHold`（纯数据写入：格子 contested 字段 + `OccupationDoc` upsert + 可选立即结算防守方 yieldRate；不含推送/战报，供 `landSiege` 这类"自带统一推送尾巴"的调用点直接用，避免重复推送）+ `startOccupationHold`（调 `writeContestedHold` 后再补上占中立地/PvE 据点/PvE 关口这几处共享的"无防守方"推送+战报逻辑）。两者都改成 public（供 `combatSiege/arrival.ts` 里的 `landSiege`/`applyStrongholdSiege`/`applyCrossingSiege` 跨 mixin 调用），入参从只吃"程序化生成的 `ProceduralTile`"放宽成一个通用的 `HoldTileDesc{type,level,resType?}`——因为 PvP 场景下格子的真实 `type`/`level`/`resType` 来自当前 `TileDoc`（可能已偏离生成时的程序化默认值），不能像纯 PvE 场景那样直接现算 `proceduralTile()`。
  - **关口类型在倒计时结算时不丢失**：`OccupationDoc` 新增可选字段 `type?: TileType`（缺省=落地时写 `'territory'`，这是此前唯一行为；仅关口场景显式带上 `'bridge'/'plankway'`）；`settleOccupation` 落地时改成 `type: d.type ?? 'territory'`。`writeContestedHold` 内部按 `desc.type` 是否为 `bridge`/`plankway` 自动决定要不要把这个字段写进 `OccupationDoc`——调用方不用手动判断。倒计时期间格子本身继续显示 `desc.type`（即捕获前的样子，如仍是 `'stronghold'`/`'bridge'`），只有落地那一刻才切换成结算后的类型，与占中立地的既有行为（倒计时中仍显示原始资源格外观）保持一致。
  - **客户端连带修复**：`WorldMapInput.ts` 的 `onTileClick` 里 `tile?.contestedUntil` 判断原来排在 `tile?.type==='stronghold'` 之后——一个正在倒计时中的据点格子 `type` 字段在结算前仍是 `'stronghold'`（见上一条），旧顺序会让它继续弹"攻打 NPC 驻军"的据点菜单，而不是"占领中/可驱逐"菜单。把 `contestedUntil` 分支挪到 `type==='center'`/`'stronghold'` 之前，任何被占领倒计时占着的格子——不管它底下是什么类型——优先展示占领中/驱逐 UI。
  - **已知遗留问题（未修，仅记录）**：`applyOccupationExpulsion` 驱逐一个真实玩家的占领倒计时时，统一走 `startOccupationHold` 内部硬编码的 `recordSiege(m, undefined, 'attacker_win', ...)`——被驱逐者的 accountId 不会记进这场战报的 `defenderId`，战报显示成"无防守方"（跟驱逐一个 PvE 占领没区别）。这是改动前就有的既有行为（`applyOccupationExpulsion` 本身结构这次没变，只是 `startOccupationHold` 被公开化），不是本次改动引入的回归，测试里已用 `siege-hold-expulsion.e2e.test.ts` 的 `expect(expulsionSiege?.defenderId).toBeUndefined()` 记录现状；如果产品上想让"你把谁的占领打退了"在战报里可见，需要另外拍板再改。
- **影响**：`server/worldsvc/src/db.ts`（`OccupationDoc.type`）；`server/worldsvc/src/combatSiege/{occupation.ts,base.ts,arrival.ts}`（`landSiege`/`applyStrongholdSiege`/`applyCrossingSiege` 三处改走占领倒计时，`startOccupationHold`/`writeContestedHold` 重构为公开方法）；`client/src/scenes/worldmap/{WorldMapNet.ts,tileGraphics.ts,WorldMapInput.ts}`；`client/src/i18n/locales/{zh,en,de}.ts`（新增 `world.siegeWinHold`）；`client/test/ui/{worldMapSiegeResultToast.ui.ts,worldMapTileResourceInfo.ui.ts}`；`server/worldsvc/test/{siege,teams,nation-bonus,field-structure-attack,stronghold,passage,card-slg}.e2e.test.ts`（受影响/改写）+ 新建 `server/worldsvc/test/siege-hold-expulsion.e2e.test.ts`（占领倒计时期间反打回收，覆盖此前完全没测过的场景）。

### 5.5 全量 code review 发现的 5 处 worldsvc 问题（2026-08-04）

- **`POST /world/occupy`（S8-1 瞬间占领）仍暴露在公网 HTTP 面**：本节前面（5.4 末尾"旧版 `TerritoryService.occupyTile()`"一条）已经拍板它"内部/测试专用，不再对外暴露真实产品流程"，但 `httpApi.ts` 的路由分支从未真正摘掉这条公网端点——玩家 JWT 仍能直接命中它，绕开 5.4 整套"打一场 PvE 战斗、胜后再挂占领倒计时"的行军流程瞬间落地。已从公网路由表移除（`svc.occupyTile()` 只保留给 e2e 测试直接调用铺垫场景）。
- **`recoverCard`（受伤卡牌花钱秒愈）免费重复刷**：扣费走 `commercial.spend(accountId, cost, orderId, ...)`，`orderId` 幂等去重；原先 `orderId` 只是 `recover:${cardInstanceId}`——同一张卡的每一次恢复都撞同一个 key，`spend` 把重复 orderId 当幂等重放直接返回成功、不再扣费，导致第一次之后同一张卡永远免费恢复。改为 `recover:${worldId}:${accountId}:${cardInstanceId}:${nowMs}`（时间戳保证每次调用唯一）。
- **卡牌行军战力被打成通用兵力数字（本轮最大的一处，也是最初驱动这次 review 的问题）**：围攻结算（`combatSiege/arrival.ts`）里"是否走廉价结算路径"和廉价结算本身用的攻方强度都是 `Math.round(m.troops * moraleMult)`——`m.troops` 对卡牌布阵行军只是队伍携带的卡槽数量级，真实战力活在 `cardState.currentTroops`（已经通过 `resolveCardArmy` 折算进 `attackerArmy` 里）。等于不管卡牌真实等级/装备多强，都被按最低档"合成兵力"打折。改法：先算未按疲劳缩放的 `rawAttackerArmy`（`resolveCardArmy` 或 `synthesizeArmy` 兜底），取其真实 HP 总和 `sumArmyHp(rawAttackerArmy)` 再乘 `moraleMult` 得到 `attackerHp`，用它代替 `m.troops` 参与 `shouldUseCheapSiege`/`resolveSiege`；对非卡牌（flat）行军，`sumArmyHp(rawAttackerArmy)` 与旧的 `m.troops` 恰好相等，行为逐字节不变，只有卡牌行军才受影响。触及 `arrival.ts` 3 处调用点 + `occupation.ts` 2 处调用点。
- **`relocateBase`（主动迁城）缺 rev 守卫**：整段迁城（校验九格己方全占 → 扣 500 金币 → 删旧主城/建新主城 tile → 结算资源写回 `playerWorld`）此前全程没有并发保护，末尾 `updateOne` 是无条件的盲 `$set`——同一账号并发发起两次迁城，或迁城过程中恰好撞上另一次结算（建筑升级/训练 tick），后写入者会把先写入者刚落的 `resources`/`rev` 原样覆盖。改法比照本文件其他站点（`refundTroops`/`transferLoot`）已有的模式：函数一开始先用 `updateOne({_id, rev: pw.rev}, {$inc:{rev:1}})` 原子认领这一代 rev（抢不到直接 `REV_CONFLICT`，不扣费不动格子），末尾资源结算的写回也带上刚认领的 `rev` 做 CAS，失败同样 `REV_CONFLICT`。
- **`startMarch` 出征扣兵 + 围攻/驱逐夺城奖励结算都是盲 `$set`**：`combatMarch/command.ts` 的 `startMarch`（卡牌布阵/idle-redispatch 分支）原先无条件 `$set` 写回 `resources`；改为 `rev`-guarded CAS，失败时（区分"确实兵力不足"vs"纯粹 rev 冲突"各自返回 `NO_TROOPS`/`REV_CONFLICT`）回滚刚插入的行军文档。`combatSiege/arrival.ts` 里"夺取要塞（stronghold）一次性资源奖励"的结算原是读一次快照就无条件写回，改为最多重试 5 次的「每次都重新读取最新 `playerWorld` 再算奖励再 CAS 写回」循环——这段是从调度器（`processDueArrivals`）跑的，不是活的 HTTP 请求，重试耗尽只记错误日志、不抛出（夺城本身已经无条件落地，不能因为这个一次性奖励失败就把夺城结果打回）。
- **回归测试**：`server/worldsvc/test/httpApi.e2e.test.ts`（`/world/occupy` 404）、`server/worldsvc/test/service.e2e.test.ts`（`recoverCard` 第二次收费）、`server/worldsvc/test/card-slg.e2e.test.ts`（卡牌围攻按真实 HP 而非 `m.troops` 结算）、`server/worldsvc/test/stronghold.e2e.test.ts`（并发夺城奖励结算）、`server/worldsvc/test/teams.e2e.test.ts`（`relocateBase` 并发 rev 冲突）。

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
- **宗门内视野共享**：宗门成员共享侦察视野（地图迷雾对盟友透明）。**实现口径收窄记录（DECISIONS §18.6）**：视野共享实际只做到**家族**级（`familyMemberIds`），未扩到整个宗门；宗门内非同家族成员之前甚至在地图上**没有专属颜色**（会被当成敌方渲染），2026-08-08（DECISIONS ADR-060）补上第三档地图色（紫墨 `sectmate`，仍不共享视野），连地判定/驻扎目标/攻击豁免这几处逻辑本就早已按整个宗门算，只是着色一直没跟上。
- **合纵连横（联盟）**：宗门可与至多 **2 个**其他宗门结盟（3 宗门联盟上限）；盟友间禁止进攻/夺地；**盟友不共享视野**；地图上对盟友土地颜色标记区分（黄描边 + 2026-08-08 起额外配琥珀墨底色，DECISIONS ADR-060）。
- **门主继承**：门主主城被攻破 → 主城被动迁移到新位置（见 §3.4，所有玩家通用规则）；**额外**令所有宗门成员损失 50% 当前资源（重大惩罚，城主周围宗门成员有强烈互保动机）。门主职位通过**罢免投票**更换：各家族族长发起，超过 **2/3 族长同意 + 同时提名新门主**方可执行。
- **宗门频道**（Redis pub/sub，✅ 已实现）：宗门内全员广播频道。worldsvc 落库后把消息发到 `GW_PUSH_REDIS_CHANNEL`（`nw:gw:push`，一条带收件人列表），各 gateway 实例订阅后只向本机在线成员扇出（≤900 人不做 worldsvc 端 O(n) HTTP 直推；天然支持多 gateway 横扩，SOC9）。无 Redis → 降级为 gateway client 逐个 HTTP push 兜底；离线成员靠 REST 拉历史（TTL 7 天）。

### 8.3 国家

- **立国**：占领首府即可立国并命名（宗门/家族主导占领后，该首府归属该宗门下的玩家）。
- **国民加成**：己方所属州（角度扇区归属，ADR-034）内战斗/产出加成（DRAFT 数值）。
- **赛季结算排名**：按宗门占领首府数量排名；中原首府额外加权奖励。
- **奖励内容**：材料、皮肤、称号（如「十冠王」等连续赛季成就称号）；运营活动叠加额外奖励。

### 8.4 技术基建

- **presence 已按「不假设单实例」设计**，横扩有底子（见 `SOCIAL_DESIGN`）。
- **宗门/国家编制每赛季重置**；**家族本体跨季持久**（ADR-021 起，家族是 socialsvc 管理的全局实体，无 worldId）——赛季重置只清家族的 SLG 归属镜像（`sectId`/`territoryCount`/繁荣度/活跃度），家族成员关系、频道历史不受影响。coin/养成/好友关系同样跨季保留。

---

## 9. 服务端架构（SLG10）

### 9.1 第七进程 `worldsvc`（有状态世界服）

- 职责：地图状态机（格子归属/等级/防守 config/资源/驻军）+ 行军调度 + 围攻触发 + 资源惰性结算 + 关键战斗权威结算（`runSiegeBattle`，见 §16）。
- **状态权威在 Mongo**（专属库或 meta 库新集合，DRAFT）；**热态/空间索引/行军定时在 Redis**：
  - 行军 = Redis sorted-set 按到达时刻调度（到点触发围攻/占领/增援）。
  - 资源产出 = 读时按时间戳 delta + 仓储上限惰性结算（**不每格 active tick**，省海量算力）。
  - 空间查询（某区域格子/邻接/家族连地）走 Redis 缓存 + Mongo 地理/网格索引。
- **围攻战不经 gameserver（D0，已按 §16/ADR-007 改）**：防守方恒为离线 config，`worldsvc` 进程内直接跑 `runSiegeBattle`（seed+攻守双方预布阵）headless 算出权威结果即时落地——无手操、无客户端录像上传、无 `judgeRunner` 复算这一步。无锁步、无第二真人，**gameserver 不参与 SLG**。自动扫荡同理（worldsvc headless 跑或信任客户端 + 抽检）。

### 9.2 与现有进程咬合

| 进程 | SLG 中的角色 |
|---|---|
| **meta** | 账号/养成/家族持久数据权威；SLG 玩法 REST 端点（地图查询/行军/挂单/家族操作经 meta 或 worldsvc，分工 DRAFT） |
| **gateway** | 控制面 WS；SLG 实时推送（行军到达/被攻击告警/家族频道）；**横扩 + Redis account→实例路由** |
| **matchsvc** | 不参与 SLG（SLG 不走 1v1 配对） |
| **gameserver** | **不参与 SLG（D0）**——围攻由 worldsvc 进程内直接跑权威结算，无锁步、无第二真人 |
| **commercial** | SLG 全部变现（加速/资源包/科技直购/战令）走其钱包/充值 |
| **admin** | SLG 运维（异常交易审计/补偿/赛季运营/监控），复用 OPS 基建 |
| **worldsvc（新）** | 世界状态机 + 行军 + 围攻触发 + 权威围攻结算编排 |
| **auctionsvc（新）** | 拍卖行独立服务（端口 18086，全服单实例），与 worldId/SLG shard **无关**；`auctions` 集合不含 worldId，机制权威见 [`AUCTION_DESIGN.md`](AUCTION_DESIGN.md) |

### 9.3 Redis 入场（兑现 M22）

- gateway 横扩 account→实例路由（频道找在线成员跨实例推送）。
- 家族/宗门频道 pub/sub 扇出。
- worldsvc 行军调度 + 空间热态缓存。

---


---

**接下页** → [`SLG_DESIGN_CONTRACTS.md`](SLG_DESIGN_CONTRACTS.md)：§10 与现有系统咬合、§11 反作弊、§12 分期任务、§13 风险、§14 契约设计。
