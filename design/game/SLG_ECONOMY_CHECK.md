# SLG 数值经济性核验方法（SLG_ECONOMY_CHECK）

> 状态：设计中 · 权威：本文（**SLG DRAFT 数值的核验流程/验收口径**；具体数字仍归 [ECONOMY_NUMBERS.md](ECONOMY_NUMBERS.md) §13-SLG） · 更新：2026-06-30

本文回答一个问题：[SLG_DESIGN.md](SLG_DESIGN.md) §17.12 / §21.4 列出的一批 **DRAFT 数值**——
`PROSPERITY_W_*` / `PROSPERITY_DECAY_PER_DAY` / `SECT_FOUND_PROSPERITY_MIN` / `SETTLE_REWARDS` 各档 + `CENTER_CAPITAL_MULT` /
`sectStrengthScore` 权重 / `WORLD_CAPACITY` / `RESET_DELETE_BATCH` / 国民加成 `NATION_BONUS_PRODUCTION(0.10)`·`NATION_BONUS_DEFENSE(0.15)` / 碾压级廉价结算阈值（U7）——
**怎么算「过没过」**，谁来签字，结果登记到哪。

它**不**重新拍数字（那是 ECONOMY_NUMBERS 的活），只定义**核验的方法、判据与流程**。

---

## 0. 核心认知：这批数不是同一种「经济」

最大的误区是把这一整批数当成一件事「跑一遍经济模拟」。它们其实分属 **6 条互不相同的核验轨道**，判据、工具、签字人都不一样。先分轨，再各自核：

| # | 参数 | 影响域 | 是否动**持久经济**（coin/材料） | 核验轨道 | 工具 |
|---|---|---|---|---|---|
| A | `SETTLE_REWARDS` 材料量 / `CENTER_CAPITAL_MULT` | 持久材料 faucet | **是** | §2 持久经济聚合 | econ-sim（§3，待建） |
| A | `SETTLE_REWARDS.coins`（若 >0） | 持久 coin faucet | **是·最敏感** | §2 + 经济总预算批准 | econ-sim + 人工签字 |
| A | `SETTLE_REWARDS.skins` | cosmetic 稀缺度 | 否（不破红线即可） | §2.4 定性核对 | 人工（ADR-003） |
| B | `NATION_BONUS_PRODUCTION=0.10` | **赛季资源**（粮铁木，季末清零） | 否（赛季内闭环） | §4 赛季资源产消 | econ-sim 季内模式 |
| C | `NATION_BONUS_DEFENSE=0.15` / 碾压级廉价结算阈值 | 战力 / 围攻结算 | 否 | §5 围攻对拼 | difficultySim |
| D | `sectStrengthScore` 权重 | 分区公平（蛇形均衡） | 否 | §6 分配方差 | 蒙特卡洛分配模拟 |
| E | `PROSPERITY_W_*` / `PROSPERITY_DECAY_PER_DAY` / `SECT_FOUND_PROSPERITY_MIN` | 节奏 / 建宗门门槛 | 否 | §7 解析可达性 | 公式手算 / 表格 |
| F | `WORLD_CAPACITY` / `RESET_DELETE_BATCH` | 运维 / 性能 | 否 | §8 负载估算 | 容量估算 / 压测 |

> **唯一会撑爆全局经济的是 A 轨**（settle 发持久材料/金币）。B/C/D/E/F 是「玩法平衡」「分区公平」「节奏」「运维」，各有判据，但都**不并入** `ECONOMY_NUMBERS §6.1` 月度金币预算。把它们混进同一个「经济模拟」会得出无意义的结论。

### 0.1 SLG 的持久经济面只有一处（2026-06-30 拍板）

> **SLG 本质 = 一场时间长得多的对战**。局内的一切（赛季资源粮铁木、领地、城建、兵力、繁荣度）**季末全部重置**，不沉淀进持久经济。玩家能从一个 SLG 赛季「带出来」的只有两样：
> 1. **赛季结算奖励**（`SETTLE_REWARDS`，发到**宗门每一个成员**）——**绝对主项**；
> 2. **日常/活动的少量材料产出**——很有限的细水。
>
> 因此**整个 SLG 对持久经济的影响 ≈ A 轨**。B 轨（国民产出加成 / 赛季资源）确认是**纯季内节奏**，零持久 faucet/sink，核验优先级低、永不进 §6.1 预算。日常/活动材料并入 A 轨一起聚合（§2.1）。

---

## 1. 红线（核验前先认这几条铁律）

来自 [SEASON_OVERVIEW.md](SEASON_OVERVIEW.md) §3.3、[ECONOMY_BALANCE.md](ECONOMY_BALANCE.md)、ADR-003/009/014：

1. **不新增金币龙头**：SLG settle 的 coin（如果发）必须**并入** `ECONOMY_NUMBERS §6.1` 月度预算，挤占既有格子，不能另开一条持续 faucet。
2. **PvP 硬墙**：SLG 任何奖励（材料/装备/皮肤）绝不进 PvP 蓝图（`buildPvpBlueprints` 零养成参）。本文核验的是 PvE/SLG 侧产出，不碰天梯公平性。
3. **赛季资源 ≠ 持久货币**：粮/铁/木等赛季资源**季末清零、禁挂**（[[project-currency-canon]]），它们的平衡是「赛季内产消节奏」，不沉淀进持久经济。国民产出加成 `0.10` 只影响这一层。
4. **皮肤稀有度铁律**（ADR-003）：settle 限定皮肤纯 cosmetic，不给数值/识别优势，legendary 仍只走盲盒。
5. **默认 `SETTLE_REWARDS.coins = 0`**（现状）：保持 0 则 A 轨的 coin 子项天然通过；任何 >0 提案必须走 §2.3 的额外批准。

---

## 2. A 轨——持久经济聚合（最重要）

### 2.1 要回答的问题

> 全服一个 SLG 赛季（60 天 ≈ 2 个月），`SETTLE_REWARDS`（+ 日常/活动少量材料）一共**发出多少持久材料/金币**？两个视角都要看：
> - **人均视角**（决定养成稀释）：单个玩家一季拿到多少，折月度后相对他自己的常规刷量（§3 关卡掉落）占多大比例；
> - **全服视角**（决定通胀）：乘上全服人口后的总发放量，折月度金币当量在 §6.1 预算的什么位置。

### 2.2 聚合公式（发到宗门每个成员 → 按人头口径）

> **口径已拍板（2026-06-30）**：settle 奖励**发给排名宗门里的每一个成员**（per-head），不是「一个宗门发一份」。当前 `settleSeason` 发奖循环按此展开到成员账号（§17.5）。因此 `recipients` 数的是**人头**，不是主体——这是聚合量的主导因子。

```
recipients(tier) = 处于该档宗门内的「成员人数」之和：
  champion    = 冠军宗门成员数
  top3        = rank 2..3 宗门成员数之和
  top10       = rank 4..10 宗门成员数之和
  participant = 其余所有参与结算的玩家人头（≈ 该 shard 活跃人口 − 上述成员）

单 shard 单赛季某材料发放量 M_mat
  = Σ_tier ( recipients(tier) × SETTLE_REWARDS[tier].items[mat] × capitalMult(tier) )
    + 日常/活动材料的人均季产 × 活跃人口        // §0.1 的细水项，量小但计入

capitalMult(tier) = 该档玩家所属宗门持中原首府(CENTER_CAPITAL_IDX=9)的比例 ×CENTER_CAPITAL_MULT

全服月度材料当量 = (Σ_shard M_mat) / SEASON_MONTHS       // SEASON_MONTHS = 60d/30 ≈ 2
月度金币当量     = Σ_mat ( 全服月度材料当量(mat) × 材料→金币估值(mat) ) + settle 月度 coin 当量
```

> **主导项 = `participant` 人头 × 该档材料**。因为绝大多数玩家落在 participant 档，全服总量 ≈ `活跃人口 × participant 档材料`。例：单 shard 1 万活跃、participant `scrap 50` ⇒ ~50 万 scrap/季/shard，这就是要盯的大头；champion/top3 因人头少，绝对量反而小（但人均高，看 §2.3 头部倾斜）。

### 2.3 验收判据（A 轨）

| 判据 | 视角 | 阈值（提案，待批准） | 说明 |
|---|---|---|---|
| **人均稀释** | 人均 | 单玩家 settle 一季材料折月度 ≤ 他常规月度材料产出（§3）的 **15%** | settle 是「长局打完的一次结算大奖」，不能让人均养成靠它推进、架空体力闸门 |
| **全服通胀** | 全服 | settle 全服月度金币当量计入并不显著抬高 §6.1 大盘（提案：增量 ≤ 大盘 **10%**） | per-head 口径下总量随人口放大，确认乘到全服仍温和 |
| **coin 子项** | — | 默认 **= 0**；若 >0 须 ≤ §6.1 月度预算剩余 headroom、挤占既有格、不新增龙头 | 任何 coin 走 §2.4 人工签字 |
| ~~**头部倾斜（人均）**~~ → **informational** | 人均 | ~~≤ 10×~~ **已降级非门控**（2026-06-30 拍板，采纳方案 a） | per-head 实测 ~118–124×（binding 结构性：participant=0/champion>0），10× 对竞技 SLG 过严；**真护栏改由 champion 绝对人均稀释 ≤15% 承担**（上行），梯度本身不设硬墙。econ-sim 仍上报比值不计入 CORE |
| **稀释检验** | 人均 | settle 大奖把「整套装备 +9 / 单位 T9」的鲸鱼级目标拉近不超过 **5%** | settle 不能变相缩短最深氪点（ECONOMY_NUMBERS §4/§5 长期目标） |

> 阈值 15%/10%/10×/5% 是**提案**，跑出真实聚合数后由经济负责人拍板调整并回填本表。
> ⚠️ per-head 口径下：**人均稀释**控养成体验（每人就那一份），**全服通胀**控大盘（乘了人口）——两个判据缺一不可，且可能给出相反信号（人均小但乘人口大），需同时满足。
> ⚠️ **全服通胀分母口径（2026-06-30 econ-sim 首跑澄清）**：settle 发的是**材料**、实发 `coins=0`，所以「全服月度金币当量」应比的是**材料龙头**（同单位、可兑、量级可比 = 全服关卡刷量的 coin-equiv），**不是** §6.1 金币龙头。把材料 coin-equiv 去比金币龙头是量纲错配（两套经济不同数量级），econ-sim 把该口径列为 informational 跨类参考、不计入 core 判决。本判据「全服」行据此以**材料龙头**为分母。

### 2.4 材料→金币估值基准（必须先确立）

聚合要折金币当量，就需要 `材料→金币` 的估值。项目目前**没有**显式的材料定价。核验前先按以下任一基准确立（记录到 ECONOMY_NUMBERS §13-SLG）：

- **卡包/直购反推**：若有金币直购材料包，用「包价 / 包内材料量」反推单材料金币值；
- **养成成本反推**：用「升一级单位/装备消耗的材料」对应的等效金币投入反推；
- **保守上界**：取上述两者较高值，使核验偏保守（宁可高估 settle 产出）。

估值一旦确立，本文与 ECONOMY_NUMBERS §13-SLG 共用同一组数，不各立一套。

---

## 3. econ-sim 核验脚本（A 轨已建 ✅ 2026-06-30，B 轨季内模式待补）

战斗侧有 `difficultySim`（headless 引擎 + 基线 AI，见 [[project-difficulty-sim]]）；经济侧 **A 轨工具已落地**：`server/tools/econ-sim/`（纯 TS，import `@nw/shared` 的 `SETTLE_REWARDS`/`CENTER_CAPITAL_MULT`/`WORLD_CAPACITY`/`DUPE_REFUND_COINS`/`GACHA_MATERIAL_GRANTS`，**不连库**，与 difficultySim 同构）。跑法 `cd server/tools/econ-sim && npx tsx src/index.ts`；估值/基准在 `src/valuation.ts`，聚合/判据在 `src/model.ts`，场景在 `scenarios/*.json`。首跑结论登记 [`ECONOMY_NUMBERS.md` §13-SLG](ECONOMY_NUMBERS.md)。**B 轨全部已建**：`src/city.ts` + `cityRun.ts`（建筑节奏，结论 [§13-SLG-CITY](ECONOMY_NUMBERS.md)）；`src/nationBonus.ts` + `nationBonusRun.ts`（裸经济不破·国民加成，结论 [§13-SLG-NATION](ECONOMY_NUMBERS.md)）；均 import `@nw/shared`，`npx tsx src/cityRun.ts` / `npx tsx src/nationBonusRun.ts`。B 轨 CLOSED（2026-06-30）。

**位置**：`server/tools/econ-sim/`（已建）。

**输入（场景配置 JSON）**：
```
{
  population: 50000,          // 全服 SLG 活跃账号
  worldCapacity: 10000,       // = WORLD_CAPACITY
  shardCount: ceil(pop / cap),
  sectsPerShard: 200,         // 每 shard 参与结算的宗门数
  membersPerSect: { dist: 'lognormal', mean: 25, ... },  // 宗门人数分布（驱动 per-head 总量）
  // recipientGranularity 已固定 = 'member'（发到宗门每个成员，§2.2，无需再设开关）
  capitalHoldRate: { champion: 1.0, top3: 0.5, ... },  // 各档持首府比例
  materialCoinValue: { scrap: x, lead: y, binding: z }, // §2.4 估值
  seasonDays: 60
}
```

**输出**：
- 全服单赛季各材料/金币发放总量；
- 折月度金币当量 + 占 §6.1 预算比例；
- 头部/中游/尾部分布直方图；
- 与 §2.3 各判据的 PASS/FAIL 对照表。

**跑法**：至少 3 个场景——`保守`（低活跃 / 宗门人数偏小）、`基准`（预期人口与宗门人数分布）、`激进`（高活跃 / 大宗门 / 首府全占）。口径固定 per-head（§2.2），场景差异来自**人口 × 宗门人数分布**。三档都 PASS 才算过；激进档 FAIL 但基准 PASS 则记为「上线后盯紧」（见 §10）。
> per-head 口径让全服总量对**宗门人数分布**高度敏感（大宗门越多、participant 人头越多 → 总量线性涨），故 `membersPerSect` 分布是激进档的主旋钮。

> 在脚本落地前，**可先用电子表格按 §2.2 公式手算基准档**作为临时门槛——但调参阶段务必补脚本，避免每次改 `SETTLE_REWARDS` 都重描表格。

---

## 4. B 轨——赛季资源产消（国民产出加成 0.10）·纯季内·低优先

`NATION_BONUS_PRODUCTION=0.10` 只加 **本国 Voronoi 区赛季资源产出**（粮铁木，**季末清零**，不入持久经济）。核验的是**赛季内节奏**，**零持久 faucet/sink，永不进 §6.1 预算**（§0.1）。因此 B 轨优先级低于 A 轨——它影响「这一局打得爽不爽」，不影响全局经济。

**判据**：
- **裸经济不破**：+10% 不应让「占本国地 vs 占敌国地」的产出差大到逼所有人龟缩本国（破坏大世界争夺动机）。用 econ-sim 季内模式对比 `本国全占` vs `跨国扩张` 两种策略的资源累计曲线，差距 ≤ **某阈值（提案 20%）**。
- **建造/练兵节奏**：用加成后的资源产率，验算 SLG_CITY（[SLG_CITY_DESIGN.md](SLG_CITY_DESIGN.md)）关键建筑/练兵的达成时间是否落在设计窗口（数字归 ECONOMY_NUMBERS §13-SLG-CITY）。

---

## 5. C 轨——围攻/战力（国民防御加成 0.15 + 碾压级廉价结算阈值）

走 **difficultySim**（围攻确定性引擎，SLG_DESIGN §16；R-4 已登记「国民加成数值未调参」）。这不是经济核验，但同属「DRAFT 待实测」，在此登记判据以便一次过。

| 参数 | 判据 | 方法 |
|---|---|---|
| `NATION_BONUS_DEFENSE=0.15` | 守方 +15% 不应让「本国地不可攻破」——同等兵力当量下，攻方仍有合理胜率（提案：均势对拼攻方胜率落 **40–55%**） | difficultySim 跑攻守满血容量表样本（§16.5），统计胜率 |
| 碾压级廉价结算阈值（U7） | 阈值不得把**正常激战**误判为碾压而走廉价快算（误判率 ≤ **1%**）；同时真碾压须命中以省算力 | 用历史/构造围攻样本回放，统计阈值两侧的分类准确率 |

---

## 6. D 轨——分区公平（sectStrengthScore 权重）

`sectStrengthScore` 权重只影响 `allocateSectsToShards`（蛇形均衡）把宗门发到各 shard 后**强弱是否持平**，与经济无关。

**判据**（已部分由 SLG_DESIGN §17.10 单测覆盖）：
- 蒙特卡洛：随机生成 N 组宗门（含「有历史排名」与「新宗门给中位 500」混合），跑 `allocateSectsToShards`，断言**各 shard 实力总和的极差 ≤ 最强单体宗门分值**（蛇形发牌的理论上界）。
- 权重敏感性：分别拉高 `lastSeasonRank` 权重 / `memberFamilyCount×50` / `prosperity/100` 三项，确认没有哪一项主导到让分配退化（如全按人数 → 历史强队扎堆）。

**工具**：复用 §17.10 的纯函数单测框架加一个统计跑批即可，无需 econ-sim。

---

## 7. E 轨——节奏 / 建宗门门槛（繁荣度三参）

`familyProsperity = territory×10 + member×50 + activity×5`，`SECT_FOUND_PROSPERITY_MIN=2000`，`PROSPERITY_DECAY_PER_DAY=0.05`。纯解析，手算即可。

**判据**：
- **门槛可达但有阻**：SLG_DESIGN §17.1 注释已估「30 人 +30 地 ≈ 1800 基础，需约 40 活跃点」。核验=用**中位家族**的真实规模假设（占地速率 × 在线天数 + 成员增长曲线）算「建宗门所需天数」，应落在设计窗口（提案：活跃中位家族 **第 7–14 天**可建，休闲家族更久）。
- **衰减不惩罚正常作息**：`0.05/日` ⇒ 半衰期 ≈ `ln2/ln(1/0.95) ≈ 13.5 天`。判据=正常玩家**周常活跃**（每周上线数次产生 activity）不应净衰减；只惩罚**整周挂机零活跃**。手算「连续 X 天零活跃后繁荣度跌破建宗门门槛」的 X，应 ≥ 一个合理离线窗口（提案 ≥ 7 天）。
- 三权重相对关系：member(50) ≫ territory(10) ≫ activity(5) 是否符合「人是宗门核心」的设计意图——定性确认即可。

---

## 8. F 轨——运维容量（WORLD_CAPACITY / RESET_DELETE_BATCH）

非经济，纯工程。`WORLD_CAPACITY=10000`（单 shard 人口上限）、`RESET_DELETE_BATCH`（清档批大小）。

**判据**：
- `WORLD_CAPACITY`：单 shard 10000 人对应的 `FamilyDoc`/领地/march 文档量与 worldsvc 内存/Mongo 查询（如 `families.find({worldId}).sort({prosperity})`）延迟在可接受区间——用预估文档数 + 关键查询的 explain/压测确认；超限则下调容量、靠多 shard 摊。
- `RESET_DELETE_BATCH`：清档分批删除不打满 Mongo（单批耗时 / 锁影响可控）——用一个满 shard 的清档耗时实测确定批大小。
- 两者都是**上线前压测项**，不阻塞数值拍板，但需在 §9 清单登记「已估算/已压测」。

---

## 9. 验收清单 + 登记

一批 SLG 数值「过经济核验」的完整定义：

- [x] **A 轨已过核验（2026-06-30，CLOSED）**：econ-sim 三场景 **CORE 全 PASS**（§13-SLG.3）；材料→金币估值基准已确立并记录（§13-SLG.1，binding=400 保守上界）；细水已计入。**人均稀释 ✅**（participant 0.11% / champion 13.36%）+ **全服通胀 ✅**（vs 材料龙头 0.45–4.01%）+ **coins=0 ✅**。头部倾斜经经济负责人拍板**降级为 informational**（采纳方案 a，护栏改由 champion 绝对稀释承担，§13-SLG.4-2）。
- [x] **A-coin**：`SETTLE_REWARDS.coins` = 0（econ-sim 校验 ✅）；若改 >0，须并入 §6.1 预算且经济负责人签字。
- [x] **B 轨（全 ✅ CLOSED 2026-06-30）**：
  - **建造/练兵节奏 ✅**（econ-sim `city.ts`/`cityRun.ts`，结论 [§13-SLG-CITY](ECONOMY_NUMBERS.md)：资源门控数周肝、落 60 天窗口、乘子合理；informational：drillYard L13 提速触底 / sticker 自我门控）。
  - **裸经济不破 ✅**（econ-sim `nationBonus.ts`/`nationBonusRun.ts`，结论 [§13-SLG-NATION](ECONOMY_NUMBERS.md)：`NATION_BONUS_PRODUCTION=0.10` 本国 vs 跨国最大差距 **+10.0%**（≪ 阈值 20%）；结构性保证：差距上限恒等于加成值本身，11 个场景全 PASS；高等级他国格（+20% level）可使跨国扩张反超 −8.3%——大世界争夺动机完整）。
- [x] **SLG_CITY P2 ✅ CLOSED（2026-06-30）**：`wall`（守方主城 garrison HP × wallDefenseMult）/ `cabinet`（transferLoot 折减 effectiveLootRate）/ `academy`（`buildSiegeBlueprints` 第 4 参数 siegeAcademy 叠乘攻方 HP/伤害）全部落地；`buildGateReason` 改用 `BUILDING_KEYS` 全集，wall/academy 正式可建；CityScene 建筑网格更新；i18n zh/en/de；单测 11/11 绿；DRAFT 数值（WALL_DEFENSE_STEP=0.05 / CABINET_PROTECT_STEP=0.02 / ACADEMY_HP_STEP=0.02 / ACADEMY_DAMAGE_STEP=0.015）。
- [x] **C 轨 ✅ CLOSED（2026-06-30）**：Lanchester 线性模型（`resolveSiege + nationDefenseStrength`，与 worldsvc `applySiege` 一致）；攻方胜率 U[100,2000] = **43.0%**、U[100,500] = **40.4%**，均在 40–55% 窗口；`SIEGE_CHEAP_RATIO=10` 误判率 **0%**（结构性保证：atk/defEff≥10⇒attacker_win）。结论 [§13-SLG-C](ECONOMY_NUMBERS.md)。
- [x] **D 轨 ✅ CLOSED（2026-06-30）**：蒙特卡洛 10 seeds × 6 配置（sects 10–1000，shards 2–10）**全 PASS**（极差 ≤ 最强单体，典型极差 ≈ 10–15% 上界）；排名权重是主稳定器（去掉排名退化符合预期，确认多维设计必要性）。结论 [§13-SLG-D](ECONOMY_NUMBERS.md)。
- [x] **E 轨 ✅ CLOSED（2026-06-30）**：活跃中位家族（20 人起、3.5 地/天、4 活跃/天）**第 9 天**建宗门（7–14 天窗口 ✅）；从 ≥3000 分起零活跃 **8 天**跌门槛（≥7 天判据 ✅）；`decayProsperity` 惰性结算，有动作即满分重算，周常活跃玩家不观测衰减 ✅。结论 [§13-SLG-E](ECONOMY_NUMBERS.md)。
- [x] **F 轨 ✅ CLOSED（2026-06-30，工程估算）**：WORLD_CAPACITY=10000 / shard：~246k（中位）–582k（峰值）文档；热路径查询全为点查或窄范围扫描（< 10ms）；RESET_DELETE_BATCH=2000 清档 **1.9–4.4s**（< 5s）；活跃层缓存 **36 MB / shard**（VPS 可承 28–56 shard）。结论 [§13-SLG-F](ECONOMY_NUMBERS.md)；待预发压测确认。
- [x] **登记 ✅（2026-06-30）**：C/D/E/F 轨结论已写入 [ECONOMY_NUMBERS.md](ECONOMY_NUMBERS.md) §13-SLG-C / §13-SLG-D / §13-SLG-E / §13-SLG-F；数值未变（常量未动），SLG_DESIGN §17.1 / §21.4 `DRAFT` 标记按上线后压测策略保留（见 §10）。
- [x] **代码**：C/D/E/F 轨核验数字与 `server/shared/src/slg.ts` 当前常量一致，无需改动。

**签字人**：A/A-coin 轨 = 经济负责人（动持久经济）；B/C 轨 = 战斗/SLG 玩法负责人；D/E/F 轨 = 实现者自核 + 复核即可。

---

## 10. 上线后复核（数值是 DRAFT 的本质）

经济核验跑的是**假设**（人口/活跃/口径），真实分布只有上线后才知道。因此：

- econ-sim 的「激进档」FAIL 但「基准档」PASS 的项 → 标记**埋点盯紧**：用 analyticsvc 采 settle 实际发放总量 / participant 主体数 / 首府持有率，赛季结束对账。
- 实测偏离模型假设 > 一档 → 回本文重跑 + 调 `SETTLE_REWARDS`，走惰性下季生效（不追溯已发）。
- 复核触发：每个 SLG 赛季结算后做一次「模型 vs 实测」对账，偏差进 ECONOMY_NUMBERS §13-SLG 的「演算 vs 实测」附注。

> 与全局口径一致（ECONOMY_NUMBERS §6.1 广告金币「上线后视实际再议」）：DRAFT 数值的终态判据是**实测**，本文只保证上线前不犯数量级错误。
