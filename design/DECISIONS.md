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
- **影响**：新增 [`game/SLG_CITY_DESIGN.md`](game/SLG_CITY_DESIGN.md) 为建筑系统机制权威；[`game/SLG_DESIGN.md`](game/SLG_DESIGN.md) §3.4 遗留指针改指本方案、§21 R-1 更新、新增 §21 剩余工作总览；数字落 [`game/ECONOMY_NUMBERS.md`](game/ECONOMY_NUMBERS.md) §13-SLG-CITY，核验经 [`game/SLG_ECONOMY_CHECK.md`](game/SLG_ECONOMY_CHECK.md)。实现 P1 含 `biomeAt` 四分改造（client 经 alias 共用，须确认确定性地图不破老种子——或仅新赛季生效）。README §1.2 已登记。

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

## ADR-025 SLG 主城 = 真占 3×3=9 格实体（封路 + 一体防守 + 计 9 格） — Accepted — 2026-07-02

- **决策**（用户拍板）：玩家主城从「单格 `type:'base'`」改为**真实占据 3×3=9 个地格的实体建筑**。锚点仍是 `PlayerWorldDoc.mainBaseTile`（中心格），围绕它的 8 格同写 `type:'base'` 且同 `ownerId`，**九格一体、不可分割**（敌人不能单独占/弃其中一角）。
- **四条细则**：
  1. **落城/迁城占位校验**：join（自动落城 + 手动）/relocateBase 都要求 3×3 九格全空（无 obstacle/gate/center/stronghold/他人领地），且中心格离地图边 ≥1 格。`pickSpawnTile` 自动选址扫描「3×3 可落」的锚点。
  2. **封路**：主城九格对**非城主行军不可穿过**（等同障碍），敌军寻路必须绕行——玩家可用主城**封路**。城主自己的行军可进出自己的主城（`findMarchPath` 新增 `blockedBaseKeys` 参数，语义同 `passableGateKeys`：命中即阻挡，但 `isDest` 放行以便围攻敌方主城）。
  3. **一体防守**：主城为一体，**攻击九格中任意一格 = 围攻整座主城**，到达后一律以锚点的驻军/防守 config 结算同一场围攻；「在主城的队伍依次作为守军出战」沿用既有防守 config 机制（§3.3），本条不新建多队波次系统。
  4. **繁荣/领地计数**：九格**全部计入** `territoryCount` 与家族繁荣（`countDocuments{ownerId}` 无需特判）。
- **不迁移**：SLG 未上线，无存量数据；现有 dev/test 单格主城在下次 join/relocate 时自然重建为九格。
- **影响**：`@nw/shared`（`slg.ts`：新增 3×3 footprint 工具函数 + `findMarchPath` 增 `blockedBaseKeys`）**属公共依赖，最先合 main**；`worldsvc`（`service.ts` joinWorld/relocateBase/passiveRelocate 写 9 格、placement 校验 9 格、`computeMarchPath` 构建 `blockedBaseKeys`、`applySiege` 任一 base 格→锚点、abandon/occupy 拒绝 base 格、`pickSpawnTile` 3×3 扫描）；`client`（`WorldMapScene` 城市 sprite 对齐真实九格 + 修贴图留白 + 点击任一格开主城菜单）。[`game/SLG_DESIGN.md`](game/SLG_DESIGN.md) §3.1 主城行 + §3 footprint 说明须更新。
