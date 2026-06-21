# Notebook Wars — SLG 大世界设计文档（Nivara 版图争霸）

> 创建：2026-06-16。本文件是 SLG 大世界玩法（共享大地图 / 领地 / 兵力行军 / 家族宗门 / 拍卖行经济）的设计基准，随实现推进同步更新。
> 配套阅读：`META_DESIGN.md`（系统/架构总纲，§11 元循环定位）、`world.md`（世界观：宗门-家族版图争霸）、`SOCIAL_DESIGN.md`（家族频道兑现 SOC6-4 + Redis）、`COMMERCIAL_DESIGN.md`（充值/钱包，SLG 变现走它）、`ECONOMY_BALANCE.md`（数值）、`SERVER_API.md`（接口契约）、`META_TASKS.md`（任务进度 S8）。
> 拍板（2026-06-16，用户）：**走最重的率土之滨级共享大地图**；分赛季；交易全走拍卖行（个人交易=指定受拍人）；养成天梯绝对隔离、PvE+SLG 统一一棵树；资源先用 粮食/铁/木材 + 高阶稀有养成材料。

---

## 0. TL;DR

- **SLG = 游戏的最后一块拼图，也是「赚钱区」**：率土之滨级的**共享大地图领土争霸**——一张地图容纳一整个赛季服的玩家，地图上铺满资源点与领地格子，玩家用有限兵力占领、驻守、行军、互攻；兵力守不住全部领地 → **必须加入家族（联盟）/ 宗门（赛季服）抱团** → 社交从「可选」变「刚需」。
- **承重墙（一句话）**：**SLG 围攻战 = 跑确定性引擎打一份「玩家自定义关卡」式的防守 config，产出录像**。复用全部既有战斗基建（确定性引擎 / `ReplayInputSource` / `AISystem` / `buildXxxBlueprints` / `judgeRunner` 复算 / `matches` 归档），战斗内核**几乎零改动**。
- **三定位互不污染**：天梯 PvP = 公平电竞（**永不卖战力**，硬墙单测守住）；PvE = 免费玩家出路；**SLG = 卖战力的赚钱区**（养成战力＝付费战力）。SLG 与天梯**分开匹配、分开榜**。
- **养成统一、天梯隔离**：PvE 和 SLG **共用一棵养成树 + 统一产出**（PvE 攒的装备/材料直接是 SLG 战力，PvE 成 SLG 的免费 on-ramp）；唯一红线——**天梯 PvP 永远走 `buildPvpBlueprints()`（无养成参）**，养成对天梯零影响。
- **第七进程 `worldsvc`**：有状态世界服，管地图状态机 + 行军调度 + 围攻触发；**状态权威在 Mongo，热态/空间索引/行军定时在 Redis**；资源产出**读时惰性结算**（不每格 active tick）。
- **Redis 入场**：SLG 强制引入 Redis（gateway 横扩 account→实例路由 + 家族/宗门频道 pub/sub + 行军调度），兑现 `META_DESIGN §6.7 / M22` 那条 ADR 与 `SOCIAL_DESIGN SOC7 / S6-4`。
- **交易全走拍卖行**：单一机制；个人交易 = 挂单时指定受拍人；高税 + 限额反 RMT。
- **复算只算关键战斗**：占地/丢地/家族战/打真人驻军 = 必复算 + 留录像；扫荡自己领地 / 清中立 NPC / 碾压级目标 = 信任客户端 + 廉价结算（可抽检）。

---

## 1. 锁定的设计决策

| # | 决策 | 理由 |
|---|---|---|
| SLG1 | **走 Heavy 共享大地图**（率土之滨级），不走部落冲突式 Lite 无地图 | 用户拍板；最贴 fiction「版图争霸」；交易/领地/行军/家族连地的核心循环需要共享空间承载 |
| SLG2 | **大区 = 赛季服 = 一张地图实例**（容量 ~1 万活跃玩家，超出则开新大区）；**宗门 = 大区内势力组织**（≤30 家族/≤900 人）；**国家 = 占领首府立国的概念疆域**（Voronoi 分区，10 首府）；**大比 = 大区内赛季结算，按宗门占国数排名** | 大区代替原「宗门服」概念；宗门降为大区内势力；国家系统新增为战略目标与 Voronoi 加成机制 |
| SLG3 | **分赛季（2 个月）+ 周期性重置**：单大区 ~1 万活跃玩家；超出则并行开新大区；宗门由系统按综合实力（历史排名/规模/繁荣度）平衡分配大区，同宗门成员进同一大区 | 赛季制是变现发动机（重肝重充）；能力分组防止强队碾压生态 |
| SLG4 | **赛季重置粒度**：清「领地 / 兵力 / 地图态 / 赛季资源存量」；保「养成（装备/科技/材料）/ 外观皮肤 / 天梯段位 / 账号档案」 | 战略态归零保新鲜感与公平起跑，养成/付费资产跨季留存保护玩家投入与变现信任 |
| SLG5 | **SLG 围攻战 = 确定性引擎打防守 config（玩家自定义关卡形态）+ 录像** | 复用全部既有战斗基建，战斗内核几乎零改动；防守方离线也能被打 |
| SLG6 | **进攻双形态**：①真人手操（保留车道战术乐趣，差异化卖点）②自动扫荡（碾压级/自己领地，省时挂机） | 「攻城能手操的 SLG」是对率土系的差异化；扫荡满足挂机刚需 |
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
大区（赛季服 = 一张地图实例，~1 万活跃玩家）
 └── 宗门（大区内势力组织，≤30 家族；可与最多 2 个其他宗门结盟）
      └── 家族（宗门内联盟，≤30 人；繁荣度达标后族长可立宗门/建国）
           └── 玩家（占领格子 + 有限兵力 + 国籍归属）
宗门间大比 ── 大区内赛季结算，按宗门占领国家（首府）数排名
```

- **大区**：技术上 = 一个赛季服实例 + 一张独立地图。容量 ~1 万活跃玩家；超出则开新大区；大区间完全隔离（经济/地图/战斗互不影响）。
- **宗门**：大区内由家族组建的势力，最多 30 个家族（≤900 人）。建立宗门需花费 **5000 coin** + 家族繁荣度达中等门槛。宗门可与至多 **2 个**其他宗门结盟（盟友禁止相互攻击夺地；视野不共享；地图上对盟友土地进行颜色标记）。
- **家族**：宗门内自由组建/加入的小团体（≤30 人）。建立家族需花费 **500 coin**。
- **国家**：占领 10 首府之一即可立国，给国家取名。国家是概念疆域（Voronoi 分区），为本国玩家提供战斗/产出加成；国家土地仍需玩家逐格占领。
- **宗门间大比**：大区内赛季结束时，按宗门占领国家（首府）数排名结算奖励。

### 2.2 分服与人口（SLG3）

- 一个赛季开启 = 开一个或多个大区实例（地图）。
- 单大区容量 **~1 万活跃玩家**；超出则并行开新大区。
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

- **10 个首府**：地图上固定 10 个首府位置，布局参考三国志战略版（灵犀互娱）九宫格风格：
  - **8 个外围首府**（四角 + 四边中点附近，各带随机偏移避免过于对称）
  - **1 个中原首府**（地图中心）= 赛季额外奖励目标（占领方结算时额外获得材料/皮肤/称号 tier 提升）
  - 共 **9 普通首府 + 1 中原首府 = 10 国**
- **Voronoi 分区**：每格归属离它最近的首府（欧氏距离），固定把地图切成 10 块势力区。首府位置固定，分区边界不变，仅归属国家随首府易主而变化。
- **立国**：占领首府即立国；可给国家取名；该首府 Voronoi 区内的本国玩家获战斗/产出加成。
- **灭国**：A 国占领 B 国首府 → B 国 Voronoi 区加成转给 A 国；B 国玩家国籍丢失（无加成）直到重新占领一座首府立国。
- **国民加成**（DRAFT 数值）：己方 Voronoi 区内防御战斗加成、资源产出加成（具体数值待 S8-1 调参）。

---

## 3. 地图与格子

### 3.1 格子类型

| 类型 | 说明 | 进攻形态 | 防守 |
|---|---|---|---|
| **中立资源点** | 产出某种资源，产率/类型随位置与等级分布；占领后归玩家持续产出 | 扫荡（PvE，NPC 防守，按等级默认布防） | 系统默认防守 config（按格子等级） |
| **玩家领地** | 玩家占领并驻军的格子 | 围攻（关键战斗，真人手操或自动；服务器复算 + 录像） | 防守方自定义 config + 驻军 |
| **险地（Stronghold）** | NPC 极强的战略格，非常难攻占；占领后通常提供大幅资源或战略价值 | 围攻（高难 PvE，系统默认超强防守 config） | 系统超强默认防守（高等级 NPC） |
| **首府（Capital）** | 10 个固定位置；占领即立国；Voronoi 分区给本国玩家提供加成；赛季终局争夺目标 | 围攻（关键战斗，服务器复算 + 录像） | 占领方自定义防守 config + 驻军 |
| **关隘/桥（Gate/Bridge）** | 嵌于阻挡地形（山脉/河流）之间的唯一通道；可被占领；只有占领方及其盟友才能通过 | 围攻（占领通道） | 占领方驻军；未占领视为阻挡 |
| **阻挡地形（Obstacle）** | 山脉/河流等完全不可通行格子（程序化分布，约占地图 10–15% DRAFT）；行军必须绕行或攻占关隘/桥 | 不可进攻 | — |
| **出生地 / 主城** | 玩家不可被永久夺取的本营（被打=掠夺资源 + 自动迁移 + 保护罩，不丢主城资格） | 围攻（掠夺） | 主城防守 config |

### 3.2 地图尺寸与地形布局

- **地图尺寸**：**1500×1500（约 225 万格）**，对应单大区 ~1 万玩家、人均 ~150–225 格可开发空间。
- **稀疏存储**：DB 只落被占领/被改动的格子；阻挡格、险地等静态地形由 `proceduralTile()` 程序化生成，不落库。
- **程序化分布**（`SLG_GEN` 旋钮）：资源格/等级分布按现有 §14.10 U6 已定方案；阻挡地形（山脉/河流）约占 10–15%，形成若干连续地形带，创造自然通道；关隘/桥数量 DRAFT（约 20–40 处战略通道）嵌于阻挡带之间；险地稀疏分布于高战略价值位置。
- **10 首府固定位置**（`CAPITAL_POSITIONS`）：硬编码于 `shared/slg.ts`，参考三国志战略版九宫布局；Voronoi 分区由首府坐标派生，deterministic。

### 3.3 格子 = 玩家自定义关卡（SLG5）

- 玩家领地/主城的防守 = 一份**可序列化 config**，形态等同 `LevelDefinition`：建筑摆位（兵营/箭塔在哪格）+ 出兵脚本时间线 + 基地强化 + 驻军兵种/数量。
- 玩家用养成解锁/强化各组件来编自己的「防守关」。
- **中立点/NPC 格按等级有系统默认防守 config**（玩家不编辑，等级越高越难）。
- 复用 level-editor 的概念与 `levelSchema` 校验（防守 config 走同一套运行时校验）。

### 3.4 资源（SLG12，DRAFT）

- **基础三种**：粮食（练兵/兵力上限）/ 铁（建筑/装备）/ 木材（建筑）。读时惰性产出 + 仓储上限，被攻破时按比例掠夺。
- **高阶稀有养成材料**：复用既有 PvE 材料 **scrap / lead / binding**（SLG8）——SLG 不另造养成货币，PvE 与 SLG 材料统一流转、可上拍卖行。
- 物产差异（不同格子产不同资源、丰度不同）= 交易意愿的来源。
- 主题皮：可后期换为文具等价物（保持手绘笔记本视觉语言）。

---

## 4. 兵力 / 驻军 / 行军（留存发动机）

> 这套数值循环是「为什么必须加家族」的根，要卡死。

- **兵力上限**：玩家可拥有的兵力有上限（训练队列消耗资源 + 时间，是主 sink + 变现加速点）。
- **驻军占用**：每块领地需驻军才守得住；驻军占用兵力池。
- **守不住全部** → 兵力 < 全部领地所需驻军 → **必然需要家族连地互守/增援** → 社交刚需化。
- **行军寻路**：地图含阻挡格（山脉/河流，完全不可通行）和关隘/桥（可占领通道）。服务端用 **A\*** 算法计算行军路径（绕阻挡 + 检查关隘/桥归属）；行军时间 = 路径格数 × `MARCH_SPEED_SEC_PER_TILE`。未被己方或盟友控制的关隘/桥视为阻挡。
- **占领、增援、进攻都需行军**，有距离/时间成本（Redis 调度的定时事件）；家族抱团占**连续领地**才高效（连地加成 + 短行军距离 + 快速增援）。
- **增援 / 代守 / 代打**：家族成员可向彼此领地派驻援军、被攻击时驰援（行军到达触发协防）。
- **保护罩**：被打败后短时保护（防连续碾压），是变现/节奏旋钮。

---

## 5. 战斗接入（承重墙）

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

### 7.3 赛季经济

- 赛季资源（粮/铁/木 + 赛季存量）季末清空，养成材料/金币/外观跨季留存（SLG4）。
- 拍卖行季末结算/冻结策略 ✅（2026-06-21，AUCTION_DESIGN §4.F）：settling 世界拒新挂单，resetSeason 前 clearWorldOnReset 清算退还。

---

## 8. 家族 / 宗门 / 国家社交（兑现 SOC6-4）

### 8.1 家族

- **建立**：花费 **500 coin**；族长管理成员（≤30 人）。
- **繁荣度**：动态综合评分（领地数 + 成员数 + 每日活跃度如新占领数/战斗场次），长期无人上线则衰减；赛季开始时重置；结算时繁荣度决定奖励档位。
- **族长可建宗门**：繁荣度达中等门槛 + 花费 **5000 coin** 方可创立。
- **家族频道 = N 人群聊**（Redis pub/sub 扇出 + gateway 多实例广播，兑现 SOC6-4）。
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
| **worldsvc（新）** | 世界状态机 + 行军 + 围攻触发 + 复算编排 |

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
- **拍卖行反 RMT**（SLG9）：高税 + 限额 + 禁挂 + 异常模式 admin 审计。
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
- **S8-4b 宗门 ✅（2026-06-20）**：补齐「大区→宗门→家族」三级里此前缺失的宗门层。宗门以**家族**为成员单位，操作须族长代表；`sects`/`sectMessages` 集合 + `families.sectId`。功能：建宗门（5000 coin via commercial，TAG worldId 内唯一）/家族加入退出（≤30 家族）/解散/联盟（双向，各 ≤2 = 3 宗门联盟）/罢免换届（族长投票 ≥⌈家族数×2/3⌉ → 门主转移）/宗门频道（落库，TTL 7 天）。**门主被打惩罚**：门主主城被破 → 全宗门成员资源 -50%（§8.2；主城迁移暂缓）。**大比按宗门**：`settleSeason` 按「宗门→散家族→个人」聚合占国数排名（兑现 §2.1）。`/sect/*` REST + worldsvc 12 e2e。**待办**：繁荣度建宗门门槛数值；盟友视野标记 + 客户端 UI（S8-9 C6）。
- **S8-4c 宗门频道实时推送横扩 + 主城迁城 ✅（2026-06-20，服务端 + 客户端）**：
  - **宗门频道实时推送（横扩，SOC9 / §8.2 / §8.4）**：worldsvc `gatewayClient.broadcast(recipients, msg)`——Redis 可用 → publish 一条 `{recipients, msg}` 到 `GW_PUSH_REDIS_CHANNEL='nw:gw:push'`（`shared/slg.ts`），各 gateway 实例订阅（`gateway/redis.ts` `connectGatewaySubscriber`）后经 `Gateway.routeBroadcast` **只推本机在线收件人**；无 Redis → 降级逐个 HTTP push 兜底（≤900 人，避免 worldsvc O(n) 直推）。`sectService.sendMessage` 落库后扇出 `sect_msg`（排除发送者，本地回显靠 REST 回包），`sectMemberAccountIds` 跨成员家族汇总收件人去重。proto `SectBroadcast`→`SectMsg`（对齐 FamilyMsg：`sectId/fromPublicId/fromName/text/ts`）；新增 `family_msg`/`sect_msg` 两个 push 分支（gateway `proto.ts`/`matchsvcClient.PushMsg`/`toServerMsg` + worldsvc `SlgPushMsg`）。gateway 读 `NW_GW_REDIS_URL` 订阅（缺省降级，与 worldsvc 共用同一 Redis）。
  - **主城迁城（§3.4 / §8.2，所有玩家通用）**：
    - **主动迁城**：`service.relocateBase(worldId, accountId, x, y)`——花 `RELOCATE_COST=500` coin via commercial，把主城迁到自选合法空格（界内/非中心/非障碍/非关隘/未被占领），**保留全部领地**，沿用旧城剩余保护罩（自愿迁城不续）；原地迁城 = no-op 不扣费。`POST /world/relocate`。
    - **被动迁城**：`applySiege` 主城被破分支改为 `passiveRelocate(worldId, defenderId, t)`——`deleteMany({ownerId})` 删玩家全部己方格（旧主城 + **所有领地**，失地强惩罚，不退驻军）→ `pickRandomEmptyTile` 随机选合法空格写新主城（守军 0 + 上保护罩）→ 改 `mainBaseTile` + 重算产率。门主额外仍触发全宗门 -50%（`applySectLeaderPenalty`，叠加）。极端找不到空格 → 仅失地 + 清 `mainBaseTile`。
  - **契约/客户端 ✅**：`openapi-world.yml`（`/world/relocate`）+ `transport.proto`（`SectBroadcast`→`SectMsg`）已改并 codegen（`openapi-world.ts`/`proto/transport.ts`）；`WorldApiClient.relocateBase`；`NetSession.onSectMsg` 路由 `msg.sectMsg`；`WorldMapScene` 中立格菜单加「迁城到此」（确认弹层显花费）+ `doRelocate`；`SectScene.applySectMsg` 实时插入频道（去重）+ `createAppCore.goSectHub` 转发 `onSectMsg`；i18n `world.actRelocate/relocateTitle/relocateConfirm/relocateBtn/relocated` zh/en/de。
  - **部署接线**：gateway 加 `NW_GW_REDIS_URL`（与 worldsvc 同 Redis）+ `ioredis` 依赖；写入 `.env.example`/`dev-up.ps1`/`ecosystem.config.cjs`/`docker-compose.{prod,local}.yml`。
  - 验证：服务端 `tsc -b shared worldsvc gateway` 全绿 + worldsvc **81 e2e**（+主动迁城/迁城校验/宗门频道扇出 3 例，含被动迁城断言改写）；client `tsc --noEmit` 0 错 + **273 测试** + `build:web` 通过。
- **S8-5 拍卖行**：材料挂单（赛季资源禁挂）/一口价 + 竞拍/指定受拍人/10% 手续费（coin）/每日限额/价格护栏滑窗/绑定禁挂机制/季末冻结清算 + **装备交易（A）** 全 ✅（2026-06-21，装备交易随装备库存后端 E2 一并落地）；仅异常审计（依赖 admin G7）待依赖。**机制权威见 [`AUCTION_DESIGN.md`](AUCTION_DESIGN.md)**。
- **S8-6 养成统一**：`buildSiegeBlueprints` + PvE/SLG 材料统一 + 服务器权威扩展 + 战力单调性单测。
- **S8-6.5 国家系统**：10 首府固定坐标写入 `shared/slg.ts`、Voronoi 分区计算、立国/灭国状态机、国民加成注入围攻蓝图。
- **S8-6.6 关隘/桥 + A\* 寻路 ✅（2026-06-18）**：
  - **阻挡地形程序化生成**：`TileType` 扩 `'obstacle'`/`'gate'`；`SLG_GEN` 加 `obstacleFreq/obstacleThreshold/obstacleMaxDr/gateFreq/gateThreshold`；`proceduralTile()` 在 `dr ≤ obstacleMaxDr=0.87` 区域用 `valueNoise` 生成 ~12% 障碍 + 极稀疏关隘（`gateThreshold=0.99`）；**角落区（dr > 0.87，玩家落城起始区）永无障碍**。
  - **A\* 寻路**：`shared/slg.ts` 加 `PathCell` 类型 + `findMarchPath()`（4方向 A*，曼哈顿距离启发，`Map`-based g-score 稀疏大地图友好，500k 节点上限）+ `marchDurationFromPath()`（`(path.length-1) × MARCH_SPEED_SEC_PER_TILE`）；`api.ts` 加 `PATH_BLOCKED`(400) 错误码。
  - **关隘通行规则**：`findMarchPath` 中关隘格逻辑——目标格始终可达（用于占领）；中途经过须在 `passableGateKeys` 中（己方已占领的关隘；盟友通行 S8-4 pending）；障碍格永远阻挡（含作为目标格）。
  - **worldsvc 接入**：`service.ts` 去掉 `marchDurationSec`，改用 `computeMarchPath()`（预取所有 `type:'gate'` TileDoc → 组装 `passableGateKeys` → 调 `findMarchPath`，无路 → `PATH_BLOCKED` 400）；`startMarch` 用 `marchDurationFromPath(path)*1000` 计算 `arriveAt`；`joinWorld`/`occupyTile`/`startMarch` 加障碍格/关隘格校验（`BAD_REQUEST`）。
  - **测试**：`worldsvc/test/pathfinding.test.ts`（纯单测：同格/越界/无障碍路径/4方向邻接/角落无障碍/marchDurationFromPath）；`march.e2e.test.ts` 全部 `marchDurationSec` 替换为 `mv.arriveAt` / `findMarchPath` 期望值，兼容 A* 曼哈顿距离。`siege.e2e.test.ts` 无需修改（横向路径 Manhattan=Euclidean）。
  - 验证：`shared` + `worldsvc` 两包 `tsc --noEmit` 全绿（无 `marchDurationSec` 遗留引用）。
- **S8-7 赛季**：大区分配（宗门强弱平衡匹配）/赛季开启/赛季重置（清领地/兵力/繁荣度/国家归属）/结算（按宗门占国数排名/奖励材料皮肤称号）。**→ 可编码实现规格见 §17**（赛季四段式现状盘点 + 7 处代码冲突修正 + settle 发奖/排名落库/reset 原子化/admin 鉴权/繁荣度评分/G6 分配算法）。
- **S8-8 变现 + 运营**：加速/资源包/科技直购/战令（commercial）+ admin 赛季运维。

**MVP 切片建议**：S8-0~3（地图+领地+兵力+围攻战，单服、无家族、无拍卖、无赛季重置）先验证「战斗接大地图」这条承重墙跑通，再叠加家族/拍卖/赛季。

---

## 13. 风险与开放问题

- **R1 工程量与风险最大的是 worldsvc + Redis**：第七进程 + 新有状态基建 + 空间/调度，是 month 级且不确定性最高。MVP 切片先验证承重墙。
- **R2 平衡复杂度**：三套蓝图 + 统一养成 + SLG 专属数值，平衡面变大；硬墙单测 + 战力单调性单测兜底。
- **R3 拍卖行 RMT**：自由市场永远是搬砖温床，税/限额/审计需持续对抗。
- **R4 单服容量与分服规则**：健康容量、并行多服、跨服大比形态仍待定（DRAFT）。**分服选人/归属链已拍板（2026-06-21）= 宗门 > 家族 > 单随**：开服分配大区时，①有宗门 → 整宗门进同一大区；②无宗门有家族 → 跟家族走；③都没有 → 单人随机分配到有空位的大区。保证社交单位（宗门/家族）成员同服可协作。
- **R5 赛季节奏与重置粒度**：周期长短、重置/留存边界影响留存与变现，需上线后调参。
- **R6 真人手操围攻的在线性**：防守方离线由确定性引擎跑，但「进攻方手操 + 防守方实时反应」不成立（防守恒为脚本）——这是设计取舍（防守=自定义关卡，非实时对抗），需在玩法说明里明确。
- **开放问题**：地图/行军/家族 REST 的 meta vs worldsvc 分工；拍卖计价币种；宗门间大比形态；家族容量；资源主题（功能命名 vs 文具皮）。

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
- **⚠️ P3 — 地图尺寸 + 程序化分布函数**：`mapW×mapH`（DRAFT，如 600×600）与"什么位置产什么资源/什么等级"的程序化规则未定（影响交易生态与开荒节奏）。

### 14.3 Mongo 集合（worldsvc 库，权威）

> 写型沿用单文档原子 + `rev` 乐观锁（META_DESIGN §6.3）。

| 集合 | `_id` | 关键字段 | 索引 |
|---|---|---|---|
| `worlds` | `worldId` | `season, shard, status(open/active/settling/closed), mapW, mapH, openAt, resetAt, capacity` | `{status:1}` |
| `tiles` | `tileId` | `worldId, x, y, type, level, ownerId?, familyId?, defenseRef?, resType?, garrison?, protectedUntil?, rev` | `{worldId,x,y}`、`{ownerId}`、`{familyId}` |
| `playerWorld` | `worldId:accountId` | `troops, troopCap, resources{food,iron,wood}, yieldRate{...}, lastTickAt, mainBaseTile, defenseRef, materials镜像?, familyId?, rev` | `{worldId,accountId}`、`{familyId}` |
| `marches` | `marchId` | `worldId, ownerId, fromTile, toTile, kind(attack/reinforce/occupy/sweep/return), troops, departAt, arriveAt, status, rev` | `{worldId,ownerId}`、`{arriveAt}` |
| `families` | `familyId` | `worldId, name, tag, leaderId, memberCount, territoryCount, rev` | `{worldId,tag}` 唯一、`{worldId}` |
| `familyMembers` | `worldId:accountId` | `familyId, role(leader/elder/member), joinedAt` | `{familyId}` |
| `auctions` | `auctionId` | `worldId, sellerId, itemType, item, qty, price, currency, designatedBuyerId?, expireAt, status(open/sold/expired/cancelled), buyerId?, rev` | `{worldId,itemType,status}`、`{sellerId}`、`{designatedBuyerId}`、TTL `{expireAt}` |
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
# 拍卖行
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
- **枚举**：`TileType`(neutral/resource/territory/familyKeep/center/base)、`MarchKind`、`SiegeOutcome`、`FamilyRole`、`WorldStatus`、`AuctionStatus`、`ResourceType`(food/iron/wood)。
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
| **P1** | **worldsvc 自暴露公网 REST**（第四公网面：`/world/*` `/family/*` `/auction/*`），复用 meta JWT（仅 `verifyToken` 验签，不连 accounts 库） | 反代加三组路由；拓扑原则更新为「客户端触达 meta + worldsvc(REST) + gateway + game(WS)」 |
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

- **U4 大区容量 ✅（2026-06-18 更新）**：**~1 万活跃玩家/单大区**（替代原 300-500 人/单服）。配套：march 风暴/视区推送扇出（U11）、A* 寻路计算量需节流；worldsvc 行军调度单点 ZSET 对该量级需压测确认（U12）。
- **U2 地图尺寸 ✅（2026-06-18 更新）**：**1500×1500（~225 万格）**（替代原 300×300），对应 1 万玩家人均 ~150–225 格开发空间。稀疏存储只落被占格不影响存储。
- **U6 程序化分布 ✅（原方案 + 扩展）**：在原 `proceduralTile()` 基础上扩展：增加阻挡地形（山脉/河流约 10–15% 格子，连续地形带）；险地（稀疏强 NPC 战略点）；关隘/桥嵌于阻挡带（约 20–40 处）；10 首府固定坐标（`CAPITAL_POSITIONS`）。
- **U1 拍卖行计价币种 ✅（2026-06-18 定）**：充值 **coin**；**赛季资源（粮/铁/木）禁挂**，仅材料/装备可交易；系统抽 **10% 手续费**；免费玩家通过任务/活动/关卡赚 coin 参与（最低生活保障原则）。
- **U3 赛季周期 + 大比形态 ✅（2026-06-18 定）**：赛季 **2 个月**；大比 = **大区内宗门占领首府数排名**（非跨服）；中原首府额外加权奖励；奖励材料/皮肤/称号（含连续赛季成就称号如「十冠王」）；运营活动叠加。
- **U5 家族/宗门容量 + 权限 ✅（2026-06-18 定）**：家族 ≤30 人（建立 500 coin）；宗门 ≤30 家族（建立 5000 coin + 繁荣度中等门槛）；联盟 ≤3 宗门；门主换届需 2/3 族长投票 + 提名；门主主城被破 → 全宗门成员资源 -50% + 主城自动迁移。
- **U7 碾压级阈值 ✅（2026-06-18 定）**：满装备玩家 ≈ 碾压 100 个零充值玩家（Lanchester 比值约 100:1）；非关键战斗廉价结算阈值据此设置（DRAFT 具体数值待调参）。
- **U8 防守 config 可编辑范围 ✅（2026-06-18 定）**：可编辑内容 = 玩家已收集的单位和已有的建筑/机关（复用现有兵营/箭塔等），未收集的无法使用；不引入新元素，引擎现有组件即可。

**B. 数值 DRAFT（先占位，上线后调参）**
- **U6** §14.7 全部常量（兵力上限 / 行军速度 / 资源上限与产率 / 保护时长 / 驻军数）；国民加成具体数值（防御加成 % / 产出加成 %）；繁荣度建宗门具体阈值；碾压级廉价结算具体比值。

**C. 实现期风险 / 细节（实现时处理，先记着）**
- **U9 engineVersion 耦合**：引擎更新 → worldsvc 须重构建；赛季中途引擎升级如何 pin 版本，保录像/复算一致性（D0+P2 的代价）。
- **U10 防守 config 旋钮接引擎 ✅（2026-06-18）**：三组新旋钮已完整落地——①**garrison（驻军单位）**：`LevelDefinition.garrison[]`（unitType/col/row），siege 模式下构造期在 Top 侧指定行列预置兵，首 tick `emitInitialEvents` 发 `unit_spawned`+`unit_move_start` 事件，单位随即按正常移动系统向 Bottom 行进；②**defenderBuildings（防守建筑）**：`LevelDefinition.defenderBuildings[]`（buildingType/col），放在 `TOP_BUILDING_ROW=17`，首 tick 发 `building_placed(owner=1)` 事件，ArrowTower/Barracks 即刻生效（射程攻击/生产单位）；③**defenderBaseLevel（基地强化）**：`LevelDefinition.defenderBaseLevel`（0–3），直接设 `topPlayer.upgradeLevel`（跳过 ink 消耗），影响 ink 回复加成。`levelSchema` 三字段全部验证（unitType/buildingType/lane 合法性 + baseLevel 范围 0–3）；**天梯红线不动**（仅在 siege 路径生效，pvp/netplay 无 level）；31 新单测全绿；265 全量回归全绿。
- **U11 视区订阅推送扇出**：1 万人地图 `tile_update`/`march_update` 风暴，需节流/聚合（P9 订阅模型的规模化）；密集首府区域尤需注意。
- **U12 worldsvc 单点 march 调度**：ZSET 到点消费是单点；1 万人规模需压测；多实例需选主/分片，前期单进程可接受。
- **U13 多步原子性**：占地/丢地改 `yieldRate` 与读时惰性结算的并发（rev 守卫够不够）；拍卖成交（扣卖方挂存 + 给买方 + 抽税）的跨文档幂等与回滚；门主被打全宗门资源 -50% 的大规模写操作原子性。
- **U14 A\* 寻路性能**：1500×1500 地图 A\* 最坏情况计算量，需评估是否要路径缓存或分块寻路（阻挡带连续则影响不大）。
- **U15 Voronoi 分区计算**：首府坐标固定后，Voronoi 分区可预计算并缓存（或实时算），每格 tileId 的国家归属查询路径确定（worldsvc 内存缓存 + Mongo 按需）。

---

## 15. 已知缺口 / 收尾清单（2026-06-20 盘点）

> S8-0~S8-9 主干切片全部 ✅（地图/领地/行军/围攻/家族/宗门/拍卖/赛季/变现框架/客户端全量 UI）。本节盘点「设计已承诺、任务已标 ✅，但代码里仍空转或暂缓」的缺口，按"该不该补"分三档。盘点依据：逐函数核对 `worldsvc`/`shared` 实现与本文档 §2~§9 承诺。

### 15.1 第一档——已定义但没接通（最该补，目前是死代码/空转）

| # | 缺口 | 现状 | 影响 |
|---|---|---|---|
| **G1** | **国民加成未生效** | `NATION_BONUS_PRODUCTION=0.10`/`NATION_BONUS_DEFENSE=0.15`（`shared/slg.ts`）仅 import、worldsvc 全程未使用；`resolveSiege` 与 `recomputeYield` 都不读 | 国家系统沦为「占国数计分牌」，对产出/战斗零影响，违背 SLG2 / §2.4「国民加成」 |
| **G2** | ~~**繁荣度系统是死字段**~~ ✅ **已落地（2026-06-21，§17.1/§17.4）** | `FamilyDoc` 补 `prosperity/prosperityUpdatedAt/activity`；`familyProsperity`/`decayProsperity` 纯函数 + 读时惰性衰减（`prosperity.ts`）；占领/围攻 `$inc activity` 并刷新；`SectDoc.prosperity` = 成员家族聚合；建宗门加繁荣度门槛（`SECT_FOUND_PROSPERITY_MIN`，不足抛 `PROSPERITY_TOO_LOW`） | §8.1 繁荣度循环兑现；G6 分配基础数据就位 |
| **G3** | ~~**围攻反作弊判负翻转未启用**~~ ✅ **已由 G3-2b 解决（2026-06-21）** | 围攻重构为「服务器跑引擎权威即时落地」（§16/§16.8），从根上不存在「先信客户端再复算翻转」——客户端无战报上传通道，伪造无从谈起 | 承重墙 SLG11 兑现：关键战斗权威在 worldsvc 进程内 |
| **G4** | **养成统一的「材料流转」**（材料流转 ✅ **2026-06-21，§15.6**；战令增益仍延后） | `buildSiegeBlueprints(养成)` 注入装备/科技战力已通；PvE↔SLG 材料（scrap/lead/binding）经 **单一 `SaveData.materials` 池**贯通——PvE 产出 / 装备合成 / PvE 升级 / 拍卖行买卖（S8-5 `meta.deduct/grantMaterial`）全读写同池，赛季奖励经新增邮件 `kind:'material'` 附件入此池（§15.6）。**仍缺** 战令 `hasBattlePass` 增益效果（属 S8-8 战令专项，§17.12 待定） | SLG7/SLG8「养成统一」材料侧闭环已合；战令增益随专项 |

### 15.2 第二档——系统级整块缺失

| # | 缺口 | 现状 | 影响 |
|---|---|---|---|
| **G5** | ~~**地图迷雾 / 侦察视野 / 宗门视野共享 / 盟友土地标记**~~ ✅ **四片全落地（2026-06-21，§18）** | G5-1 读路径门控 + G5-2 反向视野推送 + G5-3 客户端渲染（灰雾/友敌色/敌军显形）+ 联盟领地黄标（§18.7）全 ✅；共享降级为家族级（§18.1 V2）。scout 侦察行军（§18.8）+ 瞭望塔建筑（§18.9）全 ✅，V2 余项全部兑现 | §8.2 视野共享 + 盟友标记、§2.1 视野订阅核心战略玩法已兑现 |
| **G6** | **多大区 + 赛季分配规则**（数据地基+纯算法 ✅ **2026-06-21，§17.8**；多 shard 运行时仍延后） | 数据地基已就位：`seasonResults` 集合落库本季宗门排名 + 繁荣度快照（C2 闭）；`sectStrengthScore`/`allocateSectsToShards`（蛇形均衡）纯函数 + 单测。**仍缺**多 shard 运行时调度（按人口开新区/跨区迁移/隔离巡检），单列后续任务 | 规模化数据/算法地基兑现；运行时调度待专项 |
| **G7** | **admin 运营后台 SLG 接入**（赛季运维 ✅ **2026-06-21，§17.7**；异常交易审计仍随 OPS 专项） | worldsvc `/admin/world/*` 迁出 JWT 改 X-Internal-Key（**C4 安全洞已堵**，任意玩家不再可清区）+ 新增 `GET /admin/world/list`；admin 后端加 `worldClient` + `POST /admin/slg/season/{open,settle,reset,close}` + `GET /admin/slg/worlds`（能力 `slg.season.view/manage`，reset 前必 settle 约束 + 审计）。**仍缺**异常交易审计工单（随 OPS 专项）+ 商品价格可调 + ops 前端 UI | S8-8 赛季运维侧兑现；反 RMT 审计待 OPS |
| **G8** | ~~**险地（Stronghold）格子类型**~~ ✅ **已落地（2026-06-21，§19）** | 新增 `'stronghold'` TileType + `proceduralTile` 稀疏生成（~0.3%，比 familyKeep 稀疏 ~16×）+ `strongholdGarrison` 系统超强守军 + worldsvc `applyStrongholdSiege`（无主险地 PvE 围攻：权威引擎跑系统守军，攻克占为领地 + 一次性丰厚奖励，攻败残兵撤退）；occupy/sweep/落城/重生全拦截险地；契约 enum + 客户端渲染/交互/i18n。worldsvc 5 e2e | 高战略价值 PvE 格兑现（§3.1） |

### 15.3 第三档——DRAFT 数值 / 打磨

- 拍卖行季末冻结/结算策略（DRAFT）；国民加成/繁荣度/碾压级廉价结算具体数值待调参（§14.10 U6）。
- 首府改名服务端已校验 ownerId；商城金币余额展示已接 SaveData 镜像。

### 15.4 收尾优先级建议

1. ~~**G1（国民加成）+ G3（判负翻转）**~~ ✅：「承诺了但空转」，先收口。
2. ~~**G5（视野系统）**~~ ✅：「加家族才守得住」留存逻辑的关键拼图，四片全落地（§18，含联盟黄标 §18.7）。
3. **G2/G4/G6/G7/G8**：随对应经济/运营/规模化专项推进。

> **进度**：**G1 国民加成已落地（2026-06-20）**——见 §15.5。**G5 视野/迷雾四片全落地（2026-06-21，含联盟黄标）**——见 §18。

### 15.5 G1 国民加成实现记录（2026-06-20）

- **shared**：新增纯函数 `nationDefenseStrength(garrison, inOwnNation)`（己方 Voronoi 区守军强度 ×(1+`NATION_BONUS_DEFENSE`)，否则原值；`Math.floor` 整数化、双端可算）。
- **归属判定**（无逐玩家国籍字段，v1 取「首府占领者即国民代表」）：瓦片落在「由瓦片主人自己占领的首府」的 Voronoi 区内 → 享加成。
- **生产加成**：`recomputeYield` 先取该玩家占领的首府集合（`nations.find({worldId, ownerId})` → `capitalIdx` Set），逐格 `nearestCapitalIdx` 命中集合则该格 `tileYield` ×(1+`NATION_BONUS_PRODUCTION`)；聚合后 `Math.floor` 保持整数产率。占领/放弃/围攻易主等所有改产率路径均经 `recomputeYield`，天然覆盖。
- **防御加成**：`applySiege` 围攻到点结算前，查目标格 Voronoi 首府，若 `nation.ownerId === defenderId` → 守军经 `nationDefenseStrength` 放大后再喂 `resolveSiege`。NPC 扫荡（`applySweep`）不享（无国籍）。
- **测试**：`worldsvc/test/nation-bonus.e2e.test.ts`（生产加成产率提升、防御加成抬高破城门槛、非己方区无加成）。

### 15.6 G4 材料统一流转实现记录（2026-06-21）

> SLG8「PvE 与 SLG 材料统一流转、可上拍卖行」的材料侧闭环。盘点（2026-06-20）时 G4 标「半截」；逐路径核对后实为**两条**：①拍卖行买卖——S8-5 已接（`auctionService` 经 `meta.deductMaterial/grantMaterial` 读写 `SaveData.materials`），无需补；②赛季奖励发材料——本刀修。

- **病灶（孤儿桶）**：养成材料统一池是 `SaveData.materials`（PvE 通关 `/pve/clear` 产、装备合成 `/equipment/craft` + PvE 升级 `/pve/upgrade` 耗、拍卖行买卖均读写它）。但赛季结算奖励（`SETTLE_REWARDS` 的 scrap/lead/binding）走系统邮件 `kind:'item'` 附件 → 领取经 `deliverMailGrant` 落 `save.inventory.items.{id}`——一个**无任何消费者**的泛用桶。结果：SLG 赛季产出的材料养成/装备/拍卖全读不到，材料流转断在「SLG→养成池」这一段。
- **修法（新增 `'material'` 附件类型，分桶直发统一池）**：
  - **契约**：`MailAttachmentKind`（shared `social.ts`）/ `MailAttachmentDoc`（`mongo.ts`）/ openapi `MailAttachmentView` enum 增 `'material'`；client `openapi.ts` 重生。`'material'` → `SaveData.materials`；`'item'` 仍 → `inventory.items`（刻意分桶，材料不混入泛用物品）。
  - **metaserver**：`splitAttachments` 多拆一个 `materials` 桶；`deliverMailGrant` 增 `materialInc` 形参，`$inc save.materials.{id}`；`claimMail` 透传 `split.materials`。`/internal/mail/system/send` 的 body 附件类型由 `CompAttachment[]`（仅 coins/item/skin）放宽为 `MailAttachmentDoc[]`（含 material）。
  - **worldsvc**：`settleSeason` 发奖材料附件由 `kind:'item'` 改 `kind:'material'`；`WorldMailAttachment` 类型同步加 `'material'`。
  - **客户端**：`attachmentLabel` 加 `material` 分支 + i18n `mail.attMaterial`（zh/en/de）。
- **测试**：`metaserver/social-mail.e2e`（内部直投材料 → 领取后 `save.materials.scrap=1000` 且 `inventory.items.scrap` 不增）；`worldsvc/season-ops.e2e`（断言改 `kind:'material'`）。`tsc -b shared metaserver worldsvc gateway commercial admin` + client `tsc --noEmit` 全绿。
- **未尽**：战令 `hasBattlePass` 增益效果仍空（§17.12 列 S8-8 战令专项）；OPS 补偿工单若需发材料，`CompAttachmentKind` 可同样扩 `'material'`（随 OPS 专项）。

---

## 16. G3 围攻重构：预布兵自动战斗（SLG11 承重墙，2026-06-20 拍板）

> 用户拍板（2026-06-20）：**放弃手操**（不符 SLG 异步习惯 + 海量并发：一个玩家可同时进攻 5–6 个目标、到达错峰且常在离线时，逐场手操不可承受；且手操会用手速稀释「SLG=卖战力」定位）。关键围攻 = **双方预布兵的确定性自动战斗**；**服务器跑引擎算权威结果即时落地**，客户端凭 `seed + 双方布阵` 本地重播观战。本节是重构基准与分片计划，作废上一版「延迟落地/judge 复算/手操复盘」方案。

### 16.1 战斗模型（锁定）

- **兵力 = 单位血量（HP）**：每兵种按等级有满血容量（如 L3 盾兵 = 100）；布兵时给某单位分配 X 兵 → 它以 X 血出战（X ≤ 满血容量）；一支军队各单位分配之和 ≤ 携带兵力（行军预算）。**伤害**由兵种/等级定、**v1 不随兵力缩放**（兵力只决定耐久）。战后**残存血量折回兵力池**，阵亡兵力**永久损失** → 靠地图资源重新练兵（兑现资源 sink 闭环：资源→练兵→战损→再练）。
- **双方各有基地，破敌基地者胜**（沿用现有 `objective: destroy_base`）；**超时 / 同归于尽（双基地皆存）→ 进攻方负**（防守占优；含「两单位互射同归于尽、基地皆存」的特例）。
- **复用现有 12×18 双基地引擎**（PvP/campaign/netplay 同款）；唯一战斗改动 = 攻方从「实时出牌」改「开局预布兵」（攻方下半场预布、首 tick 起步推进，与防守方 garrison 同机制）。无 waves、无 live 指令 → 战斗由 `seed + 双方布阵` 唯一确定。

### 16.2 队伍与布阵（锁定）

- **5 支队伍**（前期上限）= 5 个可保存的**进攻布阵模板** + **并发上限**。点队伍直接进布阵编辑器；出征挂一支队，committed 兵力从池扣除，队伍占用至回师。
- **防守布阵**：点地图格 → 「布阵」选项 → 进该领地布阵编辑器；**可在任意盟军领地布阵**（互助协防，§4「代守」）。
- **布阵编辑器**：DefenseEditorScene 推广为通用半场布兵 UI（攻方半场 = 进攻队伍；守方半场 = 领地防守）；调色板取**已收集兵种**（U8）+ 每单位兵力分配滑杆（≤ 满血容量，总和 ≤ 预算）。

### 16.3 战斗接入与权威

- **Battle level** = 攻方预布军（下半场 owner0）+ 守方预布军（上半场 owner1，沿用 garrison）+ 双方基地 + `objective:destroy_base` + **时间上限**（DRAFT ~10min 游戏时间，安全网 + 算力封顶）。
- **worldsvc 跑引擎**（M12 §14.1「裁判」例外，设计允许）：import 确定性引擎 headless 跑到终局 → 权威胜负 + 真实残存血量 → `landSiege`（G3-1 已抽出）即时落地。代价 = worldsvc 绑 `engineVersion`（U9，赛季中途升级须 pin）。
- **算力**：单场约几千 tick、几十实体 ≈ 10–100ms CPU，可忽略；规模化用队列/worker 节流。
- **客户端**：收 `siege_result` + `seed + 双方布阵` → `ReplayInputSource` 本地重播观战（非权威，纯演出）。

### 16.4 分片（可独立验收）

- **G3-1 落地逻辑抽取（纯重构）✅（2026-06-20）**：`applySiege` 的写库块抽成 `landSiege(m, pw, target, defenderId, defender, res, t)`，行为零变化、e2e 全绿。judge/兜底/引擎三路共用此唯一落地点。
- **G3-2a shared + 引擎 ✅（2026-06-21）**：army layout schema（`GarrisonEntry.initialHp` 复用于攻守两军 + `LevelDefinition.attackerArmy`/`battleTimeoutTicks`，`levelSchema` 校验）；troops=HP（`Unit` 构造 `this.hp = min(initialHp ?? 满血, 满血)`，maxHp 恒为蓝图满血）；`buildSiegeBattle`（shared/slg.ts，**复用 `buildSiegeLevel` 守方规整 + 叠攻方军 + `battleTimeoutTicks`**；`buildSiegeLevel` 暂留供 worldsvc，G3-2b 再切换以守「不碰 worldsvc」）；引擎镜像 garrison 初始化到 `attackerArmy`（owner0/Bottom，首 tick spawn+move 向 `TOP_BUILDING_ROW`）+ 超时双基皆存判 owner1（防守方）胜；headless 跑通；**确定性 battle 单测**（`client/test/siege-battle.test.ts`：同布阵 + seed → 逐 tick 双基 HP 序列逐字一致；破基地 / 超时两路胜负；红线不破）。client tsc + 293 测试全绿、server tsc -b shared worldsvc 绿。
- **G3-2b-0 引擎抽包 `@nw/engine` ✅（2026-06-21）**：确定性模拟内核从 `client/src/game` 抽成独立 workspace 包 `@nw/engine`（物理放 `server/engine/`，加入 `server/package.json` workspaces，与 `@nw/shared` 同范式），worldsvc/gateway 直接 import；client 经 webpack alias + tsconfig paths + vitest alias 引 `../server/engine/src`，旧 `client/src/game/*` 留 27 个再导出 shim 保 client/测试逐字不变。详见 §16.7「实现记录」。**这是 G3-2b 的前半截**——做完后 worldsvc 接引擎、gateway 去 peer-judge 那跳自复算都顺理成章。
- **G3-2b worldsvc ✅（2026-06-21）**：承重墙合龙——worldsvc 直接 import `@nw/engine` headless 跑权威围攻。`applySiege` 关键战斗（攻领地/攻主城）改为「跑引擎 → 真实残存折兵力 → `landSiege`」即时落地；非关键 sweep/NPC 维持廉价 `resolveSiege`。详见 §16.8「实现记录」。
- **G3-2c 客户端 ✅（2026-06-21）**：5 队伍布阵编辑器（攻）+ 领地布阵（守，盟军可布）+ 出征挂队 + `seed` 重播观战；i18n。四阶段全落地——Phase 1 服务端+契约 / Phase 2 客户端编辑器+队伍 UI / Phase 3 重播观战改造 / Phase 4 删 judge 死路径，详见 §16.9。
- **删除 ✅（G3-2c Phase 4）**：S8-3b 的录像上传 / `getSiegeDefense` / `resolveSiegeWithJudge` / worldsvc→gateway `judge` 客户端复算路径（手操不再存在，引擎给真实残存）。

### 16.5 开放项（DRAFT 默认值，调参细化）

- **生还折回**：战后各残存单位 HP 之和回兵力池（封顶 troopCap）；阵亡永久损失。
- **队伍兵力 vs 共享池**：队伍 = 布阵模板（含每单位兵力分配）；出征即从共享池扣 min(模板需求, 可用)；不足默认**拒发**（v1，后续可议按比例缩水）。
- **伤害不随兵力缩放（v1）**；若平衡需要（兵力高却因伤害不变而无优势）再议是否让伤害/兵力联动。
- **满血容量表 / 各兵种兵力当量 / 时间上限具体值** 待调参；险地/首府的系统默认布阵沿用 §3.3「按等级派生」。
- **僵局**：纯零伤害对峙（如双方全盾兵、DPS≈0）理论可无限 → 由「时间上限 + 超时进攻方负」兜底（正常战斗到不了上限）。

### 16.6 引擎落地锚点（G3-2a 实现指引，2026-06-20 探查）

> 已摸清确定性引擎现状（`client/src/game/`，纯 TS 无 PIXI），G3-2a 据此实现，新会话不必重新探查。

- **棋盘**（`config.ts:22–39`）：12 列 × 18 行；owner0=下方（基地 row0，spawn row1）、owner1=上方（基地 row17，spawn row16）；战斗区 row2–15；攻击车道 col 0–4 / 7–11，基地列 5–6（不可攻）。
- **garrison 现成可镜像**（`GameEngine.ts:182–212` 构造预布 + `:480–498` 首 tick 发 `unit_spawned`+`unit_move_start`）：防守方（Top）单位已能中场预布 + 自动推进。**攻方预布 = 把这套镜像到 owner0/Bottom 半场**，不新建 director。`GarrisonEntry{unitType,col,row}`（`campaign/LevelDefinition.ts:159–173`）。
- **兵力=血量**：单位 HP 恒取 `blueprint.hp`（`Unit.ts:145–170`，`UNIT_BLUEPRINTS` in `config.ts:131–257`），无覆写口。→ 给布兵项加 `initialHp?`，构造改 `this.hp = initialHp ?? blueprint.hp`，其余战斗逻辑不动。
- **模式分支**（`GameEngine.ts:118–130`）：siege→`buildSiegeBlueprints(pveUpgrades)`；攻方现为 live 出牌（`:540–649`），改为预布后**无 live 指令**。
- **胜负判定**（`GameEngine.ts:750–867`）：先判 Bottom 基地 HP≤0→Top 胜；`destroy_base` 可带 `durationTicks` 超时。**改动点**：加战斗时限 → 超时（双基地皆存）判 owner1（防守方）胜。
- **headless 跑法现成**（`net/judgeRunner.ts:44–69,119–153`：`createGameEngine(config, ReplayInputSource)` + `while phase!==GameOver tick(1/30)`）：双方纯预布、喂空输入源跑到终局取 `winnerSide`。`maxTicks` 兜底防死循环。
- **不可破的确定性护栏**：`buildPvpBlueprints()` 无养成参签名（编译期硬墙，`test/hardwall.test.ts`）；PRNG 注入（`math/prng.ts`，三 seed XOR）；定点数 `Fp`（`math/fixed.ts`）；实体 ID 重置（`Unit.ts:7–17`/`Building.ts:8–17`，每局 reset）；金回放/`siege.test.ts` 确定性。

**G3-2a 改动清单**：①`LevelDefinition.ts` `GarrisonEntry.initialHp?` + `attackerArmy?: GarrisonEntry[]` + `battleTimeoutTicks?`；②`GameEngine.ts` 镜像 garrison 初始化到 `attackerArmy`（owner0，首 tick spawn+move）+ spawn 套 `initialHp` + 超时判防守胜；③`shared/slg.ts` `buildSiegeLevel`→`buildSiegeBattle`（双军+双基地+timeout）；④`levelSchema` 校验新字段；⑤`client/test` 确定性 battle 单测（同布阵+seed→同终局；破基地/超时两路；硬墙不破）。**只动引擎+shared+单测，不碰 worldsvc/客户端**（G3-2b/2c）。

### 16.7 引擎抽包 `@nw/engine`（G3-2b-0 设计，2026-06-21 拍板）

> **背景探查（2026-06-21）**：确认现状——确定性引擎只存在于 `client/src/game` 一份；服务端**无引擎副本**，worldsvc 围攻走 `@nw/shared` 的廉价公式 `resolveSiege`，gateway 的 `/gw/judge` 靠 **peer-judge**（挑在线玩家客户端跑 `judgeRunner` 回报 hash），引擎从不在服务端进程内运行。client 与 server **零代码共享**（手抄镜像 + openapi/proto codegen 对齐，client tsconfig 无 `paths`、webpack 无 `alias`）。引擎是最吃「两端逐字一致」（确定性）的逻辑，手抄镜像在此是定时炸弹 → 抽成单一来源包。

**目标**：worldsvc / gateway 能像 import `@nw/shared` 一样 import 引擎，headless 跑权威围攻 / 自复算比赛；从根上杜绝「未来出现第二份引擎」的确定性裂缝。

**方案：新 workspace 包 `@nw/engine`（物理放 `server/engine/`，加入 `server/package.json` workspaces，与 `@nw/shared` 同范式）**
- **服务端消费**：worldsvc / gateway 加 `"@nw/engine": "*"` 依赖，`tsc -b` 项目引用，CJS dist。零新机制。
- **客户端消费**：client 是独立 webpack 项目（无 workspace），经 **webpack alias + tsconfig `paths`** 把 `@nw/engine` 指向 `../server/engine/src`，ts-loader 直编源码进 bundle（不依赖 engine 的 CJS dist）。这是 client 的**首个跨边界桥**，net-new 但很小。

**边界划线（什么进包）**

| 进 `@nw/engine` | 留在 client |
|---|---|
| `config` / `math/*`（`fixed`/`prng`）/ `Card` | `meta/*`（SaveManager/SaveStore/ReplayStore 持久化） |
| `GameEngine` / `GameState` / `Unit`/`Building`/`Player`/`EscortUnit` | `net/NetInputSource`（联机传输，依赖 proto） |
| `systems/*` / `campaign/WaveDirector` / `LevelDefinition` + `levelSchema` | `campaign/maps/ChapterMap`（UI/i18n） |
| `balance/pveUpgrades`（三套 blueprints，**含天梯红线**）| `i18n` 本体；PIXI 渲染层全部 |
| `net/InputSource`（Local/Replay/Recording，纯逻辑）| `judgeRunner` 的 proto 解码外壳 |
| **新增 `runHeadless(seed, level, frames, source)`**（从 `judgeRunner` 抽出的引擎跑动核心）| — |

> `runHeadless` 吃**已解码输入**，proto 解码留各调用方边缘（client / gateway / worldsvc 各自把自己的 proto frames 解成统一形状再喂）——这就是让 **gateway 自复算** 与 **worldsvc 权威跑** 共用一条引擎路径的关键。

**三个已知坑**
1. **strict 不一致**：server base 开 `noUncheckedIndexedAccess` / `noImplicitOverride`，比 client 严。引擎进 server 包要清掉新报的索引/override 错（可能几十处）。**拍板：清干净**（引擎是命根子代码，不给 engine 包开宽松特例）。
2. **`TranslationKey` 外泄**：`types.ts` / `LevelDefinition.ts` type-only 引 `../i18n` 的 `TranslationKey` → engine 内降级为 `string`（显示用 key，模拟不关心），i18n 校验留 client。
3. **`engineVersion` pin（U9）**：engine 包打版本号常量，worldsvc 跑围攻 / 录像复算时校验，赛季中途升引擎须 pin。抽包时落进 `@nw/engine` 导出。

**验收**：`@nw/engine` 建包 + 迁移 + strict 清理后 → server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + 现有 293 测试（含 `siege-battle.test.ts` / 硬墙 / 金回放确定性）全绿 + `build:web` 通过——**测试逐字不变全绿 = 抽包行为零变化的证明**。完成后方启 G3-2b（worldsvc 接引擎）。

**实现记录（2026-06-21 落地）**
- **包**：`server/engine/`（`@nw/engine`，`package.json` + `tsconfig.json` composite/CJS dist，加入 `server/package.json` workspaces 第二位）。`server/engine/src/index.ts` barrel 导出公共面（`createGameEngine`/`runHeadless`/输入源/类型/枚举/定点工具/`GameState` type/`LevelDefinition` 全族 + `parseLevelDefinition` + `ENGINE_VERSION`），内部类（Unit/Building/Board/GameState 类/Player/EscortUnit）不进 barrel——深层消费（测试）走子路径 shim。
- **迁移**：`git mv` 27 个源文件进 `server/engine/src`（含 `math/` `balance/` `campaign/{LevelDefinition,levelSchema,WaveDirector}` `net/{InputSource,ReplayInputSource}` `systems/*`）。**留 client**：`meta/*`、`net/NetInputSource`、`campaign/{levels.ts+levels/*.json,maps/*,progress.ts}`、`game/index.ts` barrel、`net/judgeRunner.ts`。
- **client 接线**：webpack `resolve.alias`（`@nw/engine$`→`src/index.ts`、`@nw/engine`→`src/`，ts-loader 直编源码进 bundle）；`client/tsconfig.json` 加 `baseUrl`+`paths`（`@nw/engine`/`@nw/engine/*`）、`include` 加 `../server/engine/src/**/*`、**删 `rootDir`**（避免 TS6059 跨 root）；4 份 vitest config 各加 `resolve.alias`（rollup-alias 前缀匹配覆盖裸名 + 子路径）。旧 `client/src/game/<path>.ts` 留一行 `export * from '@nw/engine/<path>'` shim（27 个）→ client 应用代码 + 293 测试 import 逐字不变。
- **三坑**：①strict 实际只新报 5 处（Board `addBuilding`/`removeBuilding` 写格用 `!`、Card `tickTimers` 槽位判 `if(!slot)`、GameEngine `spawnEnemyUnit` laneLen 提取 const 收窄）；②`TranslationKey` 在 engine 两文件改本地 `type TranslationKey = string`，client 11 处消费点（createAppCore×3/GameRenderer/HandView/CollectionScene×2 + Set 改 `Set<string>` 收 2 处/DefenseEditorScene×2）`as TranslationKey` 再收窄；③`ENGINE_VERSION=1` 原就在 `types.ts`，barrel 显式再导出标注 U9 用途。
- **`runHeadless(config,input,maxTicks)`**：`server/engine/src/runHeadless.ts`，吃已解码 `GameConfig`+`InputSource`，建引擎跑 tick 到 GameOver/maxTicks，返回 `{ok,ticks,engine}` 供调用方读 `state.winner`/`snapshotStats()`；proto 解码留各调用方边缘。client `judgeRunner` 三路（netplay/pve/siege）改用之（去三份重复 tick-loop），由 `judge-runner`/`pve-judge` 测试覆盖证明等价。worldsvc 接入是 G3-2b。

### 16.8 worldsvc 接引擎（G3-2b 实现记录，2026-06-21 落地）

> **承重墙合龙**：worldsvc 成为史上第一个在进程内直接 import 确定性引擎、headless 跑权威围攻的服务端（M12「裁判例外」延伸）。关键围攻不再走廉价线性公式，而是双方预布兵确定性自动战斗的真实结果即时落地。

- **新模块 `server/worldsvc/src/siegeEngine.ts`**：
  - `synthesizeArmy(troops, role)`：把扁平兵力数铺成确定性 `GarrisonEntry[]` 布阵——默认步兵（满血 60 = 兵力当量），每单位 `initialHp ≤ 满血`（兵力=血量，§16.1），按 `ATTACK_LANES` 轮转铺开（attacker 从 row 1 升、defender 从 row 16 降）。这是**布阵编辑器（G3-2c）落地前的 v1 桥**：现行数据模型仍存扁平 `march.troops`/`tile.garrison`，编辑器接入后真实布阵从 `tile.defense`/`playerWorld.teams[]` 读，此合成退为「未设布阵」兜底。
  - `runSiegeBattle({attackerArmy,defenderConfig,tileLevel,seed})`：`buildSiegeBattle`（攻军+守军+双基地+时限）→ `parseLevelDefinition` 校验（P2，引擎侧 `levelSchema`）→ `runHeadless` siege 模式跑到终局/时限 → 读 `state.winner` 定胜负、累加 `board.units` 各侧存活 HP 定真实残存兵力 → 返回 `SiegeResolution`。winner=Bottom(owner0)=攻方破基地夺地。
- **`applySiege` 改造**：关键围攻调 `runSiegeBattle`（seed=`siegeSeedFromId(march._id)`，守方布阵 `buildDefenderConfig`——自定义 `tile.defense` 优先、否则按有效守军兵力合成；国民加成 v1 只作用合成路径）；坏布阵/引擎异常 try/catch 兜底回退廉价 `resolveSiege`，绝不卡死行军。`landSiege`（G3-1 唯一落地点）行为不变，新增 defender_win 时攻方残存撤退折回兵力池（§16.5；廉价兜底 survivors=0 时天然无回师）。**非关键 `applySweep`（NPC 扫荡）仍走廉价 `resolveSiege`**（§5.3）。
- **引擎侧两处小改**：①`@nw/engine` barrel 增导 `UNIT_BLUEPRINTS`/`ATTACK_LANES`/`BOARD_*`/`BOTTOM_SPAWN_ROW`/`TOP_SPAWN_ROW`/`UnitBlueprint`，让 worldsvc 合成布阵读「与引擎模拟同源」的棋盘几何 + 兵种 HP（不抄常量）；②`levelSchema.parseWaves` 放宽——siege 战斗（含 `attackerArmy`/`battleTimeoutTicks`）为纯预布无脚本波次，允许空 `waves.entries`（战役关仍要求 ≥1 波）。
- **engineVersion pin（U9）**：`runSiegeBattle` 喂 `ReplayInputSource` 空帧（纯预布无 live 指令），其构造按 `ENGINE_VERSION` 校验；worldsvc 随引擎版本重构建（D0+P2 代价）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + `build:web` + 293 测试全绿（levelSchema 放宽不破金回放/硬墙/确定性）；worldsvc e2e（`siege.e2e` 6 + `nation-bonus.e2e` 4）改断言为「方向+结构效应」（易主/残存>0/减员）并按引擎真实断点重校准国民加成用例（同 march seed 下 820 兵破 500 守军、破不了加成后 575 → 反证加成来自国籍），全绿。引擎单场约几千 tick≈10–100ms CPU（§16.3）。
- **未尽（移交 G3-2c）**：①布阵编辑器写真实 `tile.defense`/`playerWorld.teams[]` 取代 `synthesizeArmy` 兜底；②自定义布阵的国民加成；③客户端 `seed+双方布阵` 重播观战（`siege_result` 带 seed/布阵）；④删 S8-3b 残留 judge/peer 复算路径（`resolveSiegeWithJudge`/`getSiegeDefense` 等，手操方案作废后无调用方时清理）。

### 16.9 G3-2c：闭合围攻闭环（分四阶段，2026-06-21 起）

> 围攻承重墙（引擎权威）已合龙，但玩家侧入口/观战仍缺。G3-2c 闭合「玩家定布阵 → 出征 → 看战斗」闭环。分四阶段，每阶段 tsc + 测试验证后提交。

**Phase 1 — 服务端数据模型 + 契约 ✅（2026-06-21）**

兑现 §16.8 未尽 ①②③的服务端半截（④留 Phase 4）。逐函数核对落地：

- **数据模型（`worldsvc/src/db.ts`）**：新增 `ArmyEntry`（GarrisonEntry 可序列化镜像：unitType/col/row/initialHp）、`TeamTemplate`（`{id,name,army}`）；`PlayerWorldDoc.teams?`（≤ `SIEGE_TEAM_CAP`=5 支进攻布阵模板）、`MarchDoc.army?`（attack 挂队时的攻方布阵快照，出征后队伍可改不影响在途军）、`SiegeDoc.{seed,attackerArmy,defenderConfig,tileLevel}?`（关键围攻持久化重播输入）。
- **队伍 CRUD（`service.ts`）**：`getTeams`/`setTeams`——保存时校验「≤5 支 + id 唯一 + 每支 army 过引擎 `levelSchema`」（`siegeEngine.validateAttackerArmy`，非法即整组拒不落库）。`GET/PUT /world/teams`。
- **围攻挂队**：`startMarch` 加 `teamId?` 参数——attack 挂队 → committed 兵力 = 队伍各单位 `initialHp` 之和（覆盖 body `troops`）、army 快照随 `MarchDoc` 落库；池不足默认拒发（`NO_TROOPS`，§16.5 v1）。`applySiege` 用 `m.army ?? synthesizeArmy`（真实布阵优先，合成退为兜底）。`POST /world/march` 加 `teamId`。
- **自定义布阵国民加成（item②）**：`buildDefenderConfig(target, effGarrison, inOwnNation)`——自定义守方布阵在己方首府 Voronoi 区时，各单位 `initialHp` ×(1+`NATION_BONUS_DEFENSE`)（`siegeEngine.scaleArmyHp`，引擎 Unit 构造封顶满血，故未满血单位受益；合成路径仍走 `effGarrison` 多铺单位）。两路各只施加一次加成。
- **重播观战（item③ 服务端）**：`landSiege`/`recordSiege` 持久化 seed + 双方布阵 + 格等级到 `SiegeDoc`（廉价兜底/NPC 扫荡 `replay=null` → 无重播）。`getSiegeReplay`——攻守双方可读（旁观者拒），用持久化输入 `buildSiegeBattle` 重建 `level`（含 `attackerArmy`），客户端凭同 seed 空 `ReplayInputSource` headless 重跑逐字复现。`GET /world/siege/{id}/replay`。
- **代守（盟军可布）**：`setDefense` 放宽——己方领地或**同家族盟军**领地（`sameFamily`，与 `computeMarchPath` 关隘通行盟友判定一致；盟友宗门待联盟系统）均可布防；并加保存期 `validateDefenseConfig` 校验。
- **契约**：`openapi-world.yml` 加 `ArmyEntry`/`TeamTemplate`/`SiegeReplayView` schema + `/world/teams`(GET/PUT) + `/world/siege/{id}/replay`(GET) + march `teamId`；`rest:gen` 重生 `client/src/net/openapi-world.ts`。**proto 无改动**（重播按 siegeId 拉取，`SiegeResult` 推送字段不变）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` 全绿；worldsvc e2e 88 全绿（新增 `teams.e2e.test.ts` 3 例：队伍 CRUD 校验 / 挂队 committed+快照+权威围攻+可重播 / 兵力不足拒发；既有 siege/nation/march e2e 不破）。

**Phase 2 — 客户端布阵编辑器 + 队伍管理 ✅（2026-06-21）**

兑现 §16.8 未尽 ①的客户端半截（玩家可视化编辑攻方布阵 + 出征选队）：

- **`DefenseEditorScene` 推广为通用半场 UI**：加 `target` 判别联合（`{mode:'defense',tileKey}` | `{mode:'attack',teamId,teamName}`）。攻方模式 = 下半场出兵行（`ATTACK_ROWS=[8..1]`，1=出兵行在底）、调色板只列单位（无建筑/无基地强化）、footer 显 committed 兵力。守方模式行为逐字不变（建筑行 + garrison 16..9 + 基地步进）。攻方 load 走 `getTeams` 找槽位 → `applyArmy`；save 走 `getTeams`→替换该槽→`setTeams`。
- **每单位兵力**：v1 每单位以**满血容量**出战（`initialHp = UNIT_BLUEPRINTS[type].hp` = 兵力当量，§16.1）；committed 兵力 = 单位数 × 满血。**每单位兵力分配滑杆暂缓**（§16.2 提及，列为后续打磨——当前靠「摆多少兵种」控制军队规模已闭环）。
- **`TeamsScene`（新）**：列 5 槽位（committed 兵力 / 空），点槽位进编辑器；槽位 id/名固定 `t1..t5`（v1 不做自定义命名）。`TEAM_CAP=5` UI 常量（服务端 `SIEGE_TEAM_CAP` 权威）。
- **`WorldMapScene` 出征选队**：围攻入口从「派兵数对话框」改为 `showAttackTeamPicker`——列可用队伍（含 committed 兵力）+「管理队伍」入口；选队 → `doMarchTeam`（`startMarch` 挂 `teamId`，troops=1 占位由服务端覆盖）。空队伍 → 引导去管理。主城菜单加「管理队伍」入口。
- **接线**：`WorldApiClient` 加 `getTeams`/`setTeams`/`getSiegeReplay` + `startMarch` `teamId`；`AppViews`/`app.ts` 加 `showTeams`；`createAppCore` 加 `goTeams`/`goTeamEditor`，`goDefenseEditor` 改传 `target`；i18n `world.team.*` + `world.teams` zh/en/de。
- **验收**：client `tsc --noEmit` + 293 测试 + `build:web` 全绿；server 不动。

**Phase 3 — seed 重播观战改造 ✅（2026-06-21）**

兑现 §16.8 未尽③（客户端凭 seed + 双方布阵重播观战）：

- **`goSiegeReplay` 改纯演出**：从「跑 live 局 + 上传录像 judge 复算」（旧 S8-3b 模型）改为——拉 `getSiegeReplay`（seed + 双方布阵重建的 LevelDefinition）→ 构造 siege 模式空帧 `Replay`（无 live 指令）→ `views.showReplay` spectator 重跑，逐字复现 worldsvc 跑过的权威战斗。**无录像上传、无 judge**（引擎权威已在 worldsvc 落地）。攻守双方均可观战。
- **`ReplayScene` 推广**：构造加可选 `providedLevel` 参数——siege 重播的 level 含双方军（攻方 `attackerArmy` + 守方 garrison），不能由 campaign id 派生，直接传入；campaign 重播仍走 `getLevel(meta.levelId)`。endFrame = 战斗时限 + 余量（实际由 game-over 先停）。
- **接线**：`AppViews`/`app.ts` `showReplay` 加可选 `level`；createAppCore 去 `replayToUploadFrames` 死 import；`analytics.track('siege_replay')`。
- **验收**：client `tsc --noEmit` + 293 测试 + `build:web` 全绿。

**Phase 4 — 删 S8-3b judge/peer 死路径 ✅（2026-06-21）**

兑现 §16.8 未尽④（手操方案作废后清理无调用方的录像 judge 复算路径）：

- **worldsvc service.ts**：删 `getSiegeDefense` / `siegeDefenseConfig` / `resolveSiegeWithJudge`（C2 复盘 + S8-3b 录像复算）；去 `buildSiegeLevel` / `WorldJudgeArgs` import（`buildSiegeLevel` 仍在 shared 内部供 `buildSiegeBattle`）。保留 `getSiegeReplay`（新）。
- **worldsvc gatewayClient.ts**：删 `WorldJudgeArgs` / `WorldJudgeResult` / `judge()`（interface + `HttpWorldGatewayClient` impl + `nullWorldGatewayClient` + 4 个 e2e fakeGateway 桩）——worldsvc 不再调 gateway `/gw/judge`（关键围攻已在进程内跑引擎）。gateway 服务端 `/gw/judge` 基建保留（PvP/netplay peer-judge 仍用）。
- **httpApi.ts**：删 `GET /world/siege/{id}/defense` + `POST /world/siege/{id}/resolve` 路由。
- **客户端**：`WorldApiClient` 删 `getSiegeDefense` / `resolveSiege` / `SiegeResolvePayload` + `SiegeDefenseView`/`SiegeResolveResult` 别名；`WorldMapScene.onReplaySiege` 注释更新为「纯演出观战」。
- **契约**：`openapi-world.yml` 删两路径 + `SiegeDefenseView`/`SiegeResolveResult` schema；`rest:gen` 重生。proto 无改动（`SiegeResult.replayRef` 字段保留为空，无害遗留）。
- **验收**：server `tsc -b shared engine worldsvc gateway` + worldsvc e2e 88；client `tsc --noEmit` + 293 测试 + `build:web` 全绿。

> **G3-2c 四阶段全 ✅（2026-06-21）**：围攻闭环合龙——玩家可视化编辑攻守布阵、挂队出征、seed 重播观战，权威结果全程由 worldsvc 进程内引擎跑。承重墙 SLG11 至此完整兑现。剩 §16.5 DRAFT 数值调参（满血容量表/兵种当量/时限）+ 每单位兵力滑杆打磨。

## 17. SLG 大区赛季可编码实现规格（S8-7 + G2/G6/G7 收口）

> **✅ 已落地（2026-06-21）**：§17.1–§17.9 全部实现并测试通过（worldsvc 122 / admin 18 / metaserver 140 测试绿，全量 `tsc -b` 0 错）。
> - **§17.1 `@nw/shared`**（`slg.ts`/`api.ts`）：繁荣度常量 + `familyProsperity`/`decayProsperity` + `settleTier`/`SETTLE_REWARDS` + `sectStrengthScore`/`allocateSectsToShards`（蛇形均衡）+ `WORLD_CAPACITY`/`RESET_DELETE_BATCH`；`WorldStatus` 加 `resetting`；`PROSPERITY_TOO_LOW` 错误码。
> - **§17.2 `worldsvc/db.ts`**：`FamilyDoc` 补 `prosperity/prosperityUpdatedAt/activity`；`WorldDoc` 补 `engineVersion`；新集合 `seasonResults`（C2）+ 索引。
> - **§17.3 状态机**：`joinWorld` open→active CAS；settle 守卫 active/settling；reset 守卫 settling/resetting（dev/test 无 world 文档时容量守卫口径放行）。
> - **§17.4 繁荣度**：`prosperity.ts`（refresh/effective/aggregate）；占领/围攻 `bumpFamilyActivity`（$inc + 刷新）；建宗门门槛（`sectService`）。
> - **§17.5 发奖+落库**：worldsvc `mailClient`（复用 meta `/internal/mail/system/send`，meta 加 `accountId` 直投分支）；`settleSeason` 落 `seasonResults`（$setOnInsert 幂等）+ 逐主体 `expandToAccounts` 发奖（中原首府材料 ×2，dispatchKey 幂等）。
> - **§17.6 resetSeason**：resetting 中间态 + 幂等续跑 + `deleteInBatches` 分批删 + 家族赛季态归零 + `engineVersion` 重 pin。
> - **§17.7 admin（C4/G7）**：worldsvc `/admin/world/*` 迁出 JWT 改 `X-Internal-Key` + `GET /admin/world/list`；admin 后端 `worldClient` + `/admin/slg/season/*` + `/admin/slg/worlds`（能力 `slg.season.view/manage`，reset 前必 settle + 审计）。
> - **§17.9 engineVersion pin**：`openSeason`/`resetSeason` pin `ENGINE_VERSION`；`applySiege` 跑前漂移告警（不阻断）。
> - **DRAFT/后续（§17.12）**：数值待经济模拟；G6 多 shard 运行时调度、SLG 战令增益、称号 grantTitle(S10)、异常交易审计工单（OPS 专项）仍待。
>
> 本节把 §2.3 / §8.3 / S8-7 + 缺口 G2（繁荣度）/ G6（多大区分配）/ G7（admin 接入）细化到**字段/常量/函数签名/端点伪代码**级别，对齐现行 `worldsvc`（`service.ts` 1657–1837 五个赛季函数 + `db.ts` schema + `commercialClient`/`metaClient`）与 `metaserver`（`mail.ts`/`internal.ts`）代码。
> **范式同源**：与天梯 [`SEASON_DESIGN §13A/§13B`](SEASON_DESIGN.md)（commit 1c3f46cf）并列；天梯那轮逐文件核对发现 4 处代码冲突，本节核对 worldsvc 发现 **7 处**（§17.0）。
> **边界铁律**：本节任何实现**不得**触碰 meta `saves.pvp.*`（OVERVIEW §3.1 写入域隔离）——§17.10 给出代码层自检证明「无需改动即合规」。
> **本节作用域**（2026-06-21 拍板）：发奖走系统邮件；G6 只到「数据地基 + 算法规格」，多 shard 运行时调度单列后续任务；繁荣度家族+宗门双层（宗门 = 成员家族聚合）。

### 17.0 与现状的代码对齐修正（实现前必读，7 处）

逐函数核对现行 `worldsvc`/`metaserver` 后，§2.3/§8.3/S8-7 初稿有 7 处与现状冲突或缺口，**以本节为准**：

| # | 缺口/冲突 | 现状 | 修正（本节基准） |
|---|---|---|---|
| **C1 结算零发奖** | `settleSeason`（`service.ts:1728`）只算排名 `return`，**不发任何材料/皮肤/称号**；worldsvc **无邮件能力**（`metaClient` 仅 deduct/grantMaterial/getProfile） | meta 已有 `POST /internal/mail/system/send`（X-Internal-Key，OPS 补偿用，`internal.ts:163`）+ `insertSystemMail`/`bulkInsertSystemMail`（dispatchKey 幂等，`mail.ts:180/199`）+ `splitAttachments`（`coins`/`skin`/`item` 三 kind，`mail.ts:83`） | worldsvc 新增 `mailClient` 复用 meta `/internal/mail/system/send`；settle 发奖 = 邮件附件（材料=`item`、皮肤=`skin`、coin=`coins`）；**称号** = grantTitle TODO(S10) + 邮件正文写明（同天梯 §13A.0-C4），本轮不发 |
| **C2 排名不落库** | 排名仅 HTTP 响应返回，**12 集合无历史表**；G6「按宗门强弱平衡分配」所需历史排名**无数据源**（=天梯「战令依赖 RETENTION 未落地」同构） | `WorldCollections` 无 `seasonResults` | 新增 `seasonResults` 集合（§17.2），`settleSeason` 落库本季宗门排名 + 繁荣度快照，作为下季 G6 分配输入 |
| **C3 繁荣度死字段 + 定位错位** | `prosperity` 实际在 **`SectDoc`**（`db.ts:134`，建宗门设 0、永不更新）；**`FamilyDoc` 根本没有 prosperity 字段**（仅 `territoryCount`）。设计 §8.1/§15.1 G2 却都写「FamilyDoc.prosperity」 | `sectService.ts:164` 建门设 `prosperity:0`，无评分/衰减 | `FamilyDoc` 补 `prosperity` + `prosperityUpdatedAt`；`SectDoc.prosperity` 改为「成员家族繁荣度聚合」（§17.4）；建宗门门槛读家族繁荣度 |
| **C4 admin 端点未鉴权** | `/admin/world/{open,settle,reset,close}`（`httpApi.ts:515–541`）在 **JWT handler 内、无 X-Internal-Key**——任意登录玩家可调 `/admin/world/reset` 清整个大区。代码自认「生产应加 X-Internal-Key，P2 补」 | 天梯 roll 走 `/internal/*`+X-Internal-Key+admin 后端 | 四端点迁出 JWT 分支、改 `X-Internal-Key` 门控（§17.7）；admin 后端加 SLG 赛季运维代理（G7） |
| **C5 reset 非原子/非分批** | `resetSeason`（`service.ts:1795`）7×`deleteMany` 并发 `Promise.all`+2×update，万人级无分批、无幂等键、无中途失败保护；`status` 无中间态 | U13 列了原子性风险，未处理 | status 加 `resetting` 中间态 + 幂等守卫（settling→resetting→open）；大集合分批删（§17.6） |
| **C6 battlePass 死增益** | `buySlgShopItem`（`service.ts:1908`）写 `hasBattlePass:true`，**全代码无处读取给增益**（reset 删 playerWorld 时随之清除，这条本身 OK） | G4 | 本节不补战令增益（属 SLG 战令专项 S8-8，列 §17.12 待定）；仅确认 reset 清除路径正确 |
| **C7 engineVersion 未 pin** | `WorldDoc` 无 `engineVersion`；`SiegeDoc` 存 seed+布阵未记引擎版本，赛季中途升引擎重播/权威围攻一致性无锚点（U9） | `@nw/engine` 已导出 `ENGINE_VERSION`（§16.7） | `WorldDoc.engineVersion` 开服时 pin = `ENGINE_VERSION`；worldsvc 跑围攻校验 world pin vs 进程版本（§17.9） |

**死状态值修正**：`WorldStatus` 四段 `open/active/settling/closed` 中 **`active` 从无写入点**（join 接受 `open|active` 但从不置 `active`）。本节定义完整状态机（§17.3），首次有玩家 join 后 `open→active`。

### 17.1 `@nw/shared` 新增（`slg.ts`，常量 + 纯函数 + 类型）

紧挨现有 `SEASON_LENGTH_DAYS=60`（`slg.ts:164`）、`NATION_BONUS_*` 追加：

```ts
// ── 繁荣度（G2，§8.1）──────────────────────────────────────
/** 繁荣度评分权重（DRAFT，→ ECONOMY_NUMBERS §13-SLG 登记）。 */
export const PROSPERITY_W_TERRITORY = 10;   // 每块领地
export const PROSPERITY_W_MEMBER    = 50;   // 每个成员
export const PROSPERITY_W_ACTIVITY  = 5;    // 每点赛季活跃（新占领数+战斗场次，§17.4 来源）
/** 长期无活跃衰减：每自然日衰减比例（读时惰性结算，类比资源 yield）。 */
export const PROSPERITY_DECAY_PER_DAY = 0.05; // 5%/日
/** 建宗门繁荣度中等门槛（§8.2，U5 数值占位）。 */
export const SECT_FOUND_PROSPERITY_MIN = 2000;

/** 家族繁荣度纯函数：可单测、双端可算、整数化。activity = 赛季累计活跃点（§17.4）。 */
export function familyProsperity(territoryCount: number, memberCount: number, activity: number): number {
  return Math.floor(
    territoryCount * PROSPERITY_W_TERRITORY +
    memberCount * PROSPERITY_W_MEMBER +
    activity * PROSPERITY_W_ACTIVITY,
  );
}
/** 衰减：base 经过 dtDays 天后的衰减值（无活跃则缩水），floor 整数。 */
export function decayProsperity(base: number, dtDays: number): number {
  return Math.floor(base * Math.pow(1 - PROSPERITY_DECAY_PER_DAY, Math.max(0, dtDays)));
}

// ── 赛季结算奖励（§8.3，DRAFT → ECONOMY_NUMBERS §13-SLG）─────
/** 大比档位（按宗门占国数排名名次切档）。 */
export type SettleTier = 'champion' | 'top3' | 'top10' | 'participant';
export function settleTier(rank: number): SettleTier {
  if (rank === 1) return 'champion';
  if (rank <= 3) return 'top3';
  if (rank <= 10) return 'top10';
  return 'participant';
}
/** 各档奖励（材料 item / 皮肤 skin / 称号 titleId）。占位数值待经济模拟。 */
export interface SettleReward {
  items: Record<string, number>;     // 材料：{ scrap: N, lead: M, binding: K }
  skins: string[];                   // 皮肤 id（限定）
  titleId?: string;                  // 称号（grantTitle TODO S10，本轮仅邮件正文）
  coins?: number;                    // 可选 coin（须并入经济总预算，OVERVIEW §3.3）
}
export const SETTLE_REWARDS: Record<SettleTier, SettleReward> = {
  champion:    { items: { scrap: 500, lead: 200, binding: 50 }, skins: ['slg_champion_frame'], titleId: 'slg.champion', coins: 0 },
  top3:        { items: { scrap: 300, lead: 120, binding: 25 }, skins: [], titleId: 'slg.top3' },
  top10:       { items: { scrap: 150, lead: 60,  binding: 10 }, skins: [] },
  participant: { items: { scrap: 50,  lead: 20,  binding: 0  }, skins: [] },
};
/** 中原首府（capitalIdx 9，§2.4）占领加权：该档奖励材料 ×CENTER_CAPITAL_MULT。 */
export const CENTER_CAPITAL_IDX = 9;
export const CENTER_CAPITAL_MULT = 2;

// ── 引擎版本 pin（C7/U9）────────────────────────────────────
// ENGINE_VERSION 由 @nw/engine 导出；worldsvc 开服时写入 WorldDoc.engineVersion。
```

**G6 分配算法（纯函数，可单测，不碰 DB）**：

```ts
/** 一个宗门的「综合实力」输入（来自上季 seasonResults + 当前规模/繁荣度）。 */
export interface SectStrength {
  sectId: string;
  lastSeasonRank?: number;   // 上季大比名次（无 = 新宗门）
  memberFamilyCount: number;
  prosperity: number;        // 当前繁荣度聚合
}
/** 实力评分（越高越强）：历史排名为主（名次越小越强），规模/繁荣度为辅。DRAFT 权重。 */
export function sectStrengthScore(s: SectStrength): number {
  const rankScore = s.lastSeasonRank ? Math.max(0, 100 - s.lastSeasonRank) * 100 : 500; // 新宗门给中位
  return rankScore + s.memberFamilyCount * 50 + Math.floor(s.prosperity / 100);
}
/**
 * 蛇形（snake）均衡分配：按 score 降序，蛇形发牌到 shardCount 个大区，
 * 使各区强弱总和尽量持平（强宗门与弱宗门搭配，SLG3）。返回 sectId→shardIndex。
 * shardCount 由「∑成员人数 / 单区容量 向上取整」预先算出（§17.8）。
 */
export function allocateSectsToShards(sects: SectStrength[], shardCount: number): Map<string, number>;
//  实现：sort by score desc；蛇形游标 0,1,..,n-1,n-1,..,1,0,0,..；同宗门成员随宗门进同一 shard（成员粒度由调用方按 sectId 展开）。
```

**类型/枚举**：`WorldStatus` 扩 `'resetting'`（`shared/slg.ts` 枚举 + `db.ts` 引用同步）。

### 17.2 worldsvc 数据模型扩展（`db.ts`）

```ts
// FamilyDoc 补（C3）：
prosperity: number;            // 家族繁荣度（familyProsperity 算，读时惰性衰减）
prosperityUpdatedAt: number;   // ms，衰减锚点
activity: number;              // 赛季累计活跃点（新占领数 + 战斗场次，§17.4）

// SectDoc.prosperity 语义改为「成员家族繁荣度之和」（settleSeason / 建宗门门槛时聚合刷新）。

// WorldDoc 补（C7）：
engineVersion: number;         // 开服时 pin = ENGINE_VERSION

// 新集合 seasonResults（C2）——赛季结算历史，G6 分配输入：
export interface SeasonResultDoc {
  _id: string;                 // `${worldId}:s${season}`（幂等键）
  worldId: string;
  season: number;
  settledAt: number;
  ranking: Array<{
    rank: number;
    scope: 'sect' | 'family' | 'solo';
    id: string;                // sectId / familyId / ownerId
    name?: string;
    nationCount: number;
    capitalIdxs: number[];
    prosperity?: number;       // 结算时繁荣度快照（sect scope 才有意义）
    tier: SettleTier;
  }>;
}
// WorldCollections 加 seasonResults: Collection<SeasonResultDoc>;
// ensureIndexes 加：seasonResults.createIndex({ worldId: 1, season: -1 });
//                  families.createIndex({ worldId: 1, prosperity: -1 });  // 建宗门门槛/分配查询
```

### 17.3 赛季状态机（修正 `active` 死值 + 加 `resetting`）

```
open ──(首位玩家 join)──▶ active ──(POST /admin/world/settle)──▶ settling
                                                                    │
                          ┌──(POST /admin/world/reset)─────────────┘
                          ▼
                      resetting ──(清档完成)──▶ open ──(再开季 join)──▶ active
                          │
  active/settling ──(POST /admin/world/close)──▶ closed（归档，不再 join）
```

- `joinWorld`（`service.ts:320`）：进入时若 `status==='open'` → CAS 置 `active`（`updateOne({_id,status:'open'},{$set:{status:'active'}})`，幂等）。
- `settleSeason` 守卫：仅 `active`/`settling` 可结算（重入安全）。
- `resetSeason` 守卫：仅 `settling`/`resetting` 可重置（防越过结算直接清档丢历史；先 settle 落 `seasonResults` 再 reset）。

### 17.4 繁荣度评分 + 衰减 + 建宗门门槛（G2 / C3）

**活跃点累加（`activity`，服务器权威，无客户端写口）**——挂既有结算点 `$inc`：

| 触发点 | 现有函数 | 累加 |
|---|---|---|
| 占领新领地 | `occupyTile` / march `applyArrival` occupy | `families.$inc({activity: 1})`（占领者所属家族） |
| 围攻战（攻/守，关键战斗落地） | `landSiege`（`service.ts` G3-1） | 双方家族各 `$inc({activity: 1})` |

**繁荣度读时惰性结算**（类比资源 yield，不每日 tick）：读 `FamilyDoc` 时
`current = decayProsperity(familyProsperity(territoryCount, memberCount, activity), (now - prosperityUpdatedAt)/86400_000)`；
显式刷新点（占领/丢地/成员变动/settle）回写 `prosperity` + `prosperityUpdatedAt=now`。

**建宗门门槛（`sectService` 建门校验）**：现仅扣 5000 coin（`sectService.ts`）；加前置——发起家族 `prosperity ≥ SECT_FOUND_PROSPERITY_MIN`，否则 `SlgError('PROSPERITY_TOO_LOW')`（新错误码，接 `api.ts` + HTTP 400）。

**宗门繁荣度聚合**：`SectDoc.prosperity = ∑ 成员家族.prosperity`，在 settle / 建门 / G6 分配采集时刷新（`families.find({sectId}).reduce`）。

### 17.5 `settleSeason` 发奖改造（C1）+ 排名落库（C2）

**新增 worldsvc `mailClient`（复用 meta `/internal/mail/system/send`）**：

```ts
export interface WorldMailClient {
  readonly available: boolean;
  /** 系统邮件（dispatchKey 幂等，附件 coins/skin/item）。best-effort，失败 log 不阻断结算。 */
  sendSystemMail(accountId: string, dispatchKey: string, content: {
    subject: string; body: string;
    attachments?: Array<{ kind: 'coins' | 'skin' | 'item'; id?: string; count?: number }>;
    expireDays?: number;
  }): Promise<void>;
}
// HttpWorldMailClient → POST {baseUrl}/internal/mail/system/send (X-Internal-Key)
//   body: { accountId, dispatchKey, subject, body, attachments, expireDays }
// nullWorldMailClient: available=false, no-op（未配 NW_META_INTERNAL_URL）
```

**`settleSeason` 改造**（追加在现有排名计算之后，`service.ts:1777` return 前）：

```ts
async settleSeason(worldId) {
  // ...（现有 status→settling + 按 宗门→家族→个人 聚合排名，不变）...
  const ranking = [...agg.entries()].sort(...).map((e,i)=>({rank:i+1, ...}));

  // ① 落库历史（C2，幂等：_id = `${worldId}:s${season}`，$setOnInsert）
  const w = await cols.worlds.findOne({ _id: worldId });
  await cols.seasonResults.updateOne(
    { _id: `${worldId}:s${w.season}` },
    { $setOnInsert: { worldId, season: w.season, settledAt: now(),
        ranking: ranking.map(r => ({ ...r, tier: settleTier(r.rank),
          ...(r.scope==='sect' ? { prosperity: aggSectProsperity(r.familyId) } : {}) })) } },
    { upsert: true },
  );

  // ② 发奖（C1）——逐排名主体展开到「该主体下所有玩家账号」发邮件附件
  for (const r of ranking) {
    const tier = settleTier(r.rank);
    let reward = SETTLE_REWARDS[tier];
    if (r.capitalIdxs.includes(CENTER_CAPITAL_IDX)) {              // 中原加权（§2.4）
      reward = { ...reward, items: mapValues(reward.items, v => v * CENTER_CAPITAL_MULT) };
    }
    const accounts = await expandToAccounts(worldId, r.scope, r.familyId); // sect→成员家族成员 / family→成员 / solo→ownerId
    for (const acct of accounts) {
      void this.mail.sendSystemMail(acct, `slg-settle:${worldId}:s${w.season}`, {
        subject: 'slg.settle.subject',                            // i18n key
        body: `slg.settle.body|rank=${r.rank}|tier=${tier}|nations=${r.nationCount}`, // 含名次/段位/称号占位
        attachments: [
          ...Object.entries(reward.items).filter(([,n])=>n>0).map(([id,count])=>({kind:'item' as const, id, count})),
          ...reward.skins.map(id=>({kind:'skin' as const, id})),
          ...(reward.coins ? [{kind:'coins' as const, count:reward.coins}] : []),
        ],
        expireDays: 30,
      });
      // TODO(S10): if (reward.titleId) grantTitle(acct, reward.titleId)  —— 称号系统未实现（同天梯 §13A.0-C4）
    }
  }
  return ranking;
}
```

> **dispatchKey = `slg-settle:{worldId}:s{N}`**（同主体同账号幂等，重入不重复发——但注意：同一玩家若属多个排名主体不会发生，scope 互斥）。**coin 默认 0**（SLG settle 奖励以材料/皮肤为主，OVERVIEW §3.3 经济总预算口径；任何 coin 须经经济模拟批准）。

### 17.6 `resetSeason` 原子/分批/幂等改造（C5 / U13）

```ts
async resetSeason(worldId) {
  // ① 状态守卫 + 中间态（幂等：已 resetting 直接续跑）
  const w = await cols.worlds.findOneAndUpdate(
    { _id: worldId, status: { $in: ['settling', 'resetting'] } },
    { $set: { status: 'resetting' as const } },
  );
  if (!w) throw new SlgError('WORLD_CLOSED', '须先 settle 再 reset'); // 防跳过结算丢历史

  // ② 分批删大集合（tiles/marches/playerWorld/sieges 可能万级；每批 BATCH=2000，让出事件循环）
  const deleted = {};
  for (const c of ['tiles','marches','playerWorld','nations','sieges','sects','sectMessages']) {
    deleted[c] = await deleteInBatches(cols[c], { worldId }, RESET_DELETE_BATCH); // 循环 deleteMany(limit) / 游标删
  }
  // ③ 家族编制保留（成员关系/coin/养成跨季留存）但清赛季态：繁荣度/活跃/territory/宗门归属归零
  await cols.families.updateMany({ worldId },
    { $set: { territoryCount: 0, prosperity: 0, activity: 0, prosperityUpdatedAt: now() }, $unset: { sectId: '' } });

  // ④ 重开（engineVersion 重新 pin 当前进程版本，C7）
  await cols.worlds.updateOne({ _id: worldId },
    { $set: { status: 'open' as const, population: 0, resetAt: now(), engineVersion: ENGINE_VERSION }, $inc: { rev: 1 } });
  await this.initNations(worldId);
  return { deleted };
}
```

> **新常量** `RESET_DELETE_BATCH = 2000`（`shared/slg.ts`）。**幂等**：`resetting` 中途崩溃 → 重调从 `resetting` 续跑（删已删的是 no-op，最终一致）。**赛季资源清零原子性（U13）**：playerWorld 整文档删除 = 粮/铁/木一并清，无「半清」中间值可被惰性结算读到（删后玩家 re-join 走 `joinWorld` 重建初始态）。

### 17.7 admin 鉴权 + admin 后端 SLG 接入（C4 / G7）

**worldsvc 侧**：`/admin/world/{open,settle,reset,close}` 四端点**迁出 JWT 分支**，改 `X-Internal-Key` 门控（与 commercial/meta `/internal/*` 同模式）。在 `httpApi.ts` JWT 鉴权之前加内部分支：

```ts
// 内部运维分支（X-Internal-Key，不走 JWT）
if (path.startsWith('/admin/world/')) {
  if (req.headers['x-internal-key'] !== INTERNAL_KEY) return sendErr(res, ErrorCode.UNAUTHORIZED);
  // open / settle / reset / close（逻辑不变，鉴权升级）
}
```

**admin 后端侧（G7，`server/admin/src` 当前 SLG 零命中）**：新增 worldsvc 代理 + 工单：
- `worldClient`（admin→worldsvc 内部 HTTP，X-Internal-Key）：`openWorld/settleWorld/resetWorld/closeWorld/listWorlds`。
- admin REST（管理员鉴权，OPS 复用）：`POST /admin/slg/season/{open,settle,reset,close}` + `GET /admin/slg/worlds`（列各大区 status/population/resetAt）。
- **运维序列约束**（admin 后端 enforce）：reset 前必须 settle（否则丢 `seasonResults`），UI 按钮顺序 open→（运营期）→settle→reset→close；临近 `openAt + SEASON_LENGTH_DAYS` 高亮（不自动切，同天梯手动 roll）。
- **异常交易审计工单**（SLG9 反 RMT，G7 半截）：复用 OPS 补偿工单基建，拍卖异常模式（高频自卖自买/定向倒货）进审计队列——本轮列规格，落地随 OPS 专项（§17.12）。

### 17.8 G6 多大区 + 按宗门强弱平衡分配（数据地基 + 算法规格，运行时延后）

> 本轮拍板：**只做数据地基 + 纯算法规格**（§17.1 `allocateSectsToShards` + §17.2 `seasonResults`）；**多 shard 运行时调度**（按人口开新区、跨区迁移玩家/宗门、行军/拍卖跨区隔离巡检）单列后续任务。

**分配触发时机**：新赛季 open 前（admin 操作），读上季 `seasonResults` + 当前 `sects`/`families`：

```
1. 采集 SectStrength[]：每宗门 { sectId, lastSeasonRank(从上季 seasonResults.ranking 查 scope==='sect'),
                                 memberFamilyCount, prosperity(成员家族聚合) }
2. shardCount = ceil(∑所有宗门成员人数 / WORLD_CAPACITY)   // WORLD_CAPACITY 默认 10000（openSeason capacity 参数）
3. assignment = allocateSectsToShards(SectStrength[], shardCount)   // 蛇形均衡
4. 同宗门成员随 sectId 进同一 shard；散家族/散人按家族强弱补位（次轮）
5. 对每个 shardIndex 调 openSeason(`s{season}-{shardIndex}`, season, shardIndex, WORLD_CAPACITY)
```

**数据源缺口确认**（=天梯「战令依赖 RETENTION」同构）：在 `seasonResults` 落库（§17.5 ①）**之前**，G6 分配**无任何历史排名可读** → 首季所有宗门 `lastSeasonRank=undefined`（`sectStrengthScore` 给中位 500，纯按规模/繁荣度分配）；第二季起 `seasonResults` 提供历史。**这是为什么 §17.5 的排名落库是 G6 的硬前置**。

**新常量** `WORLD_CAPACITY = 10000`（`shared/slg.ts`，替代 `openSeason` 硬编码 `10000` 默认）。

### 17.9 engineVersion pin（C7 / U9）

- `openSeason` 写 `WorldDoc.engineVersion = ENGINE_VERSION`（`@nw/engine` 导出，§16.7）；`resetSeason` 重 pin（§17.6 ④）。
- `applySiege`/`runSiegeBattle`（`siegeEngine.ts`，§16.8）跑围攻前校验：`world.engineVersion === ENGINE_VERSION`？不一致 → log 警告（赛季中途引擎升级未重开区），**v1 仍按当前进程版本跑**（不阻断），但 `getSiegeReplay` 重播在版本漂移时标注「可能不一致」。
- **赛季中途升引擎的运维口径**：优先「赛季结束后再升引擎 + 重开区重 pin」；紧急修复须升级时，已落地 `SiegeDoc` 重播可能逐帧漂移（D0+P2 已知代价，U9）。

### 17.10 互不干涉契约自检（OVERVIEW §3，确认无需改动即合规）

逐写集合核对，证明 SLG 赛季重置/结算**天然不触碰天梯**：

| 操作 | 写集合 | 触碰 `saves.pvp.*`？ |
|---|---|---|
| `settleSeason` | world 库 `worlds`/`seasonResults` + meta `/internal/mail/system/send`（邮件，附件领取才入账，**不写 saves.pvp**）+ commercial.grant（coin，**不写 saves.wallet**） | **否** ✓ |
| `resetSeason` | world 库 7 集合 deleteMany + `families` updateMany + `worlds` | **否** ✓（养成/段位/coin/皮肤全在 meta saves，worldsvc 物理无连接） |
| 繁荣度/活跃累加 | world 库 `families.$inc` | **否** ✓ |

> **结论**：与天梯侧不同（天梯软重置就写在 `saves.pvp` 同档，须小心隔离），**SLG worldsvc 进程从不连 meta saves 库**——隔离是架构级保证，本节实现无需额外隔离代码。唯一共享触点 = 发奖（邮件/coin 经 meta/commercial 内部 HTTP），且都走「玩家领取才入账」或「commercial 权威」，不直写跨季资产（OVERVIEW §3.2/§3.3）。

### 17.11 测试要点

- **纯函数单测（always-run）**：`familyProsperity`/`decayProsperity`（边界 0/无活跃衰减）、`settleTier`（名次切档边界 1/3/10/11）、`sectStrengthScore`（新宗门中位/有历史）、`allocateSectsToShards`（蛇形均衡：各 shard 强弱总和差 ≤ 最强单体；同宗门不拆分）。
- **worldsvc e2e**：
  - settle 发奖一次性（同 `slg-settle` dispatchKey 重入不重复发，fakeMailClient 断言收件人 × 附件）；中原首府占领者材料 ×2。
  - settle 落 `seasonResults`（幂等 `_id`，重入不覆盖）；下季 G6 `allocateSectsToShards` 读到上季 rank。
  - reset 幂等（`resetting` 中途模拟崩溃后重调，最终各集合清空 + status=open + engineVersion 重 pin）；reset 前未 settle → `WORLD_CLOSED` 拒绝。
  - 建宗门繁荣度门槛（`PROSPERITY_TOO_LOW` 拦截不足者）；繁荣度活跃累加（占领/围攻 `$inc activity`）。
  - admin 端点 X-Internal-Key 门控（无 key 401，有 key 通）；JWT 玩家调 `/admin/world/reset` 被拒。
  - **隔离回归**：settle/reset 后断言 meta `saves.pvp` 不变（OVERVIEW §3.1，跨进程 e2e 或桩断言 worldsvc 无 saves 写）。

### 17.12 DRAFT 数值 / 后续任务（待拍板/调参/单列）

- **数值（→ ECONOMY_NUMBERS §13-SLG 登记 + 经济模拟）**：`PROSPERITY_W_*`/`PROSPERITY_DECAY_PER_DAY`/`SECT_FOUND_PROSPERITY_MIN`；`SETTLE_REWARDS` 各档材料/皮肤量 + `CENTER_CAPITAL_MULT`；`sectStrengthScore` 权重；`WORLD_CAPACITY`/`RESET_DELETE_BATCH`。settle coin 若 >0 须经经济总预算批准（OVERVIEW §3.3）。
- **G6 运行时（单列任务）**：多 shard 实际开区调度、人口溢出触发开新区、跨区玩家/宗门迁移、行军/拍卖跨区隔离巡检（§17.8 只到算法+数据）。
- **SLG 战令增益（C6/G4，属 S8-8 战令专项）**：`hasBattlePass` 当前死字段——增益效果（加速/产率/额外奖励档）随 SLG 赛季战令专项落地，与天梯战令独立（OVERVIEW §2/§4）。
- **称号（C1 TODO）**：`SETTLE_REWARDS.titleId` 的 `grantTitle` 接入待 `TITLE_DESIGN` S10；本轮仅邮件正文写明（仪式感先到位，同天梯 §13A.0-C4）。
- **异常交易审计工单（G7 半截）**：拍卖反 RMT 审计落地随 OPS 专项（§17.7 已列规格）。
- **G5 视野系统 / G8 险地**：与赛季正交，各自专项（§15.2）。G5 已启动 → §18。

---

## 18. G5 视野 / 迷雾系统（2026-06-21 拍板，§8.2 / §2.1 / §15.2 G5）

> 兑现「加家族才守得住」留存逻辑的关键拼图：服务端此前整图全可见（grep `fog/vision/scout` 零命中）。本节定基准并记录实现。**拍板（2026-06-21，用户）见下表**；G5-1 服务端读路径门控已 ✅。

### 18.1 五项拍板

| # | 决策 | 结论 |
|---|---|---|
| **V1 迷雾模型** | 永久黑雾 vs 战争迷雾 | **2a**：地形层（程序化、确定性）**全图始终可见**；动态层（归属/驻军/防守/保护罩/行军）仅当前视野内可见，视野外**退回 `proceduralTile` 底层地形**（连「已被占领」信号都不泄露——type 不返 `territory`/`base`）。不做持久化 explored-set 黑雾——地形不是秘密，机密是动态层。 |
| **V2 视野来源 + 共享** | 半径来源 / 共享到哪一级 | 己方领地半径 `VISION_TERRITORY_RADIUS=2` + 主城 `VISION_BASE_RADIUS=5` + 在途行军 `VISION_MARCH_RADIUS=2`（侦察行军价值）。**共享 = 家族级（≤30）**，复用 `sameFamily`/`familyMembers` 反查。**§8.2 字面「宗门级共享」降级为家族级**——宗门 900 人并集近乎整图，迷雾名存实亡；宗门/联盟只做领地颜色标记不并视野。`scout` 侦察行军 kind 已落地（§18.8，半径 `VISION_SCOUT_RADIUS=4`、不打不占自动回师）；瞭望塔建筑已落地（§18.9，`VISION_WATCHTOWER_RADIUS=8` 固定半径持久视野源）。 |
| **V3 计算/存储** | 实时算 vs 落库 | **实时算 + 短 TTL 缓存（缓存留后续），vision 零落库**（避 U11 规模爆炸）。视区半径有 `MAP_VIEW_MAX_RADIUS=40` 上限，计算量有界；源领地查询复用 `{ownerId}` 索引。 |
| **V4 推送门控** | 读路径门控 / 反向视野推送 | **v1 即做反向视野推送**（用户拍板，覆盖初版「仅读路径」建议）。工程化:反向查询**只在「行军发起 / 格易主」两个低频事件点做一次**（查路径沿途半径内有视野源的玩家 → 一次性推完整 `march_update`/`tile_update`，客户端在自己视野内的路径段渲染），**不逐 tick 反向扇出**（避 U11）。`under_attack` 仍无条件发防守方（§16 布阵预设=反应窗口）。→ G5-2。 |
| **V5 客户端表现** | 雾渲染 + 标记色 | 视野外铅笔灰雾半透明覆盖（手绘风，SketchPen 烘焙）、去动态层；标记色对齐「我蓝敌红」v0.3：自己=蓝、家族/同盟友=青/绿（第三友方色）、联盟宗门=黄描边标记（不共享视野，§8.2）、敌方=红、中立=纸面本色。→ G5-3。 |

### 18.2 视野原语（`shared/slg.ts`）

- 常量 `VISION_TERRITORY_RADIUS` / `VISION_BASE_RADIUS` / `VISION_MARCH_RADIUS`（DRAFT）。
- `VisionSource{x,y,radius}`；`isInVision(sources, x, y)`：Chebyshev（方形）距离判可见，纯函数双端可算。
- `marchInterpPos(fromX,fromY,toX,toY,departAt,arriveAt,now)`：行军当前位置线性插值（路径绕障故为近似，足够圈视野）。

### 18.3 分片

- **G5-1 shared 原语 + 服务端读路径门控 ✅（2026-06-21）**：见 §18.4。
- **G5-2 反向视野推送 ✅（2026-06-21）**：`startMarch` / 格易主（occupy/landSiege/relocate）做一次反向视野查询 → 给视野内观察者推 `march_update`/`tile_update`（敌方行军进我视野即推，V4）。见 §18.5。
- **G5-3 客户端渲染 ✅（2026-06-21）**：`WorldMapScene` 灰雾覆盖 + 友/敌标记色 + 视野内敌军渲染（含 server 侧 `ally`/`getMarches` 视野门控）。见 §18.6。
- **联盟（宗门）领地黄描边标记 ✅（2026-06-21）**：`WorldTileView.allySect` + `allySectMemberIds`（family→sect→allySectIds→成员链路），客户端金琥珀内描边；联盟不共享视野、仅标记（§8.2 V5）。见 §18.7。

### 18.4 G5-1 实现记录（2026-06-21）

- **shared**：§18.2 原语（`VISION_*` 常量 + `VisionSource` + `isInVision` + `marchInterpPos`）。
- **worldsvc `service.ts`**：
  - `computeVisionSources(worldId,accountId,x0,x1,y0,y1)`：视野源主人 = 自己 ∪ 同家族成员（`familyMembers` 反查；**注意 `occupyTile` 不写 `tile.familyId`，故不能靠 tile.familyId，必须按 `ownerId:{$in: 成员}` 取源格**）。源领地在视区按 `VISION_BASE_RADIUS` 外扩查询（半径外的领地照亮视区边缘）；`type:'base'` 给大半径、其余领地小半径；在途己方/家族 `marching` 行军按 `marchInterpPos` 插值当前位置 + `VISION_MARCH_RADIUS`。
  - `getMap`：建可见集 → 逐格门控。视野外 push `{...proceduralView, visible:false}`（隐去动态层 + 占领信号）；视野内 `{...tileDocView/proceduralView, visible:true}`。**profile 拉档仅对「可见的他人领地」**（视野外不显归属，省 meta 负载）。
  - `getTile`：同口径门控（视野外 `{...proceduralView, visible:false}`），防 getTile 绕过迷雾。
  - `WorldTileView.visible?:boolean`（仅 getMap/getTile 视区读填充；occupy 等单格响应不带）。
- **契约**：`openapi-world.yml` `WorldTileView.visible`；`rest:gen` 重生 `openapi-world.ts`。proto 无改动（G5-1 不动推送）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` 全绿；worldsvc **93 e2e**（新增 `fog.e2e.test.ts` 5 例：视野内动态可见 / 视野外退程序化地形隐占领 / getTile 同口径 / 家族共享远处领地 / 在途行军照亮路径 + 对照迷雾；既有 88 不破，因视野外退回 `proceduralView` 与原程序化默认逐字一致，且正向动态断言均落在请求者己方格=恒在视野）。

### 18.5 G5-2 实现记录（2026-06-21）

- **反向视野查询（`service.ts`）**：
  - `visionObservers(worldId, cells, exclude)`：找出视野半径罩住 `cells` 中任一格的「领地/主城主人」账号集（`type:'base'` 用 `VISION_BASE_RADIUS`、领地用 `VISION_TERRITORY_RADIUS`，Chebyshev）。在 cells 包围盒按 `VISION_BASE_RADIUS` 外扩查有主格，逐格判命中即收。**只在低频事件点调用一次（非逐 tick）**，避 U11 反向扇出爆炸。**v1 只取领地主人本人**（家族成员实时扇出留后续——他们经家族共享 getMap 轮询亦可见）。
  - `pushTileToObservers(tile, exclude)`：包一层，对单格变更推 `tile_update` 给观察者。
- **事件点接入**：
  - **行军发起 `startMarch`**：复用已算出的 `path`（A* 全路径，比直线包围盒更准）反向查观察者 → 推 `march_update`。守方（attack）已单独收 `under_attack`，连同行军主一起从观察者集排除（避重复）。`march_update` 载荷无 troops 字段——敌方观察者看得见行军路线/ETA/类型但**不知兵力**，合理的侦察信息粒度。
  - **格易主/新领地**：直占 `occupyTile`、行军到点占领、围攻 `landSiege` 易主、主动/被动迁城新主城——五处在原 owner/defender `pushTile` 之后加 `pushTileToObservers`（排除已单独推过的当事人）。增援不接（garrison 不在 `tile_update` 载荷，无观察者价值）。
- **关键修复（async 时序）**：观察者推送内含 DB 查询（`visionObservers` await），不能 `void` fire-and-forget——否则事件函数返回时推送尚未发出（owner 的同步 `pushTile`/`pushMarch` 不受影响，但观察者推送会丢）。五处 `pushTileToObservers` 与 startMarch 的观察者推送全部 **`await`**，确保 `processDueArrivals`/`startMarch` 返回时推送已落。
- **契约**：proto / openapi 均无改动——`march_update`/`tile_update` 推送通道既有，G5-2 纯服务端逻辑（推送给更多收件人，载荷不变）。
- **验收**：server `tsc -b` 全绿；worldsvc **96 e2e**（新增 `vision-push.e2e.test.ts` 3 例：行军进观察者视野推 march_update + 远端不推 / 直占新领地推 tile_update + 占领者不重复推 + 远端不推 / 围攻易主对第三方观察者推；既有 93 不破——awaited 观察者推送不改既有 owner/defender 推送断言）。

### 18.6 G5-3 实现记录（2026-06-21）

> 客户端把迷雾「画出来」+ 友/敌正确上色 + 让 G5-2 反向推送的敌军真正显形。为正确性需配套两处小 server 改动（家族盟友领地原本会显示为敌色；`getMarches` 原只返己方行军，敌军推送后客户端 refetch 拿不到）。

- **server（小补）**：
  - `WorldTileView.ally?:boolean`——`getMap` 用家族成员集（`familyMemberIds`，从 `computeVisionSources` 抽出复用）标记「可见、非己方、同家族」的格。解决家族共享视野后盟友领地显示为敌色的正确性 bug（`tile.familyId` 占领不写，靠成员集判定）。
  - `MarchView.mine?:boolean` + `getMarches` 扩展：己方行军（mine:true）+ **视野内的非家族敌方在途行军**（mine:false，按 `marchInterpPos` 当前位置过 `isInVision`，视野源取全图 `computeVisionSources(0,mapW-1,0,mapH-1)`）。这是 G5-2 反向 `march_update` 推送在客户端「refetch-on-push」模型下真正显形的数据源。家族友军行军不计入（友方靠家族集）。
  - 契约 `openapi-world.yml`：`WorldTileView.ally` + `MarchView.mine`；`rest:gen` 重生。proto 无改动。
- **client `WorldMapScene.ts`**：
  - **灰雾**：`tile.visible===false` 的格画底层地形后罩一层 `FOG_COLOR=0x6b6458 @0.4` 铅笔灰（地形可见、局势看不清，对齐迷雾模型 2a）；视野外不画等级点（不暴露细节）。
  - **标记色**（沿用本场景既有「敌蓝我红」约定）：自己=红（`MINE_*`）、**家族盟友=绿（新 `ALLY_TINT/ALLY_BASE_TINT`，友方第三色）**、敌方=蓝（`ENEMY_*`）、中立=纸面。`tileColor` 加 `ally→绿` 分支（在 mine 之后、occupied 之前）。
  - **敌军行军**：march 箭头 `march.mine===false` → 统一敌色（蓝）+ 更粗描边 + 更大终点点，突出威胁；己方按 kind 上色。HUD 行军列表过滤为 `mine!==false`（敌方行军不可撤、不进列表）。
  - 既有 `applyMarchUpdate`→`refreshMarches()` / `applyTileUpdate`→`loadMapViewport()` 的 refetch-on-push 通道不变——G5-2 推送触发 refetch，新 `getMarches`/`getMap` 门控返回视野内敌情，自动显形。
- **scout 行军**：已落地（§18.8，2026-06-21）。**瞭望塔**：已落地（§18.9，2026-06-21）——己方领地建固定半径（8）持久视野源。
- **验收**：client `tsc --noEmit` + **293 测试** + `build:web` 全绿；server `tsc -b` 全绿；worldsvc **97 e2e**（vision-push +1：`getMarches` 己方 mine:true / 视野内敌方 mine:false / 视野外不返回；fog 家族用例加 `ally:true` 断言）。

### 18.7 联盟（宗门）领地黄描边标记实现记录（2026-06-21，§8.1 V5 余项）

> §8.2「盟友不共享视野、仅地图颜色标记区分」：联盟宗门成员的领地**不并入视野**（看不见远处联盟领地），只在它**恰好落进请求者自身/家族视野**时打一个标记 → 客户端黄描边。与家族盟友（`ally`，绿色满涂、共享视野）正交且互斥。

- **server（`service.ts`）**：
  - `WorldTileView.allySect?:boolean`——可见、非己方、非家族、且归「本宗门联盟宗门」成员所有的格。
  - `allySectMemberIds(worldId, accountId)`：链路 `accountId → familyMembers → family.sectId → sect.allySectIds（≤2）→ 各联盟宗门成员家族 → 成员 accountId 集`。无宗门/无联盟 → 空集；不含自己/同家族（那些归 `familyMemberIds`）。**不参与 `computeVisionSources`**（联盟不照亮视野，仅标记）。
  - `getMap`：算 `allySect` 集一次；逐格 `allied = !ally && 可见他人格 && allySect.has(owner)` → 置 `allySect:true`（家族 `ally` 优先，二者互斥）。`getTile`/`occupy` 等单格响应不带（同 `ally`/`visible`，仅视区读填充）。
  - 每次 getMap 多 3~4 次小查询（familyMember/family/sect/成员家族+成员），V3 短 TTL 缓存仍列后续。
- **契约 `openapi-world.yml`**：`WorldTileView.allySect`；`rest:gen` 重生 `openapi-world.ts`。proto 无改动（标记走 getMap 读路径，不动推送）。
- **client `WorldMapScene.ts`**：`ALLY_SECT_BORDER=0xe6a817`（金琥珀）内描边（`px+1.5, TILE_PX-4`，1.5px）——刻意区别于首府星标/选区的亮黄 `0xffcc00`（满边+填充）。填充仍走 `tileColor`（联盟领地是他人占领格，底色保持敌色蓝，黄描边叠加区分「勿攻」）；视野外（fogged）不画描边。**联盟「禁止进攻/夺地」的战斗约束属联盟系统专项，非 G5 视野范围，不在本片实现**。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + `build:web` 全绿；worldsvc **100 e2e**（新增 `alliance-mark.e2e.test.ts` 3 例：视野内联盟领地标 `allySect`、敌方/家族不标 / 联盟不共享视野远处仍迷雾不标 / 解盟后视野内他人领地不再标；既有 97 不破）。

### 18.8 scout 侦察行军实现记录（2026-06-21，§18.1 V2 余项）

> 把 §18.1 V2「scout 行军 kind」从「列 v2」兑现：新增**不打不占的侦察行军**——派少量兵到任意非障碍格（含敌方/中立/保护中/中心），沿途 + 抵达点照亮一片**更大**视野后**自动回师**。普通行军已是视野源（半径 2），scout 的差异价值 = 更深的视野半径 + 不触发战斗。

- **shared（`slg.ts`）**：`MarchKind` 加 `'scout'`；新常量 `VISION_SCOUT_RADIUS = 4`（DRAFT，> 普通行军 `VISION_MARCH_RADIUS=2`，「探得更深」）。
- **worldsvc（`service.ts`）**：
  - `MARCHABLE_KINDS` 加 `'scout'`；新 helper `marchVisionRadius(kind)` = scout→4 / 其余→2，`computeVisionSources` 在途行军视野源按此取半径（`getMarches` 的全图视野源同步生效，敌方 scout 进我视野亦显形）。
  - `startMarch`：新 scout 分支——无归属/中心/保护期限制（仅上方拦掉障碍地形），不设 `defenderId`（**不发 `under_attack` 预警**，侦察非进攻）。反向视野推送仍照常（敌方观察者沿路看得见斥候，载荷无兵力，合理侦察粒度）。
  - `applyArrival`：新 scout 分支 → `autoReturnScout(m,t)`：到点不打不占，自动生成一条 `kind:'return'` 返程腿（target→origin、原兵力、返程耗时 = 去程耗时对称近似），途中继续提供视野，到点 `return` 退兵回池。
- **契约**：`openapi-world.yml` 两处 enum（`MarchView.kind` + `startMarch.kind`）加 `scout`，`rest:gen` 重生 `openapi-world.ts`；`transport.proto` `MarchUpdate.kind` 注释补 `scout`（string 字段，无需重生 proto）。`WorldApiClient.startMarch` 的 `MarchKind = Exclude<MarchView['kind'],'return'>` 自动纳入 scout。
- **client（`WorldMapScene.ts`）**：`DeployKind` 加 `'scout'`；敌方格 + 中立/未知格菜单加「侦察」按钮 → `doScout(tx,ty)` **直接派 1 名斥候**（不走派兵数对话框，侦察讲究轻量、不锁大军）；行军箭头 scout=紫 `0x9b59b6`、HUD 图标 `🔭`。i18n `world.actScout` / `world.scoutSent`（en/zh/de）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + **293 测试** + `build:web` 全绿；worldsvc **103 e2e**（新增 `scout.e2e.test.ts` 3 例：侦察敌方格不占不发预警归属不变 / 视野深度 chebyshev≤4 可见 >4 迷雾 / 到点自动回师且全程不占地兵力归池；既有 100 不破）。

### 18.9 瞭望塔（Watchtower）实现记录（2026-06-21，§18.1 V2 最后余项）

> 把 §18.1 V2「瞭望塔建筑——固定半径持久视野源」从「列 v2」兑现：在**己方领地**花资源建塔，该格升级为**最大半径**（`VISION_WATCHTOWER_RADIUS=8` > 主城 5）持久视野源。区别于 scout（一次性照路后回师）：瞭望塔是**主动布点扩视野**的永久手段——「想看哪、就在哪建塔守着」。落库随 `TileDoc`（丢地即随格子消失，无单独退还），符合 V3「vision 零落库，但塔标记本身落库、视野仍读时实时算」。

- **shared（`slg.ts`）**：`VISION_WATCHTOWER_RADIUS=8`（DRAFT，最大视野源）；`VISION_MAX_RADIUS=max(全部视野半径)`（外扩查询 pad 统一用，须覆盖最大半径源以免漏照视区边缘）；`WATCHTOWER_COST={food:0,iron:2000,wood:3000}`（DRAFT，资源非金币——视野扩张是建造行为）。
- **worldsvc（`db.ts`/`service.ts`）**：`TileDoc.watchtower?:boolean`。新 helper `tileVisionRadius(t)` = watchtower→8 / base→5 / 其余领地→2，`computeVisionSources` 与反向 `visionObservers` 的静态源半径统一走它（两处 pad `VISION_BASE_RADIUS`→`VISION_MAX_RADIUS`，否则瞭望塔半径外的塔照不亮视区边缘 / 反向漏查塔观察者）。新 `buildWatchtower(worldId,accountId,x,y)`：校验己方领地（`TILE_NOT_OWNED`）+ 非主城（`BAD_REQUEST`，主城自带视野）+ 结算后资源充足（`INSUFFICIENT_RESOURCES`，不足不动地图）；扣 `WATCHTOWER_COST` → `$set tile.watchtower=true` → 推 `tile_update`（owner refetch 触发新视野下次 getMap 生效）+ `pushTileToObservers`（塔是可见结构，视野内观察者亦见）。幂等：已有塔直接返回视图、不重复扣费。`tileDocView` 透出 `watchtower`。
- **契约**：`openapi-world.yml` `WorldTileView.watchtower` + `POST /world/watchtower`（返 `WorldTileView`）；`rest:gen` 重生 `openapi-world.ts`。proto 无改动（建塔走 REST，视野扩张走既有 getMap/tile_update 读推路径）。
- **client（`WorldMapScene.ts`）**：己方领地（非主城）菜单加「建瞭望塔」按钮（已有塔则隐去、改在标题显「🗼 已建瞭望塔」）→ `confirmWatchtower`（展示资源花费二确认）→ `doWatchtower`（建塔 → 刷新 me 资源 + 清 tileCache 整块重拉显形扩张视野 + toast）；地图渲染：可见格 `tile.watchtower` 画手绘小塔（米白塔身 + 深墨三角顶）。`WorldApiClient.buildWatchtower`。i18n `world.actWatchtower`/`hasWatchtower`/`watchtowerTitle`/`watchtowerConfirm`/`watchtowerBtn`/`watchtowerBuilt`（zh/en/de）。
- **验收**：server `tsc -b shared engine worldsvc gateway` 全绿；client `tsc --noEmit` + `build:web` 全绿 + 312 测试通过（1 例 `headless-nav` 因 S9 成就 stub 缺 `applyAchievementBadge` 预先失败，与本片无关）；worldsvc **141 e2e**（新增 `watchtower.e2e.test.ts` 6 例：建塔扣资源+置标记+视图透出 / 扩视野原迷雾远格建塔后可见且超半径仍迷雾 / 非己方拒绝 / 主城拒绝 / 资源不足拒绝不动地图 / 幂等不重复扣费；既有 135 不破）。

> **G5 视野/迷雾全 ✅（2026-06-21）**：读路径门控（G5-1）+ 反向视野推送（G5-2）+ 客户端渲染（G5-3）+ 联盟领地黄标（§18.7）+ scout 侦察行军（§18.8）+ **瞭望塔建筑（§18.9）**。「加家族才守得住」的视野维度**完整闭环**——地形全见、敌情藏雾、家族共享、侦察行军照路（含深探斥候）、瞭望塔主动布点固定视野、敌军进视野即现、联盟领地黄描边勿攻。V2 余项全部兑现。

## 19. G8 险地（Stronghold）实现记录（2026-06-21，§3.1 / §15.2 G8）

高战略价值 PvE 格补齐。险地 = 系统超强 NPC 驻守的程序化格，**不可直占/扫荡，只能围攻 attack 攻克**；攻克即占为领地（高产出 + 战略要点），并得一次性丰厚资源奖励。复用既有围攻确定性引擎（§16），无新战斗模型。

### 19.1 `@nw/shared`（`slg.ts`）

- **类型**：`TileType` 新增 `'stronghold'`。
- **生成**（`proceduralTile`）：在 `familyKeep` 之前判定（优先级更高），噪声 `strongholdNoise = valueNoise(x,y, strongholdFreq=1/70, seed^0x0555) > strongholdThreshold(0.92)` 且 `dr > strongholdMinDistRatio(0.25)` → `{ type:'stronghold', level: SLG_MAP_MAX_LEVEL, resType: biomeAt(...) }`。固定满级 + 带资源种类（攻克后产出丰厚）。全图约 0.3%（≈300 格），比 familyKeep（5.4%）稀疏 ~16×。阈值在 0.92→0.94 间极陡（343→1），经探针标定。
- **数值**：`STRONGHOLD_GARRISON_PER_LEVEL=360`（满级 1800 兵力当量，远超 `GARRISON_PER_TILE=500`/`npcGarrison` 满级 600）；`strongholdGarrison(level)`；`STRONGHOLD_LOOT_PER_LEVEL=5000`（攻克一次性奖励，按格等级 × 资源种类）。**1800 守军经合成步兵 ≈60 单位（纵深 ~6），叠加攻方 ≤2000 兵 ≈67 单位（纵深 ~7）< 棋盘 16 行 → 正常规模权威引擎可跑**；仅鲸鱼级超大军（>5000 兵）溢出走廉价兜底。零充值玩家满兵也因防守占优（基地 + 超时判守方胜）几乎打不过，须养成强军（科技/装备布阵）方可攻克——兑现 SLG7 卖战力 / U7 碾压级 / §3.1「非常难攻占」。

### 19.2 worldsvc（`service.ts`）

- **`startMarch` 门控**：occupy 无主险地 → `TILE_OCCUPIED`（须围攻）；sweep 险地 → `TILE_OCCUPIED`（须围攻）；attack 放行**无主险地**（PvE，`defenderId` 留空 → 不推 `under_attack`，NPC 无预警）；落城（`joinWorld`/`relocateBase`）险地 → `BAD_REQUEST`；被动迁城重生候选格扫描跳过险地。
- **`applyStrongholdSiege`**（attack 到点，`applySiege` 顶部拦截「无主 + 程序化 stronghold」分支）：按格等级派生系统守军 `synthesizeArmy(strongholdGarrison(level),'defender')` + 高基地（`buildSiegeLevel` 按 tileLevel 派生），走权威 `runSiegeBattle`（坏布阵/异常 → 廉价 `resolveSiege` 兜底，replay=null）。
  - **攻克胜**：写 `territory` TileDoc（`ownerId`=攻方，`garrison`=残存折回，level/resType 沿用程序化）+ 一次性奖励并入攻方资源池（封顶 `RESOURCE_CAP`）+ `recomputeYield` + `applyNationChange`（首府格易主立国）+ `bumpFamilyActivity` + `recordSiege`（attacker_win，无 defenderId，replay 可观战重播）+ 推 `march_update`/`siege_result`/`tile_update` + 对视野观察者可见。
  - **攻克败**：攻方残存撤退回师折回兵力池（出征已扣兵，阵亡永久损失）；NPC 守军不持久（程序化层不落库，下次攻打重置满守军）；`recordSiege`（defender_win）+ 推送。防守方全程为 NPC，无掠夺玩家、无保护罩。

### 19.3 契约 + 客户端

- **契约**：`openapi-world.yml` `WorldTile.type` enum 加 `stronghold`；客户端 `openapi-world.ts` 重新生成（`npm run rest:gen`）。proto `type` 本就是 string 字段（非 enum），无需 proto 再生成。
- **客户端**（`WorldMapScene.ts`）：`TERRAIN_COLORS.stronghold=0x8a4a4a`（暗红石垒）；点击未占领险地 → 弹「险地」面板（围攻挂队 `showAttackTeamPicker` + 侦察 + 关闭，无直占/扫荡）；占领后转 territory 走既有 mine 分支。i18n `world.stronghold`/`world.strongholdHint` 三语（zh/en/de）。

### 19.4 测试

- `worldsvc/test/stronghold.e2e.test.ts`（5 例）：生成（满级 + resType + 守军 >500）/ 直占·扫荡拦截 / 落城拦截 / 攻克胜（大军 → 占领 territory + mine + 残存驻军 + 奖励到账 + sieges attacker_win 无 defenderId + siege_result/tile_update 推送 + territoryCount+1）/ 攻克败（不占领 + 残兵回师 + sieges defender_win + 无奖励）。全 worldsvc 套件 127+5 绿。

### 19.5 DRAFT / 后续

- 数值调参：`STRONGHOLD_GARRISON_PER_LEVEL`/`STRONGHOLD_LOOT_PER_LEVEL`/`STRONGHOLD_LOOT_MATERIAL_PER_LEVEL`/生成密度（`strongholdThreshold`）待经济与战力模拟细化（§16.5 同批）。
- **攻克奖励材料 ✅（2026-06-21，随 G4 §15.6 落地）**：除单资源即时入袋，额外掉落养成材料 `binding`（`strongholdMaterialLoot(level)` 按等级线性，**DRAFT** `STRONGHOLD_LOOT_MATERIAL_PER_LEVEL=4`）——攻克胜经 `meta.grantMaterial` 发到 `SaveData.materials` 养成统一池（跨进程 best-effort，orderId=`stronghold_loot:{worldId}:{toTile}:{arriveAt}` 幂等），攻克败不掉。复用 G4 打通的材料通道，险地养成价值兑现。装备掉落仍待装备库 E2~E4。worldsvc `stronghold.e2e` 加掉落断言（胜掉/败不掉/orderId 幂等键）。
- 险地系统守军当前为合成步兵；后续可换更强兵种/自定义系统布阵 config（§16.5 满血容量表/兵种当量调参后）。

---

*本文档为 SLG 设计基准，DRAFT 标注处随实现/调参细化；锁定决策（SLG1~13）非经重新拍板不改。*
