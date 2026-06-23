# Notebook Wars — 设计文档索引与治理

> 状态：实现中 · 权威：本文（文档治理的单一入口）· 更新：2026-06-21

本文件是 **所有设计文档的统一入口**：去哪找、谁是权威、新文档放哪、数值怎么管。
新增/搬动/废弃任何 `design/` 下文档，**必须同步更新本文的文档地图**。

---

## 0. 三条铁律

1. **数值活在代码，文档引用代码。** 战斗运行数值的唯一可信源是 `server/engine/src/config.ts`（`@nw/engine`，G3-2b-0 后引擎已抽成独立库；client 经 alias 引用、旧 `client/src/game/*` 留 re-export shim）；文档只做带日期的快照（见 [`game/BALANCE.md`](game/BALANCE.md)），不得各自重述一套数值。文档与代码冲突时，**以代码为准**，并修文档。
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
| [ECONOMY_BALANCE.md](game/ECONOMY_BALANCE.md) | 经济**哲学/政策**（faucet/sink、鲸鱼天花板、反通胀） | 实现中 |
| [ECONOMY_NUMBERS.md](game/ECONOMY_NUMBERS.md) | **经济/养成数值演算表（数字权威：体力/合成/护甲/金币/皮肤）** | 设计中 |
| [EQUIPMENT_DESIGN.md](game/EQUIPMENT_DESIGN.md) | **装备系统机制基准（槽位/获取/强化/洗练/引擎注入；数字→ECONOMY_NUMBERS §5）** | 设计中 |
| [ACHIEVEMENT_DESIGN.md](game/ACHIEVEMENT_DESIGN.md) | **成就系统机制基准（统计里程碑→一次性金币；服务器权威/领取；数字→ECONOMY_BALANCE §2.4）** | 实现中 |
| [RETENTION_DESIGN.md](game/RETENTION_DESIGN.md) | **留存系统机制基准（签到/每日任务/周常；服务器权威+dayKey；不新增金币龙头；数字→ECONOMY_NUMBERS §12）** | 设计中 |
| [EVENTS_DESIGN.md](game/EVENTS_DESIGN.md) | **活动/Live-ops 编排（配置/生命周期/限定直购/双倍期；发奖走邮件、计数复用 statKey；不新增金币龙头 ADR-014）** | 设计中 |
| [TITLE_DESIGN.md](game/TITLE_DESIGN.md) | **称号系统机制基准（公开身份名片；统一 titleId 容器/赛季快照/四处展示；段位金币→ECONOMY_BALANCE §2.3）** | 设计中 |
| [SEASON_OVERVIEW.md](game/SEASON_OVERVIEW.md) | **两套赛季（天梯6周/SLG大区2月）的独立性契约·边界·对照（不重述机制，只锁边界）** | 设计中 |
| [SEASON_DESIGN.md](game/SEASON_DESIGN.md) | **天梯赛季/战令/排行榜机制基准（6周赛季·软重置·峰值奖励·Top100·Battle Pass；数字→ECONOMY_NUMBERS §13）** | 设计中 |
| [CHARACTER_DESIGN.md](game/CHARACTER_DESIGN.md) | **角色卡机制/流派基准（6张＝陶3现有兵转具名·锚点 + Anna3新画变体；数值锚点占位→config.ts/BALANCE）** | 设计中 |
| [CAMPAIGN_DESIGN.md](game/CAMPAIGN_DESIGN.md) | 战役 PvE 设计基准（数据权威见 PVE_INTEGRITY_PLAN） | 实现中 |
| [CAMPAIGN_P0_PLAN.md](game/CAMPAIGN_P0_PLAN.md) | 战役 P0 试玩切片计划 | 实现中 |
| [CAMPAIGN_STORY.md](game/CAMPAIGN_STORY.md) | 战役剧情文案（叙事铁律见 world.md / ADR） | 设计中 |
| [PVE_INTEGRITY_PLAN.md](game/PVE_INTEGRITY_PLAN.md) | **PvE 反作弊 + 服务器权威方案（PvE 数据权威真源）** | 实现中 |
| [MYTHOLOGY_DESIGN.md](game/MYTHOLOGY_DESIGN.md) | 神话「神力赋予」叠加层 | 设计中 |
| [META_DESIGN.md](game/META_DESIGN.md) | 元系统 + 服务器架构基准（meta 范畴 6 组件） | 已实现 |
| [DEPLOY_TOPOLOGY.md](game/DEPLOY_TOPOLOGY.md) | **多区域部署拓扑（Meta 共享 + 对战层按区隔离 + 中国独立；同区匹配/好友房跨区）** | 设计中 |
| [META_TASKS.md](game/META_TASKS.md) | **实现任务清单 / 进度（实现状态真源）** | 实现中 |
| [SERVER_API.md](game/SERVER_API.md) | **接口契约单一来源（REST/WS/proto/DB）** | 实现中 |
| [ACCOUNT_DESIGN.md](game/ACCOUNT_DESIGN.md) | 账号系统（设备/密码/OAuth） | 实现中 |
| [GATEWAY_DESIGN.md](game/GATEWAY_DESIGN.md) | gateway 控制面 | 已实现 |
| [MATCHSVC_DESIGN.md](game/MATCHSVC_DESIGN.md) | matchsvc 匹配大脑 | 已实现 |
| [COMMERCIAL_DESIGN.md](game/COMMERCIAL_DESIGN.md) | 钱包 / 交易 / 充值 | 已实现 |
| [SOCIAL_DESIGN.md](game/SOCIAL_DESIGN.md) | 好友 / 私聊 / 邮件 | 已实现 |
| [OPS_DESIGN.md](game/OPS_DESIGN.md) | 运维后台（监控/匹配池/补偿工单） | 已实现 |
| [ANALYTICS_DESIGN.md](game/ANALYTICS_DESIGN.md) | 埋点分析（analyticsvc:18085） | 已实现 |
| [COMPLIANCE_GLOBAL.md](game/COMPLIANCE_GLOBAL.md) | **海外合规（Web/iOS/Android：隐私/分级/抽卡概率公示/平台支付/删账号/UGC）** | 设计中 |
| [COMPLIANCE_CN.md](game/COMPLIANCE_CN.md) | **中国大陆合规（版号/实名/未成年人防沉迷限时/分龄充值限额/PIPL；跟版号走，海外测试不阻断）** | 设计中 |
| [AUDIO_DESIGN.md](game/AUDIO_DESIGN.md) | **音频系统（资产/触发表/播放层/混音/设置/平台约束；美学仍归 art-direction）** | 设计中 |
| [ONBOARDING_DESIGN.md](game/ONBOARDING_DESIGN.md) | **新手引导/FTUE 编排（首会话动线/战斗教学覆盖层/功能渐进解锁/合规门；不重述故事/关卡）** | 设计中 |
| [SLG_DESIGN.md](game/SLG_DESIGN.md) | SLG 大世界（worldsvc:18084） | 实现中 |
| [AUCTION_DESIGN.md](game/AUCTION_DESIGN.md) | **拍卖行机制基准（交易模型/状态机/反 RMT；从 SLG §7/§14 抽出；数字→shared/slg.ts）** | 实现中 |
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
| [animator/WORKSPACE_SYNC.md](tools/animator/WORKSPACE_SYNC.md) | **animator 在线工作区 + 云盘→仓库同步桥（Cloudflare Pages + Supabase + 自动 PR；状态：设计中）** |
| [level-editor/DESIGN.md](tools/level-editor/DESIGN.md) | 关卡编辑器（端口 9092） |
| [vfx-editor/DESIGN.md](tools/vfx-editor/DESIGN.md) | 特效编辑器（端口 9094，方案 A 墨线矢量程序特效；状态：设计中） |

### 1.5 快查文档（`claudedocs/`，模块级速查，非设计基准）
`animator.md` · `client-modules.md` · `file-formats.md` · **`server.md`（进程拓扑/端口权威）**

---

## 2. 权威来源登记表（冲突时认这一列）

| 域 | 权威来源 | 文档侧镜像/说明 |
|---|---|---|
| 战斗运行数值（HP/攻/速/费/上限/计时/卡池） | `server/engine/src/config.ts`（`@nw/engine`；client 经 alias） | [game/BALANCE.md](game/BALANCE.md) 快照 |
| 经济/养成**数值**（体力/合成/护甲/金币/皮肤价） | [game/ECONOMY_NUMBERS.md](game/ECONOMY_NUMBERS.md) | 演算沙盘，可调参数集中 §10 |
| 经济**政策**/货币命名/盲盒哲学 | [game/ECONOMY_BALANCE.md](game/ECONOMY_BALANCE.md) | 货币：局内 `ink`（墨滴，清零）、持久 `coins`（金币，服务器权威） |
| 装备系统**机制**（槽位/获取/强化/洗练/注入/红线） | [game/EQUIPMENT_DESIGN.md](game/EQUIPMENT_DESIGN.md) | 数字去 ECONOMY_NUMBERS §5；强化升级取代旧"5件确定性合成"(ADR-009) |
| 成就系统**机制**（统计/解锁/领取/服务器权威） | [game/ACHIEVEMENT_DESIGN.md](game/ACHIEVEMENT_DESIGN.md) | 阈值/金币数字去 ECONOMY_BALANCE §2.4；纯一次性 faucet，不可刷 |
| 称号系统**机制**（公开身份名片/统一容器/授予/展示） | [game/TITLE_DESIGN.md](game/TITLE_DESIGN.md) | 段位首达金币数字去 ECONOMY_BALANCE §2.3；与成就解耦（成就纯自看，炫耀走称号） |
| 留存系统**机制**（签到/每日任务/周常/dayKey/领取） | [game/RETENTION_DESIGN.md](game/RETENTION_DESIGN.md) | 数字去 ECONOMY_NUMBERS §12；金币只从每日任务满点出、收敛 ~60/月，不新增龙头 |
| 活动/Live-ops **编排**（配置/生命周期/类型/经济约束） | [game/EVENTS_DESIGN.md](game/EVENTS_DESIGN.md) | 数字去 ECONOMY_NUMBERS §14；发奖复用 OPS 邮件、计数复用 statKey、限定直购复用 commercial；不新增金币龙头（ADR-014） |
| 拍卖行**机制**（交易模型/挂单状态机/定向受拍/税/反 RMT） | [game/AUCTION_DESIGN.md](game/AUCTION_DESIGN.md) | 从 SLG §7/§14 抽出，机制以本文为准；数字去 `shared/slg.ts`（`AUCTION_*`）；仅 coin 计价、赛季资源禁挂 |
| 两套赛季的**独立性契约/边界/对照**（天梯 vs SLG 大区谁重置谁、共享资产归属） | [game/SEASON_OVERVIEW.md](game/SEASON_OVERVIEW.md) | 不重述机制；机制权威仍归 SEASON_DESIGN / SLG_DESIGN；锁「两条时钟互不触发 + 重置写入域隔离 + 共享 coin/称号归属」 |
| 天梯赛季/战令/排行榜**机制**（赛季时钟·软重置·惰性迁移·峰值奖励·Top100·Battle Pass） | [game/SEASON_DESIGN.md](game/SEASON_DESIGN.md) | 数字去 ECONOMY_NUMBERS §13；天梯赛季6周 ≠ SLG大区赛季2个月（两条独立时钟）；赛季切换 = admin 手动开启 |
| 角色卡**机制/流派**（6张·东西双版本·获取分层） | [game/CHARACTER_DESIGN.md](game/CHARACTER_DESIGN.md) | 数值锚点占位→落 `config.ts`+[BALANCE.md](game/BALANCE.md)；陶3＝现有兵转具名(数值不动·锚点)，Anna3＝新画变体；PvP全送/PvE章节解锁(ADR-016) |
| PvE 关卡定义 | `client/src/game/campaign/levels/*.json`（+ level-editor 编辑、`parseLevelDefinition` 校验） | — |
| PvE 奖励 / 养成数据权威 | 服务器 `server/shared/pveRewards.ts` + [PVE_INTEGRITY_PLAN.md](game/PVE_INTEGRITY_PLAN.md)（方案 B：服务器权威） | 客户端 JSON 仅参考/编辑器用 |
| 接口契约（REST/WS/proto/DB 集合） | [game/SERVER_API.md](game/SERVER_API.md) + `server/contracts/` | — |
| 进程拓扑 / 端口 | [claudedocs/server.md](../claudedocs/server.md) | 8 个应用进程，见 §4 |
| 多区域部署（区域划分/匹配域/数据驻留） | [game/DEPLOY_TOPOLOGY.md](game/DEPLOY_TOPOLOGY.md) | Meta 共享+对战层按区隔离+中国独立；同区匹配、好友房跨区（ADR-019）；进程拓扑仍归 server.md |
| 配色 / 渲染 / 美术资产分工 | [product/art-direction.md](product/art-direction.md) + `client/src/render/theme.ts` | 阵营色 **我蓝敌红**（v0.3） |
| 客户端 UI | 菜单/元系统 → [game/UI_DESIGN.md](game/UI_DESIGN.md)；战斗内 → [product/ui-design.md](product/ui-design.md) | 互补分工，见 §3 |
| 实现状态 / 任务进度 | [game/META_TASKS.md](game/META_TASKS.md) + 各文档「实现记录」节 | — |
| 叙事铁律 | [product/world.md](product/world.md) + ADR-008 | 陶(东方)/Anna(西方)/两本笔记本 |
| 海外合规（隐私/分级/抽卡公示/平台支付/删账号/UGC） | [game/COMPLIANCE_GLOBAL.md](game/COMPLIANCE_GLOBAL.md) | 与中国版 [COMPLIANCE_CN](game/COMPLIANCE_CN.md) 解耦（ADR-013，海外先行） |
| 中国大陆合规（版号/实名/防沉迷/分龄充值限额/PIPL） | [game/COMPLIANCE_CN.md](game/COMPLIANCE_CN.md) | 跟版号流程走、海外测试不触发；抽卡概率公示与海外共用一套数据源（COMPLIANCE_GLOBAL §4） |
| 音频系统（资产/触发/播放层/混音/设置/平台约束） | [game/AUDIO_DESIGN.md](game/AUDIO_DESIGN.md) | **美学方向**（音色/禁用清单）仍归 [product/art-direction.md](product/art-direction.md) §声音 |
| 新手引导/FTUE 编排（动线/教学覆盖层/渐进解锁/合规门） | [game/ONBOARDING_DESIGN.md](game/ONBOARDING_DESIGN.md) | 故事归 CAMPAIGN_STORY/world；教学关定义归 CAMPAIGN_DESIGN；埋点字段归 ANALYTICS |

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
