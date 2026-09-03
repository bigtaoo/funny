# 经济数值 — 留存 / 赛季 / SLG / 活动 / 角色卡（§12 起）

> 从 [`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md) 拆出（2026-08-17，原文件 753 行）。**小节编号沿用原文**，`ECONOMY_NUMBERS.md §N` 引用照旧有效。
> 本册内容：§12 留存、§13 赛季战令、§13-SLG 大世界持久经济、§14 活动、§15 角色卡。总览与在先小节见 [`ECONOMY_NUMBERS.md`](ECONOMY_NUMBERS.md)。

---

## 12. 留存系统数值（签到 / 每日任务 / 周常）`[DRAFT]`

> 机制权威：[`RETENTION_DESIGN.md`](RETENTION_DESIGN.md)；本节为**数字单一源**。铁律：金币绝大部分从「每日任务满点」出，月度严格收敛进 §6.1「日常任务/签到 ~150/月」格；签到里程碑格另加一笔小额 `bonusCoins`（R1b，见下，200/月，独立计，不算重新拍板 §6.1 的 150）。

### 12.1 每日签到（月历式，代码权威 `CHECKIN_REWARDS`，2026-08-01 修订）

奖励主体是**材料**（scrap/lead/binding，受体力闸门/养成树自然约束，不进金币通胀推演）+ 里程碑的卡/装备。**不发体力**（2026-08-01 前曾发体力，因体力上限 120、自然回复 10/小时、玩家常在接近/顶到上限时领取而常态性溢出浪费，已改为材料，见 RETENTION_DESIGN §10.5）。30 格月历，里程碑大奖在第 7/14/21/30 格，**每格额外带一笔 `bonusCoins`**：

| 格位 | 普通格奖励 | 里程碑大奖 | 里程碑 `bonusCoins` |
|---|---|---|---|
| 普通格（26 格，非里程碑） | 材料（scrap ×3 或 lead ×2，轮换；第 26 格 binding ×1） | — | — |
| 第 7 格 | — | 材料包（lead ×5） | **+30** |
| 第 14 格 | — | 角色卡 ×1（`pickRandomCatalogItem('card')` 均匀随机） | **+40** |
| 第 21 格 | — | 中级材料包（lead ×5） | **+50** |
| 第 30 格（月末压轴） | — | 装备 ×1（`pickRandomCatalogItem('equip_t1')` 均匀随机） | **+80** |

- 签到里程碑 `bonusCoins` 合计 **200/月**（R1b，2026-08-01）：远小于日常任务 150/月、战令 960/月、排位赛最高 5,400/赛季等既有金币龙头，判断为可忽略量级，未跑 econ-sim；若后续继续加大，需回来跑。
- 常规格材料量级刻意压得很低（月度合计约几百 coin-eq，估值基准见 §13-SLG.1），远小于正常刷关产出（~178,360 coin-eq/月，§13-SLG.3），只是"顺手甜头"，不冲养成节奏。
- 跨月（`monthKey`）重置；漏签不回退（温和档，R5）。

### 12.2 每日任务（金币唯一出口，日上限）

| 参数 | 默认 `[可调]` | 说明 |
|---|---|---|
| 当日任务数 | 3~4 条 | 前期固定全集，不随机派发 |
| 每条任务点 | 1 点 | 完成即加（服务器结算点） |
| 当日满点阈值 | 3 点 | 完成大部分任务即满 |
| **每日任务完成金币** | **5 coins/天** | 每日任务达标即得（代码 `retention.ts DAILY_COINS_REWARD=5`，=150/月；与 §12.4 一致）；与广告 50/天并列为两条常规金币 faucet（签到里程碑 `bonusCoins` 200/月是第三条，量级小一个数量级，见 §12.1） |
| 重置 | 自然日 `dayKey`（服务器时区） | 任务点不跨日 |

> 每日金币 = 广告 50/天 + 每日任务完成 5/天 ≈ **~55 coins/天**。每日任务月度 = 5 × 30 = **~150/月**（对应 §6.1「日常任务/签到」格）；签到里程碑 `bonusCoins` 200/月单独计（R1b，§12.1），调平衡只动「每日任务完成金币」「广告」「签到里程碑 bonusCoins」，不另立第四条。

### 12.3 周常活跃宝箱 `[可调]` ✅ 2026-08-05 已实现，三档奖励 2026-08-08 调整（见下）

| 档 | 周活跃点阈值 | 宝箱内容 |
|---|---|---|
| 一档 | **9**（3 天满勤） | 中级材料包（`mat_lead` ×20） |
| 二档 | **15**（5 天满勤） | 低级装备（`equip_t1` 随机抽，同签到月末装备格走法） |
| 三档 | **21**（7 天满勤/满周） | 一张传说卡（Anna 阵营 `max`/`lena`/`mara` 随机抽，界面呈橙色；**2026-08-08 前**是一件商城皮肤，见下方修正 3） |

- 周活跃点 = 每日任务点（`pve.clear`/`pvp.match`/`gacha.draw` 各 1 分）按 ISO `weekKey` 累计，与每日任务点同一个结算入口（`accrueRetentionTask`），共用其幂等判定；跨周（ISO `weekKey`）重置。
- **相对原提案的修正（实现/调整过程中发现原占位数值/内容有硬伤，或产品反馈分量不够）**：
  1. **阈值从 30/60/100 改成 9/15/21**——每日任务点上限是 3（3 个任务各 1 分），一周顶多攒 21 分，原来的 30 分永远碰不到，功能会生下来就是死的。改成"3/5/7 天满勤"三档，保留"递进三档、顶档=近乎满周"的设计意图，但真的够得着。
  2. **三档"限定皮肤碎片"改成一件普通商城皮肤（2026-08-05）**——全仓库没有"碎片"这个货币概念（皮肤只支持整件发放，`server/metaserver/src/skin.ts`），从零建一套碎片累计+兑换子系统超出这次的范围；改成直接发一件 `skin_shop_*`（非限定，不含 gacha 稀有皮肤 `skin_e1/e2/l1`，避免免费周常白送 legendary）。
  3. **三档"商城皮肤"再改成"随机传说卡"（2026-08-08，产品反馈）**——一件普通商城皮肤对需要满周活跃才够到的顶档奖励而言分量偏轻；改为 `pickRandomCatalogItem('card', rng, 'legendary')`（新增 `rarity` 过滤参数）从 Anna 阵营卡里随机抽一张，比商城皮肤更有分量，也比 checkin 第 14 天"全品阶随机卡"里程碑更稀有——匹配这一档更高的门槛（7 天满勤/满周 vs checkin 的月历第 14 格）。原 `WEEKLY_CHEST_SKIN_POOL`/`pickWeeklyChestSkin` 随之删除（唯一调用点已不存在，未保留兼容垫片）。
- 实现：`server/shared/src/retention.ts`（`makeWeekKey` 新增 ISO 周算法、`WeeklyData`/`WEEKLY_CHEST_TIERS`/`claimWeeklyTier`）→ `server/shared/src/gachaCatalog.ts`（`pickRandomCatalogItem` 新增可选 `rarity` 过滤参数）→ `server/metaserver/src/service/liveops.ts`（`getRetention` 附带 weekly 字段、新增 `claimWeeklyChest`，tier-3 走 `settleWeeklyChestReward` 的 `'card'` 分支）→ `POST /retention/weekly/claim`（`server/contracts/openapi/paths/liveops.yml`）→ 客户端 `DailyScene` 新增第四个 tab（复用 `renderDailyTasks` 的卡片+进度条+领取按钮样式，未新建场景）。测试：`server/shared/test/retention.test.ts`、`server/shared/test/gachaCatalog.test.ts`（`pickRandomCatalogItem` 稀有度过滤）、`server/metaserver/test/retention.e2e.test.ts`（真实 Mongo，tier-3 + 发放弹性用例）、`client/test/retention.test.ts`、`client/test/ui/dailySceneWeeklyTab.ui.ts`（三种奖励类型各自的领取 toast 文案 + 领取失败的 error toast/busy 复位）。详见 [`RETENTION_DESIGN.md §10.8`](RETENTION_DESIGN.md)。

### 12.4 可调参数（并入总表口径）

| 参数 | 默认 | 域 |
|---|---|---|
| 签到月历格数 | 30（月历式） | 留存 |
| 签到里程碑格 | 7/14/21/30 | 留存 |
| 签到常规格 | 材料（不发体力，2026-08-01 起） | 留存 |
| 签到里程碑 bonusCoins | 30/40/50/80（=200/月，R1b） | 留存 |
| 每日任务数 / 满点阈值 | 3~4 / 3 点 | 留存 |
| 每日满点金币 | 5 coins/天（=150/月） | 留存 |
| 周常档阈值 | 9/15/21（2026-08-05 定案，见 §12.3） | 留存 ✅ |

---

## 13. 天梯赛季 / 战令数值（赛季时钟 · 软重置 · 峰值/首达金币 · Battle Pass）`[可调]`

> 机制权威：[`SEASON_DESIGN.md`](SEASON_DESIGN.md)；本节为**数字单一源**。提案值已内联进 SEASON_DESIGN §13A.1（`@nw/shared` 常量），本节收口登记并补经济约束。
> 铁律（SEASON S5 / ADR-009）：赛季/战令金币**计入 §6.4 月度总产出核算**（取代已失效的"§6.1 月度 ~300 预算"提法），不另立持久龙头；奖励**绝不进 PvP 蓝图**。

### 13.1 赛季时钟 / 软重置

| 参数 | 默认值 | 说明 |
|---|---|---|
| `SEASON_DURATION_MS` | 6 周 | 天梯赛季时长；仅展示「预计结束」，硬切换由 admin 手动（SEASON §3.1） |
| `SEASON_RESET_BASELINE` | **1200**（= 黄金下限） | 软重置基准：`softReset(elo)= elo>基准 ? round((elo+基准)/2) : elo`（只压不抬） |

> 调高基准 → 强者每季保留更多分；调低 → 生态更平。天梯 6 周 ≠ SLG 大区 2 月（两条独立时钟，[`SEASON_OVERVIEW.md`](SEASON_OVERVIEW.md)）。

### 13.2 段位金币（首达 vs 峰值，两条独立账本）

- **首达金币 `FIRST_REACH_COINS`**：终身一次/段（`reachedRanks` 账本），升降不重复发。镜像 [`ECONOMY_BALANCE.md §2.3a`](ECONOMY_BALANCE.md)。
- **赛季峰值金币 `SEASON_PEAK_COINS`**：**每季可重复领**（按当季峰值段位），是高段玩家的持续 faucet——**最需控量的新 faucet**。现值见上表（青铜/白银=0，黄金起 100…王者 1,200，约首达的 25–34%），待 §9 总产出模拟持续确认。

| 段位 | 首达金币（终身一次） | 赛季峰值金币（每季） |
|---|---|---|
| bronze 青铜 | 100 | 0 |
| silver 白银 | 200 | 0 |
| gold 黄金 | 400 | 100 |
| platinum 铂金 | 700 | 200 |
| diamond 钻石 | 1,000 | 350 |
| star 星耀 | 1,500 | 500 |
| master 大师 | 2,000 | 700 |
| grandmaster 宗师 | 2,500 | 900 |
| king 王者 | 3,500 | 1,200 |

> 数字权威 = `server/shared/src/season.ts`（`FIRST_REACH_COINS` / `SEASON_PEAK_COINS`）。青铜/白银峰值金币现为 **0**（低段发币无意义且会激励刷小号）。
> **月度摊薄**：首达是一次性（爬满 ~11,900 摊薄进 §6.1「称号」行 ~20/月）；峰值金币按高段玩家每季实际峰值估，**已并入 §6.4 总产出核算表**（高段稳定王者 = 每季 1,200 × 30/42 ≈ 857/月，**这是此前完全没被计入任何月度估算的主要变量之一，调参时优先盯它**——注：本行此前写"月均~600"是未按 6 周赛季精确折月的旧估算，§6.4 已按 `×30/42` 重算为 857）。

### 13.3 战令 Battle Pass `[可调]`

| 参数 | 默认值 | 说明 |
|---|---|---|
| `BP_MAX_LEVEL` | 30 | 战令满级 |
| `BP_XP_PER_LEVEL` | 600 | 等差直线初版（每级等量，代码 `battlepass.ts=600`）；非线性曲线后置 |
| `BP_XP_RANKED_WIN` | 120 | ranked 胜一局经验 `[待模拟]` |
| `BP_XP_RANKED_LOSS` | 40 | ranked 负一局经验 `[待模拟]` |

- **免费轨打满约束**：`BP_MAX_LEVEL × BP_XP_PER_LEVEL / 经验日均 ≈ 42 天`（须满足「正常活跃 F2P 6 周打满免费轨」，`ECONOMY_BALANCE §2.6`）。当前 `30 × 600 = 18,000` 总经验，日均经验须约 ~430 才 6 周打满（`BP_XP_PER_LEVEL` 已从 1000 下调到 600）。任务点→XP 系数等其余来源待 [`RETENTION_DESIGN.md`](RETENTION_DESIGN.md) 落地后补（本轮经验仅 ranked 产出，SEASON §13B.0-D1）。
- **免费轨金币上限**：整季免费轨金币总额须 **< 一次十连**（`ECONOMY_BALANCE §2.6`；免费轨合计 960 < 1,350 ✅），已并入 [§6.4](#64-月度总产出核算2026-07-27审计补齐取代此前从未真正跑过的并入-9承诺) 月度总产出核算。
- **付费 Pass 定价**：对标 `ECONOMY_BALANCE §2.2` 小档 ¥6 区间（变现脊梁 + sink）。
- **奖励表重规划（`BATTLEPASS_DEFS`，2026-07-03）**：两轨均**递进**——材料档随等级爬升 scrap→lead→binding 且数量渐增；整 5 级里程碑必发金币且逐段增大，收束于 Lv30 的赛季大奖。仅用 `coins` / `material`（claim 路径实发的两类）；不发卡/皮肤（卡会进 PvP 战力、皮肤属变现脊梁，均排除）。数字 `[可调]`：改 `@nw/shared/battlepass.ts` 的 `REWARD_ROWS` → 同步 client `battlepassDefs.ts` → 回写本节。
  - **免费轨**：里程碑金币 Lv5/10/15/20/25/30 = 60/150/90/220/120/320（**合计 960**，满足「整季 < 一次十连 1,350」上限）；其余级发材料（前段 scrap 2→6、中段 lead 1→4、后段 binding 1→4）。材料在 `/battlepass/claim` 响应内与领取标记原子写入 `save.materials`。
  - **付费轨**：多数级发金币（变现龙头，逐段 20→50），少数级发更厚材料包（Lv3 scrap5 / Lv7·12 lead / Lv17·22·27 binding 2→4）；里程碑金币 Lv5/10/15/20/25/30 = 60/220/90/320/120/**520**（Lv30 为全轨最大单发）。每级付费金币 ≥ 同级免费。

### 13.4 可调参数（并入总表口径）

| 参数 | 默认 | 域 |
|---|---|---|
| `SEASON_DURATION_MS` / `SEASON_RESET_BASELINE` | 6 周 / 1200 | 赛季 |
| `FIRST_REACH_COINS`（9 段） | 100…3500（累计 11,900） | 赛季（终身一次） |
| `SEASON_PEAK_COINS`（9 段） | 0…1200（青铜/白银=0） | 赛季（每季可重复，控量重点） |
| `BP_MAX_LEVEL` / `BP_XP_PER_LEVEL` | 30 / 600 | 战令 |
| `BP_XP_RANKED_WIN/LOSS` | 120 / 40 | 战令 |
| 付费 Pass 价 | ¥6 区间 | 战令（变现） |

---

## 13-SLG. SLG 大世界持久经济数值（settle 结算奖励 · 材料估值 · A 轨聚合）`[DRAFT]`

> 机制/核验权威：[`SLG_ECONOMY_CHECK.md`](SLG_ECONOMY_CHECK.md)（核验方法/判据/签字）+ [`SLG_DESIGN_LOG.md`](SLG_DESIGN_LOG.md) §17/§21；本节为 **SLG DRAFT 数字单一源** + econ-sim 基准结论。
> 铁律（SLG_ECONOMY_CHECK §0.1 / §1，2026-06-30 拍板）：SLG 是「时间长得多的一场对战」，局内一切（赛季资源粮铁木/领地/城建/兵力/繁荣度）**季末全清**，唯一带出赛季的持久产出 = **settle 结算奖励（发到排名宗门每个成员，per-head）+ 日常/活动少量材料（细水）**。国民产出加成 `0.10`、防御加成 `0.15` 等是**纯季内节奏，永不进 §6.1 月度金币预算**。`SETTLE_REWARDS.coins` 维持 **0**（任何 >0 走 §2.4 签字并入 §6.1）。

### 13-SLG.1 材料 → 金币估值基准（保守上界，§2.4）

项目无显式材料定价。从**已发布常量自洽反推**（econ-sim `valuation.ts` 据此自动计算，永不与代码脱节）：

```
value(material) = DUPE_REFUND_COINS[该材料所在 gacha 稀有度档] / GACHA_MATERIAL_GRANTS[mat_*]
```

| 材料 | gacha 档 | dupe 退币 | 单格发放量 | **估值（coins/个）** |
|---|---|---|---|---|
| `scrap` | common | 10 | 10 | **1.00** |
| `lead` | rare | 50 | 3 | **16.67** |
| `binding` | epic | 400 | 1 | **400.00** |

> 取 epic 高退币值给 binding ⇒ **偏保守（高估 settle 产出）**，过则真过。`binding=400` 是**全部聚合结论的最大杠杆**——它独占 champion 人均价值的 ~84%，也是头部倾斜判据爆表的根因。调估值优先动这里。
> 旁证（非主依据）：单抽 150 coins、装备打造 `wp_marker(rare)=lead6+binding2` 等量级与上表同序，不矛盾。

### 13-SLG.2 settle 可调参数表（`@nw/shared/slg.ts`，DRAFT）

| 参数 | 默认 | 域 | 说明 |
|---|---|---|---|
| `SETTLE_REWARDS.champion.items` | scrap500/lead200/binding50 | settle | rank1 宗门**每成员** |
| `SETTLE_REWARDS.top3.items` | scrap300/lead120/binding25 | settle | rank2–3 每成员 |
| `SETTLE_REWARDS.top10.items` | scrap150/lead60/binding10 | settle | rank4–10 每成员 |
| `SETTLE_REWARDS.participant.items` | scrap50/lead20/**binding0** | settle | 其余全部人头（主导项） |
| `SETTLE_REWARDS.*.coins` | **0** | settle | 红线：保持 0 |
| `CENTER_CAPITAL_MULT` / `CENTER_CAPITAL_IDX` | ×2 / 9 | settle | 持中原首府的宗门成员材料 ×2 |
| `WORLD_CAPACITY` | **500**（ADR-032，2026-07-07 起；此前本表长期记 10000 已过期未同步——`prosperity.ts` 早在 2026-07-07 就把常量从 10000 降到 500，本节 §13-SLG.3 的三场景 JSON 从未跟着重算，见 §13-SLG.6） | 运维 | 单 shard 人口上限（触发开新 shard）→ shard 数 |
| 细水（日常/活动材料/人/日） | 场景输入 | settle | §0.1 计入 A 轨聚合 |

繁荣度三参 `PROSPERITY_W_*`(10/50/5)、`PROSPERITY_DECAY_PER_DAY`(0.05)、`SECT_FOUND_PROSPERITY_MIN`(2000)、`sectStrengthScore` 权重、国民加成 0.10/0.15、碾压结算阈值**不在本节经济预算内**（分属 SLG_ECONOMY_CHECK B/C/D/E/F 轨，各自核验，登记见该文档）。

### 13-SLG.3 演算示例（econ-sim 三场景，2026-06-30 首跑）

工具：`server/tools/econ-sim/`（纯 TS，import `@nw/shared`，不连库，对标 difficultySim）。跑法 `npx tsx src/index.ts`。口径固定 per-head（§2.2），场景差异 = 人口 × 宗门人数分布 × 首府持有率。

基准（per-player 月度常规材料刷量 = 40 关/日 ×30 ×0.7 复刷 × 中段普通关掉落 = **~178,360 coin-eq/月**）。

| 场景 | 人口 | settle 全服月度 coin-eq | champion 人均/季 | participant 人均/季 |
|---|---|---|---|---|
| conservative | 20k | 16.1M | 47,667c | 383c |
| baseline | 50k | 85.7M | 47,667c | 383c |
| aggressive | 100k | 714.5M | 47,667c | 403c |

判据对照（三场景一致）：

| 判据 | 视角 | 门控 | 结果 | 数 |
|---|---|---|---|---|
| **人均稀释**（participant） | 人均 | 是 | ✅ PASS | 0.11%（≪15%）|
| **人均稀释**（champion 最坏头） | 人均 | 是 | ✅ PASS | 13.36%（<15%，贴边）= 头部倾斜的真护栏 |
| **全服通胀（vs 材料龙头·正确口径）** | 全服 | 是 | ✅ PASS | 0.45% / 0.96% / 4.01%（≪10%）|
| **coin 子项** | — | 是 | ✅ PASS | Σcoins=0 |
| 头部倾斜（champion/participant 人均） | 人均 | **否·informational** | ~118–124× | 已降级非门控（见 §13-SLG.4-2）|
| 全服通胀（vs 金币龙头·跨类参考） | 全服 | 否·informational | 67%–595% | 量纲错配·名义换算（见下注）|

> **CORE 判决（仅看门控行）= 三场景全 PASS ✅**（conservative / baseline / aggressive）。

### 13-SLG.4 结论与待拍板

1. **安全主结论 ✅**：settle **不撑爆持久经济**。人均稀释（养成体验）与全服通胀（材料龙头同单位口径）在保守估值（binding=400）+ 激进场景（10万人/满编宗门）下仍 ≪ 阈值——A 轨「不破红线」成立。**coin 子项 = 0**，红线 1 自然满足。**三场景 CORE 全 PASS**。
2. **头部倾斜：已降级为 informational（2026-06-30 经济负责人拍板，采纳方案 a）**：champion 人均 ≈ participant 的 ~118–124×，纯结构性（participant `binding=0`，champion `binding=50(×2)`，binding 估值 400）。**决定：不设头部倾斜硬墙**——per-head 口径下「冠军该多拿」，10× 对竞技 SLG 过严；真正护栏是 **champion 绝对人均稀释 ≤ 15%**（判据 1b，实测 13.36% PASS，贴边但守住）——即「拿得多但不至于架空体力闸门」。该判据在 econ-sim 仍计算上报但不计入 CORE 判决。**后续若 champion 绝对稀释逼近 15%（如调高 champion binding 或首府 mult），优先压它，而非看比值。**
3. **「vs 金币龙头」口径是跨类参考、非门控** ⚠：settle 实发 `coins=0`，把材料 coin-equiv 去比**金币**龙头（§6.1）是名义换算、量纲错配（材料经济与金币经济不同数量级、不可兑），故 econ-sim 标为 informational、不计入 core 判决。**经济约束的正确分母 = 材料龙头**（同单位、可比），即上表「正确口径」行。已回注 SLG_ECONOMY_CHECK §2.3 分母口径。

### 13-SLG.5 经济约束（红线复述）

- settle/细水是 SLG **唯一**持久 faucet；赛季资源/城建/国民加成零持久沉淀，**不进本节也不进 §6.1**。
- `SETTLE_REWARDS.coins` 改非 0 ⇒ 必并入 §6.1 月度预算 + 经济负责人签字（§2.4）。
- settle 任何材料/装备/皮肤**绝不进 PvP 蓝图**（`buildPvpBlueprints` 零养成参，§9 硬墙）。
- 皮肤限定件纯 cosmetic（ADR-003）；legendary 仍只走盲盒。
- 数值是 DRAFT：终态判据 = 上线后 analyticsvc 实测（settle 实发总量 / participant 人头 / 首府持有率）对账，偏差回 SLG_ECONOMY_CHECK §10 重跑（惰性下季生效）。

> 门控阈值 15%/10% 维持提案值（实测留足余量）；头部倾斜 10× 已弃用（降级 informational，见上）。**A 轨已过核验（2026-06-30）**——`SETTLE_REWARDS` / `CENTER_CAPITAL_MULT` 的 SLG_DESIGN §17/§21 `DRAFT` 可降级为「已过 A 轨核验（2026-06-30）」；其余参数（繁荣度/国民加成/分区/容量）待 B–F 轨各自核验（SLG_ECONOMY_CHECK §4–§8）。**⚠️ 2026-07-15 重跑发现回归，见 §13-SLG.6——上面 §13-SLG.3/.4 的「三场景全 PASS」结论已过期，勿直接引用，待 §13-SLG.6 修复后重新登记。**

### 13-SLG.6 场景配置过期导致的回归 + 免费/满氪对比缺口（2026-07-15）

**根因（场景 JSON 过期，不是数值真的破防）**：`server/tools/econ-sim/scenarios/{baseline,aggressive,conservative}.json` 从 `ad6ec80a`（首次建 econ-sim）之后**从未再改过**；`topSectMembers`（各档宗门的绝对人数）是按当时 `WORLD_CAPACITY=10000`（→人口/10000 个 shard）校准的绝对值。2026-07-07 `WORLD_CAPACITY` 改到 500 后（见上表订正），`shardCount = ceil(population / WORLD_CAPACITY)` 涨了 20×，但场景 JSON 里的 `topSectMembers` 没跟着按比例缩小——`headsServerWide = topSectMembers × shardCount` 因此被放大 20×：
- `baseline`：champion 200 人/shard × 100 shard = 20,000 人头，占 5 万人口的 **40%**（不合理）
- `aggressive`：champion 900 人/shard × 200 shard = 180,000 人头，**超过 10 万总人口**（物理不可能——赢家宗门比全服人还多）

重跑 econ-sim（2026-07-15）验证了这个根因：`conservative`（topSectMembers 相对较小）仍 PASS，`baseline`/`aggressive`（未按比例缩放）CORE FAIL 在"全服通胀 vs 材料龙头"判据（10.4%/52.4%，阈值 10%）。**这是场景配置的校准 bug，不是 `SETTLE_REWARDS` 本身破防**——真实游戏里一个 shard 只有 500 人，champion 宗门绝不可能有 900 人。

**修复**：把三个场景 JSON 的 `topSectMembers` 按新旧容量比 `500/10000 = 0.05` 重新缩放（baseline champion 200→10、top3 150→8、top10 80→4；aggressive champion 900→45、top3 700→35、top10 400→20；conservative 同比核对），使宗门人数重新落在单 shard 500 人的合理区间内，再重跑确认三场景恢复 CORE PASS，回填本节 §13-SLG.3。

**免费玩家 vs 满氪玩家差距（本节此前从未量化，用户 2026-07-15 要求补）**：A 轨 econ-sim 只测「settle 结算奖励」这一条持久经济通路，不覆盖赛季内「练兵/建城节奏」这条真正被内购加速影响的通路——那条通路的核验在 B 轨（`cityRun.ts`，§13-SLG-CITY），目前只有 casual/active/hardcore 三档**活跃度**画像，没有对照"充值多少"。而 `SLG_SHOP_ITEMS`（`slg_speedup_*`/`slg_res_*`）在本次核验中发现**没有购买次数上限**（见 SLG_DESIGN.md §7.2 新增的购买频次限制），理论上满氪玩家可无限购买把 casual 画像下数天到一月的建造/练兵曲线压缩为瞬间完成，差距在补购买限制之前是无上界的。补丁：`cityRun.ts` 新增一个"满氪对照"输出——按 `SLG_SHOP_ITEMS` 现价 + 新增的每日购买上限，算出"每日最大氪金"能把 casual 画像的建造/练兵天数压缩到多少天，与免费天数并排列出，回填本节。


> §13-SLG-NATION / §13-SLG-CITY / §13-SLG-C / §13-SLG-D / §13-SLG-E / §13-SLG-F / §13-SLG-STRONGHOLD 的核验过程与结论已拆分至 [`ECONOMY_VERIFICATION_LOG.md`](ECONOMY_VERIFICATION_LOG.md)（章节号延续本文档编号，未重新编号）。

## 14. 活动 / Live-ops 数值（双倍封顶 · 积分 · 里程碑）`[可调]`

> 机制权威：[`EVENTS_DESIGN.md`](EVENTS_DESIGN.md)；本节为**数字单一源**。红线（ADR-014）：①不新增金币龙头（活动金币计入 §6.1 月度预算，主发软通货/限定皮肤碎片/积分）；②加成期硬封顶且只作用于受体力闸门约束的 PvE 产出；③积分活动期清零、不入持久经济；④PvP 硬墙恒不读活动加成。

### 14.1 加成期乘子（硬封顶，最敏感）

| 参数 | 默认值 | 上限（硬封顶） | 说明 |
|---|---|---|---|
| PvE 掉落倍率 `dropRate` | — | **≤ 2.0×** | 只作用于 PvE 材料/卡产出；体力总闸仍在（ADR-009），双倍 = 同体力翻倍产出，非无限刷 |
| 体力消耗倍率 `staminaCost` | — | **≥ 0.5×**（最多打五折） | 等效变相提产，与 dropRate 不叠满（见下） |
| 加成期单次时长 | — | **≤ 7 天** | 单个加成活动窗口上限 |
| 同时生效加成活动数 | — | **≤ 1** | 防多活动乘子叠乘冲垮预算 |
| 综合产出封顶 | — | **≤ 常态 2.5×** | dropRate × (1/staminaCost) 的合成上限，超配置拒绝上线（EVENTS §3 校验） |

> 服务器加载活动配置时校验乘子不超封顶（EVENTS §3「非法配置拒绝上线」），防运营误放超量奖励。

### 14.2 活动积分（局部货币，清零）

| 参数 | 默认值 | 说明 |
|---|---|---|
| 积分符号 | `eventPoints` | **不进 SaveData 持久经济**，活动 `settled` 即清零（EVENTS §2/§4） |
| 积分日产上限 | 按活动配置 | 受任务/里程碑数量自然约束 |
| 兑换商店产出 | 软通货 / 限定皮肤碎片 / 限定物 | **不**兑换金币、不破皮肤稀有度铁律（ADR-014 ③） |

### 14.3 活动奖励档（金币计入月度预算）

| 活动类型 | 主奖励载体 | 金币（若有） | 月度估算 `[可调]` |
|---|---|---|---|
| 登录活动 | 软通货（体力/材料/抽卡碎片）为主 | 极少/无 | 计入 §6.1「活动 ~40/月」 |
| 活动任务 | 软通货 + 活动积分 | 满档小额 | 同上 |
| 限定直购 | commercial 商店 SKU（金币/IAP） | — | 变现，不增 faucet |
| 节日主题 | 软通货 + 换皮 | 极小 | 同上 |

> **月度口径**：活动金币（若有）与登录/任务一起**收敛进 §6.1「活动 ~40/月」格**，不另开持续龙头（同 ADR-011/ADR-014）。活动是「叠加正向收益、可错过不可剥夺」的受控容器。

---

## 15. 角色卡 / Hero Roster 数值（CHARACTER_CARDS_DESIGN 全套） `[DRAFT]`

> 机制权威：[`CHARACTER_CARDS_DESIGN.md`](CHARACTER_CARDS_DESIGN.md)；本节为**角色卡数字单一源**。常量真源：养成/背包 = `server/shared/src/cards.ts`；SLG 运行态 = `server/shared/src/slg/`（2026-07-05 起按域拆包：`core.ts` 世界/资源、`city.ts` 主城内政、`citySiege.ts` 野外城池、`siege.ts` 格位围攻、`auction.ts` 拍卖）；卡池 = `server/shared/src/economy.ts`。
> 状态：全部 `[DRAFT]` 占位值（已随 CC-1~5 落地代码），终态判据 = 上线后 analyticsvc 实测（升级速率 / 背包占用 / 受伤频率 / 卡池出货）对账，偏差惰性下版本生效。CHARACTER_CARDS_DESIGN §16 开放问题已在此登记。

### 15.1 卡定义（CardDef，`cards.ts`）

| 卡（defId） | 兵种 | 阵营 | troopCapBase | troopCapGrowth | powerWeights (hp/atk) | 招牌技能成长 [L1..L9] |
|---|---|---|---|---|---|---|
| lichuang 李川 | infantry | tao | 200 | 50 | 0.4 / 0.6 | 无（NO_SKILL） |
| chenshou 陈守 | shieldbearer | tao | 100 | 25 | 0.7 / 0.3 | 无（NO_SKILL） |
| suyuan 苏远 | archer | tao | 100 | 25 | 0.3 / 0.7 | 无（NO_SKILL） |
| max Max | max | anna | 100 | 25 | 0.4 / 0.6 | burstOnSingle：0,0,5,5,10,10,15,15,20 |
| lena Lena | lena | anna | 100 | 25 | 0.7 / 0.3 | disciplineArmor：0,0,2,2,4,4,6,6,8 |
| mara Mara | mara | anna | 100 | 25 | 0.3 / 0.7 | markEnemies%：0,0,10,10,15,15,20,20,25 |

> `troopCap(card) = troopCapBase + troopCapGrowth × level`。Tao 三人 = 现有兵种具名版，属性不变（CHARACTER_DESIGN §1 铁律），故 NO_SKILL。

### 15.2 升级：融合（`cards.ts`，2026-07-19 由连续 XP 曲线重设计）

- 规则：目标卡 + **5 张同阵营、同等级**材料卡一次性融合 → 目标 `level + 1`；材料必须严格等于目标当前等级，不支持混级/打折顶替
- `FUSION_MATERIAL_COUNT` = 5，`MAX_CARD_LEVEL` = 9（原散落各处的字面量 9 收拢为命名常量）
- `applyFusion(target) = target.level >= MAX_CARD_LEVEL ? target : { ...target, level: target.level + 1 }`
- 旧版连续 XP 曲线（`cost(n→n+1) = 5^n`，L9 累计约 488 280 XP）与 `feedXp()`/`LEVEL_CUMULATIVE_XP`/`CardInstance.xp` 字段已移除；总卡量需求量级不变（材料仍需逐级独立融合，等同于原 `5^level` 曲线），改动的是交互体验（离散凑 5 张 vs 连续攒经验条），不是经济投放节奏

### 15.3 背包 / 补偿（`cards.ts`）

| 参数 | 常量 | 默认值 | 说明 |
|---|---|---|---|
| 卡背包硬上限 | `CARD_INV_CAP` | 500（2026-07-19 由 150 扩容） | 独立于装备背包 1000（`EQUIPMENT_INV_CAP`，ADR-064 2026-08-10 由 300 扩容） |
| 背包满补偿 | `CARD_FULL_COMPENSATION_COINS` | 10 coins/张 | 抽卡/通关溢出转 coin sink |
| 预警阈值 + 溢出邮寄上限 | `CARD_INV_OVERFLOW_BUFFER` | 10（2026-07-19 合并自 `CARD_INV_WARN`+`INV_FULL_MAIL_COUNT` 两个常量） | 剩余槽位 ≤10 时 UI 预警；满仓溢出时最多邮寄 10 张实体卡，其余转 coin |
| 融合幂等 TTL | `CARD_FEED_IDEM_TTL_SEC` | 7 天 | 同装备幂等纪律 |

### 15.4 SLG 兵力 / 受伤（`slg.ts`）

| 参数 | 常量 | 默认值 | 说明 |
|---|---|---|---|
| 每队最大卡数 | `CARD_TEAM_MAX_SIZE` | 12 | CHARACTER_CARDS_DESIGN §8.2 |
| 最大队伍数 | `SIEGE_TEAM_CAP` | 5 | 不变 |
| 基地兵力池基础上限 | `TROOP_CAP_BASE` | 10 000 | 统一池（2026-07-21）；新手初始即满值，练兵场每级 +`DRILL_TROOPCAP_STEP`(1000)。退役了独立的 `BASE_TROOP_STOCK_INITIAL` |
| HP 归零保底存活率 | `CARD_BASE_SURVIVAL` | 0.2 | `survivalRate = max(0.2, min(1, 残存/出战))` |
| 受伤锁队时长 | `CARD_INJURY_DURATION_MS` | 5 min | 整队锁定 |
| 受伤立即恢复价 | `CARD_RECOVER_COIN_COST` | 50 coins | 单卡 |
| 移出队伍资源返还 | `CARD_TROOP_REFUND_RATE` | 0.8 | 返还训练资源（非兵力本身） |
| 单兵训练粮成本 | `CARD_TROOP_PAPER_COST` | 2 paper/兵 | 入基地兵力池 `playerWorld.troops` |
| 士气加成 | — | (currentTroops/troopCap)×0.2 | 满员 +20% ATK |

### 15.5 卡池（`economy.ts` standard 池）

角色卡挂在标准池 `standard` 内（rarity 权重 `RARITY_WEIGHTS`：common 700 / rare 230 / epic 60 / legendary 10；池内同稀有度平均分权）：

| 稀有度 | 新增角色卡条目 | 该档条目数 | 单卡近似权重 |
|---|---|---|---|
| epic | lichuang / chenshou / suyuan（Tao 三人） | 9 | round(60/9) ≈ 7 |
| legendary | max / lena / mara（Anna 三人） | 7 | round(10/7) ≈ 1 |

- 抽到即入 `cardInv`（1 级实例，XP=0）；背包满转 §15.3 补偿
- ~~单位卡盲盒池（`UNIT_CARD_POOL_ID`）~~ 已于 2026-07-03 彻底移除（S12-C 遗留的第二个非限定池，被客户端显示成重复的「常驻池」）；单位卡进度仅保留 PvE 关卡掉落（`levelCardReward` → `cardInv`，见 §4 2026-08-03 订正——**不是**发进 `cardInventory`/`deriveUnitLevels`，那条链路本身已在 CC-9(2026-07-03) 退役，本行此前的表述过期），gacha 抽卡池及其发货路由（`unitCardPoolItems`/`GACHA_RARITY_TO_CARD_LEVEL`/`deliverCardGrant`）已删。角色卡走 Hero Roster，本就在 `standard` 常驻池发放

### 15.6 重复卡处理 / "碎片兑换表"——2026-08-03 拍板正式关闭

`DUPE_REFUND_COINS`（`server/shared/src/economy.ts`：common=10/rare=50/epic=400/legendary=1500）代码注释里提过一个未落地的设想："重复卡→碎片，碎片再兑换指定卡"，因为碎片会落进客户端同步的 `materials` 字段（与 client PUT /save 的权威冲突）而搁置，转为统一金币退还（`DUPE_REFUND_COINS`本身）。**核实结果：`DUPE_REFUND_COINS` 目前未接入任何真实发货路径**——全仓库唯一引用点是 `server/tools/econ-sim`（SLG settle 材料估值用，见 §13-SLG.1），`metaserver/src/service/economy.ts` 的抽卡/商店发货逻辑从未调用它；换言之"抽到重复卡/皮肤怎么处理"这件事目前完全没有兑现逻辑，重复项就静静地留在背包/`inventory.skins`里。

**2026-08-03 拍板：正式放弃"碎片兑换"设想，不再是开放项**——理由：融合校验本就是"同阵营互通"（涛奇三人/Anna三人互为材料），抽到的重复卡天然可用作任意同阵营目标的融合材料，碎片系统能带来的增量价值很小；且真要做还得新开一个类似 `cardInv`/`equipmentInv` 那样的服务器权威集合来绕开 `materials` 字段的客户端同步冲突，成本明显高于收益。`DUPE_REFUND_COINS` 保持现状（仅供 econ-sim 估值用），"抽到重复卡/皮肤零兑现"这件事本身**不算 bug**——皮肤重复本来就无所谓（不消耗、不占背包上限之外的资源），卡重复天然是融合燃料。若未来要做，需求得从"仅供 SLG 估值的孤立常量"重新论证，不建议照搬本节的旧设想直接实现。

### 14.4 可调参数（并入总表口径）

| 参数 | 默认 | 域 |
|---|---|---|
| PvE 掉落倍率上限 | ≤ 2.0× | 活动（加成期） |
| 体力消耗倍率下限 | ≥ 0.5× | 活动（加成期） |
| 加成期单次时长 / 并发数 | ≤ 7 天 / ≤ 1 | 活动（加成期） |
| 综合产出合成封顶 | ≤ 常态 2.5× | 活动（加成期） |
| 活动积分 | 活动期清零、不沉淀 | 活动（局部货币） |
| 活动金币月度归口 | 并入 §6.1「活动 ~40/月」 | 活动（经济红线） |
</content>
