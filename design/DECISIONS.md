# 决策日志（ADR）

> 状态：实现中 · 权威：本文 · 更新：2026-06-21

记录**会造成文档间漂移**的关键拍板：改数值口径、改命名、改架构、废弃旧方案。
每条 ADR 注明：日期、决策、影响的文档、为什么。新拍板追加在末尾，不改旧条目（要改就加一条新的 *Supersedes*）。

格式：`ADR-NNN 标题 — 状态(Accepted/Superseded) — 日期`

---

## ADR-001 战斗数值单一可信源 = `config.ts` — Accepted — 2026-06-21

- **决策**：战斗运行数值（HP/攻/速/费/上限/计时/卡池）以 `config.ts` 为唯一可信源。文档侧只在 [`game/BALANCE.md`](game/BALANCE.md) 做带日期的快照。（G3-2b-0 后 config.ts 真身在 `server/engine/src/`＝`@nw/engine`，client 经 alias 引用。）
- **背景**：审计发现 `core-gameplay-loop.md`、`v1-balance.md`、`DESIGN.md`、`config.ts` 四处数值互不一致（墨上限 30/300/300、普通兵卡费 4/16/4、移速 1.0/0.5/1.4 等）。根因是数值散落在多份散文文档里各自演化。
- **影响**：新增 BALANCE.md；core-gameplay-loop 数值降级为"设计意图"并加指针；v1-balance/v1-simulation 标记归档。

## ADR-002 局内货币重命名 `coins → ink` — Accepted — 2026-06-13

- **决策**：局内资源叫 `ink`（墨滴，单局清零）；跨局持久元货币叫 `coins`（金币，服务器权威）。代码重命名已完成（纯重构不改数值）。
- **影响**：[`game/ECONOMY_BALANCE.md`](game/ECONOMY_BALANCE.md) 为权威。`core-gameplay-loop.md` 等旧文仍把局内资源叫"金币"，属待清理的旧词（数值非权威，低优先）。

## ADR-003 阵营色 = 我蓝敌红（v0.3） — Accepted — 2026-06-14

- **决策**：我方 = 蓝钢笔，敌方 = 红钢笔。覆盖 v0.2「同色不换色」。
- **为什么**：红=老师批改=权威，是叛逆少年的对立面（diegetic）；红=敌全人类通识，乱战可读性最强；且为"红军即自己"的镜像 twist 在视觉上埋线。
- **影响**：[`product/art-direction.md`](product/art-direction.md) §3.2 为权威 + `theme.ts` `factionInk`。UI 文档不另定义阵营色。皮肤铁律：绝不动敌我蓝红。

## ADR-004 服务端进程拆分（gateway / matchsvc 独立） — Accepted — 2026-06-14（S1-M5）

- **决策**：gateway（控制面 WS）与 matchsvc（匹配大脑）拆为独立进程，经内部 HTTP 互通；commercial 独立进程 + 独立库。
- **影响**：[`GATEWAY_DESIGN.md`](game/GATEWAY_DESIGN.md) / [`MATCHSVC_DESIGN.md`](game/MATCHSVC_DESIGN.md) / [`claudedocs/server.md`](../claudedocs/server.md) 为现行实现。[`META_DESIGN.md`](game/META_DESIGN.md) §6.1 写于过渡期，其"6 组件"是 meta 范畴口径。

## ADR-005 应用进程口径 = 8 个 — Accepted — 2026-06-21

- **决策**：应用进程 8 个：metaserver / gateway / matchsvc / gameserver / commercial / admin / worldsvc / analyticsvc。`shared` 是 npm 包不计入；mongo/redis 是基础设施。
- **背景**：CLAUDE.md 旧称"九进程"且列表漏了 matchsvc、混入了 shared 包。
- **影响**：CLAUDE.md 已改；[`claudedocs/server.md`](../claudedocs/server.md) 为权威清单。

## ADR-006 PvE 数据走服务器权威（方案 B） — Accepted — 2026-06 PVE_INTEGRITY_PLAN §8

- **决策**：PvE 升级 / 通关 / 材料从"客户端同步段"迁为**服务器权威**——`pveUpgrades`/`progress`/`materials` 客户端只读镜像，变更走 `POST /pve/clear`、`POST /pve/upgrade`；奖励服务器按 `shared/pveRewards.ts` 重算，不信客户端自报。
- **影响**：[`PVE_INTEGRITY_PLAN.md`](game/PVE_INTEGRITY_PLAN.md) 为 PvE 数据权威真源。[`CAMPAIGN_DESIGN.md`](game/CAMPAIGN_DESIGN.md) §3 的"campaignProgress 客户端权威"措辞已加指针修正。`/pve/*` 端点契约待补进 [`SERVER_API.md`](game/SERVER_API.md)（缺口）。

## ADR-007 SLG 围攻 = 双方预布兵确定性自动战斗 — Accepted — 2026-06-20（G3）

- **决策**：放弃手操；关键围攻 = 双方预布兵的确定性自动战斗，**服务器跑引擎算权威结果即时落地**，客户端凭 `seed + 双方布阵`本地重播观战。
- **作废**：上一版「廉价线性结算为权威 + judge 复算反作弊对账 + 手操复盘」（S8-3/S8-3b）。`judgeRunner` siege 路径、录像上传、peer 复算、`siegeLandingFromVerdict` 全删。
- **影响**：[`SLG_DESIGN.md`](game/SLG_DESIGN.md) §16 为现行基准；§8-3/§8-3b/§11 的旧描述已加"已被 §16 取代"指针。

## ADR-009 经济/养成体系：体力 + 合成树 + 等值广告金币 — Accepted — 2026-06-21

- **决策**（用户拍板）：
  - **体力**：引入体力概念作为关卡刷材料的总闸门；不同关卡耗不同体力、产出不同。
  - **单位养成**：每单位 9 级；**5 张 N 级卡 → 合成 1 张 (N+1) 级，100% 成功**（指数 sink，T9 = 5⁸ ≈ 39 万张 T1 卡，长期 aspirational）。
  - **养成轴**：HP / 攻击力 / 攻速 / 移速 + **新增护甲 armor**（flat 减伤，填补当前无护甲的空缺）+ 每单位 1 个里程碑特性（建议）。
  - **装备养成**：独立系统，**可失败**（区别于单位合成 100%），结构 [DRAFT]。
  - **金币来源**：看广告 **固定 3 coins/条、≤5 条/天、每条间隔 ≥30 min**（弃"等值挂钩"提案）；大头在战斗/活动/称号/任务；**F2P 活跃玩家月目标 ~300 金币**。称号/成就一次性龙头保留。
  - **皮肤**：common/rare/部分 epic 金币直购；高级 epic + legendary 仅抽卡；活动限定直购。稀有度色 = 灰/蓝/紫/**橙**（legendary=橙 `#e08a2c`，2026-06-21 定）。
  - **T9 可达性**：后期关卡直产 T3 卡 + 抽卡/直购/拍卖行；付费无压力，F2P 主力 T5–T6；不想氪可只玩公平 PvP。
  - **里程碑（俗套基线）**：T3 暴击 / T6 吸血 / T9 +1出兵，通用三档；后期再差异化。
  - **装备（俗套基线，最深氪点）**：每单位 3 槽（武器/护具/饰品），+1→9 强化，成功率每级 −10%（80%…+8→9 仅 10%），**失败只损材料、不掉级不碎**；**无销毁渠道**（满级只增不减）；整套 +9 鲸鱼级稀有。
- **影响**：新增 [`game/ECONOMY_NUMBERS.md`](game/ECONOMY_NUMBERS.md) 为经济/养成数值权威；取代 ECONOMY_BALANCE §2.1 旧"50 coins/广告"。**护甲为新引擎机制**，落地时配套**重新演算全部战斗数值**（更新 BALANCE.md）。

## ADR-008 叙事铁律：两本笔记本，东西不混搭 — Accepted

- **决策**：陶（中国/来德 2 年/家庭有爱/只画东方）与 Anna（德国/富裕/只画西方）各一本笔记本贯穿剧情；东西碰撞 = 两本相遇，**不是**一人混搭。对外名 **Nivara**（亦大陆名），内部仍 Notebook Wars。
- **影响**：[`product/world.md`](product/world.md) / [`game/CAMPAIGN_STORY.md`](game/CAMPAIGN_STORY.md)。神话层（[`MYTHOLOGY_DESIGN.md`](game/MYTHOLOGY_DESIGN.md)）是"作者赋予神力"的叠加，不另起神话章节、不破坏两本结构。
</content>
