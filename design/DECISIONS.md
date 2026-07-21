# 决策日志（ADR）

> 状态：实现中 · 权威：本文 · 更新：2026-07-13

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
- **影响**：[`SLG_DESIGN_LOG.md`](game/SLG_DESIGN_LOG.md) §16 为现行基准；§8-3/§8-3b/§11 的旧描述已加"已被 §16 取代"指针。

## ADR-009 经济/养成体系：体力 + 合成树 + 等值广告金币 — Accepted — 2026-06-21

- **决策**（用户拍板）：
  - **体力**：引入体力概念作为关卡刷材料的总闸门；不同关卡耗不同体力、产出不同。
  - **单位养成**：每单位 9 级；**5 张 N 级卡 → 合成 1 张 (N+1) 级，100% 成功**（指数 sink，T9 = 5⁸ ≈ 39 万张 T1 卡，长期 aspirational）。
  - **养成轴**：HP / 攻击力 / 攻速 / 移速 + **新增护甲 armor**（flat 减伤，填补当前无护甲的空缺）+ 每单位若干**单位养成特性**（trait，离散质变；原称"里程碑特性"，已改名脱钩成就系统）。
  - **装备养成**：独立系统，**可失败**（区别于单位合成 100%），结构 [DRAFT]。
  - **金币来源**：看广告 **固定 10 coins/条、≤5 条/天（≤50/天）、每条间隔 ≥30 min**（2026-06-27 拍板 10——先定 50 觉偏高，同日下调至 10，**上线后看效果再议**；与代码 `ADS_REWARD_COINS` 一致；弃早期「50 / 3 coins / 等值挂钩」提案）。10×5≈1,500/月，仍略高于早期「~300/月、广告小头」目标但已温和，如需再收敛优先调 `ADS_DAILY_CAP` 或定价。大头在战斗/活动/称号/任务；称号/成就一次性龙头保留。
  - **皮肤**：common/rare/epic 金币直购（epic 1,800）；legendary 仅抽卡；活动限定直购。稀有度色 = 灰/蓝/紫/**橙**（legendary=橙 `#e08a2c`，2026-06-21 定）。
  - **T9 可达性**：后期关卡直产 T3 卡 + 抽卡/直购/拍卖行；付费无压力，F2P 主力 T5–T6；不想氪可只玩公平 PvP。
  - **单位养成特性（俗套基线）**：T3 暴击 / T6 吸血 / T9 +1出兵，通用三档；后期再差异化。仅 PvE/SLG 注入，PvP 硬墙恒不读。**"里程碑/milestone" 一词此后专留给成就系统**。
  - **装备（俗套基线，最深氪点）**：每单位 3 槽（武器/护具/饰品），+1→9 强化，成功率每级 −10%（80%…+8→9 仅 10%），**失败只损材料、不掉级不碎**；**无销毁渠道**（满级只增不减）；整套 +9 鲸鱼级稀有。
- **影响**：新增 [`game/ECONOMY_NUMBERS.md`](game/ECONOMY_NUMBERS.md) 为经济/养成数值权威；取代 ECONOMY_BALANCE §2.1 旧"50 coins/广告"。**护甲为新引擎机制**，落地时配套**重新演算全部战斗数值**（更新 BALANCE.md）。

## ADR-010 装备升级 = 概率强化（取代"5 件确定性合成升级"） — Accepted — 2026-06-21

- **决策**：装备「9 级」一律走 **概率强化 +1→9**（每级 −10% 成功率，失败只损材料/金币、不掉级不碎；ADR-009 口径）。合成（锻造）**降级为"获得渠道"**：文具材料 → 一件 0 级基础装备，不再承担升级。三动作分工 = **合成（获得）/ 强化（升级，概率）/ 洗练（重洗词条，吞低级同类）**。
- **作废**：旧稿「9 级合成升级 = 每升 1 级吃 5 个同种装备（Lv N = 5×Lv N-1）」——该确定性升级机制被概率强化取代（与单位卡 100% 合成保持区别，正是 ADR-009「装备可失败」的体现）。
- **影响**：新增 [`game/EQUIPMENT_DESIGN.md`](game/EQUIPMENT_DESIGN.md) 为装备系统**机制**单一权威（数字仍归 ECONOMY_NUMBERS §5）；[`game/ECONOMY_BALANCE.md`](game/ECONOMY_BALANCE.md) §5.5 与 [`game/META_DESIGN.md`](game/META_DESIGN.md) §11.4 的旧"5 件合成升级"描述已加指针指向本 ADR / EQUIPMENT_DESIGN。

## ADR-008 叙事铁律：两本笔记本，东西不混搭 — Accepted

- **决策**：陶（中国/来德 2 年/家庭有爱/只画东方）与 Anna（德国/富裕/只画西方）各一本笔记本贯穿剧情；东西碰撞 = 两本相遇，**不是**一人混搭。对外名 **Nivara**（亦大陆名），内部仍 Notebook Wars。
- **影响**：[`product/world.md`](product/world.md) / [`game/CAMPAIGN_STORY.md`](game/CAMPAIGN_STORY.md)。神话层（[`MYTHOLOGY_DESIGN.md`](game/MYTHOLOGY_DESIGN.md)）是"作者赋予神力"的叠加，不另起神话章节、不破坏两本结构。

## ADR-011 留存系统 = 不新增金币龙头 — Accepted — 2026-06-21

- **决策**：每日签到/每日任务/周常**复用既有「日常任务 ~60/月」金币预算，不另立金币龙头**。签到本体几乎不发金币、主发**软通货**（体力/材料/卡/抽卡碎片，受体力闸门+养成树自然约束，不进金币通胀推演）；金币只从**每日任务满点**一次性出且有日上限（初定 2 coins/天 ≈ 60/月）。机制服务器权威 + `dayKey`（复用广告金币既有计数），领取/红点/SaveData 扩展与成就系统同构。断签**温和档**：月历式累计、漏签不清零不惩罚。
- **为什么**：留存是经济里唯一的「持续金币 faucet」，最易冲垮 F2P ~300/月预算（ECONOMY_BALANCE §1 反通胀）；锁死为软通货钩子 + 受控小额金币，留存收益拉满而通胀压力≈0。温和断签避免逼走休闲玩家（与装备失败不碎、ADR-009 全经济温和基调一致）。
- **影响**：新增 [`game/RETENTION_DESIGN.md`](game/RETENTION_DESIGN.md) 为留存系统**机制**单一权威；数字落 [`game/ECONOMY_NUMBERS.md`](game/ECONOMY_NUMBERS.md) §12，§6.1「日常任务」行已改为「日常任务/签到」并加指针。奖励仅注入 PvE/SLG/账号资源，PvP 硬墙恒不读（ADR-009）。任务计数复用成就 statKey 累加链，不开客户端写口（ACHIEVEMENT A2）。

## ADR-012 装备生命周期：有限回收 + 库存上限 + 3 槽确认 — Accepted — 2026-06-21

- **决策**（用户拍板，*Supersedes* ADR-009「装备无销毁渠道」一条）：
  - **分解回收（取代"无销毁"）**：装备可分解，返还 **70% 打造材料**（**强化投入不返还**——强化失败损耗仍是核心 sink，不让分解漏回）；**+5 及以上不可分解**（已具价值，作为保护），高级件出口转为**拍卖 / 穿戴**。30% 损耗本身是温和 sink，分解主职是清库存。
  - **库存硬上限 = 300 独立实例**（堆叠的 0 级无词条件不计）；满仓禁获得新实例，直掉成品转**等值材料补偿**。
  - **穿戴单独计、不占 300**；穿戴数**结构性自限 = 3 槽 × loadout 套数**，不另设大上限，且因此当不成"穿戴囤货"后门。
  - **获取口径**：**材料为主、合成为成品骨干 + Boss/精英/后期关低概率直掉成品当彩头**；弃"满地掉装备"（与库存上限 + 仓鼠苦役冲突）。
  - **同时挂拍上限 = 5 件**（可付费扩为软变现杠杆，仅 SLG）；挂单 24–48h 时效，**流拍退回库存**，满仓则进溢出暂存区，不丢不超限。
  - **槽位维持 3 槽**（武器/护具/饰品）：否决"头盔/衣/裤/双手/双脚/腰带 8 件解剖槽"提案。理由：战力上限固定（35%/1.5×），加槽=稀释非增强；单位是出兵的小兵群非换装英雄；解剖槽无独立机制轴；破坏文具叙事皮；小涂鸦兵美术 + 存档双爆。深度走 `byUnit` 每兵种 loadout，不靠加槽。
- **为什么**：旧"无销毁"导致实例只增不减、存档膨胀无阀；有限回收 + 硬上限既治膨胀又添温和 sink，且 +5 保护 + 拍卖出口保住高投入件价值。数值全部缩小（库存 300 而非 500/1000、挂拍 5）符合"攒一套满级装备本就极难"的稀缺基调。
- **影响**：[`game/EQUIPMENT_DESIGN.md`](game/EQUIPMENT_DESIGN.md) L4 改写 + §3.3 / §6.3（新增分解）/ §4 / §13 / §14 / §16 更新为权威；[`game/ECONOMY_NUMBERS.md`](game/ECONOMY_NUMBERS.md) §5.1 / §5.3 / §6.3 / §10 同步去"无销毁"口径并补参数。`/equipment/salvage` 端点待进 SERVER_API.md。

## ADR-013 合规拆分为 Global / CN 两份，海外先行 — Accepted — 2026-06-21

- **决策**（用户拍板）：合规义务按地区拆两份文档，**互相解耦**：
  - **海外（先做）= [`game/COMPLIANCE_GLOBAL.md`](game/COMPLIANCE_GLOBAL.md)**：Web + iOS + Google Play 三渠道。硬门 = 隐私政策 / 年龄分级（IARC·ESRB·PEGI·Apple）/ **抽卡概率公示**（Apple 3.1.1 + Google Play，中外通吃）/ 平台 IAP 强制 / 应用内删账号（Apple 5.1.1(v)）/ GDPR·COPPA / UGC 治理。
  - **中国（跟版号走，可推迟）= `COMPLIANCE_CN.md`**（占位，未建）：版号(ISBN) / 实名认证 / 防沉迷（未成年限时限额）/ PIPL / 分龄充值限额。
- **为什么**：实名 + 防沉迷 + 版号是**中国区特有**，海外测试期不触发；但海外有自己（更轻）的一套，且**抽卡概率公示**和**平台支付强制**最易在审核卡审。先海外测试、同时申国内版号，两条线并行不阻断。
- **影响**：新增 COMPLIANCE_GLOBAL.md 为海外合规权威；README §1.2 / §2 登记。挂钩既有系统：analyticsvc §10（同意/删除）、commercial GachaPool weight（概率公示数据源）、account（删账号端点待补 SERVER_API）、social 敏感词（UGC）。`iapVerify` dev 桩上线前换平台 SDK。

## ADR-014 活动/Live-ops = 叠加既有系统的受控容器，不新增金币龙头 — Accepted — 2026-06-21

- **决策**（用户拍板）：运营活动作为**有时效的内容容器**引入（回答 ECONOMY_BALANCE §299「是否引入限时活动池/双倍掉落」=引入但严格受控），且**不另造平行子系统**——发奖走 OPS 邮件路径、任务计数复用 RETENTION/ACHIEVEMENT 的 statKey 累加链、限定直购复用 commercial 商店、时钟服务器权威（同 dayKey 思路）。经济红线：①**不新增金币龙头**（活动金币计入月度 ~300 预算，主发软通货/限定皮肤碎片/活动积分，同 ADR-011）；②双倍/加成期有**硬封顶**且只作用于受体力闸门约束的 PvE 产出（ADR-009 体力总闸）；③限定直购**不破皮肤稀有度铁律**（不把高级 epic/legendary 降为金币直购）；④活动积分活动期清零、不沉淀；⑤**PvP 硬墙恒不读活动加成**（ADR-009）。
- **为什么**：活动是最容易冲垮 F2P 经济预算与公平性的运营口子；锁死「叠加正向收益、从不削弱常态、可错过不可剥夺」+ 复用既有发奖/计数/售卖路径，避免造第二条发奖通道与数值漂移。活动有**自己的第三条时钟**，与天梯6周/SLG大区2月赛季时钟解耦（SEASON_OVERVIEW），纯由 window 决定。
- **影响**：新增 [`game/EVENTS_DESIGN.md`](game/EVENTS_DESIGN.md) 为活动系统编排权威；数字落 [`game/ECONOMY_NUMBERS.md`](game/ECONOMY_NUMBERS.md) §14（待建）；ECONOMY_BALANCE §299 待决项关闭。`/events` 端点待补 SERVER_API.md。README §1.2 / §2 登记。

## ADR-015 文档缺口补全（实现前收口） — Accepted — 2026-06-21

- **决策**：实现功能前先补齐设计文档自登记的缺口，使 design/ 无悬空引用。本轮补齐 7 项：
  - **新建 [`game/COMPLIANCE_CN.md`](game/COMPLIANCE_CN.md)**（兑现 ADR-013 占位）：版号/实名/未成年人防沉迷限时/分龄充值限额/PIPL，跟版号走、海外测试不阻断。
  - **[`game/ECONOMY_NUMBERS.md`](game/ECONOMY_NUMBERS.md) §13**（赛季/战令数值，SEASON_DESIGN 引用）+ **§14**（活动加成封顶/积分/月度归口，EVENTS_DESIGN / ADR-014 引用）补齐；SEASON/EVENTS 里「待铺/待建」指针改为「已铺」。
  - **[`game/SERVER_API.md`](game/SERVER_API.md)** 补四组端点契约（兑现 ADR-006 / ADR-012 / ADR-013 / ADR-014 的「待补 SERVER_API」）：§2.7 `/pve/clear|verify|upgrade`、§2.8 `/equipment/craft|enhance|salvage|reforge|equip`、§2.9 `/events|claim|redeem`、§2.10 `/account/delete`；顺带 §2.11 赛季/排行榜/战令端点（SEASON §10 指向）+ §5 DB 集合扩 `pveDaily`/`pveVerifications`/`ladderSeasons`。
- **为什么**：用户拍板「先把文档补全再实现」。这些缺口此前散记在各 ADR 的「待补」字样里，集中收口避免实现时无契约可依。
- **影响**：上述文档 + README §1.2/§2 登记 COMPLIANCE_CN。**注**：契约最终落地仍以 `server/contracts/openapi.yml` codegen 为准（SERVER_API §1.2），本轮只补人类可读契约摘要。各「机制设计中、数值 [可调]/[DRAFT]」项不属文档缺口，留实现期配合代码定参。

## ADR-016 角色卡 = 6 张（陶3＝现有兵转具名·锚点 + Anna3＝新画变体） — Accepted — 2026-06-21

- **决策**（用户拍板）：每定位（剑士/盾卫/弓手）做**东西双版本，共 6 张卡**：
  - **陶 / 方家三人 = 现有三张通用兵直接转为具名，数值原样不动**：李川＝普通兵、陈守＝盾兵、苏远＝弓箭兵。三者是**全套战斗数值的锚点/地基**，**首版零机制**（纯保平衡，二期再议 signature）。
  - **Anna / Hartmann 三人 = 重新绘制 + 重新设计**，以陶对位兵为数值参照做差异化变体（同定位、不同打法）：**Max** 出1强单体·强击啃肉（vs 李川出2脆快铺场，刻意拉大对比度）；**Lena** 纪律固定减伤·站定加成（vs 陈守高裸血肉墙）；**Mara** 标记敌人团队增伤（vs 苏远高单发独狼）。每张须「一句话验收」与对位陶卡的差异。
  - **获取**：**PvP 六张全部直送**（竞技不拼卡池、防 P2W）；**PvE/SLG 通关对应章节各送一张**（Ch2→Max / Ch4→Lena / Ch6→Mara）；**抽卡/活动获更多**（重复获取转养成材料/碎片/皮肤）。
  - **同定位允许超过 2 张**（未来第三家族/神话层/联动），新卡须与已有两张都拉足差异。
  - **东西羁绊 = 未来大系统，本期只记录、不做、不留接口**。
- **为什么**：3 张会浪费一半美术且抹掉东西碰撞；6 张「同定位异打法」既全用美术又加构筑深度。陶侧锁为锚点 = 不动现有战斗平衡地基（数值参考系稳定）；Anna 侧承载新机制与收集。PvP 全送 / PvE 解锁分层 = 竞技公平与养成收集两不误（同 ADR-009 经济基调）。
- **影响**：新增 [`game/CHARACTER_DESIGN.md`](game/CHARACTER_DESIGN.md) 为角色卡**机制/流派**权威（数值锚点占位，落地进 `config.ts` + 同步 [BALANCE.md](game/BALANCE.md)）。落地需在 `server/engine/src/config.ts` 加 Anna 三单位 + 三卡定义、机制走单位特性字段（参考 PvE `aura_heal` 等范式）；PvE 解锁写 `server/shared/pveRewards.ts`；新美术绑骨走 animator。叙事遵 ADR-008（陶东/Anna西）。README §1.2/§2 登记。

## ADR-017 装备洗练 = 技能槽 0–2 + 2 条可锁定重洗；抽卡与皮肤共池 — Accepted — 2026-06-21

- **决策**（用户拍板）：
  - **技能槽数**：每件装备最多 **2 个技能词条**——**多数 0 条、部分 1 条、极少 2 条**（稀有度越高越可能有，2 条为顶级稀有）。槽数随实例生成定，洗练不改槽数。
  - **洗练模式**：0/1 个技能 → 全部随机重洗；**2 个技能 → 玩家二选一**：①花金币**锁定其中 1 条**、只重洗另一条（更贵、更可控）；②全部随机（更便宜）。锁定费是又一温和 coin sink。落地洗练接口加 `lockAffixIndex?`（仅 2 技能实例可传），服务器校验槽数 + 收锁定费。
  - **装备抽卡池**：**与皮肤共池**，且**主产出是材料**，装备成品仅低概率彩头（呼应 ADR-012「材料为主、成品骨干靠合成」，不让抽卡变装备直购后门）。
- **影响**：[`game/EQUIPMENT_DESIGN.md`](game/EQUIPMENT_DESIGN.md) §7.8 改写 + §6 抽卡行 + §15 开放问题两条关闭（洗练模式、抽卡池）；数字仍归 ECONOMY_NUMBERS §5。`/equipment/reforge` 契约（SERVER_API §2.8）落地时补 `lockAffixIndex?`。
- **附带（同日复核）**：[`game/PVE_INTEGRITY_PLAN.md`](game/PVE_INTEGRITY_PLAN.md) §5/§8.4 离线合并定为**弱网补偿三档**（先发后查、异常追回）；[`game/SLG_DESIGN.md`](game/SLG_DESIGN.md) R4 分服归属链定为**宗门 > 家族 > 单随**；[`game/AUCTION_DESIGN.md`](game/AUCTION_DESIGN.md) §8 确认无剩余机制级开放问题（全降实现期调参）。

## ADR-018 海外分级自定为 13+（不面向儿童） — Accepted — 2026-06-21

- **决策**（用户拍板，落实 ADR-013 / COMPLIANCE_GLOBAL §3.4 原建议）：海外自我定级为 **「13+ / 不面向儿童」**，规避 COPPA / GDPR-K 家长同意重负担。
- **为什么不定 6+**：曾考虑更低龄友好的 6+，但与现有设计两处硬冲突——①**真钱抽卡**面向儿童在欧盟是监管雷区（比利时禁付费开箱、USK 因内购+随机机制抬级）；②**开放陌生人聊天**对儿童是安全风险。要做 6+ 需大改（抽卡改软通货抽、聊天收预设短语）或单做儿童分版屏蔽抽卡，后者工程量大且效果存疑（孩子可用家长账号）。**改造代价 > 收益 → 定 13+**。
- **影响**：13+ 下**抽卡与社交聊天保持原设计、无需儿童分版逻辑**；付费控制仍靠平台家长控制 + 鲸鱼天花板 + 广告每日上限（锦上添花非硬门）。[`game/COMPLIANCE_GLOBAL.md`](game/COMPLIANCE_GLOBAL.md) §2 COPPA 行 + §3.4 更新；分级问卷按 13+ 如实勾选，**铁律：不得勾成全年龄/含儿童**。COMPLIANCE_CN 防沉迷仍按中国法另算（与海外分级解耦，ADR-013）。
</content>

## ADR-019 多区域部署 = Meta 共享 + 对战层按区隔离 + 中国独立 — Accepted — 2026-06-23

- **决策**（用户拍板）：全球部署切三个 Realm——**西方大区（欧洲+美洲单一 realm，账号/天梯/经济/SLG 共享）** 与 **中国区（完全独立整套栈，与西方不互通）**。西方大区内部再分层：**Meta 层（metaserver/MongoDB/worldsvc/commercial/social）单实例托管欧洲共享；匹配+对战层（gateway/matchsvc/gameserver）按地理区各一套**，两区都指向同一共享 metaserver。
- **匹配规则**：天梯/随机匹配**同区优先**（每区独立 matchsvc 池天然隔离，杜绝跨洋锁步）；ELO 存共享 Meta → **全大区统一天梯**（区域匹配 + 全局天梯）；**好友房允许跨区**（邀请制非天梯，延迟玩家自担，不影响公平）。
- **为什么这么切**：① `gameserver`/`matchsvc` 均不连库、`gameserver` 永不触库且 ticket 动态携带 `gameUrl` → 对战层可自由就近部署、加机器即插即用；② 现状 `matchsvc.pick()` 只看负载、**无区域感知**，故**绝不能把欧美 gameserver 注册到同一 matchsvc**（会跨洋乱发）→ 用「每区一套独立 matchsvc」让区域隔离来自部署结构，**匹配核心零改动**；③ MongoDB 单主欧洲、**禁跨大西洋副本集写**（跨洋写拖垮 meta），游戏帧不触库故不受影响；④ 中国跨 GFW 实时竞技不可行 + 监管/数据出境/支付渠道全不同 → 必须独立。
- **未采用**：单一 matchsvc 服务两区（需给注册加 region 标签 + QueueEntry 加 region + 改 pick/配对分桶）——动匹配核心代码、要自防跨区兜底，收益不及成本。
- **影响**：新增 [`game/DEPLOY_TOPOLOGY.md`](game/DEPLOY_TOPOLOGY.md) 为多区域部署权威；实现期需参数化 gateway/match-report→metaserver 地址、每台 gameserver 设区域 `NW_GAME_PUBLIC_WS_URL`、客户端加选区/测速逻辑（清单见该文 §4.1）。进程拓扑/端口仍归 [claudedocs/server.md](../claudedocs/server.md)。README §1.2/§2 登记。

## ADR-020 跨平台账号/钱包隔离边界 — Accepted — 2026-06-23

- **背景**：上线规划时确认「某些平台是否不允许共享用户、需把用户隔离」。审 [`accounts.ts`](../server/metaserver/src/accounts.ts) 后澄清：**身份层默认就隔离**——device(web/CrazyGames)/openid(微信)/oauth/password 各映射独立 `accountId`，跨端合并是用户主动 `bind*`，不存在"被迫隔离身份"的问题。真正逼迫隔离的是**数据合规**与**支付渠道**，与身份无关。
- **决策**（用户拍板）：
  - **身份/存档/天梯**：web + CrazyGames **共享同一套全球部署**（Cloudflare 前端 + 欧洲 VPS + Atlas）。两端用户可共存、可绑定合并。
  - **中国（微信）= 物理独立部署**：中国大陆玩家个人信息按 PIPL/网络安全法须**境内存储** → 微信线跑完全独立的境内栈（境内云 + 境内 Mongo），账号/存档/钱包均不与全球区互通。承接 ADR-019「中国独立」与 ADR-013「Global/CN 合规拆分」，此处补「数据驻留」为隔离的法律根因。**延后实现**，先做全球区。
  - **钱包/充值币按支付渠道隔离**：`SaveData.wallet.coins` 当前为全局单一钱包。上线微信/苹果/谷歌前必须改造——**站外渠道（如 Stripe）购买的虚拟货币不得在微信/苹果内消费**（违反各平台"不得消费站外购买虚拟货币"条款）。落地方式：充值币标记来源渠道，或钱包按平台隔离。**现在就要记入数据结构设计**，避免后期迁移。
  - **CrazyGames**：门户限制主要在前端行为（禁站外支付/外链跳转），账号层可与 web 共享，无需隔离。
- **未决/待查**：微信小游戏、CrazyGames、苹果/谷歌的开发者协议中"虚拟货币跨渠道流通"的具体条款原文（上线对应平台前逐条核实）。
- **影响**：[`product/deploy-cloudflare.md`](product/deploy-cloudflare.md) 新增「平台隔离边界」节为现行口径；钱包改造待在 [`game/ECONOMY_BALANCE.md`](game/ECONOMY_BALANCE.md) / [`game/ACCOUNT_DESIGN.md`](game/ACCOUNT_DESIGN.md) 补「充值币渠道标记」字段设计（缺口，上线渠道前收口）。

## ADR-021 独立 socialsvc = 第五公网面，推翻 SOC1 — Accepted — 2026-06-28

- **决策**（用户拍板）：*Supersedes SOC1*（"持久数据扩展 meta，不新建 social 进程"）。新建独立进程 `socialsvc`（第五公网面，`/social/*`），承接：
  - **家族（全局持久，去掉 worldId）**：从 worldsvc 迁出，跨赛季长存；TAG 全局唯一；worldsvc 存 `familyId` 只读镜像供地图渲染用。
  - **好友关系 / 私聊 / 邮件（P2 期）**：从 metaserver 迁出，集合搬入独立 `nw_social` 库。
  - **所有频道 Redis pub/sub 宿主**：家族/宗门/世界公频统一由 socialsvc 管理；worldsvc 通过 `POST /internal/push` 委托推送。
  - **push 路由中枢**：所有推送经 socialsvc → gateway `/gw/push`，gateway 不直接被多方调用。
  - **Redis 随 socialsvc P1 引入**（取代原计划"随 worldsvc SLG 一起引入"，提前到位）。
- **为什么**：家族被迫绑 worldId 导致每赛季重置（违背"公会是社交资产"直觉）；metaserver 持续臃肿；频道 Redis 无单一宿主；独立 socialsvc 关注点清晰且延时可接受（push 是最终一致、非关键路径）。
- **影响**：新增 [`game/SOCIAL_SVC_DESIGN.md`](game/SOCIAL_SVC_DESIGN.md) 为 socialsvc 架构权威；[`game/SOCIAL_DESIGN.md`](game/SOCIAL_DESIGN.md) 数据模型细节仍有效（P2 迁移参考）；[`game/SLG_DESIGN.md`](game/SLG_DESIGN.md) §8.1 家族章节加"家族已迁 socialsvc"指针；CLAUDE.md 进程数由 8 → 9；[`claudedocs/server.md`](../claudedocs/server.md) 加 socialsvc 条目。README §1.2 登记。

## ADR-022 SLG 主城建筑系统 = 仿三战书桌内政；资源 = 4 地块 + 1 铜币；建筑赛季清空 — Accepted — 2026-06-30

- **决策**（用户拍板）：新增 SLG 主城内政/建筑系统（仿三国志战略版「点进主城 → 君王殿等级门控 + 资源建筑/练兵/城防/科技」），落 [`game/SLG_CITY_DESIGN.md`](game/SLG_CITY_DESIGN.md)。三条关键拍板：
  - **资源结构对齐三战「4 地块 + 1 铜币」**（消解 graphite/sticker 空转，SLG §3.4 遗留）：`ink/paper/graphite/metal`（粮木石铁）= **地块资源**，地图 `biomeAt` 产——**`graphite`（石料）此前被 `biomeAt` 漏产（三分），须补成四分**（地图 faucet 根因修复）；`sticker`（铜币位/通用）= 主城 `stickerShop`（民居模型）**自产**，非地块。两者 sink = 主城高级建筑升级消耗。资源建筑只给**全局产率乘数**，不取代地图主产。
  - **D-CITY-1 建筑赛季清空**：建筑/资源/兵力/地图态等 SLG 赛季内战略态**全部赛季重置清空**（对齐 SLG4），是变现发动机「重肝」。**跨季只留 meta 系统资产**——主要是**材料**（材料合成装备；meta 直接发装备的地方很少，呼应 ADR-012/ADR-017「材料为主、成品骨干靠合成」）。
  - **红线/边界**：建筑只动经济/兵力上限/主城城防，**不提单位战力**（战力归跨季统一养成树的装备/科技）；建筑**永不喂 `buildPvpBlueprints`**（天梯红线，SLG7）；升级吃赛季资源+时间，**coin 只买加速不买上限**（反 P2W，ADR-009 经济基调）。
- **为什么**：graphite/sticker 两种赛季资源此前无 faucet/sink 空转；`troopCap` 是死值无成长；「点进主城内政」是 SLG 核心体验缺口。仿三战结构最省且玩家认知成熟。赛季清空保战略起跑公平 + 变现重肝，与跨季养成（meta 材料/装备）分层互不污染。
- **影响**：新增 [`game/SLG_CITY_DESIGN.md`](game/SLG_CITY_DESIGN.md) 为建筑系统机制权威；[`game/SLG_DESIGN.md`](game/SLG_DESIGN.md) §3.4 遗留指针改指本方案、[`game/SLG_DESIGN_LOG.md`](game/SLG_DESIGN_LOG.md) §21 R-1 更新、新增 §21 剩余工作总览；数字落 [`game/ECONOMY_VERIFICATION_LOG.md`](game/ECONOMY_VERIFICATION_LOG.md) §13-SLG-CITY，核验经 [`game/SLG_ECONOMY_CHECK.md`](game/SLG_ECONOMY_CHECK.md)。实现 P1 含 `biomeAt` 四分改造（client 经 alias 共用，须确认确定性地图不破老种子——或仅新赛季生效）。README §1.2 已登记。

## ADR-023 服务端契约从「运行时解析」改为「构建期代码生成」 — Accepted — 2026-06-30

- **背景（触发事件）**：2026-06-30 一次 i18n 英文化重构（commit `51445c5c`）把 `openapi.yml` 三处行内 flow 映射的 description 译成带逗号的英文且未加引号（`replayRef`/`defId`/`materialId`），YAML flow 上下文里逗号是映射分隔符 → 尾部括注（如 `deprecated)`）被解析成多余裸 key。文件仍是合法 YAML，但 metaserver 启动时 `fastify-openapi-glue` 的 OpenAPI 结构校验拒绝多余属性 → glue 注册抛错 → 进程崩溃反复重启 → CI `docker compose up --wait` 报 `server-metaserver-1` unhealthy 退出 1。已先行修复（commit `130a329b` 加引号）。根因不在那三行，而在**契约正确性只在启动期/运行期才被校验**。
- **现状盘点**（修复时确认，服务端侧零代码生成）：
  - `metaserver` = `openapi.yml` 经 `fastify-openapi-glue` **运行时**解析装配路由 + 校验（唯一用 glue 的进程）。
  - `gateway` / `gameserver` = `transport.proto` / `game.proto` 经 `protobufjs` **运行时** `loadSync`，字段名 snake_case 映射**手写**（靠 `transport.test.ts` 兜，写错静默丢字段）。
  - `worldsvc` = `openapi-world.yml` **根本未被代码加载**，路由全手写，yml 仅被一个 metaserver 测试引用 → spec 与实现完全无绑定，漂移风险最高。
  - `commercial` / `admin` / `matchsvc` / `socialsvc` / `analyticsvc` = 无机器契约，手写路由。
  - **客户端**早已双端 codegen：`client/scripts/gen-openapi.mjs`（`rest:gen`）→ 入库 `client/src/net/openapi.ts` + `openapi-world.ts`；`gen-proto.mjs`（`proto:gen`）→ proto TS。
- **决策**（用户拍板）：服务端也改走**构建期代码生成 + 生成产物入库**，推翻「运行时解析单一真源」的旧取向。`contracts/*` 仍是唯一真源，但服务端不再在运行时读取，而是由 codegen 在构建期把它编译成入库的 TS（路由表 + ajv 校验 schema + operationId→handler 的类型约束）。
- **为什么**（两点收益，恰是本次事故暴露的缺口）：
  1. **契约错误在构建期就炸**：坏 spec 进不了 CI 的 docker 阶段，`tsc` / codegen 直接失败（本次逗号 bug 会被前置拦截）。
  2. **契约变更物化为入库 diff，CD 可卡版本**：一次协议改动同时产出**服务端 stub diff + 客户端类型 diff**，CD 能强制「服务端契约变 → 客户端类型必须同改 → 两端同批次发版」。运行时 glue 下契约变更只体现为 yml 单文件改动，客户端是否同步全靠人自觉——**动态加载才是真正的漂移温床**。
  - 澄清：「强制客户端跟版本」主要靠客户端 codegen + CD 卡，本就与服务端用不用 glue 无关；服务端转 codegen 真正多买到的是上面两点，非「逼客户端更新」本身。
- **范围 / 分期**（实现拆 P1→P3，详见实现提示）：
  - **P1（REST，承重）**：`metaserver` 去 glue，新增 `server/contracts/scripts/gen-openapi-server.mjs` 生成入库的路由/schema 产物，`app.ts` 注册生成产物;handler 仍手写、由生成的 operationId 类型约束（缺/错名变 TS 编译错，强于 glue 运行时 501）。CI 加 `gen --check`（生成物与入库不一致即失败）。✅ 已完成（2026-06-30，commit `5bb86afe`）。
  - **P2（worldsvc 收口）**：新增 `server/contracts/scripts/gen-openapi-world.mjs` 生成入库的 `WorldOperationId` + `WORLD_ROUTES` + schema 产物（worldsvc 用 node:http，不用 fastify，故不生成 registerRoutes；仅生成路由表和类型约束）；CI 加 `gen:api:world:check`。`openapi-world.yml` 新增 `/world/active-season` 公开端点（§20.8 实时赛季号）。✅ 已完成（2026-06-30）。
  - **P3（proto，可选/后置）**：`gateway`/`gameserver` 的 protobufjs 运行时解析 + 手写字段映射存在同类问题;评估是否一并 codegen（ts-proto 等）。**默认后置**，先做 REST。✅ 已完成（2026-06-30）：gateway + gameserver 各新增 `buf.gen.yaml` + `scripts/gen-proto.mjs`，生成产物入库 `src/generated/transport.ts`；`proto.ts` / `proto/transport.ts` 去 protobufjs，改从入库产物 import；`protobufjs` 运行时依赖已移除；CI 加 proto staleness check（`npm run proto:gen` + `git diff --exit-code`）。
- **实时赛季号下行（§20.8）**：`createAppCore.ts` 的 `CURRENT_SEASON = 1` 硬编码已替换为动态调用 `worldApi.getActiveSeason()`（失败则 fallback 到 `FALLBACK_SEASON = 1`）；新增 worldsvc `GET /world/active-season` 公开端点 + worldsvc `getActiveSeasonNo()`。✅ 已完成（2026-06-30）。
- **影响**：[`game/SERVER_API.md`](game/SERVER_API.md) §1.2「契约单一来源 + 双端 codegen」一节须更新（现描述把 glue 等同于 codegen，实现后改为「服务端构建期生成入库」）；新增 `server/contracts/scripts/gen-openapi-server.mjs` + `gen-openapi-world.mjs`；gateway/gameserver 新增 `buf.gen.yaml` + `scripts/gen-proto.mjs`；CI 加三组 staleness check；[`claudedocs/server.md`](../claudedocs/server.md) 服务端构建链补一笔。

## ADR-024 SLG 世界地图配色 = 纸底地形 + motif 载类型；归属只用彩色描边/wash — Accepted — 2026-07-01

- **决策**（用户拍板）：世界地图渲染把两个正交信号彻底分层，止住「彩色方块拼贴」的粗糙观感。
  1. **地形/资源 = 安静的近纸底填充**。资源「类型」由手绘 motif（`drawResMotif`，L1）承载，**不再靠饱和背景色**。`RES_COLORS` 重度去饱和为纸邻近的暖/中性色，只在 L2/L3 概览时轻声提示 biome 分区，且刻意避开红/蓝/绿以免冒充归属色。
  2. **归属 = 唯一的强色**，以半透明 wash + 彩色描边/角标叠加（`ownerTint` + `drawTileL1/L2`），沿用「我红敌蓝、盟友绿」。L3 概览仍让归属色主导整格（态势可读性）。
- **为什么**：旧实现里颜色同时表达「地形类型」和「归属」，且 `RES_COLORS` 的绿/蓝直接撞 ally 绿 / enemy 蓝 —— 一块资源地看起来像别人的地盘；每格 0.85 实心填充 + 硬边框 = 全图花花绿绿，与手绘笔记本纸感相反。
- **不动的铁律**：ADR-003 我蓝敌红 / [`product/art-direction.md`](product/art-direction.md) §3.2 归属色未改；本条只改地形/资源底色与「归属改画描边而非整格填充」的呈现方式。
- **影响**：仅客户端 `client/src/scenes/WorldMapScene.ts`（`TERRAIN_COLORS`/`RES_COLORS`/新增 `ownerTint`+`terrainFill`/`drawTileL1`/`drawTileL2`）。无服务端/契约改动。

## ADR-026 SLG 建筑攻防 = 血量 + 逐队守军波次 + 攻城值延迟结算 — Accepted — 2026-07-02

- **决策**（用户拍板）：把主城围攻从「单场合并确定性战斗」重构为**通用建筑攻防系统**，适用于主城 / 关卡 / 城池 / 据点等**所有可攻建筑**。**Supersedes ADR-025 细则 3**「本条不新建多队波次系统」——现在明确要建多队波次。

- **核心规则（用户已定）**：
  1. **建筑血量**：每个可攻建筑有血量。主城 `maxHp = mainBaseLevel × SLG_BASE_HP_PER_LEVEL`；关卡/城池/据点由 `tile.level` 派生同式。血量存 `TileDoc.hp`（锚点格承载整座主城血量）。
  2. **逐队守军**：每城最多 5 队（复用 `PlayerWorldDoc.teams[] t1..t5`，攻守两用）。**在城 + 未受伤**的队伍自动为守军；**在外行军**（有活跃 march 占用该队）的跳过。判据：`MarchDoc.teamId`。
  3. **波次战**：攻方一队到城，守军按 `t1→t5` **逐队上阵**，攻方**存活兵力跨波延续**（上一波存活 HP 作下一波初始）。攻方中途**被全灭 = 攻城失败**（不扣血）。每波 `seed = waveSeed(marchId, waveIndex)`，逐波确定性、可回放。
  4. **攻城值延迟结算**：攻方**清光全部守军（或本就无守军）→ 胜后挂 5 分钟（`SLG_SIEGE_DAMAGE_DELAY_MS`）→ 按该攻方队伍「攻城值」扣建筑血量**。延迟由新集合 `SiegeDamageDoc`（`dueAt` 到点由 scheduler 结算）承载。**窗口内伤害必落**（守方即便补队/补血也不撤销这次伤害），保持确定性与简单性。
  5. **守军受伤**：每支**战败**守军 → **进入受伤状态 10 分钟**（`SLG_TEAM_INJURY_MS`），受伤期永不参战。存 `PlayerWorldDoc.teamState[tid].injuredUntil`（队伍粒度，区别于 CC-3 的卡粒度 `cardState[].injuredUntil`）。未交手的守军队不受伤。
  6. **攻占**：建筑**血量归零 → 被攻占**。玩家主城 → 复用 `passiveRelocate`（掠夺 + 失地 + 随机迁城 + 保护罩 + 宗主惩罚）。关卡/城池/据点 → 易主 / 发奖（沿用现有 territory 结算）。

- **占位数值（DRAFT，攻城值细节另于新会话专议，经济核验前均为占位）**：
  - `SLG_BASE_HP_PER_LEVEL = 100`（主城每级 100 血 ⇒ 30/次约 3~4 次攻破 lv1）。
  - 「攻城值」是**每张卡的新属性**（与攻击/移速同级，用户 2026-07-02 拍板）；队伍攻城值 = **队内各卡攻城值之和**。**队伍必有卡 → 攻城值恒 > 0**；唯一「不扣血」情形 = 攻方被全灭（本就判守方胜、不排结算）。
  - `SLG_SIEGE_DAMAGE_DELAY_MS = 5 min`、`SLG_TEAM_INJURY_MS = 10 min`。

- **实现更新（2026-07-02，任务 #8）**：攻城值已从「每卡统一 10」升级为**逐卡真实属性**。
  - `CardDef.siegeValueBase` 逐卡定 DRAFT 值（按定位差异化：盾兵/坦克破墙 14 > 步兵 11/Max 12 > 弓手/Mara 8），目录均值 ≈ `SLG_SIEGE_VALUE_PER_CARD` 以保 ADR-026 血量节奏不变；`cardSiegeValue(card) = round(base × (1 + 0.1×(lv-1)))` 逐级放大。`teamSiegeValue(army, cardInv)` 逐卡求和，缺卡（合成/旧测试）回退统一值。**数值仍为 DRAFT，待经济核验调优**（README §0 铁律：只调常数不改公式）。
  - 契约 + 客户端 UI 已实现（不再后置）：`WorldTileView.hp/maxHp`、`PlayerWorldView.teamState/cardState/baseTroopStock` 下行；`getMe` 补齐序列化；地图建筑血条（受损才显示）+ 攻击弹窗 `world.buildingHp` 数值 + 队伍菜单受伤倒计时。下行沿用 `getMe/getMap` 主动查询（无实时推送）。

- **5 分钟语义澄清**：即「攻方胜利 → 结算伤害」之间的延迟，**不是**再攻免疫窗；同一建筑可叠加多次各自的 5min 计时。

- **细化（2026-07-17，NPC 单场围攻基地血量随等级缩放，用户拍板方案 2）**：上面 ①/④ 描述的是**玩家主城/领地**的分波 + `TileDoc.hp` 延迟结算路径。但 **NPC 地块**（占地 `applyOccupy`/驱逐 `applyOccupationExpulsion`、领地 `buildDefenderConfig`、据点、关口）走的是**单场** `runSiegeBattle`（objective=`destroy_base`），其"基地"是引擎内的象征基地——此前恒为 `BASE_HP=100`，**不随地块等级变化**。后果：一级地驻军仅 `npcGarrison(1)=120`(=2 步兵)，基地却要 100 血,合成步兵每个到城仅造成 siege 值 11 ⇒ 需 ~10 个幸存者才推得平，`OCCUPY_MIN_TROOPS=500` 的最小占地兵力清完守军也打不掉基地 → 超时判守方胜（用户实测踩到）。修复：新增 `npcBaseHp(level) = SLG_NPC_BASE_HP_PER_LEVEL × level`（**缓坡 40/级**：L1=40、L10=400），由上述 NPC 单场路径**显式**经 `defenderConfig.defenderBaseHp` 传入（引擎新增 `LevelDefinition.defenderBaseHp` → `Player.maxBaseHp`；`base_hp_changed.maxHp` 改发各玩家 `maxBaseHp`）。分波路径**不传**该字段（`defenderBaseLevel:0` 的象征基地保持最小终结器，真实血量仍是 `TileDoc.hp = baseDurabilityMax(墙等级)`），与玩家城侧"基地血量随墙等级缩放"形成对称。econ-sim 复核（`tools/econ-sim/src/occupyBaseHpRun.ts`，真实引擎）：L1 最小取胜兵力 660→**300**(5 步兵，最小占地 500 现稳赢)，L2/L3 基本不变，L10 1560→**2940**(高级地成真墙)。数值仍 DRAFT。

- **PvE**：关卡里与 PvP 里的基地**都吃攻城值**（同一套血量+扣血）。PvE 据点守军仍为系统 NPC 阵（沿用 `applyStrongholdSiege` 的合成守军），不套 5 队玩家波次。

- **实现更新（2026-07-02，PvP/引擎接线）**：攻城值落地为**引擎蓝图级一级属性**，接入 PvP/战役实时基地扣血。
  - **动机**：此前引擎里单位到达敌方基地扣血用的是 `unit.attack`（战斗攻击力），导致「打兵」与「拆家」被焊死成一个数字——便宜兵/贵兵的攻城性价比无法独立调。攻城值把这根杠杆解出来。
  - `UnitBlueprint.siegeValue`（`server/engine/src/config.ts`）：**全 12 个兵种**都排了基础值,与 `attack`/`speed` 同级。六个英雄卡的值与 `@nw/shared` `CardDef.siegeValueBase` **保持一致**（步兵 11 / 盾兵 14 / 弓手 8 / Max 12 / Lena 14 / Mara 8）；六个复用入 PvP 的兵种（Ironclad 15 / Berserker 13 / Splitter 8 / Runner 6 / Harpy 7 / Medic 4）只存在于引擎蓝图（无 CARD_DEFS 卡）。按定位排：破墙坦克 > 拆楼手 > dps/玻璃炮/飞兵/支援;siege/ink 刻意不平（步兵 2.75 最划算 → 医疗 0.67 最差）。
  - **扣血口径**：`MovementSystem` 到达基地时 `damage = unit.siegeValue`（原 `unit.attack`）。所有引擎模式（pvp/campaign/siege）统一。SLG 的 `teamSiegeValue()` 延迟结算在引擎**外**独立进行,不双算。
  - **养成对称（PvE/SLG 吃全渠道）**：`applyUnitLevels` 新增 `siege: 0.1`（+10%/级,与 `cardSiegeValue` 同式）。**PvP 硬墙**：`buildPvpBlueprints()` 永不调养成,只读蓝图基础常量,和 attack 的处理完全同构。
  - **实现更新（2026-07-02，三渠道补齐）**：攻城值的**装备 + 学院**两条渠道已接,与 attack 完全同构,养成三渠道对齐(等级/装备/学院)。
    - **装备 gear**：`@nw/engine` `AFFIX_FIELD_MAP` 新增 `mult_siege` 系(主词条 `m_siege` / 副词条 `s_siege`)→ `applyEquipment` 里 `u.siegeValue *= (1+Σsiege%)`,含 `EFFECT_CAPS.siegePct=0.6`(镜像 atkPct)。`@nw/shared` `SUB_AFFIX_POOL` 加 `s_siege 3..6%`(rare/epic 可滚);`m_siege` 仅登记入词表,暂无主槽产出(前向兼容,不扰动 weapon 单候选确定性)。
    - **学院 academy**：`academyBuff()` 返回值从 `{hp,damage}` 扩为 `{hp,damage,siege}`,新增常量 `ACADEMY_SIEGE_STEP=0.015`(镜像 damage step);`buildSiegeBlueprints` 第 4 参 `siegeAcademy.siege` 在 `clampEffectCaps` 后叠乘 `u.siegeValue`(post-cap 层,仅 siege 路径)。类型链透传:`engine/types.ts` `GameConfig.siegeAcademy` → `worldsvc/siegeEngine.ts` `SiegeBattleInput` → `service.ts` `academyBuff`。
    - **PvP 仍硬墙**:`buildPvpBlueprints()` 无卡/装备/学院任何形参,编译期漏不进;单测 22 例(client `equipment.test.ts`)含 siege 词条正交 attack、siege 封顶、academy siege 应用 + 叠加。全部数值 DRAFT。
  - **`BASE_HP` 保持 100**（用户拍板,数值影响留实机体验再调）；全部 siege 值为 DRAFT。
  - **影响**：`@nw/engine`（`types.ts`/`config.ts`/`Unit.ts`/`MovementSystem.ts`/`balance/progression.ts`）**属公共依赖,最先合 main**。文档：[`game/PVP_LOADOUT_DESIGN.md`](game/PVP_LOADOUT_DESIGN.md) 攻城值章。

- **影响**：
  - `@nw/shared`（`slg.ts`：新增 `SLG_BASE_HP_PER_LEVEL`/`SLG_SIEGE_VALUE_PER_CARD`/`SLG_SIEGE_DAMAGE_DELAY_MS`/`SLG_TEAM_INJURY_MS` + `teamSiegeValue()`/`waveSeed()`/`buildingMaxHp()`）**属公共依赖，最先合 main**。
  - `worldsvc`：`db.ts` 新增 `TileDoc.hp`、`PlayerWorldDoc.teamState`、`MarchDoc.teamId`、`SiegeDamageDoc` 集合；`service.ts` 重写 `applySiege` 为波次战 + 建筑血量 + 延迟结算调度 + 队伍受伤 + 攻占；`joinWorld`/`relocateBase`/`passiveRelocate` 初始化主城血量；scheduler 加 `processDueSiegeDamage`。
  - 契约（`openapi-world.yml`）：`getMe`/tile view 下行建筑血量 + 队伍受伤态。**（任务 #8 已实现）**
  - `client`：血条 + 受伤态 UI。**（任务 #8 已实现：`WorldMapScene.drawHpBar` + `TeamsScene` 队伍受伤徽标）**
  - 文档：[`game/SLG_DESIGN.md`](game/SLG_DESIGN.md) §3.1 主城行 + §5 围攻章须更新为本模型。

## ADR-025 SLG 主城 = 真占 3×3=9 格实体（封路 + 一体防守 + 计 9 格） — Accepted — 2026-07-02

- **决策**（用户拍板）：玩家主城从「单格 `type:'base'`」改为**真实占据 3×3=9 个地格的实体建筑**。锚点仍是 `PlayerWorldDoc.mainBaseTile`（中心格），围绕它的 8 格同写 `type:'base'` 且同 `ownerId`，**九格一体、不可分割**（敌人不能单独占/弃其中一角）。
- **四条细则**：
  1. **落城/迁城占位校验**：join（自动落城 + 手动）/relocateBase 都要求 3×3 九格全空（无 obstacle/gate/center/stronghold/他人领地），且中心格离地图边 ≥1 格。`pickSpawnTile` 自动选址扫描「3×3 可落」的锚点。
  2. **封路**：主城九格对**非城主行军不可穿过**（等同障碍），敌军寻路必须绕行——玩家可用主城**封路**。城主自己的行军可进出自己的主城（`findMarchPath` 新增 `blockedBaseKeys` 参数，语义同 `passableGateKeys`：命中即阻挡，但 `isDest` 放行以便围攻敌方主城）。
  3. **一体防守**：主城为一体，**攻击九格中任意一格 = 围攻整座主城**，到达后一律以锚点的驻军/防守 config 结算同一场围攻；「在主城的队伍依次作为守军出战」沿用既有防守 config 机制（§3.3），本条不新建多队波次系统。
  4. **繁荣/领地计数**：九格**全部计入** `territoryCount` 与家族繁荣（`countDocuments{ownerId}` 无需特判）。
- **不迁移 → 强制自愈（2026-07-03 修订）**：SLG 未上线，无正式存量数据，但 **dev/test 世界里可能残留 ADR-025 之前建的单格主城**。原以为「下次 join/relocate 时自然重建」——**错**：旧 `joinWorld` 对已存在玩家是幂等早返回，根本不会重建，遗留单格主城会一直渲染不出城市 sprite（客户端严格要求完整 3×3 锚点）。**改为强制数据正确**：worldsvc 新增 `isBaseIntact()`（校验 `mainBaseTile` 锚点九格全在、全 `type:'base'`、同主）+ `purgePlayerWorld()`（删该玩家该世界全部 tiles + playerWorld）；`joinWorld` 对已存在玩家改为「基座完整→幂等；损坏/遗留→purge 全部旧数据 + 落全新 3×3」，即以全新用户重入。**`getMe` 保持只读、不做门控**（避免波及被围攻方读态等所有调用方、并规避与 `passiveRelocate` 的并发写竞争），自愈只放在唯一入口 `joinWorld`。客户端 `WorldMapScene.loadData` 进图时**总是**调 `joinWorld`（健康号幂等空转，损坏号触发重建）。
- **影响**：`@nw/shared`（`slg.ts`：新增 3×3 footprint 工具函数 + `findMarchPath` 增 `blockedBaseKeys`）**属公共依赖，最先合 main**；`worldsvc`（`service.ts` joinWorld/relocateBase/passiveRelocate 写 9 格、placement 校验 9 格、`computeMarchPath` 构建 `blockedBaseKeys`、`applySiege` 任一 base 格→锚点、abandon/occupy 拒绝 base 格、`pickSpawnTile` 3×3 扫描；**+ `isBaseIntact`/`purgePlayerWorld` 完整性自愈**，e2e `base-integrity.e2e.test.ts` 4 例）；`client`（`WorldMapScene` 城市 sprite 对齐真实九格严格锚点 + 修贴图留白 + 点击任一格开主城菜单 + 进图总是 joinWorld 触发自愈）。[`game/SLG_DESIGN.md`](game/SLG_DESIGN.md) §3.1 主城行 + §3 footprint 说明须更新。

## ADR-026b 拍卖物品交割/退回 = escrow-out + 系统邮件（废弃"溢出暂存区"） — Accepted — 2026-07-02

> 📌 编号订正（2026-07-03）：本条原误编为第二个「ADR-026」，与上方「SLG 建筑攻防」撞号。因 SLG 建筑攻防那条被代码/文档大量按 `ADR-026` 引用（siege 相关），保留其为 026，本条改为 **026b**。无 inbound `ADR-026` 引用指向本条，改号不破坏交叉引用。

- **决策**（用户拍板）：拍卖走 **escrow-out** 模型——玩家挂单即把物品**从背包移出寄存**（拍卖期间背包不可见、不可用）；**所有离开拍卖系统的物品一律通过系统邮件附件下发，玩家领取附件后才回背包**。范围含**成交发给买家 + 流拍/取消/季末清算退回卖家**，物料/装备/角色卡三类皆然。**推翻** EQUIPMENT_DESIGN §13 早先的「满仓溢出暂存区领取 UI」提案——邮件本身即持有缓冲，天然规避满仓资损、不突破 300 硬上限（ADR-012），语义也更清晰（寄存物取回）。
- **为什么**：旧路径成交/退回直接 `grantEquipment/grantCard/grantMaterial` 写回背包，撞满仓时要么资损要么需另建暂存区；且"退回即刻入库"与"寄存出去"的心智不符。改经邮件后，出账与领取解耦，一套机制覆盖买卖两侧。
- **不动**：金币侧（卖方收款、竞拍退款）仍直接走 commercial（钱包权威，无背包/实例问题）；`createAuction` 内 escrow 后的**同步失败回滚**仍直接 grant（挂单未成立的即时回退，非出账语义）。
- **影响**：`@nw/shared`（`MailAttachmentDoc`/`social.ts MailAttachmentView` 增 `kind:'equipment'|'card'` + `instance`）**属公共依赖，最先合 main**；`server/contracts/openapi.yml`（`MailAttachmentView` 同步）；`metaserver`（`mail.ts splitAttachments` + `service.ts claimMail` 写回实例，`cards.ts` 抽 `grantCard`）；`worldsvc`（`auctionService.ts deliverItem` 改发系统邮件、注入 `mail`；`mailClient.ts` 附件类型扩展）；`client`（`FriendsScene` 邮件渲染装备/卡附件 + i18n 三语）。文档同步：EQUIPMENT_DESIGN §13、AUCTION_DESIGN §1/§2/§A。

## ADR-027 品牌 Logo = 盾徽 + 文具三笔（蓝主导 / 无字）；大小双版本 — Accepted — 2026-07-02

- **决策**（用户拍板）：确立游戏 logo/图标为**奶油横格纸盾牌 + 钢笔（蓝）/铅笔（琥珀）/马克笔（红）交叉 X 徽记**。**蓝主导**——中央钢笔最大最显眼，宣示「我方蓝」（ADR-003 / art-direction §3.2 阵营色），红仅点缀。mark 内**不嵌文字**；字标 "Nivara"（对外名）用真实字体单独排，待字体打包后落地。
- **大 / 小双版本**（按尺寸分工，避免小尺寸糊）：
  - **master**（`art/logo/logo.png` 2048² 透明）：全细节手绘（纸纹/笔尖/排线/胶带），用于 **≥128px**。
  - **simple**（`art/logo/logo-simple.png` 1024² 透明）：扁平实色粗描边、无纹理无胶带，用于 **≤64px**（favicon/小图标）。实测 master 到 32px 三笔糊成团，simple 仍可读。
- **生成流程**（AI 图管线，同 art-direction §〇 分工）：AI 出图（盾徽三笔交叉、蓝主导、明显纸纹、**无字、无胶带**——交叉不带遮挡 AI 才画得对笔身连续性；master 胶带用户 GIMP 后期补）→ GIMP 抠透明底 → `System.Drawing` HighQualityBicubic 保 alpha 批量降采样入 `art/logo/derived/`。
  - 出图 prompt（记录备后续补图）：`rounded shield crest with soft U-shaped bottom, hand-drawn notebook doodle style, bold navy ink outlines, cream ruled notebook paper (blue lines + red margin, prominent paper texture); three pens cross in a clear X: dominant blue fountain pen center + amber pencil + small red marker; each pen ONE continuous piece, blue dominant red accent; no text, no tape.` 简版加 `flat solid colors, no texture, no ruled lines, readable at 32px`。
- **落地**（web/CrazyGames）：`client/public/` 出货 `favicon-16/32/48.png`（simple 派生）+ `apple-touch-icon.png`(180)/`icon-192/512.png`（master）+ `site.webmanifest`（name/short_name=Nivara，theme `#1b3a6b`/bg `#F5F0E8`）；`webpack.config.js` CopyPlugin（`!isWechat`）拷到 dist 根；`public/{web,crazygames}/index.html` `<head>` 加 `<link icon/apple-touch/manifest>` + `theme-color`。生产 web 构建已验证图标入 dist + head 注入正确。
- **对外名落地**（2026-07-02 补）：主名 **Nivara** + 副标题 **Notebook Wars**。① HTML `<title>` = `Nivara — Notebook Wars`，四份入口 `client/public/{index,web/index,crazygames/index,wechat/index}.html` 同步。② 局内已抽单一 i18n key `game.title`（zh/en/de 同值 = proper noun），`auth.title` 改插值 `{game}`，`LoginScene` 传参；改名只改 `game.title` 一处（记忆 game-name）。
- **运维手动步骤（无代码接入点）**：**微信小游戏图标**须在**微信公众平台后台**手动上传，用 `art/logo/derived/logo-512.png`。列入上线前 checklist。
- **待办 / 不在本次**：字标字体待打包（同 art-direction §7.4）。
- **影响**：新增 `art/logo/**`；`client/public/{favicon-*,apple-touch-icon,icon-*}.png` + `site.webmanifest`；改 `client/webpack.config.js`（CopyPlugin）+ `client/public/{web,crazygames}/index.html`。[`product/art-direction.md`](product/art-direction.md) §13 记录全貌。
- **大厅内落地**（2026-07-05 补）：大厅头部之前独立硬编码 `lobby.title`="NOTEBOOK WARS"（三语言未翻译），未跟上①的改名，且徽记只用于 favicon/manifest、局内头部纯文字无图标。改为：头部改用 `game.title`（= Nivara）+ `logo-simple-128.png` 图标并排居中，副标题维持现有 tagline（`lobby.subtitle`，玩法说明，不改成 "Notebook Wars"）。删除 `lobby.title` key。header 高度 `0.14h → 0.16h` 让出图标空间。logo 走 L0 启动清单（`bootManifest.ts`，与开局三兵同批预加载，避免首屏闪烁）。影响：`client/src/scenes/LobbyScene/build.ts`、`client/src/assets/{logo.png,bootManifest.ts}`、`client/src/i18n/locales/{zh,en,de}.ts`。

---

## ADR-028 盲盒进阶变现 = 软保底 + 限定池 50/50 歪+命运点 + 月卡/新手包 — Accepted — 2026-07-02

- **背景**：盲盒基础抽卡+硬保底(S2-3)已上线，但 GACHA_DESIGN §2/§5/§6/§7 的变现深度（限定池/月卡/新手包/命运点）服务端全缺。本 ADR 记录落地时的两处口径拍板；机制/落地全貌见 [`GACHA_DESIGN.md §11.1`](game/GACHA_DESIGN.md)。
- **决策 1 — 软保底取代硬崖**：`rollGacha` 从「90 抽硬崖」改为「70 抽起每抽 +5% legendary 概率、90 兜底」（`SOFT_PITY_START=70/STEP=0.05`）。起点以下走原扁平权重表（旧行为逐字不变，回归单测锁定），概率提升实现用 1000-slot 重整（`P(leg)=legW/1000`，起点以上其余稀有度按基础比例分摊 `1-P(leg)`）。
- **决策 2 — 限定池 = 50/50 off-banner + 命运点，调和 §2.2**：GACHA_DESIGN §2.2 原述「池内 legendary 只有 1 个 → 大保底必出本体」（则无从「歪」）；但 §7 命运点机制**要求**能歪。因用户明确要命运点，采用经典 **50/50**：限定 legendary 层 = 主打 banner（约 50%，靠 slot 重复加权）+ 常驻**非角色卡** legendary 垫底（`DEFAULT_LIMITED_FILLER_LEGENDARIES`，避免限定池稀释养成）；抽到非 banner legendary = 歪 → +1 命运点；30 点兑换任一历史 featured。**未做** §2.2「下次必得」的 per-pool 保底翻转（需额外 `guaranteedFeatured` 状态），留后续。
- **权威归属**：限定池 config 存 commercial `gachaPools`（admin 建/关，永久保留供兑换）；池内容由 `@nw/shared buildLimitedPool()` 从常驻池**纯派生**（无漂移）。`wallet.fatePoints/subscription/starterUsed` 均 commercial 权威 → 镜像 `SaveData.monetization`（客户端只读，不入 SyncPatch）。
- **范围外**：真实 IAP 验单（月卡/新手包当作已授权购买，接 SDK 时 meta 前置验签）；G7–G10 美术展示层（程序占位可跑）。
- **影响**：`@nw/shared`（economy/api/types）；`commercial`（db/gacha/service/internalHttp）；`metaserver`（commercialClient/economy/service/internal + routes.gen）；`openapi.yml`（4 端点 + GachaPool 限定字段 + SaveData.monetization）；客户端 GachaScene/ShopScene/ApiClient/SaveData/i18n。

## ADR-029 SLG 世界地图渲染从正交方格改为等距菱形投影 — Accepted — 2026-07-02

- **背景**：用户反馈世界地图画质偏低（对照三国志战略版等同类 SLG）。排查确认两层问题：① 地形/据点大量用 `PIXI.Graphics` 纯色矩形拼接、缺手绘贴图（单独跟进，见下方 Out of scope）；② 更根本的是地图渲染用**正交俯视方格**，同类 SLG 普遍用**等距菱形**网格，视觉「俯视 3D 感」差距的大头来自网格投影方式本身。用户明确表态：项目尚在早期，只要最终效果最好，不用考虑重构成本。
- **决策**（用户拍板）：`client/src/scenes/WorldMapScene.ts` 的地图渲染改为经典 2:1 等距菱形投影（`screenX=(tx-ty)*tileW/2, screenY=(tx+ty)*tileH/2`，`tileH=tileW*0.5`）。**纯客户端渲染层改动**——服务端契约（`openapi-world.yml` 的 `WorldTileView.{x,y}`）、寻路（`server/shared/src/slg.ts`）、tile 缓存 key 等逻辑数据模型全部保持正交整数 `(x,y)` 不变；ADR-024/025/026 的地形色块/归属水洗描边/3×3 据点占地/HP 血条等玩法与配色拍板同样不受影响，只是改了画法。
- **实现**：新增 `client/src/render/isoGrid.ts`（`tileToScreen`/`screenToTile`/`screenToTileF`/`diamondPath`/`diamondVertices`/`visibleTileBounds`），`WorldMapScene.ts` 内所有 `tx*tp`/`ty*tp` 式定位、`drawRect(0,0,tp-1,tp-1)` 式绘制、`screenToTile` 命中测试，以及 `centerAt`/`clampPan`/`viewportCenter`/`makeZoomCfgs`（池大小需按等距可视区域的外接矩形算，比正交估算更大）全部换成基于 `isoGrid` 的等距公式；瓦片池每格的本地绘图原点从"正方形左上角"改为"菱形中心"，`drawCityIcon`/`drawResMotif`/`drawResMotifFallback`/`drawTileL1`/`drawTileL2`/`drawHpBar` 内的图标、边框、defense frame、tick mark、danger corner 相应重新锚定到菱形几何（角标→菱形顶点/边中点、方形描边→`diamondPath` 内缩、HP 血条→贴菱形下顶点）；`refreshCityLayer` 新增按 `(tx+ty)` 的 `zIndex` 深度排序（`cityLayer.sortableChildren=true`），避免等距下据点建筑贴图互相穿插覆盖错误。
- **已知遗留（不阻塞，v1 可接受）**：`city_atlas.png` 素材是画在方形画布上的建筑图，v1 仍按 `BASE_SPRITE_TILES` 原尺寸贴到菱形 footprint，四角可能有留白/比例不完全贴合菱形俯视角，是否需要重新出图待视觉验收后再定。
- **为什么**：等距菱形是移动 SLG 的行业惯例观感，且经确认是纯投影变换、不涉及契约/寻路/数据模型改动，改动面收敛在单一文件，值得直接做到位而非留妥协方案。
- **影响**：新增 [`client/src/render/isoGrid.ts`](../client/src/render/isoGrid.ts)；[`client/src/scenes/WorldMapScene.ts`](../client/src/scenes/WorldMapScene.ts) 渲染层大改（详见文件内注释）；[`game/SLG_DESIGN.md`](game/SLG_DESIGN.md) §3.2 补一句视觉呈现说明，避免与"正交网格"表述产生歧义；无服务端/契约改动。
- **Out of scope（本次不做，已记录跟进）**：地形/据点手绘贴图接入（`terrainAtlasLoader.ts` 及配套图集，出图 prompt 清单见 [`product/slg-terrain-art.md`](product/slg-terrain-art.md)，待产出素材）；据点建筑贴图针对菱形 footprint 的重新出图。

## ADR-030 深化金币 sink（洗练金币化 / SLG 便利 / 外观广度）+ PvE 多人副本 + SLG 新手区毕业软过渡 — Accepted — 2026-07-03

- **背景**：本会话核查确认经济收支两端已**全实装**（盲盒/装备/成就/留存/战令，均有代码+测试；README 状态标签本轮已从「设计中」修正为「已实现」）。但金币深水 sink 集中在**盲盒 + 装备强化**两处，暴露两个偏浅：①长尾鲸鱼「买空盲盒后金币无处去」；②变现重心压在 **SLG 参与率**（纯 PvP/收集玩家付费弱）。用户全数采纳补深方案。
- **先厘清既有、只记增量**（不重复既有拍板）：SLG 建筑/练兵「coin 只买加速不买上限」= ADR-022；洗练 2 技能「金币锁 1 条」= ADR-017；SLG 外环新手区 + 宗门>家族>单随路由 + 跨区隔离 = **G6 已实现（2026-06-21，[`SLG_DESIGN_LOG.md`](game/SLG_DESIGN_LOG.md) §20 / R4）**。
- **决策（5 项增量，用户 2026-07-03 拍板全采纳）**：
  1. **洗练基础金币化**：洗练**每次**收基础金币（不止 2 技能锁定费）——把「重洗词条」整体做成可无限重复的深水 coin sink（付的是**尝试次数**、买不到确定结果，不破公平红线）。落 [`EQUIPMENT_DESIGN.md`](game/EQUIPMENT_DESIGN.md) §7.8，数字 ECONOMY_NUMBERS §5.3。⚠️ 代码缺口：`metaserver/src/equipment.ts reforgeEquipment()` 现仅扣材料未扣基础金币（2026-07-03 核查），落地补。
  2. **SLG 便利 sink 扩展**（在 ADR-022 加速之外新增）：迁城令 / 开新地块 / 宗门科技捐献等「买方便不买战力」的 coin sink。红线同 ADR-022（coin 不买上限、永不喂天梯）。落 SLG_CITY_DESIGN / SLG_DESIGN。
  3. **外观广度 sink**：角色皮肤之外扩程序绘制外观——主城/城池皮肤、宗门旗帜徽章、头像框、称号装饰、战斗特效皮肤、录像分享装饰。走文具 bone-slot 程序叠加**近零美术成本**；是「买空图鉴后仍可花钱」的长尾鲸鱼去处，纯外观不触公平。落 ECONOMY_BALANCE §3.4 + art-direction。
  4. **PvE 后期多人副本（co-op）**：战役后期加多人合作副本，给**不玩 SLG 的鲸鱼**一个装备/角色卡战力的消耗与展示出口（摊薄「变现全压 SLG」的偏科）。PvE 性质 → 装备战力生效、**天梯硬墙不受影响**；产出复用 PvE 材料/装备 faucet（受体力闸门 + 反通胀预算，**不新增金币龙头**，ADR-011/014）。落 [`CAMPAIGN_DESIGN.md`](game/CAMPAIGN_DESIGN.md)。
  5. **SLG 新手区毕业软过渡**：新手在外环新手区（G6 已实现）养成，赛季末/达阈值迁入正式区时，**整个新手区打包迁入同一新开正式区**（一起毕业、起跑线齐），而非散插成熟老区——补掉「保护期一过即被老玩家碾压」的断崖。是 R4 分服规则的增量。落 SLG_DESIGN §R4/§20。
- **为什么**：盲盒管「抽到」，洗练/便利/外观管「抽空之后」——补长尾鲸鱼深水区；多人副本给非 SLG 付费人群一个装备出口，摊薄营收单点；毕业软过渡补新手 onramp 最后一跳。全部**不新增金币龙头、不卖直接战力**（洗练卖尝试、SLG 卖便利、外观卖体面、副本卖内容），守 ADR-009/011/014 经济基调与公平红线（ADR-009 硬墙）。
- **影响**：[`EQUIPMENT_DESIGN.md`](game/EQUIPMENT_DESIGN.md) §7.8、[`ECONOMY_BALANCE.md`](game/ECONOMY_BALANCE.md) §3.4、[`SLG_DESIGN.md`](game/SLG_DESIGN.md) §R4、[`SLG_CITY_DESIGN.md`](game/SLG_CITY_DESIGN.md)、[`CAMPAIGN_DESIGN.md`](game/CAMPAIGN_DESIGN.md) 均加本 ADR 指针；数字落 ECONOMY_NUMBERS（§5.3 洗练 / §13-SLG 便利 / 外观定价 / 副本产出）待铺。均为**方向拍板 + DRAFT**，实现期配合代码定参。

## ADR-031 订阅卡全局单卡门控 + 年卡（九折）+ 商店图标卡网格 — Accepted — 2026-07-03

- **背景**：月卡原实现可无限叠购（每次 `max(now,expiry)+30d` 续期），玩家可一次性堆很多个月；且商店商品用横向 list row 展示。用户拍板两点：①月卡改为「买了必须用完才能再买」，并新增年卡；②商店改图标卡网格（与卡背包/装备背包 790d3cff、战令 a383728b 一致的视觉语言）。
- **决策（用户 2026-07-03 拍板）**：
  1. **全局单卡门控**：只要有任意订阅卡生效（`subscription.expiry > now`），月卡与年卡的购买都锁定，服务端返回 `ALREADY_ACTIVE`；到期后才可再买（不叠购、不续期）。新手成长包的 7 天卡不受此门控约束（一次性新手包）。
  2. **年卡**：365 天，奖励结构与月卡一致（每日 120 + 即赠 600），仅时长 ×12。定价 **¥298**（= 12 张月卡 ¥360 的九折取整），UI 原价 ¥360 划线 + 「省 ¥62」角标。真实 IAP 扣款仍为「视为已授权」占位，年卡价格仅前端展示。
  3. **商店图标卡网格**：`ShopScene` 从 list row 改为响应式图标卡网格（名字上·图标左·价格/状态右·底部动作按钮），拖动滚动 + 遮罩裁剪固定表头/tab；充值 tab 同改网格；兑换码保留为网格下方整行。

## ADR-032 SLG 大地图尺寸 500×500 + 地块等级 1-10 + 取消无产出中立地 — Accepted — 2026-07-04

- **背景**：用户怀疑 SLG 文档与实现脱节，逐项核查后确认属实，且比预想的更严重：
  1. `SLG_DESIGN.md` 曾在 2026-06-18 拍板"U2 地图尺寸 ✅ 1500×1500替代300×300"和"U4 大区容量 ✅ 1万玩家替代300-500"，但代码里 `SLG_MAP_W/H`（`server/shared/src/slg.ts:108-109`）从未改过，一直是 300；`SLG_WORLD_CAPACITY_MIN/TARGET/MAX` 也一直是 300/400/500。这次"✅"标记的升级从未真正实现。
  2. 更严重的是，2026-06-30 的经济核验（`ECONOMY_VERIFICATION_LOG.md` §13-SLG-NATION、§13-SLG-STRONGHOLD）是在这次"从未实现的升级"之后做的，却仍然是在未升级的 300×300 上跑蒙特卡洛，并被打上「已过核验」标签——即错误的地图尺寸假设已经污染了一份"已核验"的经济结论。
  3. 地块等级上限代码实际是 `SLG_MAP_MAX_LEVEL=5`（`slg.ts:110`），用户回忆中的"9 级"实际是装备强化/武将卡的 `MAX_LEVEL=9`（`equipment.ts:64`/`unitCards.ts:12`）——两套毫不相关的系统被记混。经网络调研核实，用户参照的三国志战略版真实地块等级上限是 **10 级**，不是 9 级也不是 5 级（详见 [`SGZ_LAND_REFERENCE.md`](game/SGZ_LAND_REFERENCE.md)）。
  4. 现有等级生成公式 `level = round((1-dr)×(MAX-1)+1+noise)` 配合 `resourceDensity=0.34`（34% 概率地块保留计算出的等级，66% 被降级为"中立地"、等级强制封顶 2 级且不产任何资源）——这与用户在本轮讨论最初提出的设计前提"地图上没有真正空地，低级地也是某种资源，只是没人要"直接矛盾。
- **决策（用户 2026-07-04 拍板，逐步收敛到最终数字）**：
  1. **地图尺寸 = 500×500（25 万格）**。推导：用户要求"5 级以上地块占总地块约一半，500 玩家人均最多占 200 块 5 级+地"→ 500×200=10 万块 5 级+地块 ÷ 50% 占比 = 20 万总格子 → 边长 √200,000≈447，实测 447×447/450×450 更精确贴合目标（人均 202-208），但用户最终选择好记的整数 **500×500**（实测人均 5 级+地块约 254，略超目标但用户认可，理由：容量有余量，早期够用，未来扩容不用换图）。
  2. **地块等级上限 = 10**（不是 5，不是 9），对齐调研到的三战真实上限。
  3. **取消无产出中立地**：`resourceDensity` 从 0.34 改为 **1.0**——除阻挡地形/关隘/据点/首府外，所有格子都是某等级的资源地，不再有"中立地=不产任何东西"的类别。
  4. **等级分布曲线指数从 1 调到 1.1**：`level = round((1-dr)^1.1 × (MAX-1) + 1 + noise)`。配合 3.，实测（Monte Carlo，`hash2`/`rand2`/`valueNoise` 原样复刻自 `slg.ts`）在 300×300 上得到约 49.8-51.3% 的格子达到 5 级以上，验证曲线形状本身正确，再按 §1 反推地图尺寸。
  5. **正式废止 2026-06-18 的"1500×1500/1万玩家"版本**：不是"改成更小的数字"，是承认那次升级从未真正发生过，`WORLD_CAPACITY` 维持代码现状 300-500。
  6. **国家版图布局（6 外围国+2 资源国+1 霸业的三战式环带结构）本次不拍板**：现有 10 首府对称布局、等级公式与"国家身份"完全脱钩的结构性问题已确认（详见 `SLG_DESIGN.md` §3.2 待定项），但改国家数量/布局是更大的结构改动，留待下一轮设计。
- **为什么**：用户对三战玩法节奏非常熟悉，希望 Notebook Wars 的 SLG 数值手感向其看齐；核查发现两轮此前的"文档拍板"都从未真正实现，且已经污染了下游的经济核验结论，必须先把地图尺寸/等级上限这个地基钉死，才能继续设计地块建筑、国家版图等上层玩法。
- **影响**：
  - [`SLG_DESIGN.md`](game/SLG_DESIGN.md) §3.2、§14.2（P3）、§14.10（U2/U4/U11/U12/U14）已按本决议改写。
  - [`ECONOMY_NUMBERS.md`](game/ECONOMY_NUMBERS.md) 的 `WORLD_CAPACITY` 行、[`ECONOMY_VERIFICATION_LOG.md`](game/ECONOMY_VERIFICATION_LOG.md) 的 §13-SLG-NATION、§13-SLG-STRONGHOLD 已标记「待重跑」，尚未重新跑 econ-sim（下一步工作）。
  - 新增 [`SGZ_LAND_REFERENCE.md`](game/SGZ_LAND_REFERENCE.md)：三战地块/建筑/版图机制调研笔记，供后续设计参考，非本项目设计基准。
  - **代码尚未改动**：`server/shared/src/slg.ts` 的 `SLG_MAP_W/H`、`SLG_MAP_MAX_LEVEL`、`SLG_GEN.resourceDensity`、等级曲线指数均待实现（本次只是拍板+文档，依本会话"先文档后代码"的既定流程，实现是下一步任务，会牵动十余个 e2e 测试的坐标假设）。
  - 地块建筑系统（三战式"6-10级解锁造币厂/工坊/虎帐/仓库/乐府"）与国家版图重构均为后续独立任务，不在本 ADR 范围内。
- **实现**：`@nw/shared`（economy 加 YEAR_CARD_DAYS/IMMEDIATE_COINS/价格常量 + PRODUCT_YEAR_CARD；api 加 `ALREADY_ACTIVE`）；`commercial`（`monthlyCardBuy`/`yearCardBuy` 收敛到私有 `subscriptionCardBuy`：先占 orderId 槽→门控回滚→applySubscription，门控置于占槽之后以不误伤同 orderId 幂等重放；internalHttp 加 `/internal/year-card/buy`）；`metaserver`（commercialClient 加 `yearCardBuy`；service 加 `yearCardBuy` handler + `subscriptionErrCode` 把 `ALREADY_ACTIVE` 透传给客户端）；`openapi.yml` 加 `/year-card/buy`（重生 routes.gen + 客户端 openapi.ts）；客户端 ApiClient/createAppCore(`buyYearCard` + `ALREADY_ACTIVE`→`shop.cardActive`)/ShopScene 大改 + i18n 三语（`shop.yearCard`/`shop.cardActive`/`shop.save`）。
- **为什么**：门控把月卡从「可囤积」改为「用完再买」，强化每日留存锚（月卡定位本就是留存而非性价比）；年卡九折给长线玩家一个更划算的锚，同时单卡门控避免年卡+月卡叠加把订阅收益一次性透支；图标卡网格提升付费诱惑并与全局 UI 统一。
- **影响**：[`GACHA_DESIGN.md`](game/GACHA_DESIGN.md) §5/§5.1b + 实现小结；`@nw/shared` economy/api；`commercial` service/internalHttp（+e2e：门控 + 年卡用例，91 全绿）；`metaserver` commercialClient/service（+ routes.gen，293 全绿）；`openapi.yml`；客户端 ShopScene/ApiClient/createAppCore/i18n。真实 IAP 验单仍范围外。

## ADR-033 SLG 国家版图三战式环带布局 + 等级/险地与「国家身份」绑定 — Superseded by ADR-034 — 2026-07-05

> **⚠️ 已作废（2026-07-05，同日撤销）**：本 ADR 与另一条并行会话讨论出的 [ADR-034](#adr-034-slg-国家版图改为环形分层结构6-出生州3-资源州1-核心州--地形隔离城池体系拍板--accepted--2026-07-05) 撞了同一个编号且方向不同——本条是"10 首府改三层同心环几何位置 + 等级按最近首府距离衰减"（点+距离模型），ADR-034 是"6 出生州+3 资源州+1 核心州角度扇区 + 折痕岭/墨河/城池完整体系"（扇区+地形模型）。用户拍板**以 ADR-034 为准，本条（含已落地的代码 `CAPITAL_FRACTIONS`/`NATION_KIND_BY_IDX`/`GEN_MAX_CAP_DIST`/`proceduralTile`/`SLG_GEN.obstacleMinDistRatio`/10 个 e2e 测试文件）全部作废，需按 ADR-034 重写**。以下原文保留作历史记录，不代表当前状态。
- **背景**：ADR-032 落地地图尺寸/等级上限/资源密度/等级曲线后，遗留一条「⚠️ 待定」：现有 10 首府对称布局（8 外围+1 内环+1 中心）与地块等级公式（`level = round((1-dr)^1.1×(MAX-1)+1+noise)`，`dr`=离地图**几何中心**的距离比例）完全脱钩于「国家身份」——不管站在哪个首府的地盘里，地块等级只看离地图正中心多远，10 个首府本身除了 idx9（地图中心，`CENTER_CAPITAL_IDX`）外，对地块生成毫无影响，与用户设想的「三战式一国一版图，各有肥沃/贫瘠」不符。用户拍板：保留 10 国（不是三战式常见的 9 国），布局改为 **6 外围国 + 3 资源国 + 1 霸业国**，且等级要按「离自己国家首府的距离」算，不能只看离地图中心的距离。
- **决策**：
  1. **10 首府布局改为三层同心环**（`CAPITAL_FRACTIONS`，`server/shared/src/slg.ts`）：外环 6 外围国（正六边形，半径 0.40，idx 0-5）+ 中环 3 资源国（正三角形，半径 0.20，与外环错开 30° 交错，idx 6-8）+ 中心 1 霸业国（地图正中心，idx 9，即原 `CENTER_CAPITAL_IDX`，行为不变）。新增 `NATION_KIND_BY_IDX` 常量标注每个 idx 的国家类型（供后续 UI/econ-sim 使用）。
  2. **地块等级/据点/中立地生成全部改为「离自己最近首府的距离」**：`proceduralTile` 里的 `dr` 从"离地图几何中心距离/半对角线"改为"离最近首府距离/`GEN_MAX_CAP_DIST`"（`GEN_MAX_CAP_DIST` = 采样整张地图算出的"离最近首府最远的一点"到其首府的距离，模块加载时算一次）。地图中心格仍特判为唯一的 `type:'center'` 格（霸业国首府所在格）。
  3. **等级曲线指数从 1.1 重新调到 1.9**：10 个首府比 1 个几何中心覆盖面积更大，同样的 1.1 指数会把 5 级以上占比从 ADR-032 的目标 ~50% 推到实测 ~81%；重新蒙特卡洛校准后 1.9 把该占比拉回 ~51%（详见 `SLG_DESIGN.md` §3.2）。
  4. **阻挡地形改为「离最近首府越远越密」**：`obstacleMaxDr`（旧：只排除地图最外角，`dr≤0.87` 才生成）废止，改为 `obstacleMinDistRatio=0.15`（新：`dr≥0.15` 才生成）——天然把山脉/河流集中在每个国家的边境，而不是围绕地图单一几何中心，呼应"资源国出关可达"的读法（资源国夹在霸业国和外环国之间，边境天然险要）。keep/stronghold 的 `keepMinDistRatio`/`strongholdMinDistRatio` 语义同步从"离地图中心"变成"离最近首府"，数值不变。
  5. **⚠️ 顺带发现并修正一处校准错误**：`obstacleThreshold=0.88` 的注释一直声称"约 12% 的格子变阻挡"，实测（新旧公式都测过）实际只有 ~2.7-2.9%——`valueNoise` 的双线性插值+平滑步进会把噪声值压缩，远小于"均匀分布、12% 超过 0.88"的朴素假设。这个校准错误在 ADR-032 之前就存在，本次未重新调阻挡密度本身（那是独立的数值平衡任务），只是把注释改成实测数字，`obstacleMinDistRatio` 按实测密度校准。
- **为什么**：用户对三战版图节奏的核心诉求是"各国有各国的地盘和肥沃程度"，而不是"整张地图只有一个山巅"；10 国（不是 9 国）是因为用户更看重"外围 6+资源 3+霸业 1"这个数字对称性，胜过严格照搬三战的 9 国。
- **影响**：
  - [`SLG_DESIGN.md`](game/SLG_DESIGN.md) §2.4/§3.2 已按本决议改写（新增环带布局说明 + 等级/阻挡与首府绑定的机制描述 + 实测数字）。
  - **本 ADR 是"拍板即实现"**：与 ADR-032（先拍板后实现，隔一轮）不同，这次设计讨论中直接把 `CAPITAL_FRACTIONS`/`proceduralTile`/`SLG_GEN` 一并改完，同批验证。
  - 过程中发现并修复了一个**与本次改动无关、此前从未被真正跑过的回归**：`server/worldsvc` 的 e2e 测试此前一直通过本地 worktree 的 `node_modules/@nw/*` 符号链接指向主仓库的**未重建**产物在跑（worktree 约定的已知坑，见 [`claudedocs/worktrees.md`](../claudedocs/worktrees.md) 补充说明），导致 ADR-032 合并后测试从未真正验证过新地图常量；本次修好链接后跑出 27 个真实失败（`resourceDensity=1.0` 后 `'neutral'` 地块已绝迹、`(250,250)` 在 500×500 地图下变成地图正中心、以及若干测试用坐标恰好落入新地形分布的阻挡带），已在本 ADR 一并修复（10 个测试文件），修复后 worldsvc 210 例 + shared 463 例全绿。
- **实现**：`server/shared/src/slg.ts`（`CAPITAL_FRACTIONS`/`NATION_KIND_BY_IDX`/`GEN_MAX_CAP_DIST`/`proceduralTile`/`SLG_GEN.levelFalloffExp`+`obstacleMinDistRatio`）；`server/worldsvc/test/*.e2e.test.ts`（10 个文件的坐标假设修复）。**⚠️ 该实现已被 ADR-034 判定作废，需重写，见下条。**

## ADR-034 SLG 国家版图改为环形分层结构（6 出生州+3 资源州+1 核心州）+ 地形隔离/城池体系拍板 — Accepted — 2026-07-05

- **背景**：与另一条并行会话独立进行的 ADR-033（10 首府三层同心环+距离衰减）撞了同一天、同一个"国家版图重构"题目，但走向了不同方案。本 ADR 是这条会话的产物：用户指出现有 10 首府点 Voronoi 分区有两个无法用调参解决的问题：① 随机生成的地形（`proceduralTile()`）不知道国界在哪，② 国家之间的隔离效果差（边界随机穿山、切资源带）。经讨论确认根因：地形生成与国家分区是两条互不感知的纯函数管线，纯参数化生成到此已到天花板，需要引入编辑器承载的人工修正手段（新工具见 [`design/tools/map-editor/DESIGN.md`](tools/map-editor/DESIGN.md)）。讨论中调研了三战（三国志战略版）的版图/城池机制作参考（[`SGZ_LAND_REFERENCE.md`](game/SGZ_LAND_REFERENCE.md) §5 环形结构、§8 城池系统），并借助一次性 HTML/JS 原型反复验证骨架后收敛。**发现与 ADR-033 冲突后，用户拍板以本 ADR 为准，ADR-033（含其已落地的代码）全部作废。**
- **决策**：
  1. **国家分区从"10 首府点 Voronoi"改为"角度扇区 + 半径分层"**：6 个出生州（外圈，各占 60°）+ 3 个资源州（中环，各占 120°，与出生州 2:1 对齐）+ 1 个核心州（中心圆域）。半径边界初始参考值：核心州半径比例 0.11、资源州外边界比例 0.39（相对地图半对角线），非最终锁死数字。
  2. **新增两类天然隔离地形**：折痕岭（3 条山脉，= 出生州↔资源州环形边界本身，6 段两两分组）+ 墨河（2 条河流，全新横穿全图的独立层，噪声扰动弦线）；均完全不可通行，厚度 5–11 格随机。
  3. **出生州之间新增支脉/支流隔离**：折痕岭/墨河从环形边界向地图边缘延伸出 6 条支脉（单双号交替山脉/河流类型），把 6 个出生州两两隔开；每条支脉按实际长度分配 1-2 座**关隘城池**（长的一半配 2 座，短的一半配 1 座），必须攻城才能通过——不设免费关隘。
  4. **明确区分"关隘/桥"与"城池"两套机制**（三战调研的关键结论：城池是跟地块并列的独立节点，多驻军+城墙耐久一层，不能等价成关隘）：关隘/桥只出现在两条大环边界（出生州↔资源州、资源州↔核心州），免费通行，宽度 3–8 格随机；城池须攻城，出现在支脉/州府/世界中心。
  5. **拍板城池体系的种类与数量**：州府（出生州 6 座 + 资源州 3 座）+ 关隘城池（支脉 6-9 座）+ 世界中心巨城（1 座，9×9 格实体，核心州争夺目标，本质也是城池只是更大）+ **出生州分级城池**（每出生州新增 9 座：2×3 级 + 2×4 级 + 2×5 级 + 1×6 级 + 1×7 级 + 1×8 级，全图共 54 座，呼应三战"州内多级城池梯度"但改为固定配额）。城池驻军/城墙耐久数值本次不拍板，留后续。
  6. **拍板三层环各自的等级分布权重表**：出生州封顶 8 级且占比极低（~1%）；资源州 5 级+占比 ≥60%（含 ~5% 的 10 级）；核心州 10 级占比明显高于资源州（18% vs 5%）。完整权重表见 map-editor DESIGN.md §4。
- **为什么**：用户对三战版图结构（环带分层+关隘严格对应层级）非常熟悉，希望复刻其"层级递进"的攻略节奏，同时解决现有 Voronoi 方案地形/国界两不相干的结构性缺陷；城池/关隘分离是三战调研澄清的关键差异，直接照抄"关隘=城池"会做错机制；本 ADR 优先于 ADR-033，是因为角度扇区+完整地形城池体系比"点+距离衰减"更彻底地解决了"地形不知道国界"的根因（扇区边界本身就是地形，不是事后套一层距离公式）。
- **影响**：
  - 新增/改写 [`design/tools/map-editor/DESIGN.md`](tools/map-editor/DESIGN.md)（§2-§4 地形骨架定稿，§6 编辑器需求，§7 原型迭代记录）。
  - [`SLG_DESIGN.md`](game/SLG_DESIGN.md) §2.4（国家系统）、§3.2（地图尺寸与地形布局）已改写，指向本 ADR；[`SLG_DESIGN_LOG.md`](game/SLG_DESIGN_LOG.md) §24 记录代码重写完成状态。
  - **ADR-033 判定作废**：其已落地的代码已按本 ADR 整体重写完成（2026-07-05）——`server/shared/src/slg.ts` 新增 `provinceIdxAt()`（角度扇区+半径环归属，替代 `nearestCapitalIdx()` Voronoi）、`provinceCapitalPositions()`（州府位置按扇区+种子派生，替代固定表 `CAPITAL_FRACTIONS`）、环形地形带/墨河弦/支脉/城池节点（州府+世界中心 9×9+关隘城池+每出生州 9 座分级城池）、按环等级分布表；`NATION_KIND_BY_IDX` 的 `hegemony` 改名 `core`。城池落地为现有 `familyKeep`/`center` 类型而非独立 collection（驻军/耐久数值本条未拍板，故不新增 schema）。`server/worldsvc` 消费方（`coreKernel`/`coreNation`/`coreYield`/`combatSiege`）与受影响 e2e（`nation-bonus`/`season-ops`/`fog`/`service`/`httpApi`/`pathfinding`）已同步修完；`server/shared`/`server/worldsvc`/`server/tools/econ-sim` typecheck+test 全绿。
  - `tools/map-editor` 工具仍未搭骨架，讨论期验证骨架用的 HTML/JS 原型未提交仓库——留后续任务。
  - 城池驻军/耐久数值、资源州/核心州是否也要分级城池梯度、国民加成如何随分层结构调整，均留待后续 ADR。
- **教训**：两条并行会话在同一天独立展开"国家版图重构"这个大改动，导致 ADR 编号撞车、代码方向冲突——已落地代码被判定作废意味着那批 e2e 测试修复工作也随之作废。后续如有多会话并行处理同一模块的结构性改动，应在开工前先检查是否有其他会话正在动同一处（如 `git log` 看最近的 daily 分支提交），或至少在长任务过程中定期 `git fetch`/查 worktree 列表交叉核对。

## ADR-035 地图编辑器/游戏渲染对齐：河/山可分 + 城池按级出图与占地 — Accepted — 2026-07-06

- **决策**（用户拍板，两问两答）：
  1. **河流 vs 山脉端到端区分**：给瓦片加可选 `obstacleKind: 'river'|'mountain'`（`@nw/shared` `core.ts`），**类型仍是单一 `obstacle`**（寻路/占领/不可通行逻辑一字不改，纯美术标签）。`proceduralTile` 给自己生成的阻挡带打标（折痕岭=山、墨河=河、6 支脉按奇偶交替）；编辑器画笔的河/山经 `rasterizeMapEdits` 带进 `MapTemplateTile.obstacleKind`。渲染端 `terrainTextureName(…, obstacleKind?)` 有 kind 用对应贴图，否则回退旧位置哈希。这修正了旧行为——画一条河会被 `(tx*31+ty*17)%2` 哈希成半河半山。
  2. **城池每级一张图 + 占地随级递增**：`cityFootprint(level)`=3/5/7/9（Lv1-2/3-5/6-8/9-10；世界中心 9×9=顶档），`allCityNodes` footprint 由它派生；`getCityTextureForLevel` 先取 `city_l{level}`（10 张一套）、回退旧 4 档 `city_lv{tier}`。游戏 `WorldMapRenderer.refreshCityLayer` 与编辑器 `refreshCitySprites` 用同函数同缩放，除玩家主城外也为 NPC 城池节点（州府/关隘城/分级城/世界中心）画按 footprint 缩放的城池精灵。
- **范围（用户拍板"先做渲染对齐"）**：本轮只做**共享数据模型 + 两端渲染器**，不动世界 API/持久化。因此对齐的是**"生成地图"**（编辑器与游戏都从同一份 `proceduralTile`/`allCityNodes` 本地派生，天然一致）。
- **影响文档**：[`design/tools/map-editor/DESIGN.md`](tools/map-editor/DESIGN.md) §0（2026-07-06 条）；[`SLG_DESIGN.md`](game/SLG_DESIGN.md) §3.1（山/河渲染区分）、§3.4（每级出图+占地+NPC 城精灵）；[`design/product/city-image-prompts.md`](product/city-image-prompts.md)（改为每级 10 张 + 6 张新图 prompt）。
- **美术缺口**：需新出 6 张城池图 `city_l2/l4/l5/l7/l8/l10`（未就位时按档自动回退，视觉不劣化）。
- **已知遗留（另起任务）**：编辑器"发布"仍到不了运行中的世界——`worldsvc` `getMap/getTile` 只读 `proceduralTile`，从不读世界创建时克隆进 `mapBaselines` 的模板 tile。让发布真正生效需把 `mapBaselines` 接进热读路径（含 `obstacleKind` 带进 `MapBaselineTileDoc`），是 ADR-034/§24 遗留的独立改动。
- **为什么是 `obstacleKind` 而非新 `TileType`**：全仓大量 `type === 'obstacle'` 判定（寻路、落城校验、占领）依赖单一类型；加子字段零风险，加新类型要改所有判定点。

## ADR-036 场景切换动画收窄到「进出对局/进出 SLG」四处 + 遮罩改纸色调 — Accepted — 2026-07-12

- **背景**：2026-07-11 为修「大厅 Store→Career 误跳」引入了 `SceneManager.goto()` 全屏黑幕 cross-fade，但**默认对每一次 `goto()` 都生效**——包括大厅各 tab、二级页面、返回按钮之类的普通导航。用户实测体验后反馈：①原黑幕 fade 效果本身不够好看；②不该所有界面切换都有动画，子标签之间也套了一层淡入淡出，观感怪异。参考同类项目 `D:\number`（另一相邻游戏，PixiJS 技术栈一致）的 `sceneCoordinator.ts`：用**暖色纸色调**遮罩（非黑幕）+ 快进慢出（80ms/150ms，线性）实现「闪一下」质感，而非逐场景都套的重手法。
- **决策**：
  1. **`SceneManager.goto(scene, opts?)` 默认改为同帧 instant 切换**（不传 `opts` 或 `opts.fade` 为空/false）；仅显式 `{fade:true}` 才走 cross-fade。原来的语义反过来了（原来默认 fade、`{instant:true}` 才跳过）。
  2. **收窄到 4 个调用点**：`app.ts` 的 `showGame`/`showGameNet`（进入对局）、`showWorldMap`（进入 SLG）永远传 `{fade:true}`；`nav.goLobby({fade:true})` 仅在「离开对局」（对局放弃 `onExitToLobby`、教程完成/跳过、净斗放弃、结算页返回/默认再来一局落地大厅）与「离开 SLG」（`WorldMapScene.onBack`）这些调用点传。其余数十个 `nav.goLobby()` / `manager.goto()` 调用点（商店、装备、成就、排行榜等二级页面的进入/返回）保持不传 `fade`，即默认 instant。
  3. **遮罩换色 + 缩短时长**：全屏遮罩色从纯黑 `0x000000` 改为纸色 `0xfaf6ee`（与 `sketchUi.ts` 的 `C.paper` 一致，呼应笔记本纸张基调），峰值不透明度从 1.0 降到 0.92（半透明感更轻）；耗时从 120ms/160ms 改为 90ms/180ms（fade-out 更快，fade-in 略慢让「定住」的感觉更足），easing 不变（`easeInOutQuad`）。
  4. **输入冻结门控范围同步收窄**：`InputGate.suppress` 只在显式 `{fade:true}` 的转场里才启用；instant 切换完全不冻结输入（这是「默认改 instant」的自然推论，不是新增逻辑）。
- **为什么这样收/为什么这个颜色**：只在「世界感」真的变了的四个转场（对局⇄大厅、SLG⇄大厅）保留过渡感，能让玩家感知"进入了不同的场域"；其余都是同一个大厅/同一套导航层级内的平移，不该有转场仪式感。纸色遮罩是因为游戏全局是手绘笔记本风格（`sketchUi.ts` 的 `C.paper` 背景色），黑幕在这种基调下显得突兀；参考项目证明"半透明色闪一下"比"纯黑全遮罩"更轻量、更贴风格。
- **影响**：`client/src/scenes/SceneManager.ts`（`GotoOptions.instant`→`GotoOptions.fade`，默认反转，遮罩颜色/时长常量）、`client/src/app.ts`（4 处 `manager.goto(..., {fade:true})`；`showLobby` 新增 `opts?: FadeOpts` 透传）、`client/src/app/AppViews.ts`（新增 `FadeOpts`）、`client/src/app/appCtx.ts` + `client/src/app/nav/{lobby,game,result,world}.ts`（`goLobby` 的 `fade` 选项按上述 4 类调用点显式传 `true`）、`client/test/ui/sceneManager.ui.ts`（按新默认语义重写全部用例）。详见 [`claudedocs/client-modules.md`](../claudedocs/client-modules.md) 场景淡入淡出条目。

## ADR-037 占领行军接入 PvE 战斗 + 占领倒计时（延迟落地，镜像 ADR-026） — Accepted — 2026-07-13

- **决策**（本次任务拍板，`feat/occupy-march`）：`MarchKind='occupy'`（S8-2 起已存在，不是新增行军类型）到达时的结算，从「瞬间落地、不打仗」升级为「先打一场 PvE 战斗，胜后再挂一段占领倒计时，倒计时到点才正式写入 `TileDoc.ownerId`」。
- **为什么现在做**：ADR-032 把 `resourceDensity` 提到 1.0 之后，地图上不再有真正的空地——§3.1 表格里每个中立/资源格都按等级有系统默认驻军（`npcGarrison(level)`），但 `combatMarch.ts` 的占领到达分支从未打过这份驻军，等价于让"占领"绕开了设计文档自己定义的攻防模型。本次改动把占领和扫荡/围攻统一到同一份"系统驻军按等级走"的权威来源上。
- **核心规则**：
  1. **驻军判定复用扫荡同源**：`npcGarrison(proc.level)`（`@nw/shared/slg/siege.ts`，扫荡 `applySweep` 已在用）——不新造第二套"中立格防御强度"函数。
  2. **战斗复用围攻同一引擎**：`runSiegeBattle`/`synthesizeArmy`（`server/worldsvc/src/siegeEngine.ts`），`seed = siegeSeedFromId(marchId)`，与围攻同源、同样可回放；胜负记录复用既有 `recordSiege`/`pushSiege` 战报管线，不新增推送类型。
  3. **占领倒计时（镜像 ADR-026 延迟结算范式）**：胜利不等于落地。新增集合 `occupations`（`OccupationDoc`，`_id`=目标 tileId，一格至多一份待结算记录），`dueAt = 胜利时刻 + OCCUPY_HOLD_SEC*1000`；`OCCUPY_HOLD_SEC = 5*60`（新增于 `shared/src/slg/core.ts`，**DRAFT** 占位值，与 ADR-026 `SLG_SIEGE_DAMAGE_DELAY_MS` 同为 5 分钟但语义不同——那是"扣血"，这是"落地"）。倒计时期间该格 `TileDoc` 写入 `contestedBy`/`contestedUntil`/`contestedGarrison`/`contestedFamilyId`（仍不写 `ownerId`），供客户端渲染倒计时；调度沿用 `WorldCorePush` 既有 Redis ZSET + Mongo `dueAt` 索引扫描双保险模式（新增 `scheduleOccupation`/`unscheduleOccupation`，接入 `scheduler.ts` 同一 2s tick 的 `processDueOccupations`）。
  4. **倒计时期间可被驱逐**：另一支 `occupy` 行军，或一支 `attack` 行军（本次放宽：目标格处于占领倒计时中即使无主也允许发起攻击，`defenderId`=`contestedBy`）到达时，打的是 `TileDoc.contestedGarrison`（原占领方的真实存活部队，不是重新查 NPC 驻军）。驱逐成功 → 取消原倒计时（删旧 `OccupationDoc`+反调度），驱逐方立即开始自己的新占领倒计时；驱逐失败 → 原倒计时不受影响，驱逐方生还部队退回兵力池。v1 不处理链式驱逐的公平性，只保证原子认领（`findOneAndDelete`）下不重复结算/不崩溃。
  5. **零驻军兜底**：`npcGarrison(level)>0` 恒成立（`Math.max(1,level)`），故"瞬间落地不打仗"的旧路径理论上是死代码，仅作防御性兜底保留（真出现 garrison≤0 才会命中）。
  6. **旧端点 `TerritoryService.occupyTile()`（S8-1 瞬占，`territory.ts`）**：保留，但降级为内部/测试专用（客户端已改走 `startMarch(kind:'occupy')`，产品流程不再调用它）；不做移除/404，契约文档补充说明。
- **影响**：
  - `@nw/shared`（`slg/core.ts` 新增 `OCCUPY_HOLD_SEC`）。
  - `worldsvc`：`db.ts` 新增 `OccupationDoc` 集合 + `TileDoc.contestedBy/contestedUntil/contestedGarrison/contestedFamilyId`；`corePush.ts` 新增 `scheduleOccupation`/`unscheduleOccupation`；`combatSiege/occupation.ts`（新文件，`applyOccupy`/`applyOccupationExpulsion`/`processDueOccupations`，接入 `combatSiege.ts` 装配链）；`combatMarch.ts` 的 `occupy` 到达分支改为委托 `this.siege.applyOccupy`；`combatSiege/arrival.ts` 的 `applySiege` 放宽"目标无主但处于占领倒计时中"分支；`combat.ts`/`service.ts`/`scheduler.ts` 新增 `processDueOccupations` 透传。
  - 契约（`openapi-world.yml`）：`WorldTileView` 新增 `contestedUntil`/`contestedByMe`。

## ADR-039 SLG 连地占领硬性规则（宗门级判定，含首府/桥栈道）— Accepted — 2026-07-14

- **决策**（用户拍板）：三战「连地」升级为硬性规则——占领（`occupy`）/围攻（`attack`）目标格必须与本宗门已占领地 4 方向相邻，否则拒绝发起。此前 §4 的"连地才高效"只是软性效率加成（短行军距离 + 快速增援），本次改为强制前置校验。**普通领地/资源点/险地/州府/桥栈道一视同仁**，均须连地——首府/桥栈道不豁免，否则规则本身可被绕过。扫荡（`sweep`）与侦查（`scout`）不占地，不受限。
- **为什么**：用户认为连地是三战的核心规则之一，能强制形成清晰前线、把"抱团"从口号变成机制，并解释"为什么必须一格格打过去才能抢到关键城池"。与既有环形版图结构（ADR-034：出生州→资源州→核心州）天然契合——加上连地后，宗门必须逐层推进才能摸到中心州首府，正好兑现该结构想要的"层层推进"叙事。
- **核心规则**：
  1. **判定范围 = 宗门级（不是家族级）**：宗门内所有成员家族的领地并集共同构成连地前沿，任一成员家族挨着目标格即可，不要求发起人自己家族恰好相邻。未加入家族 → 只认自己的领地；已加入家族但宗门未成立 → 判定范围=家族全体领地并集。
  2. **盟友宗门领地不计入判定**——结盟（§8.2，`sect.allySectIds`）只是互不攻伐 + 桥栈道通行，不合并版图，否则"结盟"会变相等价于"合并宗门"。
  3. **服务端两处强制**：`startMarch`（`combatMarch.ts`）的 `occupy`/`attack` 分支在发起时校验；到达时 `applySiege`（`combatSiege/arrival.ts`）与 `applyOccupy`（`combatSiege/occupation.ts`）再校验一次（行军途中宗门领地可能因丢地而断连），断连按"扑空"处理——退还部队 + 推送 `recalled`，与既有的"目标已非敌方所有"重校验同一套模式。不满足 → 新错误码 `TERRITORY_NOT_CONNECTED`（400）。
  4. **判定函数**：`WorldCoreVision.isConnectedToSectTerritory(worldId, accountId, x, y)`（`coreVision.ts`）——4 方向邻接查询 `TileDoc.ownerId ∈ 宗门成员家族的 accountId 并集`；私有辅助 `ownSectFamilyIds` 与既有 `friendlyAccountIds` 同构但**不含盟友宗门**（这是两者唯一的差异点，友军攻击豁免要盟友、连地判定不要）。
  5. **主城落地即初始领地（不依赖 ring 格 ownerId）** — 修订 2026-07-14：连地判定与行军寻路都额外把**每个宗门成员的主城 3×3 footprint**（由 `playerWorld.mainBaseTile` 推出）当作己方领地，而不是纯靠 8 个 ring `TileDoc` 是否带 `ownerId`。原因：早期版本 `baseTileDocs` 未给 ring 格写 `ownerId` 的**历史存档基地**（ring 格 `type:'base'` 但无 `ownerId`）会出现"连自己基地旁边的空地都占不了"——`isConnectedToSectTerritory` 数不到相邻己方格（只有 anchor 带 ownerId，而 anchor 的邻居正是自己的 ring 格，占领目标在 footprint 外一格，其邻居 ring 格无 ownerId → 判定失败）；且 `combatMarch.ts` 的寻路 `blockedBaseKeys` 会把无主 `type:'base'` 格当成敌方建筑（missing ownerId 命中 `$nin`）把守军堵死在城里。改为从 `mainBaseTile` 推 footprint 后，健康基地行为不变（ring 本来就带 ownerId，新旧路径一致），历史存档基地则**原地自愈**（无需触发 ADR-025 的 purge+随机重新落地那条破坏性路径）。
- **已知取舍（接受）**：先手/占据资源密集区的宗门会滚雪球更快，弱势宗门可能被堵死在外圈无法扩张——但一个大区真正对抗的宗门通常只有两三个，规则逼着弱势方要么被兼并要么结盟，符合"明确前线"的设计目的，不视为需要修正的缺陷。
- **影响**：
  - `@nw/shared`（`api.ts` 新增 `ErrorCode.TERRITORY_NOT_CONNECTED` + `ERROR_HTTP_STATUS` 映射）。
  - `worldsvc`：`coreVision.ts` 新增 `ownSectFamilyIds`/`isConnectedToSectTerritory`；`combatMarch.ts` 的 `startMarch` occupy/attack 分支新增校验；`combatSiege/arrival.ts` 的 `applySiege`、`combatSiege/occupation.ts` 的 `applyOccupy` 到达时新增重校验。2026-07-14 修订：`isConnectedToSectTerritory` 与 `computeMarchPath` 均改为从 `mainBaseTile` 推主城 footprint 作为己方领地（见核心规则 5），修历史存档基地无法从主城旁扩张的问题。
  - 文档：[`game/SLG_DESIGN.md`](game/SLG_DESIGN.md) §3.1（表格标注）+ §4.1（新增，规则细节）。
  - 测试：既有大量 e2e（`march`/`siege`/`occupy-march`/`alliance-attack`/`passage`/`base-siege` 等）的攻击目标此前多为"跨图直接打远处敌方基地"，在硬性连地规则下会被拒绝——受影响用例需改用既有的内部/测试专用 `TerritoryService.occupyTile()`（瞬占，见 ADR-037 段）预先铺垫"发起方宗门已占领相邻格"的前置状态，而不是重写测试所验证的核心断言。新增 `territory-connectivity.e2e.test.ts` 覆盖判定本身。

## ADR-038 废弃 `CollectionScene`，皮肤装备关系从全局单槏位改为逐卡独立 — Accepted — 2026-07-13

- **决策**（用户拍板）：`CollectionScene`（纯图鉴+皮肤衣柜页）整页删除，功能拆解并入养成组：图鉴全集→生涯组（`CareerTabs`）新增页签、皮肤衣柜→养成组（`CardScene`）新增页签、背景故事 lore→角色卡详情弹窗翻转展示。**皮肤的装备关系**从 `SaveData.equipped: Record<slot, skinId>`（账号级单一全局槏位）改为**逐角色卡独立槏位**——每张卡各自可换皮肤，换后该卡卡图用皮肤形象展示；皮肤的**拥有关系**（库存/购买/抽卡渠道）不变。
- **为什么**：用户质疑 `CollectionScene` 与养成/生涯页功能重复、UI 风格自成一套不统一；调研确认不是功能重复（`CollectionScene` 纯只读展示，真正升级/合成在 `CardScene`），但确实是布局孤岛。原全局单槏位皮肤模型无法支撑"点这张卡换这张卡的皮肤"的直觉交互，需要连带改数据模型。
- **影响**：[`LOBBY_IA_REDESIGN.md`](game/LOBBY_IA_REDESIGN.md) §15 为方案细节；[`CHARACTER_CARDS_DESIGN.md`](game/CHARACTER_CARDS_DESIGN.md) 需补一节角色卡皮肤/lore 字段（现状空缺）；存档结构变更需要写老档迁移逻辑（默认规则未在本次拍板范围，实现时另拍）；`ECONOMY_NUMBERS.md` §7 皮肤获取矩阵数字不变。
  - `client`：`WorldMapInput.ts` 占领按钮改走 `startMarch(kind:'occupy')`；地图渲染/HUD 消费新增的 `contestedUntil` 字段渲染倒计时。
  - 文档：[`game/SLG_DESIGN.md`](game/SLG_DESIGN.md) §5.4（新增）。
  - 测试：`server/worldsvc/test/occupy-march.e2e.test.ts`（新增）。

## ADR-040 metaserver `openapi.yml` 按域拆分为 fragment，合并生成（服务不拆）— Accepted — 2026-07-14

- **决策**：`server/contracts/openapi.yml`（此前单文件 3241 行，metaserver 全部 77 个 REST 操作）改为手写 `server/contracts/openapi/{_root.yml,schemas.yml,paths/<domain>.yml}` 9 个按域 fragment，一一对应 `MetaService` 现有的 mixin 划分（`server/metaserver/src/service/{auth,save,pve,economy,inventory,progression,liveops,social,telemetry}.ts`）；新增 `server/contracts/scripts/bundle-openapi.mjs` 把 fragment 合并回 `openapi.yml`（沿用 ADR-023 的"生成文件提交入库 + CI `--check` 防 stale"模式）。服务本身**不拆**——metaserver 代码是整合/路由为主，拆多个微服务的运维成本不划算；已有 mixin 划分已经是合理的域边界。
- **为什么**：几乎所有玩家交互都经过 metaserver，单文件契约导致跨域改动时 diff/review 范围大、merge 冲突集中。openapi 自带的 `tags` 字段粒度不准（如 `tags:[save]` 混了 pve/inventory/progression 等多个 mixin 的操作），不能直接拿来分域；改为按"哪个 mixin 实现这个 operationId"分组，逐个核对全部 77 个 operationId 后确认可行（无遗漏、无跨 mixin 的同路径冲突）。
- **影响**：
  - `server/contracts/openapi.yml` 本身变成生成产物（文件头注明 `AUTO-GENERATED ... DO NOT EDIT`），后续改契约改 `openapi/paths/<domain>.yml` 或 `openapi/schemas.yml`，跑 `npm run gen:api:contracts`（在 `server/metaserver/`）重新生成。
  - 下游消费者（`gen-openapi-server.mjs`→`routes.gen.ts`、`client/scripts/gen-openapi.mjs`→`client/src/net/openapi.ts`、`openapi-request-schema.test.ts`/`openapi-response-schema.test.ts`）均只读 `openapi.yml` 文件路径，**未改动**，已验证 tsc/vitest/client typecheck 全绿。
  - CI：`.github/workflows/ci.yml` 新增 "server codegen check (metaserver openapi bundle)" 步骤（`npm run gen:api:contracts:check`），跑在既有 routes.gen.ts staleness check 之前。
  - 范围明确不含 `openapi-world.yml`（worldsvc）/`openapi-auction.yml`（auctionsvc）——规模本身不是痛点，未来若需要可复用同一套 `bundle-openapi.mjs` 模式。

## ADR-041 主城点击直达 Desk（去掉城池菜单弹窗）+ 清理主城「手动防守配置」残留 — Accepted — 2026-07-18

- **决策**（用户拍板）：世界地图上点击自己的主城 3×3 九格，**不再弹出菜单**（原「Enter Desk / Train / Defense / Manage team / ✕」五按钮弹窗），直接调用 `onOpenCity()` 进入 Desk（CityScene）。Train 与队伍管理本就已在 CityScene 内有完整入口（drillYard 训练详情弹窗、D-CITY-10 队伍卡片网格 → `onEditTeam`），不再需要地图层的重复菜单。
- **主城没有「防守配置」概念**：ADR-026（2026-07-02）早已把主城攻防重构为「逐队守军波次」——**在城内、未受伤的队伍自动为守军；出征在外的队伍不参与防守**（`applyBaseSiege` 判据：`MarchDoc.teamId` 是否有活跃行军）。本条只是**移除与该已实现机制矛盾的遗留 UI/API**：地图菜单里指向主城的「Defense」按钮 → `DefenseEditorScene`（`mode:'defense', tileKey:'base'`）→ `setDefense/getDefense` 写读 `PlayerWorldDoc.defense`，这条路径是 ADR-026 之前（S8-4）的手动编队防守遗留，`buildDefenderConfig` 从未对 `target.type==='base'` 调用过（`applySiege` 在 `target.type==='base'` 分支直接转 `applyBaseSiege`，绕开了 `buildDefenderConfig`/`tile.defense`），即 `PlayerWorldDoc.defense` 字段自 ADR-026 起就是纯死数据，从未被任何攻城结算读取。
- **领地/据点的手动防守配置不受影响**：非主城的己方领地格（`tileKey='{x}:{y}'`）仍走 `TileDoc.defense` → `buildDefenderConfig` 的既有编队路径（S8-4/G3-2c），本条不改动。
- **影响**：
  - 客户端 `WorldMapInput.ts`：主城分支从五按钮 `showModal` 改为直接 `onOpenCity()`；连带移除只被这个弹窗使用的 i18n key（`world.actEnterCity`/`world.train`/`world.team.manage`，3 语言）与回归测试 `worldMapBaseClick.ui.ts` 的断言更新。
  - `onOpenDefense('base')`/`onOpenTeams()`（地图层「打开队伍列表 TeamsScene」入口）、`WorldMapPanels.openTrainPanel()`（地图层训练面板）自此弹窗移除后**已无任何调用方**——确认为死代码，但体量较大（TeamsScene 整个场景 + 训练面板渲染 ~150 行 + 多处 `trainPanelOpen` 状态联动），本次不一并删除，留作后续单独清理（已用 spawn_task 标记）。
  - `server/worldsvc` 的 `PlayerWorldDoc.defense`（`tileKey='base'` 的 `setDefense`/`getDefense` 分支）**保留未删**——虽已确认是死代码，但涉及改 `openapi-world.yml` 契约（`tileKey` 参数默认值/说明）+ 两端 codegen 重新生成，风险/收益比不划算，本次不动；后续若清理前端 TeamsScene/训练面板时可一并处理。
  - **2026-07-18 后续清理（已完成）**：上面标记的死代码已按后续任务清理完毕——删除 `TeamsScene.ts` 整个场景及其接线（`goTeams`/`onOpenTeams`/`showTeams`/`goTeamEditor`，后者随 `goTeams` 一起变为死代码故一并删除；`WorldMapContext.onOpenTeams`）；删除 `WorldMapPanels.openTrainPanel`/`renderTrainPanel`/`ctx.trainPanelOpen`/`ctx.panelRepaint`，以及仅服务于训练面板、随之变为死代码的 `WorldMapNet.doTrain`/`doSpeedup`；`teamSlotId`/`teamSlotName`/`TEAM_CAP`（CityScene 仍需要）迁到 `game/meta/teamTroops.ts`。相应清理了仅被这些死代码引用的 i18n key（`world.teams`/`world.team.title`/`.edit`/`.tapToBuild`/`.emptyArmy`/`.fillTroops*`/`.legacyRebuild`/`.cancelOccupy*`/`.recallErr`、`world.train*`/`.speedup`/`.trained`/`.spedup`/`.err.queueFull`，3 语言）与对应测试（删除 `teamsScene.ui.ts`，其余文件去掉对已删符号的引用）。`tsc --noEmit` + `test`/`test:ui` 全绿（104+68 files / 727+635 tests）。`server/worldsvc` 的 `PlayerWorldDoc.defense` 死字段本次仍未动，维持上面的评估。

## ADR-042 家族加入改为需 leader/elder 审批（解决 SOCIAL_SVC_DESIGN §8 O1）— Accepted — 2026-07-18

- **决策**（用户拍板）：`POST /social/family/:id/join` 不再直接入队，改为插入一条 `FamilyJoinRequestDoc`（`pending`）；leader/elder 通过新增的 `GET /social/family/requests` 查看、`POST /social/family/requests/:id/respond` 同意（复用原直接入队逻辑）或拒绝（拒绝会给申请人发一封系统邮件，`family.mail.rejected.*` i18n key）。解决 `SOCIAL_SVC_DESIGN.md` §8 遗留的 O1 开放问题（此前文档已预留 `joinPolicy` 字段但从未实现，实际代码是直接入队）。
- **为什么**：直接入队让族长对新成员毫无筛选权，用户希望能审核申请人。
- **影响**：
  - `server/socialsvc`：`db.ts` 新增 `familyJoinRequests` 集合（`{familyId,status}`/`{accountId,status}` 索引）；`familyService.ts` 新增 `requestJoin`/`listJoinRequests`/`respondJoinRequest`（`joinFamily` 保留但只在 accept 路径内部调用）；`httpApi.ts` 新增两条路由（**踩坑**：`GET /social/family/requests` 必须排在通用 `GET /social/family/:id` 之前，否则 `requests` 会被当成 familyId 捕获——已加 HTTP 层 e2e 测试锁定顺序）；`FamilyService` 新增可选 `mail?: MailService` 依赖，`index.ts` 调整实例化顺序（mailSvc 先于 familySvc）。
  - `@nw/shared`：`ErrorCode.ALREADY_REQUESTED`（409）。
  - `client`：`WorldApiClient.joinFamily` 改名 `requestJoinFamily` + 新增 `listJoinRequests`/`respondJoinRequest`；`FamilyScene`（`base/data/actions/render.ts`）新增 `isFamilyApprover` 判定、Members 面板顶部"待审批 (N)"按钮（仅 leader/elder 且有申请时显示）、审批弹窗；`FriendsScene` 的家族加入入口（`app/nav/social.ts`/`FriendsScene/service.ts`）同步改为提交申请语义，不再假定"点击即入队"。
  - 文档：[`SOCIAL_SVC_DESIGN.md`](game/SOCIAL_SVC_DESIGN.md) §3.1（新增 `FamilyJoinRequestDoc`）+ §4.1（路由表）+ §8 O1 拍板。
  - 测试：`server/socialsvc/test/family.e2e.test.ts`（新增 8 个用例）+ `familyHttp.e2e.test.ts`（新增 8 个用例，含 wire-level 路由顺序回归、权限拒绝、拒绝邮件断言）；`client/test/ui/familyJoinApproval.ui.ts`（新增，8 个用例，覆盖审批方 + 申请方双视角，headless PIXI 渲染断言）。

## ADR-043 角色卡升级从连续 XP 曲线改为离散五合一融合 + 背包 150→500 扩容 — Accepted — 2026-07-19

- **决策**（用户拍板）：角色卡升级不再是"喂经验条"（同阵营任意卡喂 XP、1 级卡固定 1 点/2 级+ 打 8 折、`5^level` 指数曲线），改为**离散融合**：选目标卡 + 从背包选 **5 张同阵营、同等级**的卡作为材料，一次性消耗后目标卡升 1 级；UI 从原来的"输入数量喂经验"面板改为**环形布局**（中心卡+5 材料槽环绕），融合时播放动画（当前程序内占位，后续换专门 VFX）。同时把卡背包容量 `CARD_INV_CAP` 从 150 扩到 500。
- **为什么**：旧曲线下喂到 6 级理论上要 3,000+ 张 1 级卡（用户原话："目前玩家看到 6 级要几千张卡，直接吓傻了"）。讨论中明确了这不是纯粹的数值问题——用户认为终局定位是"大多数玩家停在 5-6 级，9 级留给氪佛自娱自乐"，数值本身能接受，真正想改的是**交互体验**：把抽象的经验数字换成看得见摸得着的"凑 5 张卡"。因此本次重设计**刻意不改分支系数**——材料仍须严格等于目标当前等级（不允许混级/打折顶替），总卡量需求量级与旧 `5^level` 曲线一致，只是包装成融合动画而不是输入框。
- **影响**：
  - `server/shared/src/cards.ts`：删 `feedXp()`/`LEVEL_CUMULATIVE_XP`/`CardInstance.xp` 字段；新增 `applyFusion()`/`FUSION_MATERIAL_COUNT`(=5)；新增命名常量 `MAX_CARD_LEVEL`(=9，此前是散落 server/client 四处以上的字面量 `9`)；`CARD_INV_CAP` 150→500；`CARD_INV_WARN`(client-only 140)与 `INV_FULL_MAIL_COUNT`(10)合并为一个复用常量 `CARD_INV_OVERFLOW_BUFFER`(=10)，同时驱动 UI 预警阈值和满仓溢出邮寄上限两处逻辑。
  - `server/metaserver/src/cards.ts`：`feedCards()`→`fuseCards()`，校验材料数量严格等于 5、同阵营、同等级、未锁定、目标未满级。
  - 契约：`POST /cards/feed`→`POST /cards/fuse`（`server/contracts/openapi/paths/inventory.yml`，`materialIds` 加 `minItems`/`maxItems: 5`），`CardInstance` schema 删 `xp` 字段（`schemas.yml`）；重新生成 `openapi.yml`/`routes.gen.ts`/client `net/openapi.ts`。
  - `client/src/game/meta/cardDefs.ts`：**打破本仓库一贯的"client 镜像 @nw/shared 常量"纪律**（equipmentDefs.ts 同款做法），改为新增 webpack/vitest/tsconfig 的 `@nw/shared/cards` 别名直接指向 `server/shared/src/cards.ts` 源文件导入 `CARD_INV_CAP`/`MAX_CARD_LEVEL`/`FUSION_MATERIAL_COUNT`/`CARD_INV_OVERFLOW_BUFFER`——之所以能这样做且不破坏浏览器构建，是因为 `cards.ts` 本身零运行时依赖（仅 `import type`），与 `@nw/shared` 包根 `index.ts` 的完整 barrel（会拉入 mongodb/jsonwebtoken）不同；`CardDef` 卡牌定义本身仍按旧纪律镜像（含 client 独有的省略字段）。
  - `client/src/scenes/CardScene/feed.ts`：整体重写为环形融合槽位 UI；`detail.ts` 的进度条语义从"XP 进度"改为"已拥有同级材料 n/5"。
  - i18n：`roster.feedBtn/feedTitle/feedHint/feedEmpty/feedConfirm/feedOk/feedErr/xpProgress` 全部替换为 `roster.fuseBtn/fuseTitle/fuseHint/fuseEmpty/fuseOk/fuseErr/fuseMaterials`（3 语言）。
  - 文档：[`CHARACTER_CARDS_DESIGN.md`](game/CHARACTER_CARDS_DESIGN.md) §0/§1/§2.2/§3/§4.1/§10.1/§10.2/§11/§13/§14/§17（CC-13）+ [`ECONOMY_NUMBERS.md`](game/ECONOMY_NUMBERS.md) §15.2/§15.3。
  - 测试：`server/shared/test/cards.test.ts`（`feedXp`→`applyFusion` 系列）、`server/metaserver/test/cards.e2e.test.ts`（`/cards/feed`→`/cards/fuse` 全部用例改写，含材料数量/等级不匹配/满级等新增边界）、`economy.e2e.test.ts`（硬编码 150 改用 `CARD_INV_CAP` 常量）、`openapi-request-schema.test.ts` 的通用最小 payload 构造器补上对 `minItems` 的支持（此前只生成 1 元素数组）；client `test/cardDefs.test.ts`/`cardRoster-offline.test.ts`/`api-client.test.ts` 同步改写；`test/ui/cardFeedPaging.ui.ts`→`cardFusePanel.ui.ts`（候选分组/过滤/填槽/撤槽/Confirm 门控/滚动，8 用例）、`feedBtnWidth.ui.ts`→`fuseBtnWidth.ui.ts`（三语言按钮宽度自适应）；其余十余个 `.ui.ts`/`.test.ts` 里构造 `CardInstance` 字面量的地方去掉已删除的 `xp: 0` 字段、`CardCallbacks` stub 的 `feedCards`→`fuseCards`；`vitest.ui.config.ts` 补 `@nw/shared/cards` 别名。全量：server `shared`(30/595)+`metaserver`(47/632) 全绿；client `tsc --noEmit`+`typecheck`(test 层)+`vitest run`(105/737)+`test:ui`(72/658) 全绿；webpack 生产构建成功。

## ADR-044 CityScene（Home Desk）开关改为 SceneManager 覆盖层，不再重建 WorldMapScene — Accepted — 2026-07-20

- **决策**（用户拍板）：世界地图上打开/关闭 Home Desk（`onOpenCity()` 直达入口，见 ADR-041）不再走 `SceneManager.goto()`（销毁旧场景+构造新场景），改为新增的 `pushOverlay()`/`popOverlay()`：`CityScene` 挂载在仍然存活的 `WorldMapScene` 之上，关闭时只销毁 `CityScene`，`WorldMapScene` 全程不销毁、不重建、不重新拉取世界状态——"这个页面，不要走场景重绘…slg 场景一直都在，无缝切换，也不重绘"。
- **为什么**：`SceneManager.goto()` 的既有契约是"绝不同时挂载两个场景"，每次进出 City 都会把 `WorldMapScene` 整个销毁再用 `new WorldMapScene(...)` 重建（重新 `loadData()`、重置相机居中），这是 Home Desk 这种高频进出的面板级页面，用户观感上是"卡一下"，不是真正意义上离开了 SLG 世界。
- **范围**：只覆盖"WorldMap ↔ City"这一条最常用边（直接进入/直接返回）。City 内部「Edit Team → DefenseEditorScene」这条更少走、更深的分支维持原有全量 `goto()` 行为不变（进入前先 `hideCityOverlay()` 弹出覆盖层，此时 `WorldMapScene` 已经在弹出时恢复为 `current`，紧接着的 `goto(DefenseEditorScene)` 仍会把它销毁；`DefenseEditorScene.onBack` 回到的是普通全量 `goCity()`，不是覆盖层版本）——没有必要为这条冷门路径再多套一层覆盖栈。
- **影响**：
  - `client/src/scenes/SceneManager.ts`：`Scene` 接口新增可选 `pause?()/resume?()` 钩子；新增 `overlayScene` 单槽位字段（与既有的淡入淡出遮罩 `overlay: PIXI.Graphics` 同名冲突，改名为 `overlayScene` 避免撞车）+ `pushOverlay(scene)`/`popOverlay()`；`onTick` 拆出 `tickScene()` 私有方法，`current` 与 `overlayScene`（若存在）每帧都 tick（地图在覆盖层下仍继续模拟，比如行军动画）；`goto()` 开头防御性地先销毁任何残留的 `overlayScene`，避免硬切换时孤儿挂载在新场景之上。
  - `client/src/scenes/WorldMapScene.ts`：新增 `pause()/resume()`——只解绑/重新订阅它自己在 `InputManager` 上的 4 个指针回调（`ctx.unsubs`），不碰渲染/网络/ticker。这是必须的：`InputManager.dispatch()` 广播给所有订阅者、不区分 z 序，覆盖层挂载但不 `pause()` 底层场景的话，点 City 面板的同时也会命中被完全遮挡的地图 hit-rect。
  - `client/src/app.ts` / `client/src/app/AppViews.ts`：新增 `showCityOverlay(cb)`/`hideCityOverlay()`（对应 `manager.pushOverlay`/`popOverlay`），`showCity(cb)` 原有全量语义不变；`client/test/harness/HeadlessAppViews.ts` 同步补最小实现。
  - `client/src/app/nav/world.ts`：新增 `goCityOverlay()`（`onOpenCity()` 改指向它），沿用原 `goCity()` 作为 edit-team 回程的全量兜底，两者 onEditTeam 回调各自独立，不互相递归。
  - 验证：`tsc --noEmit` + webpack dev build 全绿；用真实 `SceneManager` + 假 `Scene`（模拟 `WorldMapScene` 的 `pause/resume/destroy`）在浏览器里直接跑 `pushOverlay`→tick→`popOverlay` 全流程，断言 `current` 实例在覆盖层开关前后是同一个引用、未被销毁、`pause/resume` 各调用一次、两个场景都在 tick；另跑了 `goto()` 在覆盖层挂载期间被硬切换时的防御路径（覆盖层与旧 `current` 都应销毁，不留孤儿）。

## ADR-045 累计充值：商城可见自主领取（非静默邮件）+ 退款扣计数器 + 不回填历史 — Accepted — 2026-07-21

- **决策**（用户拍板）：新增终身累计充值奖励系统（[GACHA_DESIGN.md §13](game/GACHA_DESIGN.md)），三项关键取舍：
  1. 商城常驻可见的阶梯进度条 + 玩家自主领取，**不做成静默达标发邮件**——这类系统的核心商业价值就是可视化进度驱动付费（"还差¥X解锁Y"），静默发放等于把促充值工具做成用户感知不到的隐藏彩蛋。
  2. Paddle 退款（`adjustment.created` action=refund）按笔精确扣减 `totalRechargeCents`（下限0），但**已领取的奖励不追回**——只影响后续新档位解锁资格，防"充值→领奖→退款"薅羊毛，同时不做已交付内容的回滚。
  3. 上线**不回填**老玩家历史充值金额——`recharges` 表历史记录只有折算币数没有真实金额，回填需要反推价位档且有 first-purchase 2× 加成误差，成本大于收益；所有账号从 0 开始累计。
- **为什么**：三项都是"多花一点实现成本 vs 简单但有隐患/体验打折"的取舍，且都会影响后续人读文档/查代码时的预期（不回填 ≠ bug；退款不追回奖励 ≠ 漏洞），故各自记一条方向。
- **影响**：`server/shared/src/rechargeMilestone.ts`（新增，档位表+纯领取逻辑，同构 `battlepass.ts`）；`commercial` `WalletDoc.totalRechargeCents`/`RechargeDoc.usdCents`+`refundedAt`；`SaveData.rechargeMilestone?: { claimed: number[] }`；`server/metaserver/src/paddle.ts` 退款事件处理；客户端 `goRecharge` 商城平级入口。
