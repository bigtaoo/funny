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
  - **金币来源**：看广告 **固定 3 coins/条、≤5 条/天、每条间隔 ≥30 min**（弃"等值挂钩"提案）；大头在战斗/活动/称号/任务；**F2P 活跃玩家月目标 ~300 金币**。称号/成就一次性龙头保留。
  - **皮肤**：common/rare/部分 epic 金币直购；高级 epic + legendary 仅抽卡；活动限定直购。稀有度色 = 灰/蓝/紫/**橙**（legendary=橙 `#e08a2c`，2026-06-21 定）。
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
</content>
