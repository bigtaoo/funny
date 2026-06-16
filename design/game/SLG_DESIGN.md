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
| SLG2 | **宗门 = 赛季服 = 一张地图实例**；**家族 = 服内联盟**；**宗门间大比 = 跨服赛季总决赛** | 唯一能 scale 的形态（全球玩家分服），且零违和兑现 fiction 层级（宗门>家族>玩家） |
| SLG3 | **分赛季 + 周期性重置**：一个赛季 = 一个宗门世界；人口要么全员同服，要么**系统按规则选够人**填一个健康生态的服（超容量则并行多宗门世界） | 赛季制是 SLG 长线变现发动机（重肝重充）；按规则填服可平衡生态、避免空服/挤服 |
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
宗门（赛季服 = 一张地图实例，数千~数万玩家）
 └── 家族（服内联盟，玩家加入/组建，连地互助）
      └── 玩家（一块或多块领地 + 有限兵力）
跨宗门 ── 宗门间大比（赛季总决赛，跨服事件）
```

- **宗门**：技术上 = 一个赛季服 / 一张地图实例。玩家注册赛季时被分配进某个宗门世界。
- **家族**：服内自由组建/加入的联盟（容量 DRAFT，如 ~30–50 人）。家族是「连地、互守、互助、家族战」的单位，是留存核心。
- **宗门间大比**：赛季末，各宗门世界的顶尖家族/玩家跨服对决（fiction 已写的顶点事件）。形态 DRAFT（榜单结算 / 跨服锦标赛）。

### 2.2 分服与人口（SLG3）

- 一个赛季开启 = 开一个或多个宗门世界。
- 人口策略二选一/混合：**全员同服**（活跃池不超单服健康容量时）或**系统按规则选够人**（按段位/活跃/进度/注册批次平衡分配，避免空服/挤服）。超单服容量 → 并行多个宗门世界。
- 单服健康容量 DRAFT（参考率土赛季服量级，数千~万级）。

### 2.3 赛季重置（SLG4）

| 重置（清） | 保留（跨季留存） |
|---|---|
| 领地归属 / 地图状态 | 养成（装备 / 科技 / 材料库存） |
| 兵力 / 驻军 / 行军 | 外观皮肤 / 收集 |
| 赛季资源存量（粮/铁/木） | 天梯段位 / ELO（独立系统，本就不受 SLG 影响） |
| 家族编制（每季重组） | 账号档案 / 公开 id / 好友关系 |

> 赛季周期 DRAFT（如 4–8 周）。重置是变现发动机：战略起跑归零驱动重新肝/充，养成/外观跨季留存保护投入。

---

## 3. 地图与格子

### 3.1 格子类型（DRAFT）

| 类型 | 说明 | 进攻形态 | 防守 |
|---|---|---|---|
| **中立资源点** | 产出某种资源，产率/类型随位置与等级分布；占领后归玩家持续产出 | 扫荡（PvE，NPC 防守，按等级默认布防） | 系统默认防守 config（按格子等级） |
| **玩家领地** | 玩家占领并驻军的格子 | 围攻（关键战斗，真人手操或自动；服务器复算 + 录像） | 防守方自定义 config + 驻军 |
| **家族要地 / 关隘** | 家族争夺的战略点（加成/通行/防御枢纽） | 家族战（关键战斗） | 家族驻军 |
| **世界中心 / 宗门祭坛** | 赛季终局争夺目标（决定大比席位/赛季荣誉） | 大规模家族战 | — |
| **出生地 / 主城** | 玩家不可被永久夺取的本营（被打=掠夺资源 + 保护罩，不丢城） | 围攻（掠夺） | 主城防守 config |

### 3.2 格子 = 玩家自定义关卡（SLG5）

- 玩家领地/主城的防守 = 一份**可序列化 config**，形态等同 `LevelDefinition`：建筑摆位（兵营/箭塔在哪格）+ 出兵脚本时间线 + 基地强化 + 驻军兵种/数量。
- 玩家用养成解锁/强化各组件来编自己的「防守关」。
- **中立点/NPC 格按等级有系统默认防守 config**（玩家不编辑，等级越高越难）。
- 复用 level-editor 的概念与 `levelSchema` 校验（防守 config 走同一套运行时校验）。

### 3.3 资源（SLG12，DRAFT）

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
- **行军**：占领、增援、进攻都需行军，有距离/时间成本（Redis 调度的定时事件）；家族抱团占**连续领地**才高效（连地加成 + 短行军距离 + 快速增援）。
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

- **全部交易走拍卖行**：挂单（卖方设资源/物品 + 价 + 时长）→ 买方竞拍/一口价 → 成交 + 系统抽税。
- **个人交易 = 挂单时指定受拍人**：只有指定账号可拍下（覆盖「点对点定向交易」需求，无需独立转移系统）。
- **反 RMT**：成交高税 + 每日挂单/成交限额 + 部分资源/物品禁挂（如绑定养成材料按需限制）；异常交易模式进 admin 审计（OPS 复用）。
- 货币：拍卖行计价币种 DRAFT（赛季资源 / 金币 / 专属拍卖货币，需防与天梯/付费体系串味）。

### 7.2 资源 sink / 变现

- **sink**：练兵（粮）、建筑升级（铁/木）、养成（材料）、行军/加速、拍卖税。
- **变现点**（SLG = 赚钱区）：建造/练兵队列加速、资源包、养成科技直购、家族特权、保护罩/迁城道具、赛季战令。全部走 `commercial` 钱包/充值。
- 铁律延续：金币产出/消耗严控防通胀；SLG 资源是赛季性的（季末清），与跨季金币/养成分层管理。

### 7.3 赛季经济

- 赛季资源（粮/铁/木 + 赛季存量）季末清空，养成材料/金币/外观跨季留存（SLG4）。
- 拍卖行季末结算/冻结策略 DRAFT。

---

## 8. 家族 / 宗门社交（兑现 SOC6-4）

- **家族 = 升级 social 基建**：
  - 家族成员表（新 `families` / `familyMembers` 集合，复用 meta 持久层）。
  - **家族频道 = N 人群聊**（现 chat 是 1:1，群频道是新模型）→ **Redis pub/sub 扇出 + gateway 多实例广播**，正是 `SOCIAL_DESIGN SOC7 / S6-4` 该兑现的里程碑。
  - 家族公告 / 邮件：复用现成 mail fan-out（家族 fan-out 是 global fan-out 的子集）。
  - 家族互助：捐资源（走拍卖行指定受拍人或专用捐献）/ 增援 / 代守 / 代打。
- **宗门 / 国家频道 = 跨服/全服广播频道**（纯 Redis pub/sub）。
- **presence 已按「不假设单实例」设计**（见 `CLAUDE.md` social 节 + `SOCIAL_DESIGN`），横扩有底子。
- 家族战 / 宗门间大比的赛事编排 DRAFT。

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
- **关键战斗复算**（SLG11）：占地/家族战/打真人驻军经 `judgeRunner` 复算后才落地，伪造战报无效。
- **拍卖行反 RMT**（SLG9）：高税 + 限额 + 禁挂 + 异常模式 admin 审计。
- **天梯隔离**（SLG7）：养成/SLG 战力对天梯零影响，电竞公平不被付费污染。

---

## 12. 分期与任务拆分（S8）

> SLG 是 month 级大工程，按可独立验收的切片推进。详细勾选见 `META_TASKS.md` S8 节。

- **S8-0 契约 + shared + worldsvc 骨架 ✅（2026-06-16）**：地图/格子/行军/家族 schema；`worldsvc` 第七 workspace；Redis 接入（gateway 横扩 + 调度）。**部署接线收尾 ✅**：`dev-up.ps1`(八进程 `world`)/`Dockerfile`(八包 build+runtime)/`docker-compose.{prod,ci}.yml`(worldsvc 服务 + `18084:18084` + healthcheck)/`Caddyfile`(`/world,/family,/auction → worldsvc:18084`)/`.env.example`(`NW_WORLD_MONGO_DB`/`NW_WORLD_REDIS_URL`)/`ecosystem.config.cjs`(`nw-world`)/CI(typecheck 八包 + e2e `up --wait` + `curl /health`)。`npm run dev:all` 起八进程，实跑 curl `/health`·`/world/map`·`POST /world/join`·无 token 401 全通。
- **S8-1 地图与领地 ✅（2026-06-16）**：格子状态机、占领、资源惰性产出、驻军、保护罩。worldsvc `service`/`httpApi` 做实 `joinWorld`(主城 base TileDoc + 新手保护罩 + 满兵 + 起步产率 + 容量守卫，幂等)/`occupyTile`(直占 territory：先结算资源→扣 `GARRISON_PER_TILE`→写 TileDoc→重算 `yieldRate`；校验越界 `OUT_OF_RANGE`/中心/兵力 `NO_TROOPS`/他人主城 `PROTECTED`/他人领地 `TILE_OCCUPIED`，自占幂等)/`abandonTile`(退兵+删格回归程序化+重算)；`shared/slg.ts` 加纯函数 `tileYield()` + `SlgError`；`POST /world/{join,occupy,abandon}`；视图含 `occupied`/`mine`、`getMe` 含 `territoryCount`。e2e 15 例（service 8 + httpApi 7，真 Mongo）。**直占即生效（无行军旅行/围攻）**——夺他人地走 S8-2 march occupy + S8-3 siege；owner publicId 解析待 meta `/internal/profile` 接入。
- **S8-2 兵力与行军 [~]（2026-06-16，行军/调度/到点/推送 ✅；训练队列待）**：worldsvc `startMarch`(occupy/reinforce；**出征即从兵力池扣兵**，`arriveAt=departAt+marchDurationSec`[欧氏距离 ceil × `MARCH_SPEED_SEC_PER_TILE`，双端可算])/`recallMarch`(去程翻**返程腿**，返程耗时=已走时长，到点退兵回池)/`processDueArrivals`(**Mongo `arriveAt` 索引扫描为权威**，跨世界、无 Redis 也正确；`findOneAndDelete({status:marching})` 原子认领+删瞬态文档 → occupy 写 territory TileDoc[garrison=带兵]+重算 yieldRate[到达时已被占/中心→**退兵回池**不夺地]、reinforce `$inc tile.garrison`[兵不回池；目标已非己方→退兵]、return 退兵回池[封顶 troopCap])；`scheduler.ts` `setInterval`(2s)+`unref`+重入守卫；**Redis ZSET `world:{w}:march`(score=arriveAt) 由 `scheduleMarch/unscheduleMarch` best-effort 维护，仅作未来精确唤醒提示，处理逻辑不依赖**（缺 `NW_WORLD_REDIS_URL` 静默降级）；实时推送 `march_update`/`tile_update`（§14.5）经 worldsvc `gatewayClient`(`SlgPushMsg`+`HttpWorldGatewayClient.push` best-effort) → gateway `matchsvcClient.PushMsg`+`Gateway.toServerMsg`+`proto.ts` 编码，owner 定向下发（与 social 共用 `/gw/push`）；`POST /world/march`+`/world/march/{id}/recall` 做实。e2e 22 例（worldsvc，+7 march）+ gateway 10 全绿。**待办**：兵力上限/**训练队列**(`/world/troops/train|speedup` 仍 stub)、attack/sweep 围攻→S8-3、`under_attack` 预警推送、行军列表 GET、client REST codegen + UI。
  - **数值（U6 DRAFT）**：`MARCH_SPEED_SEC_PER_TILE=6`、`OCCUPY_MIN_TROOPS=GARRISON_PER_TILE=500`、`MARCH_MIN_TROOPS=1`。
- **S8-3 围攻战 [~]（2026-06-16，全垂直一刀；廉价数值结算路径 ✅，引擎复算接入 + 客户端 UI 待 S8-3b）**：
  - **引擎 `'siege'` 模式 ✅**（`client/src/game/types.ts`）：机制同 campaign（防守方 = `WaveDirector` 脚本，防守 config = `LevelDefinition`，本地玩家 = 攻方），**仅蓝图源不同** = `buildSiegeBlueprints(pveUpgrades)`（`balance/pveUpgrades.ts`，与 `buildCampaignBlueprints` 同养成树/注入点，独立命名守天梯红线 §6.1）；`GameEngine` 把原 `campaign` 分支广义化为「有 `waveDirector` 即 PvE 形态」覆盖 campaign+siege（蓝图选择/level 设置/出怪/胜负判定），破城 winner=0 → 攻方夺地。
  - **judgeRunner siege 复算 ✅**（`net/judgeRunner.ts`，§5.3）：`JudgeRequest.defense_json`（`transport.proto` +field 8，`npm run proto:gen` 重生）非空 → `runSiegeJudge`：seed + 防守 config(JSON LevelDefinition) + 攻方权威养成快照 + 攻方帧按 siege 跑到终局，winner_side=0=attacker_win（攻方篡改本地状态改不了「这套兵能否在这套防守 config 下破城」）。
  - **worldsvc 围攻编排 ✅（廉价结算）**：`shared/slg.ts` 加 `siegeId`/`resolveSiege`(线性 Lanchester-lite)/`npcGarrison`/`SIEGE_LOOT_RATE`/`SWEEP_LOOT_PER_LEVEL`；`startMarch` 开 `attack`(校验目标他人领地/未保护 + 出征即推 `under_attack` 预警给防守方)/`sweep`(目标无主)；`applyArrival` 到点 `applySiege`（attacker_win+territory→易主+survivors 成驻军+掠夺败方资源+双方产率重算；+base→**不可夺**：守军清零+上保护罩+掠夺+攻方生还回师；defender_win→攻方 committed 全灭+守军减员）/`applySweep`（NPC：胜=缴获+回师退兵，败=兵损耗），写 `sieges` + 推 `siege_result`；`/world/sweep` 别名。
  - **gateway ✅**：`under_attack`/`siege_result` 两 ServerMsg 分支编码（`proto.ts`/`Gateway.ts`/`matchsvcClient.ts`；proto 早有消息 §14.5）。
  - **承重墙取舍**：worldsvc 不引确定性引擎（M12），到点用**廉价线性数值结算**即时落地（§5.3 许可的「非关键/廉价数值结算」路径）；引擎 + judgeRunner 复算（「关键战斗」承重墙）已落地并单测，**S8-3b** 经 worldsvc→gateway `/gw/judge` 接入替代廉价结算 + 录像 `replayRef` + **客户端围攻 UI**（本刀无 PIXI 场景，SLG client UI 无基线）。
  - 验证：client tsc + **176 测试**（+7 `test/siege.test.ts`：养成单调性/红线/引擎确定性/judge 复算闭环）+ web 构建；八包 `tsc -b` + **worldsvc 29 e2e**（+6 siege +1 sweep httpApi）+ gateway 10 全绿。
- **S8-4 家族（兑现 SOC6-4）**：家族 CRUD、家族频道（Redis pub/sub）、互助、家族战。
- **S8-5 拍卖行**：挂单/竞拍/指定受拍人/税/限额/反 RMT。
- **S8-6 养成统一**：`buildSiegeBlueprints` + PvE/SLG 材料统一 + 服务器权威扩展 + 战力单调性单测。
- **S8-7 赛季**：分服/选人/赛季重置/宗门间大比。
- **S8-8 变现 + 运营**：加速/资源包/科技直购/战令（commercial）+ admin 赛季运维。

**MVP 切片建议**：S8-0~3（地图+领地+兵力+围攻战，单服、无家族、无拍卖、无赛季重置）先验证「战斗接大地图」这条承重墙跑通，再叠加家族/拍卖/赛季。

---

## 13. 风险与开放问题

- **R1 工程量与风险最大的是 worldsvc + Redis**：第七进程 + 新有状态基建 + 空间/调度，是 month 级且不确定性最高。MVP 切片先验证承重墙。
- **R2 平衡复杂度**：三套蓝图 + 统一养成 + SLG 专属数值，平衡面变大；硬墙单测 + 战力单调性单测兜底。
- **R3 拍卖行 RMT**：自由市场永远是搬砖温床，税/限额/审计需持续对抗。
- **R4 单服容量与分服规则**：健康容量、选人规则、并行多服、跨服大比的具体形态待定（DRAFT）。
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

**A. 需你产品/经济拍板（影响玩法与变现，越早越好）**

> 2026-06-16 第二轮：MVP 切片（S8-0~3）只阻塞 U2/U4，已拍；U1/U3/U5 明确推到各自 sprint。

- **U4 单服健康容量 ✅（2026-06-16 定）**：**中型 ~300–500 人/单服**。配套代价：march 风暴 / 视区推送扇出（U11）与 march 单点调度（U12）不能"前期单进程随便扛"，需在 S8-1/S8-2 实现时即带节流聚合 + 预留分片口子（单点 ZSET 调度对该量级仍可接受）。**选人规则**（MVP 默认）：报名/活跃凑够 capacity 即开新服（first-come），分服细则（按段位/进度分流）留 S8-7 与 U3 一起定。
- **U2 地图尺寸 ✅（2026-06-16 定）**：**随容量配**——按"人均 ~150–300 格可开发"反算。MVP 锁 **~300×300（90k 格）** 对应 ~400 人单服；稀疏存储只落被占格，尺寸只影响开荒节奏/行军距离感，不影响存储。
- **U6-程序化分布 ✅（2026-06-16 用户看过预览拍板「可以」）**：首版落地 `shared/src/slg.ts` 的 `proceduralTile()` + `SLG_GEN` 旋钮（一处可调）：等级中心高→边缘低（`(1-dr)` 主导）+ 中频值噪声扰动 1–5 级；资源种类（food/wood/iron）由低频值噪声分三大连续片区（地理专精→拍卖行贸易基础）；~34% 资源格、其余中立空地（封顶 L2）、稀疏 `familyKeep` 战略要点、唯一中心格。确定性纯函数（同 worldId+坐标恒等输出），稀疏存储只落被占格、中立格即时算。
- **U1 拍卖行计价币种**（原 P8，**推迟到 S8-5**）：赛季资源 / 受限金币 / 专属拍卖币——必须防与天梯/付费体系串味，挂 `ECONOMY_BALANCE`。倾向「赛季资源 + 材料计价，禁用付费币/金币」。
- **U3 赛季周期 + 宗门间大比形态**（**推迟到 S8-7**）：赛季天数；大比是榜单结算还是跨服锦标赛。
- **U5 家族容量 + 角色权限粒度**（**推迟到 S8-4**）：家族人数上限；leader/elder/member 各能做什么。

**B. 数值 DRAFT（先占位，上线后调参）**
- **U6** §14.7 全部常量（兵力上限 / 行军速度 / 资源上限与产率 / 保护时长 / 拍卖税率与限额 / 驻军数 / 赛季天数）。
- **U7** 关键战斗"碾压级可跳过手操"的阈值。
- **U8** 防守 config 开放给玩家的可编辑组件范围（哪些建筑/兵种/出兵脚本能力）。

**C. 实现期风险 / 细节（实现时处理，先记着）**
- **U9 engineVersion 耦合**：引擎更新 → worldsvc 须重构建；赛季中途引擎升级如何 pin 版本，保录像/复算一致性（D0+P2 的代价）。
- **U10 防守 config 旋钮未接引擎**：`LevelDefinition` 的 `blocked`/`activeLanes`/`garrison` 等多数旋钮当前仅 schema pass-through、未接引擎（见 `CLAUDE.md` 关卡注）。SLG 防守要真正生效，得**先把引擎旋钮补齐**——这是 S8-3 的前置硬依赖。
- **U11 视区订阅推送扇出**：密集区域 `tile_update`/`march_update` 风暴，需节流/聚合（P9 订阅模型的规模化）。
- **U12 worldsvc 单点 march 调度**：ZSET 到点消费是单点；多实例需选主/分片，前期单进程可接受。
- **U13 多步原子性**：占地/丢地改 `yieldRate` 与读时惰性结算的并发（rev 守卫够不够）；拍卖成交（扣卖方挂存 + 给买方 + 抽税）的跨文档幂等与回滚。

---

*本文档为 SLG 设计基准，DRAFT 标注处随实现/调参细化；锁定决策（SLG1~13）非经重新拍板不改。*
