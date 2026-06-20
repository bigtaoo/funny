# Notebook Wars — 设计文档索引与治理

> 状态：实现中 · 权威：本文（文档治理的单一入口）· 更新：2026-06-21

本文件是 **所有设计文档的统一入口**：去哪找、谁是权威、新文档放哪、数值怎么管。
新增/搬动/废弃任何 `design/` 下文档，**必须同步更新本文的文档地图**。

---

## 0. 三条铁律

1. **数值活在代码，文档引用代码。** 战斗运行数值的唯一可信源是 `client/src/game/config.ts`；文档只做带日期的快照（见 [`game/BALANCE.md`](game/BALANCE.md)），不得各自重述一套数值。文档与代码冲突时，**以代码为准**，并修文档。
2. **每个域只有一个权威文档。** 见 §2 权威来源登记表。其他文档引用它，不复制它的结论。
3. **决策进 ADR。** 任何会造成"文档间漂移"的拍板（改数值口径、改命名、改架构、废弃旧方案），在 [`DECISIONS.md`](DECISIONS.md) 记一条，并在受影响文档加指针。

---

## 1. 文档地图

每份文档的状态标记（建议写进文档头）：
`状态：设计中 | 实现中 | 已实现 | 已归档(superseded)` · `权威：本文 / 见 X` · `更新：YYYY-MM-DD`

### 1.1 治理（`design/`）
| 文档 | 范围 |
|---|---|
| [README.md](README.md) | 本文：索引 / 权威登记 / 文档规约 |
| [DECISIONS.md](DECISIONS.md) | ADR 决策日志（造成漂移的关键拍板） |

### 1.2 游戏与服务端（`design/game/`）
| 文档 | 范围 | 状态 |
|---|---|---|
| [DESIGN.md](game/DESIGN.md) | 引擎 / 系统设计基准（机制，非数值权威） | 实现中 |
| [BALANCE.md](game/BALANCE.md) | **战斗数值快照（镜像 config.ts）— 文档侧唯一数值参考** | 实现中 |
| [ECONOMY_BALANCE.md](game/ECONOMY_BALANCE.md) | 经济 / 货币（局内 `ink` + 持久 `coins`）/ 盲盒数值 | 实现中 |
| [CAMPAIGN_DESIGN.md](game/CAMPAIGN_DESIGN.md) | 战役 PvE 设计基准（数据权威见 PVE_INTEGRITY_PLAN） | 实现中 |
| [CAMPAIGN_P0_PLAN.md](game/CAMPAIGN_P0_PLAN.md) | 战役 P0 试玩切片计划 | 实现中 |
| [CAMPAIGN_STORY.md](game/CAMPAIGN_STORY.md) | 战役剧情文案（叙事铁律见 world.md / ADR） | 设计中 |
| [PVE_INTEGRITY_PLAN.md](game/PVE_INTEGRITY_PLAN.md) | **PvE 反作弊 + 服务器权威方案（PvE 数据权威真源）** | 实现中 |
| [MYTHOLOGY_DESIGN.md](game/MYTHOLOGY_DESIGN.md) | 神话「神力赋予」叠加层 | 设计中 |
| [META_DESIGN.md](game/META_DESIGN.md) | 元系统 + 服务器架构基准（meta 范畴 6 组件） | 已实现 |
| [META_TASKS.md](game/META_TASKS.md) | **实现任务清单 / 进度（实现状态真源）** | 实现中 |
| [SERVER_API.md](game/SERVER_API.md) | **接口契约单一来源（REST/WS/proto/DB）** | 实现中 |
| [ACCOUNT_DESIGN.md](game/ACCOUNT_DESIGN.md) | 账号系统（设备/密码/OAuth） | 实现中 |
| [GATEWAY_DESIGN.md](game/GATEWAY_DESIGN.md) | gateway 控制面 | 已实现 |
| [MATCHSVC_DESIGN.md](game/MATCHSVC_DESIGN.md) | matchsvc 匹配大脑 | 已实现 |
| [COMMERCIAL_DESIGN.md](game/COMMERCIAL_DESIGN.md) | 钱包 / 交易 / 充值 | 已实现 |
| [SOCIAL_DESIGN.md](game/SOCIAL_DESIGN.md) | 好友 / 私聊 / 邮件 | 已实现 |
| [OPS_DESIGN.md](game/OPS_DESIGN.md) | 运维后台（监控/匹配池/补偿工单） | 已实现 |
| [ANALYTICS_DESIGN.md](game/ANALYTICS_DESIGN.md) | 埋点分析（analyticsvc:18085） | 已实现 |
| [SLG_DESIGN.md](game/SLG_DESIGN.md) | SLG 大世界（worldsvc:18084） | 实现中 |
| [UI_DESIGN.md](game/UI_DESIGN.md) | **菜单 / 元系统客户端 UI**（与战斗 UI 分工，见 §3） | 实现中 |
| [IMPROVEMENT_PLAN.md](game/IMPROVEMENT_PLAN.md) | 6 项工程改进（全完成） | 已归档 |
| [PROFILE_POPUP_PLAN.md](game/PROFILE_POPUP_PLAN.md) | 资料弹层（已实现） | 已归档 |

### 1.3 产品与玩法愿景（`design/product/`）
| 文档 | 范围 | 状态 |
|---|---|---|
| [core-gameplay-loop.md](product/core-gameplay-loop.md) | 核心玩法循环（**设计意图，数值非权威 → BALANCE.md**） | 实现中 |
| [logic-architecture.md](product/logic-architecture.md) | 逻辑层架构（坐标系/系统/录像） | 实现中 |
| [art-direction.md](product/art-direction.md) | **美术方向（配色/渲染/资产分工的权威）** | 实现中 |
| [ui-design.md](product/ui-design.md) | **战斗内 UI 规格**（HUD/手牌/棋盘布局，见 §3） | 实现中 |
| [characters.md](product/characters.md) | 角色设定 | 设计中 |
| [world.md](product/world.md) | 世界观 / 叙事 | 设计中 |
| [market-analysis.md](product/market-analysis.md) | 市场分析 | 参考 |
| [mvp-gaps.md](product/mvp-gaps.md) | MVP 缺口盘点 | 实现中 |
| [client-rendering-cache.md](product/client-rendering-cache.md) | 渲染缓存 / 对象池 | 实现中 |
| [v1-balance.md](product/v1-balance.md) | 早期数值提案（**未落地，已被 config.ts 取代**） | 已归档 |
| [v1-simulation.md](product/v1-simulation.md) | 基于 v1-balance 的推演（同上归档） | 已归档 |

### 1.4 工具（`design/tools/`）
| 文档 | 范围 |
|---|---|
| [animator/ARCHITECTURE.md](tools/animator/ARCHITECTURE.md) · [REQUIREMENTS.md](tools/animator/REQUIREMENTS.md) | 骨骼动画编辑器（端口 9091） |
| [level-editor/DESIGN.md](tools/level-editor/DESIGN.md) | 关卡编辑器（端口 9092） |

### 1.5 快查文档（`claudedocs/`，模块级速查，非设计基准）
`animator.md` · `client-modules.md` · `file-formats.md` · **`server.md`（进程拓扑/端口权威）**

---

## 2. 权威来源登记表（冲突时认这一列）

| 域 | 权威来源 | 文档侧镜像/说明 |
|---|---|---|
| 战斗运行数值（HP/攻/速/费/上限/计时/卡池） | `client/src/game/config.ts` | [game/BALANCE.md](game/BALANCE.md) 快照 |
| 经济 / 货币命名 / 盲盒 | [game/ECONOMY_BALANCE.md](game/ECONOMY_BALANCE.md) + 代码常量 | 货币：局内 `ink`（墨滴，清零）、持久 `coins`（金币，服务器权威） |
| PvE 关卡定义 | `client/src/game/campaign/levels/*.json`（+ level-editor 编辑、`parseLevelDefinition` 校验） | — |
| PvE 奖励 / 养成数据权威 | 服务器 `server/shared/pveRewards.ts` + [PVE_INTEGRITY_PLAN.md](game/PVE_INTEGRITY_PLAN.md)（方案 B：服务器权威） | 客户端 JSON 仅参考/编辑器用 |
| 接口契约（REST/WS/proto/DB 集合） | [game/SERVER_API.md](game/SERVER_API.md) + `server/contracts/` | — |
| 进程拓扑 / 端口 | [claudedocs/server.md](../claudedocs/server.md) | 8 个应用进程，见 §4 |
| 配色 / 渲染 / 美术资产分工 | [product/art-direction.md](product/art-direction.md) + `client/src/render/theme.ts` | 阵营色 **我蓝敌红**（v0.3） |
| 客户端 UI | 菜单/元系统 → [game/UI_DESIGN.md](game/UI_DESIGN.md)；战斗内 → [product/ui-design.md](product/ui-design.md) | 互补分工，见 §3 |
| 实现状态 / 任务进度 | [game/META_TASKS.md](game/META_TASKS.md) + 各文档「实现记录」节 | — |
| 叙事铁律 | [product/world.md](product/world.md) + ADR-008 | 陶(东方)/Anna(西方)/两本笔记本 |

---

## 3. 两份 UI 文档的分工（常见困惑）

不是冲突，是**分层**：
- **[game/UI_DESIGN.md](game/UI_DESIGN.md)** = 菜单 / 元系统客户端 UI（大厅、商店、收集、战役地图、导航、i18n、网络态）。
- **[product/ui-design.md](product/ui-design.md)** = 战斗内 UI 规格（HUD、手牌、棋盘布局、结算）。
- 配色一律引 [art-direction.md](product/art-direction.md)，两份 UI 文档不各自定义配色。

---

## 4. 进程拓扑（8 个应用进程）

权威清单见 [claudedocs/server.md](../claudedocs/server.md)。应用进程 = **8 个**（`shared` 是 npm 包不算进程，mongo/redis 是基础设施）：

`metaserver` · `gateway` · `matchsvc` · `gameserver` · `commercial` · `admin` · `worldsvc` · `analyticsvc`

> [META_DESIGN.md](game/META_DESIGN.md) §6.1 的「6 组件」是 **meta 范畴**（S0–S5）的拓扑，不含后加的 admin/worldsvc/analyticsvc——以本节为全量。

---

## 5. 文档规约

**一个功能何时需要单独文档？** 当它是**可独立交付的子系统**——有自己的数据模型 / API 面 / 生命周期（如 social、ops、SLG、commercial）。更小的特性写进相关已有文档的一节，不另起文件。

**放哪？**
- `design/game/` —— 与游戏系统或服务端强绑定的设计基准。
- `design/product/` —— 产品愿景 / 玩法意图 / 美术 / 市场（偏"为什么/长什么样"）。
- `design/tools/<tool>/` —— 编辑器等工具。
- `claudedocs/` —— 模块级速查（"现在代码长这样"），**不是**设计基准。

**命名**：`game/`/`tools/` 用 `UPPER_SNAKE.md`，`product/` 用 `kebab-case.md`（沿用现状）。

**改数值**：改 `config.ts` → 同步 [BALANCE.md](game/BALANCE.md) 快照（注明日期）→ 大改记 ADR。**不要**去 core-gameplay-loop / v1-balance 改数值（前者数值非权威，后者已归档）。
</content>
</invoke>
