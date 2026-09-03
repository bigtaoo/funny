# Notebook Wars — 设计文档索引与治理

> 状态：实现中 · 权威：本文（文档治理的单一入口）· 更新：2026-09-03（一致性审计后的三轮修正，见 §6）

本文件是 **所有设计文档的统一入口**：去哪找、谁是权威、新文档放哪、数值怎么管。
新增/搬动/废弃任何 `design/` 下文档，**必须同步更新本文的文档地图**。

> **地图完整性可机械核对**——`design/` 下每一份 `.md` 都必须能在本文找到一个链接。核对命令：
> ```bash
> comm -13 <(grep -oE '\]\(([a-zA-Z0-9_./-]+\.md)\)' design/README.md | sed -E 's/^\]\(//; s/\)$//; s|^\./||' | sort -u) <(find design -name '*.md' | sed 's|^design/||' | sort)
> ```
> 输出为空才算齐。2026-09-03 审计时它输出 **62 行**（含整组 25 份美术 prompt 文档、31 份续册、一个已 Accepted 的
> 子系统设计 `SLG_FIELD_BATTLE_DESIGN.md`）——上面那句「必须同步更新」写了两个月，从未被执行过一次。现已补齐至 0。

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
| [DECISIONS.md](DECISIONS.md) | ADR 决策日志（造成漂移的关键拍板）——**索引表**，正文见 [ADR-001~040](DECISIONS_ADR-001-040.md) / [ADR-041~069](DECISIONS_ADR-041-069.md) / [ADR-070 起](DECISIONS_ADR-070-onward.md)（新拍板写最后一册） |

### 1.2 游戏与服务端（`design/game/`）
| 文档 | 范围 | 状态 |
|---|---|---|
| [DESIGN.md](game/DESIGN.md) | 引擎 / 系统设计基准（机制，非数值权威） | 实现中 **（拆分：§8 起 → `DESIGN_SUBSYSTEMS.md`）** |
| [BALANCE.md](game/BALANCE.md) | **战斗数值快照（镜像 config.ts）— 文档侧唯一数值参考** | 实现中 |
| [ECONOMY_BALANCE.md](game/ECONOMY_BALANCE.md) | 经济**哲学/政策**（faucet/sink、鲸鱼天花板、反通胀） | 实现中 |
| [ECONOMY_BALANCE_CN.md](game/ECONOMY_BALANCE_CN.md) | 中国区专属 IAP 定价档（CNY 档位；版号申请中暂不实施，ECONOMY_BALANCE §2.2 链入） | 待落地 |
| [ECONOMY_NUMBERS.md](game/ECONOMY_NUMBERS.md) | **经济/养成数值演算表（数字权威：体力/合成/护甲/金币/皮肤）** | 设计中 **（拆分：§12 起 → `ECONOMY_NUMBERS_LIVEOPS.md`）** |
| [ECONOMY_VERIFICATION_LOG.md](game/ECONOMY_VERIFICATION_LOG.md) | econ-sim 各轨（NATION/CITY/C/D/E/F/STRONGHOLD）核验过程与结论（已 CLOSED，非数值权威） | 已完成 **（拆分：F 轨起 → `ECONOMY_VERIFICATION_LOG_CAPACITY.md`）** |
| [CHARACTER_CARDS_DESIGN.md](game/CHARACTER_CARDS_DESIGN.md) | **角色卡实例系统（Hero Roster/喂卡升级/兵力/受伤/布阵对接；数字→ECONOMY_NUMBERS §6）** | 设计中 **（拆分：§9 起 → `CHARACTER_CARDS_DESIGN_IMPL.md`）** |
| [EQUIPMENT_DESIGN.md](game/EQUIPMENT_DESIGN.md) | **装备系统机制基准（槽位/获取/强化/洗练/引擎注入；数字→ECONOMY_NUMBERS §5）** | 已实现（`shared/equipment.ts` craft/enhance+0..9/reforge/salvage+e2e；洗练基础金币已于 ADR-030 / 2026-07-03 实装，`metaserver/src/equipment/reforge.ts` 走 `commercial.spend`） **（2026-08-17 拆分：§3–8 → `_MODEL`，§9–14 → `_IMPL`，§15–20 → `_REF`）** |
| [ITEM_IDENTITY_DESIGN.md](game/ITEM_IDENTITY_DESIGN.md) | **物品身份基准（唯一id/状态/溯源，跨材料/装备/角色卡/皮肤/称号）** | 已实现（ADR-059；三个实例化任务皮肤/材料/称号全部落地，2026-08-10，`shared/src/types.ts` `SkinInstance`/`MaterialInstance` + `shared/src/titles.ts`） |
| [EQUIPMENT_ICON_PROMPTS.md](game/EQUIPMENT_ICON_PROMPTS.md) | 装备图标 AI 生成 prompt 清单（美术素材，非机制基准） | 参考 |
| [ACHIEVEMENT_DESIGN.md](game/ACHIEVEMENT_DESIGN.md) | **成就系统机制基准（统计里程碑→一次性金币；服务器权威/领取；数字→ECONOMY_BALANCE §2.4）** | 已实现（`shared/achievements.ts` StatKey/分阶/反作弊L1+测试） |
| [RETENTION_DESIGN.md](game/RETENTION_DESIGN.md) | **留存系统机制基准（签到/每日任务/周常；服务器权威+dayKey；不新增金币龙头；数字→ECONOMY_NUMBERS §12）** | 已实现（`shared/retention.ts` 30格签到/每日任务/周常宝箱/dayKey+e2e；末次机制调整 2026-08-09，见本文 §10.4–§10.14） |
| [EVENTS_DESIGN.md](game/EVENTS_DESIGN.md) | **活动/Live-ops 编排（配置/生命周期/限定直购/双倍期；发奖走邮件、计数复用 statKey；不新增金币龙头 ADR-014）** | 设计中 |
| [TITLE_DESIGN.md](game/TITLE_DESIGN.md) | **称号系统机制基准（公开身份名片；统一 titleId 容器/赛季快照/四处展示；段位金币→ECONOMY_BALANCE §2.3）** | 设计中 |
| [SEASON_OVERVIEW.md](game/SEASON_OVERVIEW.md) | **两套赛季（天梯6周/SLG大区2月）的独立性契约·边界·对照（不重述机制，只锁边界）** | 设计中 |
| [SEASON_DESIGN.md](game/SEASON_DESIGN.md) | **天梯赛季/战令/排行榜机制基准（6周赛季·软重置·峰值奖励·Top100·Battle Pass；数字→ECONOMY_NUMBERS §13）** | 已实现（S11 天梯+`shared/battlepass.ts` 30级双轨+测试） **（拆分：§13A 起 → `SEASON_DESIGN_IMPL_SPEC.md`）** |
| [CHARACTER_DESIGN.md](game/CHARACTER_DESIGN.md) | **角色卡机制/流派基准（6张＝涛3现有兵转具名·锚点 + Anna3新画变体；数值锚点占位→config.ts/BALANCE）** | 设计中 **（拆分：§7.6 英雄 → `_HEROES_IRONCLAD_RUNNER` / `_HEROES_MEDIC`）** |
| [PVP_LOADOUT_DESIGN.md](game/PVP_LOADOUT_DESIGN.md) | **PvP 构筑卡组 + 按段位解锁单位机制基准（复用 6 PvE 单位入 PvP·全池随机→构筑·diamond/king 解锁；数值→config.ts/BALANCE，段位→ladder.ts）** | 设计中 |
| [ANNA_CHARACTERS.md](game/ANNA_CHARACTERS.md) | Anna 方三角色（Max/Lena/…）立绘与设定细化（引擎定义见 CHARACTER_DESIGN，叙事见 product/characters） | 设计中 **（拆分：怪物 → `ANNA_CHARACTERS_MONSTERS.md`）** |
| [CAMPAIGN_DESIGN.md](game/CAMPAIGN_DESIGN.md) | 战役 PvE 设计基准（数据权威见 PVE_INTEGRITY_PLAN） | 实现中 **（拆分：§4.9 起 → `CAMPAIGN_DESIGN_KNOBS.md`）** |
| [CAMPAIGN_P0_PLAN.md](game/archive/CAMPAIGN_P0_PLAN.md) | 战役 P0 试玩切片计划（试玩切片已完成） | 已归档 |
| [CAMPAIGN_STORY.md](game/CAMPAIGN_STORY.md) | 战役剧情文案（叙事铁律见 world.md / ADR） | 设计中 |
| [PVE_INTEGRITY_PLAN.md](game/PVE_INTEGRITY_PLAN.md) | **PvE 反作弊 + 服务器权威方案（PvE 数据权威真源）** | 实现中 |
| [DIFFICULTY_SIM.md](game/DIFFICULTY_SIM.md) | 关卡难度模拟器（真实引擎+基线 AI 量化战役难度；代码 `client/test/difficultySim.ts`） | 工具/实现中 **（拆分：调参记录 → `_TUNING_CH2-CH6` / `_TUNING_CH1_STARS`）** |
| [STAR_SCORING.md](game/STAR_SCORING.md) | PvE 关卡三星评分机制（评分维度/阈值；client-modules 引用） | 实现中 |
| [REPLAY_SHARE_DESIGN.md](game/REPLAY_SHARE_DESIGN.md) | **录像游戏外分享（状态流·客户端自产·无登录直达哑播放器·公开 /r/{code}·微信 shareAppMessage；与输入流录像分工）** | 已实现（2026-06-24 拍板→当日落地：`StateReplay.ts`/`StateRecorder.ts`/`StatePlayerScene.ts` + `POST /replay/share` + 公开 `GET /r/{shareCode}`；订正 2026-09-03，本行此前一直写「待实现」） |
| [MYTHOLOGY_DESIGN.md](game/MYTHOLOGY_DESIGN.md) | 神话「神力赋予」叠加层 | 设计中 |
| [META_DESIGN.md](game/META_DESIGN.md) | 元系统 + 服务器架构基准（meta 范畴 6 组件） | 已实现 |
| [DEPLOY_TOPOLOGY.md](game/DEPLOY_TOPOLOGY.md) | **多区域部署拓扑（Meta 共享 + 对战层按区隔离 + 中国独立；同区匹配/好友房跨区）** | 设计中 |
| [ASSET_PACKAGING.md](game/ASSET_PACKAGING.md) | **资源分包/加载策略（L0启动闸门/L1按需/L2不进包；Web加载界面·微信CDN方案A·手机全量；AssetIO 抽象）** | 实现中 **（§15/§16 → [`ASSET_PACKAGING_LOG.md`](game/ASSET_PACKAGING_LOG.md)）** |
| [META_TASKS.md](game/META_TASKS.md) | **实现任务清单 / 进度（实现状态真源）** | 实现中 |
| [SERVER_API.md](game/SERVER_API.md) | **接口契约单一来源（REST/WS/proto/DB）** | 实现中 **（拆分：§7 起 → `SERVER_API_INTERNAL.md`）** |
| [ACCOUNT_DESIGN.md](game/ACCOUNT_DESIGN.md) | 账号系统（设备/密码/OAuth） | 实现中 |
| [GATEWAY_DESIGN.md](game/GATEWAY_DESIGN.md) | gateway 控制面 | 已实现 |
| [MATCHSVC_DESIGN.md](game/MATCHSVC_DESIGN.md) | matchsvc 匹配大脑 | 已实现 |
| [COMMERCIAL_DESIGN.md](game/COMMERCIAL_DESIGN.md) | 钱包 / 交易 / 充值 | 已实现 **（拆分：§10 起 → `COMMERCIAL_DESIGN_IAP.md`）** |
| [GACHA_DESIGN.md](game/GACHA_DESIGN.md) | **盲盒系统完整设计（限定池/软保底/月卡/新手包/命运点/美术资源清单；数字→ECONOMY_BALANCE §3–4）** | 已实现（`commercial/src/gacha.ts` 软保底70/硬保底90/十连保底+测试） |
| [SOCIAL_DESIGN.md](game/SOCIAL_DESIGN.md) | 好友 / 私聊 / 邮件（原社交数据模型；**已被 SOCIAL_SVC_DESIGN 取代**，仅留数据模型作迁移参考） | 已归档 |
| [SOCIAL_SVC_DESIGN.md](game/SOCIAL_SVC_DESIGN.md) | **socialsvc 独立社交服务（家族/好友/邮件/频道/push 路由；推翻 SOC1，新增第五公网面）** | 已实现（P1–P4 迁移全部完成，末批 2026-06-29；OpenAPI 契约 2026-07-27 补齐 → `openapi-social.yml`；`server/socialsvc/` 已在 prod compose / ecosystem / Caddy） |
| [OPS_DESIGN.md](game/OPS_DESIGN.md) | 运维后台（监控/匹配池/补偿工单） | 已实现 |
| [BOTSVC_DESIGN.md](game/BOTSVC_DESIGN.md) | **botsvc 机器人玩家服务（冷启动填充人气；1000池/稳态100在线；容量分层降级/充值分层模拟/家族任务映射表）** | 已实现（2026-07-14：SLG 节奏 + 真实 gateway/gameserver 排位对战 + 1000 bot 负载实测；已在 prod compose 与 `dev-up.ps1`） |
| [FEATURE_FLAGS_DESIGN.md](game/FEATURE_FLAGS_DESIGN.md) | **功能开关（全局+定向灰度/区域/平台/白名单；统一服务端求值；公开 /bootstrap 下发+各进程缓存轮询；与 SaveData.flags 解耦）** | 已上线（F1/F2/F4 + F3 `GET /bootstrap`/客户端 `FeatureFlags` + 客户端日志定向采集闭环） **（拆分：§8 实现记录 → `FEATURE_FLAGS_DESIGN_LOG.md`）** |
| [ANALYTICS_DESIGN.md](game/ANALYTICS_DESIGN.md) | 埋点分析（analyticsvc:18085） | 已实现 **（拆分：§6 起 → `ANALYTICS_DESIGN_BACKEND.md`）** |
| [COMPLIANCE_GLOBAL.md](game/COMPLIANCE_GLOBAL.md) | **海外合规（Web/iOS/Android：隐私/分级/抽卡概率公示/平台支付/删账号/UGC）** | 设计中 |
| [COMPLIANCE_CN.md](game/COMPLIANCE_CN.md) | **中国大陆合规（版号/实名/未成年人防沉迷限时/分龄充值限额/PIPL；跟版号走，海外测试不阻断）** | 设计中 |
| [CONTENT_MODERATION_DESIGN.md](game/CONTENT_MODERATION_DESIGN.md) | **内容治理（用户名/家族名/宗门名/聊天敏感词归一化+词库外部化/举报处理闭环/信誉分分级处罚/审核+申诉后台）；取代 SOC10 与 COMPLIANCE_GLOBAL §7** | 已实现（**P1–P5 全部完成**，见本文 §9；ops 词库页 2026-08-20 补齐） |
| [AUDIO_DESIGN.md](game/AUDIO_DESIGN.md) | **音频系统（资产/触发表/播放层/混音/设置/平台约束；美学仍归 art-direction）** | 已实现（§7 七步全完成；第一批素材 + `bgm.lobby` 已发货，2026-09-01）·**开放项 4 个：`bgm.battle` 缺 master、微信真机、还没有人听过任何一个声音、ducking 未在真实 stinger 下听过** |
| [ONBOARDING_DESIGN.md](game/ONBOARDING_DESIGN.md) | **新手引导/FTUE 编排（首会话动线/专属教学关 ch0_tutorial 三阶段编排/首次功能引导/功能开放策略；合规已移出归 COMPLIANCE，不重述故事/关卡）** | 设计中 |
| [SLG_DESIGN.md](game/SLG_DESIGN.md) | SLG 大世界核心设计（§0–14：世界结构/地图/战斗接入/契约） | 实现中 **（拆分：§10 起 → `SLG_DESIGN_CONTRACTS.md`）** |
| [SLG_DESIGN_LOG.md](game/SLG_DESIGN_LOG.md) | SLG 大世界实现记录（§15 起：收尾清单/功能落地/bug 修复，worldsvc:18084；§21 剩余工作总览） | 实现中 **（2026-08-17 拆分：本文仅索引 + §15；正文见 `SLG_LOG_*.md`）** |
| [SGZ_LAND_REFERENCE.md](game/SGZ_LAND_REFERENCE.md) | **参考资料**：三国志战略版地块/资源/建筑/版图机制调研（非本项目设计基准，供 SLG 地块系统设计对照） | 参考 |
| [SLG_CITY_DESIGN.md](game/SLG_CITY_DESIGN.md) | **SLG 主城内政/建筑系统机制基准（仿三战书桌内政：资源建筑/练兵/城防/科技；激活 graphite/sticker faucet+sink；数字→ECONOMY_VERIFICATION_LOG §13-SLG-CITY，红线不喂天梯）** | P1+P2 已实现（e2e 8/8 实测）·数值 DRAFT |
| [SLG_CITY_SIEGE_DESIGN.md](game/SLG_CITY_SIEGE_DESIGN.md) | **野外城池攻占机制基准（宗门门槛 + 耐久/回复封死单人 + 归属/产量/锚点收益；补完 SLG §3.1 长期挂着的「驻军/耐久待定」缺口；数字→ECONOMY_VERIFICATION_LOG §13-SLG-CITYSIEGE）** | 已实现（P0/P1/P2 2026-08-25 + P3 2026-08-27，ADR-074/076/077）**·数值已由 `econ-sim/citySiegeRun.ts` 实测标定**（不再是 DRAFT） |
| [SLG_FIELD_BATTLE_DESIGN.md](game/SLG_FIELD_BATTLE_DESIGN.md) | **SLG 实时野战遭遇机制基准（停留/驻扎拆分 + Redis 逐格行军 + 玩家建筑层；SLG_DESIGN §4/§5.4 野外驻扎 v1 的 v2 升级）** | Accepted（ADR-051，2026-07-24）**·补进本地图 2026-09-03** |
| [SLG_ECONOMY_CHECK.md](game/SLG_ECONOMY_CHECK.md) | **SLG DRAFT 数值的经济性核验方法（6 条轨道分流：持久经济聚合/赛季资源/围攻/分区公平/节奏/运维；判据+流程+登记口径；数字仍→ECONOMY_NUMBERS §13-SLG）** | 设计中 |
| [WORLD_MAP_ART_SPEC.md](game/WORLD_MAP_ART_SPEC.md) | 大世界地图美术资产规格书（待替换的程序占位色块清单；权威=WorldMapScene.ts/SLG_DESIGN） | 实现中 |
| [AUCTION_DESIGN.md](game/AUCTION_DESIGN.md) | **拍卖行机制基准（交易模型/状态机/反 RMT；从 SLG §7/§14 抽出；数字→server/shared/src/slg/auction.ts）** | 实现中 **（§9 拆分任务清单 → `AUCTION_DESIGN_SPLIT_TASKS.md`）** |
| [UI_DESIGN.md](game/UI_DESIGN.md) | **菜单 / 元系统客户端 UI**（与战斗 UI 分工，见 §3） | 实现中 **（2026-08-17 拆分：场景规格 → `UI_DESIGN_SCENES.md`，变更记录 → `UI_DESIGN_LOG_*.md`）** |
| [LOBBY_IA_REDESIGN.md](game/LOBBY_IA_REDESIGN.md) | 大厅信息架构重规划（一级入口/底部 tab 重分组；装备并入养成、战绩升级为生涯、克制付费曝光） | 设计中 **（拆分：变更记录 → `LOBBY_IA_REDESIGN_LOG.md`）** |
| [PARALLEL_DEV_PLAN.md](game/archive/PARALLEL_DEV_PLAN.md) | **并行开发计划（按依赖耦合分三条轨道 A/B/C，各自 worktree）** | 已归档 |
| [LAUNCH_TRACK_1_CLIENT.md](game/archive/LAUNCH_TRACK_1_CLIENT.md) | 上线收口 Track 1 — 客户端合规 UI + 孤儿场景接线（已完成） | 已归档 |
| [LAUNCH_TRACK_2_SERVER.md](game/archive/LAUNCH_TRACK_2_SERVER.md) | 上线收口 Track 2 — 服务端闭环补全（已完成） | 已归档 |
| [LAUNCH_TRACK_3_RELEASE.md](game/archive/LAUNCH_TRACK_3_RELEASE.md) | 上线收口 Track 3 — 法务素材 + 真机验收 + 发布物料（已完成） | 已归档 |
| [IAP_CREDENTIALS.md](game/IAP_CREDENTIALS.md) | IAP / 广告凭据上线手册（commercial 验单 + metaserver 广告验签；验签权威=iap.ts/ads.ts） | 实现中 |
| [IOS_RELEASE.md](game/IOS_RELEASE.md) | iOS 发布手册（TestFlight/OTA R2/提审清单；TestFlight 已上、IAP 产品+提审待办） | 实现中 |

#### 1.2.1 验收清单（`design/game/release/`）
| 文档 | 范围 |
|---|---|
| [release/acceptance-S0-8.md](game/release/acceptance-S0-8.md) | 验收清单：meta 阶段 S0–S8 |
| [release/acceptance-S1-9.md](game/release/acceptance-S1-9.md) | 验收清单：阶段 S1–S9 |
| [release/acceptance-smoke.md](game/release/acceptance-smoke.md) | 上线前冒烟验收清单 |


#### 1.2.2 续册（正文按 500 行约定拆出，编号沿用父文档）

> **这些不是独立设计基准**——小节编号与父文档连续，源码里的 `父文档.md §N` 引用照旧有效，权威归父文档。
> 列在这里只为让文档地图**可枚举**：2026-09-03 审计发现 62 份 `design/` 文档从未出现在本地图里，其中 31 份是这类续册。

| 续册 | 父文档 | 承载 |
|---|---|---|
| [ANALYTICS_DESIGN_BACKEND.md](game/ANALYTICS_DESIGN_BACKEND.md) | [ANALYTICS_DESIGN.md](game/ANALYTICS_DESIGN.md) | §6 起（埋点后端） |
| [ANNA_CHARACTERS_MONSTERS.md](game/ANNA_CHARACTERS_MONSTERS.md) | [ANNA_CHARACTERS.md](game/ANNA_CHARACTERS.md) | 怪物设定 |
| [AUCTION_DESIGN_SPLIT_TASKS.md](game/AUCTION_DESIGN_SPLIT_TASKS.md) | [AUCTION_DESIGN.md](game/AUCTION_DESIGN.md) | §9 拆分任务清单 |
| [CAMPAIGN_DESIGN_KNOBS.md](game/CAMPAIGN_DESIGN_KNOBS.md) | [CAMPAIGN_DESIGN.md](game/CAMPAIGN_DESIGN.md) | §4.9 起（难度旋钮） |
| [CHARACTER_CARDS_DESIGN_IMPL.md](game/CHARACTER_CARDS_DESIGN_IMPL.md) | [CHARACTER_CARDS_DESIGN.md](game/CHARACTER_CARDS_DESIGN.md) | §9 起（实现） |
| [CHARACTER_DESIGN_HEROES_IRONCLAD_RUNNER.md](game/CHARACTER_DESIGN_HEROES_IRONCLAD_RUNNER.md) | [CHARACTER_DESIGN.md](game/CHARACTER_DESIGN.md) | §7.6 英雄（Ironclad / Runner） |
| [CHARACTER_DESIGN_HEROES_MEDIC.md](game/CHARACTER_DESIGN_HEROES_MEDIC.md) | [CHARACTER_DESIGN.md](game/CHARACTER_DESIGN.md) | §7.6 英雄（Medic） |
| [COMMERCIAL_DESIGN_IAP.md](game/COMMERCIAL_DESIGN_IAP.md) | [COMMERCIAL_DESIGN.md](game/COMMERCIAL_DESIGN.md) | §10 起（IAP） |
| [DESIGN_SUBSYSTEMS.md](game/DESIGN_SUBSYSTEMS.md) | [DESIGN.md](game/DESIGN.md) | §8 起（子系统） |
| [DIFFICULTY_SIM_TUNING_CH1_STARS.md](game/DIFFICULTY_SIM_TUNING_CH1_STARS.md) | [DIFFICULTY_SIM.md](game/DIFFICULTY_SIM.md) | ch1 + 三星调参记录 |
| [DIFFICULTY_SIM_TUNING_CH2-CH6.md](game/DIFFICULTY_SIM_TUNING_CH2-CH6.md) | [DIFFICULTY_SIM.md](game/DIFFICULTY_SIM.md) | ch2–ch6 调参记录 |
| [ECONOMY_NUMBERS_LIVEOPS.md](game/ECONOMY_NUMBERS_LIVEOPS.md) | [ECONOMY_NUMBERS.md](game/ECONOMY_NUMBERS.md) | §12 起（留存/赛季/活动/角色卡数字） |
| [ECONOMY_VERIFICATION_LOG_CAPACITY.md](game/ECONOMY_VERIFICATION_LOG_CAPACITY.md) | [ECONOMY_VERIFICATION_LOG.md](game/ECONOMY_VERIFICATION_LOG.md) | F 轨起（容量/险地/NPC 血量） |
| [EQUIPMENT_DESIGN_MODEL.md](game/EQUIPMENT_DESIGN_MODEL.md) | [EQUIPMENT_DESIGN.md](game/EQUIPMENT_DESIGN.md) | §3–8（数据模型） |
| [EQUIPMENT_DESIGN_IMPL.md](game/EQUIPMENT_DESIGN_IMPL.md) | [EQUIPMENT_DESIGN.md](game/EQUIPMENT_DESIGN.md) | §9–14（实现） |
| [EQUIPMENT_DESIGN_REF.md](game/EQUIPMENT_DESIGN_REF.md) | [EQUIPMENT_DESIGN.md](game/EQUIPMENT_DESIGN.md) | §15–20（参考） |
| [FEATURE_FLAGS_DESIGN_LOG.md](game/FEATURE_FLAGS_DESIGN_LOG.md) | [FEATURE_FLAGS_DESIGN.md](game/FEATURE_FLAGS_DESIGN.md) | §8 实现记录 |
| [LOBBY_IA_REDESIGN_LOG.md](game/LOBBY_IA_REDESIGN_LOG.md) | [LOBBY_IA_REDESIGN.md](game/LOBBY_IA_REDESIGN.md) | 变更记录 |
| [SEASON_DESIGN_IMPL_SPEC.md](game/SEASON_DESIGN_IMPL_SPEC.md) | [SEASON_DESIGN.md](game/SEASON_DESIGN.md) | §13A 起（可编码规格） |
| [SERVER_API_INTERNAL.md](game/SERVER_API_INTERNAL.md) | [SERVER_API.md](game/SERVER_API.md) | §7 起（内部契约 + worldsvc/analyticsvc/socialsvc/auctionsvc 公网面） |
| [SLG_CITY_SIEGE_DESIGN_LOG.md](game/SLG_CITY_SIEGE_DESIGN_LOG.md) | [SLG_CITY_SIEGE_DESIGN.md](game/SLG_CITY_SIEGE_DESIGN.md) | §10 P0–P3 落地记录 |
| [SLG_DESIGN_CONTRACTS.md](game/SLG_DESIGN_CONTRACTS.md) | [SLG_DESIGN.md](game/SLG_DESIGN.md) | §10 起（契约） |
| [SLG_LOG_S21-S33.md](game/SLG_LOG_S21-S33.md) | [SLG_DESIGN_LOG.md](game/SLG_DESIGN_LOG.md) | §21–§33 |
| [SLG_LOG_S34-S49.md](game/SLG_LOG_S34-S49.md) | [SLG_DESIGN_LOG.md](game/SLG_DESIGN_LOG.md) | §34–§49 |
| [SLG_LOG_S50-S63.md](game/SLG_LOG_S50-S63.md) | [SLG_DESIGN_LOG.md](game/SLG_DESIGN_LOG.md) | §50–§63 |
| [SLG_LOG_SPEC_SEASON.md](game/SLG_LOG_SPEC_SEASON.md) | [SLG_DESIGN_LOG.md](game/SLG_DESIGN_LOG.md) | §17 大区赛季可编码规格 |
| [SLG_LOG_SPEC_SYSTEMS.md](game/SLG_LOG_SPEC_SYSTEMS.md) | [SLG_DESIGN_LOG.md](game/SLG_DESIGN_LOG.md) | §16、§18–§20 承重墙系统（围攻/视野/险地/多 shard） |
| [SLG_LOG_2026-08.md](game/SLG_LOG_2026-08.md) | [SLG_DESIGN_LOG.md](game/SLG_DESIGN_LOG.md) | 2026-08 起的实现记录 |
| [UI_DESIGN_SCENES.md](game/UI_DESIGN_SCENES.md) | [UI_DESIGN.md](game/UI_DESIGN.md) | 场景规格 |
| [UI_DESIGN_LOG_2026-06_07.md](game/UI_DESIGN_LOG_2026-06_07.md) | [UI_DESIGN.md](game/UI_DESIGN.md) | 变更记录 2026-06/07 |
| [UI_DESIGN_LOG_2026-08.md](game/UI_DESIGN_LOG_2026-08.md) | [UI_DESIGN.md](game/UI_DESIGN.md) | 变更记录 2026-08 起 |

#### 1.2.3 审计记录（一次性切面审计，非设计基准）

| 文档 | 范围 |
|---|---|
| [COMM_AUDIT_INTERNAL_2026-07-28.md](game/COMM_AUDIT_INTERNAL_2026-07-28.md) | 服务间通信协议审计（11 进程的内部端点/出站客户端/Redis 通道；结论已全部修复） |
| [SERVER_LOGIC_AUDIT_2026-07-29.md](game/SERVER_LOGIC_AUDIT_2026-07-29.md) | 单进程内部业务逻辑审计（复杂度/内存/数据结构/输入校验/容错；结论已按严重度全部修复） |

> 存储侧那一轮（2026-07-27 Mongo/Redis）记录在 [`claudedocs/server-audits.md`](../claudedocs/server-audits.md)，不在 `design/` 下。

### 1.3 产品与玩法愿景（`design/product/`）
| 文档 | 范围 | 状态 |
|---|---|---|
| [core-gameplay-loop.md](product/core-gameplay-loop.md) | 核心玩法循环（**设计意图，数值非权威 → BALANCE.md**） | 实现中 |
| [logic-architecture.md](product/logic-architecture.md) | 逻辑层架构（坐标系/系统/录像）——**早期单仓 `packages/` 设想，与现仓库结构已脱节** | 历史参考（本文自己的状态头如此写；订正 2026-09-03，此前 README 记「实现中」）**（拆分：七 起 → `logic-architecture-events.md`）** |
| [art-direction.md](product/art-direction.md) | **美术方向（配色/渲染/资产分工的权威）** | 草稿待评审（本文自身状态头）·内容持续被实现引用 **（拆分：六 起 → `art-direction-map-ui.md`）** |
| [ui-design.md](product/ui-design.md) | **战斗内 UI 规格**（HUD/手牌/棋盘布局，见 §3） | 草稿进行中（本文自身状态头） |
| [characters.md](product/characters.md) | 角色设定 | 设计中 |
| [world.md](product/world.md) | 世界观 / 叙事 | 设计中 |
| [market-analysis.md](product/market-analysis.md) | 市场分析 | 参考 |
| [mvp-gaps.md](product/mvp-gaps.md) | MVP 缺口盘点（v0.2 早期，游戏已远超此范畴） | 已归档 |
| [deploy-cloudflare.md](product/deploy-cloudflare.md) | **线上部署拓扑权威**（Cloudflare 前端 + VPS 后端 + Atlas Mongo + 平台隔离边界，见 ADR-020） | 实现中 **（拆分：6b 起 → `deploy-cloudflare-staging.md`）** |
| [client-rendering-cache.md](product/client-rendering-cache.md) | 渲染缓存 / 对象池 | 实现中 |
| [v1-balance.md](product/v1-balance.md) | 早期数值提案（**未落地，已被 config.ts 取代**） | 已归档 |
| [v1-simulation.md](product/v1-simulation.md) | 基于 v1-balance 的推演（同上归档） | 已归档 |

#### 1.3.1 法务文档（`design/product/legal/`）
| 文档 | 范围 |
|---|---|
| [legal/privacy-policy.zh.md](product/legal/privacy-policy.zh.md) · [.en](product/legal/privacy-policy.en.md) · [.de](product/legal/privacy-policy.de.md) | 隐私政策（中/英/德三语；合规口径见 COMPLIANCE_GLOBAL/COMPLIANCE_CN） |
| [legal/terms-of-service.zh.md](product/legal/terms-of-service.zh.md) · [.en](product/legal/terms-of-service.en.md) · [.de](product/legal/terms-of-service.de.md) | 服务条款（中/英/德三语） |

#### 1.3.2 发布物料（`design/product/release/`）
| 文档 | 范围 |
|---|---|
| [release/store-assets-checklist.md](product/release/store-assets-checklist.md) | 商店上架素材清单（图标/截图/描述/分级等发布物料核对） |


#### 1.3.3 续册（`design/product/`，编号沿用父文档）

| 续册 | 父文档 | 承载 |
|---|---|---|
| [art-direction-map-ui.md](product/art-direction-map-ui.md) | [art-direction.md](product/art-direction.md) | 六 起（地图 / UI 美术方向） |
| [logic-architecture-events.md](product/logic-architecture-events.md) | [logic-architecture.md](product/logic-architecture.md) | 七 起（事件系统） |
| [deploy-cloudflare-staging.md](product/deploy-cloudflare-staging.md) | [deploy-cloudflare.md](product/deploy-cloudflare.md) | 6b 起（staging 环境） |

#### 1.3.4 美术 prompt / 出图记录（`design/product/`，素材制作过程，**非设计基准**）

> **美术方向权威仍是** [`art-direction.md`](product/art-direction.md)；本组是「照那个方向实际出了哪些图、哪一版过/打回」的过程记录。
> 单个文件动辄 50–70 KB，全组约 700 KB——2026-09-03 审计前**整组 25 份一份都不在文档地图里**。
> 接线/验收结论（图标长宽比豁免、`iconArtAspect.test.ts` 等）以各文件自己的状态头为准。

| 文档 | 范围 |
|---|---|
| [tab-icon-art-prompts.md](product/tab-icon-art-prompts.md) | 底部 tab / 通用图标 prompt（第 1–4 批，全部完成） |
| [tab-icon-art-prompts-batch5.md](product/tab-icon-art-prompts-batch5.md) | 图标第 5 批（43 个光栅图标 / 129 张 PNG，完成） |
| [tab-icon-art-prompts-batch6.md](product/tab-icon-art-prompts-batch6.md) | 图标第 6 批（46 个图标 / 138 张 PNG，完成） |
| [tab-icon-art-prompts-batch7.md](product/tab-icon-art-prompts-batch7.md) | 图标第 7 批（最终 43 张自有美术 + 6 别名 = 49 个 ink kind，完成） |
| [tab-icon-art-prompts-batch7-log.md](product/tab-icon-art-prompts-batch7-log.md) | 图标第 7 批的逐版打回记录 |
| [tab-icon-art-prompts-batch8.md](product/tab-icon-art-prompts-batch8.md) | 图标第 8 批 |
| [tab-icon-art-prompts-batch9.md](product/tab-icon-art-prompts-batch9.md) | 图标第 9 批（7 张，含 `camp` v2，完成） |
| [avatar-art-prompts.md](product/avatar-art-prompts.md) | 头像 prompt |
| [back-arrow-art.md](product/back-arrow-art.md) | 返回箭头图标 |
| [battle-arrow-tower-art.md](product/battle-arrow-tower-art.md) | 战斗内箭塔美术 |
| [panel-frame-art-prompts.md](product/panel-frame-art-prompts.md) | 面板边框 prompt |
| [shop-art-prompts.md](product/shop-art-prompts.md) | 商店美术 prompt |
| [gacha-art-prompts.md](product/gacha-art-prompts.md) | 盲盒美术 prompt |
| [skin-art-prompts.md](product/skin-art-prompts.md) | 皮肤美术 prompt |
| [family-emblem-art-prompts.md](product/family-emblem-art-prompts.md) | 家族徽记 prompt |
| [chapter-interlude-art-prompts.md](product/chapter-interlude-art-prompts.md) | 章节过场插画 prompt（6/6 完成） |
| [intro-story-art-prompts.md](product/intro-story-art-prompts.md) | 开场故事插画 prompt |
| [city-image-prompts.md](product/city-image-prompts.md) | 城池立绘 prompt |
| [player-base-image-prompts.md](product/player-base-image-prompts.md) | 玩家主城立绘 prompt |
| [player-base-image-prompts-v2.md](product/player-base-image-prompts-v2.md) | 玩家主城立绘 prompt v2 |
| [slg-building-art.md](product/slg-building-art.md) | SLG 建筑美术 |
| [slg-citybld-icon-prompts.md](product/slg-citybld-icon-prompts.md) | SLG 主城建筑图标 prompt（6/6 完成） |
| [slg-resource-art.md](product/slg-resource-art.md) | SLG 资源图标美术（母题 5 张） |
| [slg-resource-art-levels.md](product/slg-resource-art-levels.md) | SLG 资源分级图标 |
| [slg-terrain-art.md](product/slg-terrain-art.md) | SLG 地形美术 |

### 1.4 工具（`design/tools/`）
| 文档 | 范围 |
|---|---|
| [animator/ARCHITECTURE.md](tools/animator/ARCHITECTURE.md) · [REQUIREMENTS.md](tools/animator/REQUIREMENTS.md) | 骨骼动画编辑器（端口 9091） |
| [animator/WORKSPACE_SYNC.md](tools/animator/WORKSPACE_SYNC.md) | animator 在线工作区 + 云盘→仓库同步桥（Cloudflare Pages + Supabase + 自动 PR；**⚠️ 方向已被 desktop-shell/DESIGN.md 取代，见 ADR-055，已合并代码暂未下线**） |
| [desktop-shell/DESIGN.md](tools/desktop-shell/DESIGN.md) | **工具桌面壳（Electron，多工具挂载 + 壳/内容双层自动更新 + 预留 git 提交接口；状态：设计中）** |
| [level-editor/DESIGN.md](tools/level-editor/DESIGN.md) | 关卡编辑器（端口 9092） |
| [map-editor/DESIGN.md](tools/map-editor/DESIGN.md) | SLG 大地图编辑器（端口 9095） |
| [vfx-editor/DESIGN.md](tools/vfx-editor/DESIGN.md) | 特效编辑器（端口 9094，方案 A 墨线矢量程序特效；状态：设计中） |

### 1.5 快查文档（`claudedocs/`，模块级速查，非设计基准）

索引在 [`claudedocs/README.md`](../claudedocs/README.md)。全量 14 份（**订正 2026-09-03**：本节此前只列了 7 份）：

- **进程 / 服务端**：**[`server.md`](../claudedocs/server.md)（进程拓扑 / 端口权威）** · [`server-audits.md`](../claudedocs/server-audits.md)（存储侧审计与修复记录） · [`server-testing.md`](../claudedocs/server-testing.md) · [`server-testing-coverage.md`](../claudedocs/server-testing-coverage.md) · [`server-testing-tooling.md`](../claudedocs/server-testing-tooling.md) · [`server-testing-typecheck.md`](../claudedocs/server-testing-typecheck.md)
- **客户端**：[`client-modules.md`](../claudedocs/client-modules.md) · [`client-testing.md`](../claudedocs/client-testing.md) · [`client-testing-log.md`](../claudedocs/client-testing-log.md) · [`client-memory-leak.md`](../claudedocs/client-memory-leak.md)
- **工具 / 其它**：[`animator.md`](../claudedocs/animator.md) · [`tools-testing.md`](../claudedocs/tools-testing.md) · [`file-formats.md`](../claudedocs/file-formats.md) · [`worktrees.md`](../claudedocs/worktrees.md)

---

## 2. 权威来源登记表（冲突时认这一列）

| 域 | 权威来源 | 文档侧镜像/说明 |
|---|---|---|
| 战斗运行数值（HP/攻/速/费/上限/计时/卡池） | `server/engine/src/config.ts`（`@nw/engine`；client 经 alias） | [game/BALANCE.md](game/BALANCE.md) 快照 |
| 经济/养成**数值**（体力/合成/护甲/金币/皮肤价） | [game/ECONOMY_NUMBERS.md](game/ECONOMY_NUMBERS.md) | 演算沙盘，可调参数集中 §10 |
| SLG DRAFT 数值**怎么核验**（流程/判据/工具/登记，不拍数字本身） | [game/SLG_ECONOMY_CHECK.md](game/SLG_ECONOMY_CHECK.md) | 数字仍归 ECONOMY_NUMBERS §13-SLG；本文只定核验轨道与签字流程 |
| 经济**政策**/货币命名/盲盒哲学 | [game/ECONOMY_BALANCE.md](game/ECONOMY_BALANCE.md) | 货币：局内 `ink`（墨滴，清零）、持久 `coins`（金币，服务器权威） |
| 装备系统**机制**（槽位/获取/强化/洗练/注入/红线） | [game/EQUIPMENT_DESIGN.md](game/EQUIPMENT_DESIGN.md) | 数字去 ECONOMY_NUMBERS §5；强化升级取代旧"5件确定性合成"(ADR-009) |
| 成就系统**机制**（统计/解锁/领取/服务器权威） | [game/ACHIEVEMENT_DESIGN.md](game/ACHIEVEMENT_DESIGN.md) | 阈值/金币数字去 ECONOMY_BALANCE §2.4；纯一次性 faucet，不可刷 |
| 称号系统**机制**（公开身份名片/统一容器/授予/展示） | [game/TITLE_DESIGN.md](game/TITLE_DESIGN.md) | 段位首达金币数字去 ECONOMY_BALANCE §2.3；与成就解耦（成就纯自看，炫耀走称号） |
| 留存系统**机制**（签到/每日任务/周常/dayKey/领取） | [game/RETENTION_DESIGN.md](game/RETENTION_DESIGN.md) | 数字去 ECONOMY_NUMBERS §12；金币只从每日任务满点出、收敛 ~60/月，不新增龙头 |
| 活动/Live-ops **编排**（配置/生命周期/类型/经济约束） | [game/EVENTS_DESIGN.md](game/EVENTS_DESIGN.md) | 数字去 ECONOMY_NUMBERS §14；发奖复用 OPS 邮件、计数复用 statKey、限定直购复用 commercial；不新增金币龙头（ADR-014） |
| **野外城池**怎么打（宗门门槛/耐久+回复/守军波次/归属/占领收益） | [game/SLG_CITY_SIEGE_DESIGN.md](game/SLG_CITY_SIEGE_DESIGN.md) | 注意与 `SLG_CITY_DESIGN.md`（**主城**内政）区分；数字去 `server/shared/src/slg/citySiege.ts`（`CITY_*`；2026-08-25 从 `siege.ts` 拆出，`siege.ts` 只留格位级围攻结算），核验轨道走 SLG_ECONOMY_CHECK 轨道 3（围攻）+ 轨道 2（赛季资源） |
| 拍卖行**机制**（交易模型/挂单状态机/定向受拍/税/反 RMT） | [game/AUCTION_DESIGN.md](game/AUCTION_DESIGN.md) | 从 SLG §7/§14 抽出，机制以本文为准；数字去 `server/shared/src/slg/auction.ts`（`AUCTION_*`）；仅 coin 计价、赛季资源禁挂 |
| 两套赛季的**独立性契约/边界/对照**（天梯 vs SLG 大区谁重置谁、共享资产归属） | [game/SEASON_OVERVIEW.md](game/SEASON_OVERVIEW.md) | 不重述机制；机制权威仍归 SEASON_DESIGN / SLG_DESIGN；锁「两条时钟互不触发 + 重置写入域隔离 + 共享 coin/称号归属」 |
| 天梯赛季/战令/排行榜**机制**（赛季时钟·软重置·惰性迁移·峰值奖励·Top100·Battle Pass） | [game/SEASON_DESIGN.md](game/SEASON_DESIGN.md) | 数字去 ECONOMY_NUMBERS §13；天梯赛季6周 ≠ SLG大区赛季2个月（两条独立时钟）；赛季切换 = admin 手动开启 |
| 角色卡**机制/流派**（6张·东西双版本·获取分层） | [game/CHARACTER_DESIGN.md](game/CHARACTER_DESIGN.md) | 数值锚点占位→落 `config.ts`+[BALANCE.md](game/BALANCE.md)；涛3＝现有兵转具名(数值不动·锚点)，Anna3＝新画变体；PvP全送/PvE章节解锁(ADR-016) |
| PvE 关卡定义 | `client/src/game/campaign/levels/*.json`（+ level-editor 编辑、`parseLevelDefinition` 校验） | — |
| PvE 奖励 / 养成数据权威 | 服务器 `server/shared/src/pveRewards.ts` + [PVE_INTEGRITY_PLAN.md](game/PVE_INTEGRITY_PLAN.md)（方案 B：服务器权威） | 客户端 JSON 仅参考/编辑器用 |
| 接口契约（REST/WS/proto/DB 集合） | [game/SERVER_API.md](game/SERVER_API.md) + `server/contracts/` | — |
| 功能开关机制（白名单/定向求值/分发/后台） | [game/FEATURE_FLAGS_DESIGN.md](game/FEATURE_FLAGS_DESIGN.md) | 接口落 SERVER_API/openapi；flag 白名单+default 真源 `server/shared/src/featureFlags.ts`；≠ SaveData.flags（玩家态） |
| 进程拓扑 / 端口 | [claudedocs/server.md](../claudedocs/server.md) | 11 个应用进程，见 §4 |
| 多区域部署（区域划分/匹配域/数据驻留） | [game/DEPLOY_TOPOLOGY.md](game/DEPLOY_TOPOLOGY.md) | Meta 共享+对战层按区隔离+中国独立；同区匹配、好友房跨区（ADR-019）；进程拓扑仍归 server.md |
| 配色 / 渲染 / 美术资产分工 | [product/art-direction.md](product/art-direction.md) + `client/src/render/theme.ts` | 阵营色 **我蓝敌红**（v0.3） |
| 客户端 UI | 菜单/元系统 → [game/UI_DESIGN.md](game/UI_DESIGN.md)；战斗内 → [product/ui-design.md](product/ui-design.md) | 互补分工，见 §3 |
| 实现状态 / 任务进度 | [game/META_TASKS.md](game/META_TASKS.md) + 各文档「实现记录」节 | — |
| 叙事铁律 | [product/world.md](product/world.md) + ADR-008 | 涛(东方)/Anna(西方)/两本笔记本 |
| 海外合规（隐私/分级/抽卡公示/平台支付/删账号/UGC） | [game/COMPLIANCE_GLOBAL.md](game/COMPLIANCE_GLOBAL.md) | 与中国版 [COMPLIANCE_CN](game/COMPLIANCE_CN.md) 解耦（ADR-013，海外先行） |
| 中国大陆合规（版号/实名/防沉迷/分龄充值限额/PIPL） | [game/COMPLIANCE_CN.md](game/COMPLIANCE_CN.md) | 跟版号流程走、海外测试不触发；抽卡概率公示与海外共用一套数据源（COMPLIANCE_GLOBAL §4） |
| 音频系统（资产/触发/播放层/混音/设置/平台约束） | [game/AUDIO_DESIGN.md](game/AUDIO_DESIGN.md) | **美学方向**（音色/禁用清单）仍归 [product/art-direction.md](product/art-direction.md) §声音 |
| 新手引导/FTUE 编排（动线/专属教学关 ch0_tutorial/首次功能引导/功能开放策略） | [game/ONBOARDING_DESIGN.md](game/ONBOARDING_DESIGN.md) | 故事归 CAMPAIGN_STORY/world；引擎/波次结构归 @nw/engine；合规弹窗归 COMPLIANCE（开机层，非引导）；埋点字段归 ANALYTICS |

---

## 3. 两份 UI 文档的分工（常见困惑）

不是冲突，是**分层**：
- **[game/UI_DESIGN.md](game/UI_DESIGN.md)** = 菜单 / 元系统客户端 UI（大厅、商店、收集、战役地图、导航、i18n、网络态）。
- **[product/ui-design.md](product/ui-design.md)** = 战斗内 UI 规格（HUD、手牌、棋盘布局、结算）。
- 配色一律引 [art-direction.md](product/art-direction.md)，两份 UI 文档不各自定义配色。

---

## 4. 进程拓扑（11 个应用进程）

权威清单见 [claudedocs/server.md](../claudedocs/server.md)。应用进程 = **11 个**（`engine`/`shared`/`contracts` 是 npm 包不算进程，mongo/redis 是基础设施）：

`metaserver` · `gateway` · `matchsvc` · `gameserver` · `commercial` · `admin` · `worldsvc` · `socialsvc` · `analyticsvc` · `auctionsvc` · `botsvc`

> [META_DESIGN.md](game/META_DESIGN.md) §6.1 的「6 组件」是 **meta 范畴**（S0–S5）的拓扑，不含后加的 admin/worldsvc/socialsvc/analyticsvc/auctionsvc/botsvc——以本节为全量。

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

**状态标记只有一个家**（新增 2026-09-03）：每份文档的「状态」写在**它自己的文档头**（`> 状态：… · 权威：… · 更新：YYYY-MM-DD`）。
§1 各表的状态列是**那一行的镜像**，不是第二处真源——两边不一致时**认文档头**，然后修 README。
2026-09-03 审计发现 11 行两侧对不上（10 行是 README 落后，含把已发货的录像分享写成「待实现」、把 6.9k 行的
botsvc 写成「设计中」），根因就是同一个事实存在两处、且没有任何门禁比对它们。**新开文档必须带状态头**——
`SOCIAL_SVC_DESIGN.md` 当时没有，README 那一行于是无从校对，一路错到审计。

**加/减一个应用进程必须记 ADR**（新增 2026-09-03，见 [ADR-080](DECISIONS_ADR-070-onward.md)）：只改
`claudedocs/server.md` 不算——后者是「现在代码长这样」的快查，不是拍板记录。socialsvc / auctionsvc / botsvc
三次加进程都只改了快查，导致 ADR-005 长期是全仓唯一还说「8 个进程」的文档。

---

## 6. 一致性审计记录

### 2026-09-03 —— 全库审计（161 份文档 vs 代码）

机械核对了六件事：README 地图完整性、全库相对链接、§2 登记表里每条代码路径是否存在、`BALANCE.md` 逐项对表
`config.ts`/`blueprintDefs.ts`、`SERVER_API` 端点 vs 四份 openapi spec、ADR 索引 vs 正文。结论分三类，已全部修完。

**A 类 —— 代码与文档冲突（10 处）**
1. `BALANCE.md` 的 Max 攻击力停在 14，代码 2026-07-17 已改 11（ghost-fix 后重调）——漂移 7 周，本文 §0 铁律 1 的第一次失效。
2. `server/shared/src/slg.ts` 2026-07-05 拆包后不存在，仍有 9 份活文档（含本文 §2 登记表）把它当数值真源。
3. 野外城池 `CITY_*` 真源指向 `slg/siege.ts`，实际在 `slg/citySiege.ts`（该文件头自己就写了文档指错）。
4. 本文装备行的 ⚠️「洗练当前不扣金币」——ADR-030 已于 2026-07-03 实装收费，`ECONOMY_BALANCE §3.4` 早标了 ✅。
5. `SERVER_API_INTERNAL §10.1` 仍列 `POST /world/occupy`，该路由已摘除（e2e 断言 404）。
6. `SERVER_API_INTERNAL §10.3` 整组 Family 端点在代码里一条都不存在（ADR-021 迁 socialsvc 并去掉 `worldId`）。
7. 账号删除端点三处仍写 `POST /account/delete`，落地的是 `DELETE /account`。
8. ADR-005「8 个应用进程」至今 Accepted，全仓其余文档都是 11——三次加进程都没记 ADR。已加 ADR-080 取代。
9. `SERVER_API §2.9` 的 `POST /events/redeem` 有完整契约，spec 与代码均无。
10. `blueprintDefs.ts` 四个单位注释写「PvE-only」，与同文件上方 section 注释和 `PVP_LOADOUT_DESIGN` 矛盾。

**B 类 —— 状态标记两侧对不上（11 行）**：详见 §5「状态标记只有一个家」。10 行是本文落后（把已发货的录像分享
记成「待实现」、把 6.9k 行的 botsvc 记成「设计中」等），1 行是文档头落后（`SEASON_DESIGN` 还写「设计中 / 2026-06-21」）。

**C 类 —— 索引缺失**：62 份文档不在本地图里；`DECISIONS.md` 标题写「共 69 条」而实际 79 行、ADR-079 有正文无索引行；
`claudedocs/README.md` 漏自己 6 份；仓库地图漏 `tools/desktop-shell`、`tools/gimp-export-layers`。
另发现三份文档（本文、`BALANCE.md`、`ECONOMY_NUMBERS_LIVEOPS.md`）末尾残留历史会话漏进去的 `</content>` 标签，已清。

**D 类 —— 契约覆盖缺口**：`SERVER_API` 自称「接口契约单一来源」，但把四份 openapi spec 的 180 条路径逐条对过之后，
有 **7 条端点在 spec 里、`design/` 全库一处未提**（`/match/{roomId}/replay/share`、`/pve/stamina/purchase`、
`/recharge/claim`、`/world/structure/demolish`、`/world/troops/recover`、`/social/mail/{mailId}` 的读/删两条），
另有 `/pve/enter`（体力扣费点）只在 `ECONOMY_NUMBERS.md` 出现过、契约文档漏列。同时 `openapi-social.yml` 这**第四份 spec**
从未出现在 §0/§1.2 的契约清单里，socialsvc/auctionsvc 两个公网面在本文档也没有小节（已补 §12/§13）。
`BALANCE.md` 侧：§4 手牌表漏了 `HAND_REFRESH_COST=10`（整手刷新，HUD 上有按钮），§8 之后接 `§7.1` 编号断裂，
头部「来源截至 2026-06-21 / 更新 2026-07-02」与正文里 2026-07-15 的改动记录三个日期互不相容。全部已修，
现在 180 条路径**每一条**都能在 `design/` 里检索到。

**核对通过的部分**（本次未动）：全库 md 相对链接 0 处断链；§2 登记表其余 13 条代码路径全部存在；
`BALANCE.md` §1–§7 除 Max 一处外与代码逐项一致（棋盘/墨/加速/手牌/11 单位/2 建筑/24 卡费/PvE 法术）；
`PVP_LOADOUT_DESIGN` 的 12 单位 `siegeValue` + 费用表逐项一致；11 进程与端口表四处口径一致；
阵营色我蓝敌红、gacha 70/90、天梯 9 段、`SLG_MAP_W/H=1500`、troopCap 5000+1500/级 全部与代码相符。

**根因与门禁**：两类漂移各有一个模式——**代码文件搬家后不回改文档**（A2/A3，`slg.ts` 与 gacha 两次拆包同源），
**同一事实存在两处且无门禁比对**（B 全类）。对应加了两条规约（§5「状态标记只有一个家」、「加减进程必须记 ADR」）
+ 一条可机械执行的地图完整性核对命令（见本文页首）。这三条都是「能用命令跑出来」的形态，而不是又一句提醒。
